const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const db = require('../lib/db');
const config = require('../config');
const { HttpError, validate, notFound } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { requireTask, isMember, toId } = require('../lib/access');
const { logActivity, notify } = require('../lib/events');
const { emitToProject } = require('../lib/realtime');
const { fetchSummary, positionAt } = require('../lib/tasks');

const router = express.Router();
router.use(requireAuth);

const link = (t) => `/p/${t.project_id}?task=${t.id}`;
const keyOf = (t) => `${t.project_key}-${t.number}`;
async function broadcast(taskId) {
  const summary = await fetchSummary(taskId);
  if (summary) emitToProject(summary.projectId, 'task:upsert', summary);
  return summary;
}

// ---------------------------------------------------------------- uploads (shared named volume)
fs.mkdirSync(config.uploadDir, { recursive: true });
const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|application\/zip|text\/csv)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase().slice(0, 10)),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.test(file.mimetype) ? cb(null, true) : cb(new HttpError(415, 'Allowed types: images, PDF, TXT, CSV, ZIP')),
});

// ---------------------------------------------------------------- my tasks (across all workspaces)
router.get('/me/tasks', async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.number, t.title, t.priority, t.due_date, t.project_id, p.key, p.name AS project_name, p.color,
            c.name AS column_name, w.name AS workspace_name
       FROM tasks t JOIN projects p ON p.id = t.project_id JOIN workspaces w ON w.id = p.workspace_id
       JOIN board_columns c ON c.id = t.column_id
       JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $1
      WHERE t.assignee_id = $1 AND t.completed_at IS NULL
      ORDER BY t.due_date NULLS LAST,
               CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 50`,
    [req.user.id],
  );
  res.json({
    tasks: rows.map((r) => ({
      id: r.id, key: `${r.key}-${r.number}`, title: r.title, priority: r.priority, dueDate: r.due_date,
      column: r.column_name, project: { id: r.project_id, name: r.project_name, color: r.color }, workspace: r.workspace_name,
    })),
  });
});

// ---------------------------------------------------------------- task detail
router.get('/tasks/:id', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id);
  const [summary, reporter, checklist, comments, attachments, activity] = await Promise.all([
    fetchSummary(t.id),
    db.query('SELECT id, name, avatar_color FROM users WHERE id = $1', [t.reporter_id]),
    db.query('SELECT id, text, done FROM checklist_items WHERE task_id = $1 ORDER BY position', [t.id]),
    db.query(
      `SELECT c.id, c.body, c.created_at, c.edited_at, u.id AS uid, u.name, u.avatar_color
         FROM comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = $1 ORDER BY c.created_at`,
      [t.id],
    ),
    db.query(
      `SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.created_at, u.name
         FROM attachments a JOIN users u ON u.id = a.user_id WHERE a.task_id = $1 ORDER BY a.created_at`,
      [t.id],
    ),
    db.query(
      `SELECT a.id, a.action, a.details, a.created_at, u.name, u.avatar_color
         FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [t.id],
    ),
  ]);
  const r = reporter.rows[0];
  res.json({
    task: {
      ...summary,
      description: t.description,
      reporter: r ? { id: r.id, name: r.name, color: r.avatar_color } : null,
      projectName: t.project_name,
      canEdit: t.role !== 'viewer',
    },
    checklist: checklist.rows,
    comments: comments.rows.map((c) => ({
      id: c.id, body: c.body, createdAt: c.created_at, editedAt: c.edited_at,
      author: { id: c.uid, name: c.name, color: c.avatar_color },
    })),
    attachments: attachments.rows.map((a) => ({
      id: a.id, name: a.original_name, mimeType: a.mime_type, size: Number(a.size_bytes), createdAt: a.created_at, uploadedBy: a.name,
    })),
    activity: activity.rows.map((a) => ({
      id: Number(a.id), action: a.action, details: a.details, createdAt: a.created_at,
      user: a.name ? { name: a.name, color: a.avatar_color } : null,
    })),
  });
});

// ---------------------------------------------------------------- update fields
const patchSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200).optional(),
  description: z.string().max(20000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  labelIds: z.array(z.number().int().positive()).max(10).optional(),
});
const FIELD_MAP = { title: 'title', description: 'description', priority: 'priority', assigneeId: 'assignee_id', dueDate: 'due_date', storyPoints: 'story_points' };

router.patch('/tasks/:id', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  const data = validate(patchSchema, req.body);
  if (data.assigneeId && !(await isMember(t.workspace_id, data.assigneeId))) {
    throw new HttpError(400, 'Assignee must be a member of this workspace', { assigneeId: 'Not a member' });
  }

  const changes = {};
  for (const [field, col] of Object.entries(FIELD_MAP)) {
    if (data[field] !== undefined && data[field] !== t[col]) changes[col] = data[field];
  }

  await db.tx(async (c) => {
    const cols = Object.keys(changes);
    if (cols.length) {
      const sets = cols.map((col, i) => `${col} = $${i + 2}`);
      if ('due_date' in changes) sets.push('due_notified = FALSE'); // re-arm the reminder
      await c.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, [t.id, ...cols.map((k) => changes[k])]);
      for (const col of cols) {
        const details = col === 'description' ? {} : { field: col, from: t[col], to: changes[col] };
        await logActivity(c, { projectId: t.project_id, taskId: t.id, userId: req.user.id, action: col === 'description' ? 'description_edited' : 'field_changed', details });
      }
    }
    if (data.labelIds) {
      await c.query('DELETE FROM task_labels WHERE task_id = $1', [t.id]);
      await c.query(
        'INSERT INTO task_labels (task_id, label_id) SELECT $1, id FROM labels WHERE project_id = $2 AND id = ANY($3::int[])',
        [t.id, t.project_id, data.labelIds],
      );
      await c.query('UPDATE tasks SET updated_at = NOW() WHERE id = $1', [t.id]);
    }
  });

  const summary = await broadcast(t.id);
  if (changes.assignee_id) {
    notify({ userId: changes.assignee_id, actorId: req.user.id, type: 'assigned', title: `${req.user.name} assigned you ${keyOf(t)}`, body: summary.title, link: link(t) });
  }
  res.json({ task: summary });
});

// ---------------------------------------------------------------- move (drag & drop)
router.post('/tasks/:id/move', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  const { columnId, index } = validate(z.object({ columnId: z.number().int().positive(), index: z.number().int().min(0) }), req.body);

  const result = await db.tx(async (c) => {
    const { rows: cols } = await c.query('SELECT * FROM board_columns WHERE id = ANY($1::int[])', [[t.column_id, columnId]]);
    const from = cols.find((x) => x.id === t.column_id);
    const to = cols.find((x) => x.id === columnId);
    if (!to || to.project_id !== t.project_id) throw new HttpError(400, 'Target column is not on this board');

    // WIP limit: only matters when entering a different column
    if (to.id !== from.id && to.wip_limit) {
      const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM tasks WHERE column_id = $1', [to.id]);
      if (rows[0].n >= to.wip_limit) throw new HttpError(409, `WIP limit reached: "${to.name}" allows ${to.wip_limit} task(s)`);
    }

    const { position, rebalanced } = await positionAt(c, { table: 'tasks', scopeColumn: 'column_id', scopeId: to.id, index, excludeId: t.id });
    await c.query(
      `UPDATE tasks SET column_id = $2, position = $3, updated_at = NOW(),
              completed_at = CASE WHEN $4 THEN COALESCE(completed_at, NOW()) ELSE NULL END
        WHERE id = $1`,
      [t.id, to.id, position, to.is_done],
    );
    if (to.id !== from.id) {
      await logActivity(c, { projectId: t.project_id, taskId: t.id, userId: req.user.id, action: 'task_moved', details: { from: from.name, to: to.name } });
    }
    return { rebalanced, from, to };
  });

  // After a rebalance many positions changed — tell clients to reload the board
  if (result.rebalanced) emitToProject(t.project_id, 'board:refresh', { projectId: t.project_id, reason: 'rebalance' });
  const summary = await broadcast(t.id);
  if (result.to.is_done && !result.from.is_done && t.reporter_id) {
    notify({ userId: t.reporter_id, actorId: req.user.id, type: 'completed', title: `${keyOf(t)} was completed`, body: t.title, link: link(t) });
  }
  res.json({ task: summary });
});

router.delete('/tasks/:id', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  const { rows: files } = await db.query('SELECT stored_name FROM attachments WHERE task_id = $1', [t.id]);
  await db.tx(async (c) => {
    await c.query('DELETE FROM tasks WHERE id = $1', [t.id]);
    await logActivity(c, { projectId: t.project_id, userId: req.user.id, action: 'task_deleted', details: { key: keyOf(t), title: t.title } });
  });
  for (const f of files) fs.promises.unlink(path.join(config.uploadDir, f.stored_name)).catch(() => {});
  emitToProject(t.project_id, 'task:deleted', { id: t.id, projectId: t.project_id });
  res.status(204).end();
});

// ---------------------------------------------------------------- checklist (sub-tasks)
router.post('/tasks/:id/checklist', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  const { text } = validate(z.object({ text: z.string().trim().min(1, 'Item text is required').max(200) }), req.body);
  const item = await db.tx(async (c) => {
    const { position } = await positionAt(c, { table: 'checklist_items', scopeColumn: 'task_id', scopeId: t.id });
    const { rows } = await c.query('INSERT INTO checklist_items (task_id, text, position) VALUES ($1, $2, $3) RETURNING id, text, done', [t.id, text, position]);
    return rows[0];
  });
  await broadcast(t.id);
  res.status(201).json({ item });
});

async function checklistItem(id, userId) {
  const { rows } = await db.query('SELECT * FROM checklist_items WHERE id = $1', [toId(id)]);
  if (!rows[0]) throw notFound('Checklist item');
  const t = await requireTask(rows[0].task_id, userId, 'member');
  return { item: rows[0], task: t };
}

router.patch('/checklist/:id', async (req, res) => {
  const { item, task } = await checklistItem(req.params.id, req.user.id);
  const data = validate(z.object({ text: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }), req.body);
  const { rows } = await db.query(
    'UPDATE checklist_items SET text = COALESCE($2, text), done = COALESCE($3, done) WHERE id = $1 RETURNING id, text, done',
    [item.id, data.text ?? null, data.done ?? null],
  );
  if (data.done !== undefined && data.done !== item.done) {
    await logActivity(null, { projectId: task.project_id, taskId: task.id, userId: req.user.id, action: data.done ? 'checklist_done' : 'checklist_undone', details: { text: item.text } });
  }
  await broadcast(task.id);
  res.json({ item: rows[0] });
});

router.delete('/checklist/:id', async (req, res) => {
  const { item, task } = await checklistItem(req.params.id, req.user.id);
  await db.query('DELETE FROM checklist_items WHERE id = $1', [item.id]);
  await broadcast(task.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- comments with @mentions
router.post('/tasks/:id/comments', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  const { body } = validate(z.object({ body: z.string().trim().min(1, 'Comment cannot be empty').max(5000) }), req.body);

  const comment = await db.tx(async (c) => {
    const { rows } = await c.query('INSERT INTO comments (task_id, user_id, body) VALUES ($1, $2, $3) RETURNING *', [t.id, req.user.id, body]);
    await c.query('UPDATE tasks SET updated_at = NOW() WHERE id = $1', [t.id]);
    await logActivity(c, { projectId: t.project_id, taskId: t.id, userId: req.user.id, action: 'commented' });
    return rows[0];
  });

  // @mentions: "@sara" matches a workspace member whose first name or email username is "sara"
  const handles = [...new Set([...body.matchAll(/@([\p{L}\p{N}._-]+)/gu)].map((m) => m[1].toLowerCase()))];
  const notified = new Set([req.user.id]);
  if (handles.length) {
    const { rows: members } = await db.query(
      `SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND (LOWER(split_part(u.name, ' ', 1)) = ANY($2) OR LOWER(split_part(u.email, '@', 1)) = ANY($2))`,
      [t.workspace_id, handles],
    );
    for (const m of members) {
      notified.add(m.id);
      notify({ userId: m.id, actorId: req.user.id, type: 'mentioned', title: `${req.user.name} mentioned you on ${keyOf(t)}`, body: body.slice(0, 140), link: link(t) });
    }
  }
  for (const uid of [t.assignee_id, t.reporter_id]) {
    if (uid && !notified.has(uid)) {
      notified.add(uid);
      notify({ userId: uid, actorId: req.user.id, type: 'commented', title: `${req.user.name} commented on ${keyOf(t)}`, body: body.slice(0, 140), link: link(t) });
    }
  }

  await broadcast(t.id);
  emitToProject(t.project_id, 'comment:new', { taskId: t.id });
  res.status(201).json({
    comment: { id: comment.id, body: comment.body, createdAt: comment.created_at, author: { id: req.user.id, name: req.user.name, color: req.user.avatar_color } },
  });
});

router.delete('/comments/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM comments WHERE id = $1', [toId(req.params.id)]);
  if (!rows[0]) throw notFound('Comment');
  const t = await requireTask(rows[0].task_id, req.user.id, 'member');
  if (rows[0].user_id !== req.user.id && !['owner', 'admin'].includes(t.role)) throw new HttpError(403, 'You can only delete your own comments');
  await db.query('DELETE FROM comments WHERE id = $1', [rows[0].id]);
  await broadcast(t.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- attachments
router.post('/tasks/:id/attachments', async (req, res) => {
  const t = await requireTask(req.params.id, req.user.id, 'member');
  await new Promise((resolve, reject) =>
    upload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(413, `File is larger than ${config.maxUploadMb} MB`));
      return err ? reject(err) : resolve();
    }),
  );
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const att = await db.tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO attachments (task_id, user_id, original_name, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [t.id, req.user.id, req.file.originalname.slice(0, 255), req.file.filename, req.file.mimetype, req.file.size],
    );
    await logActivity(c, { projectId: t.project_id, taskId: t.id, userId: req.user.id, action: 'attachment_added', details: { name: req.file.originalname } });
    return rows[0];
  });
  await broadcast(t.id);
  res.status(201).json({
    attachment: { id: att.id, name: att.original_name, mimeType: att.mime_type, size: Number(att.size_bytes), createdAt: att.created_at, uploadedBy: req.user.name },
  });
});

async function attachment(id, userId, min) {
  const { rows } = await db.query('SELECT * FROM attachments WHERE id = $1', [toId(id)]);
  if (!rows[0]) throw notFound('Attachment');
  const task = await requireTask(rows[0].task_id, userId, min);
  return { att: rows[0], task };
}

router.get('/attachments/:id/download', async (req, res) => {
  const { att } = await attachment(req.params.id, req.user.id, 'viewer');
  const file = path.join(config.uploadDir, att.stored_name);
  if (!fs.existsSync(file)) throw new HttpError(410, 'File is missing from storage');
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.original_name)}`);
  fs.createReadStream(file).pipe(res);
});

router.delete('/attachments/:id', async (req, res) => {
  const { att, task } = await attachment(req.params.id, req.user.id, 'member');
  await db.query('DELETE FROM attachments WHERE id = $1', [att.id]);
  fs.promises.unlink(path.join(config.uploadDir, att.stored_name)).catch(() => {});
  await broadcast(task.id);
  res.status(204).end();
});

module.exports = router;
