const express = require('express');
const { z } = require('zod');
const db = require('../lib/db');
const { HttpError, validate, notFound } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { requireProject, requireColumn, isMember, toId } = require('../lib/access');
const { logActivity, notify } = require('../lib/events');
const { emitToProject } = require('../lib/realtime');
const { fetchSummary, fetchProjectSummaries, positionAt } = require('../lib/tasks');

const router = express.Router();
router.use(requireAuth);

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #6366f1');
const toColumn = (c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wip_limit, isDone: c.is_done });
const toLabel = (l) => ({ id: l.id, name: l.name, color: l.color });
const refreshBoard = (projectId, reason) => emitToProject(projectId, 'board:refresh', { projectId, reason });

// ---------------------------------------------------------------- board
// GET /api/projects/:id — everything the Kanban board needs in one round trip
router.get('/projects/:id', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id);
  const [columns, labels, members, tasks] = await Promise.all([
    db.query('SELECT * FROM board_columns WHERE project_id = $1 ORDER BY position', [p.id]),
    db.query('SELECT * FROM labels WHERE project_id = $1 ORDER BY name', [p.id]),
    db.query(
      `SELECT u.id, u.name, u.avatar_color, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY u.name`,
      [p.workspace_id],
    ),
    fetchProjectSummaries(p.id),
  ]);
  res.json({
    project: {
      id: p.id, name: p.name, key: p.key, description: p.description, color: p.color,
      workspaceId: p.workspace_id, workspaceName: p.workspace_name, role: p.role,
    },
    columns: columns.rows.map(toColumn),
    labels: labels.rows.map(toLabel),
    members: members.rows.map((m) => ({ id: m.id, name: m.name, color: m.avatar_color, role: m.role })),
    tasks,
  });
});

router.patch('/projects/:id', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id, 'admin');
  const data = validate(
    z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(2000).optional(), color: hex.optional() }),
    req.body,
  );
  await db.query(
    `UPDATE projects SET name = COALESCE($2, name), description = COALESCE($3, description), color = COALESCE($4, color) WHERE id = $1`,
    [p.id, data.name ?? null, data.description ?? null, data.color ?? null],
  );
  refreshBoard(p.id, 'project');
  res.json({ ok: true });
});

router.delete('/projects/:id', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id, 'admin');
  await db.query('DELETE FROM projects WHERE id = $1', [p.id]);
  emitToProject(p.id, 'project:deleted', { projectId: p.id });
  res.status(204).end();
});

// ---------------------------------------------------------------- columns
const columnSchema = z.object({
  name: z.string().trim().min(1, 'Column name is required').max(40),
  wipLimit: z.coerce.number().int().min(1).max(999).nullable().optional(),
  isDone: z.boolean().optional(),
});

router.post('/projects/:id/columns', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id, 'member');
  const data = validate(columnSchema, req.body);
  const { rows } = await db.query(
    `INSERT INTO board_columns (project_id, name, position, wip_limit, is_done)
     VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM board_columns WHERE project_id = $1), 0) + 1024, $3, $4) RETURNING *`,
    [p.id, data.name, data.wipLimit ?? null, data.isDone ?? false],
  );
  refreshBoard(p.id, 'column');
  res.status(201).json({ column: toColumn(rows[0]) });
});

router.patch('/columns/:id', async (req, res) => {
  const col = await requireColumn(req.params.id, req.user.id, 'member');
  const data = validate(columnSchema.partial().extend({ index: z.number().int().min(0).optional() }), req.body);
  await db.tx(async (c) => {
    if (data.name !== undefined) await c.query('UPDATE board_columns SET name = $1 WHERE id = $2', [data.name, col.id]);
    if (data.wipLimit !== undefined) await c.query('UPDATE board_columns SET wip_limit = $1 WHERE id = $2', [data.wipLimit, col.id]);
    if (data.isDone !== undefined) await c.query('UPDATE board_columns SET is_done = $1 WHERE id = $2', [data.isDone, col.id]);
    if (data.index !== undefined) {
      const { position } = await positionAt(c, {
        table: 'board_columns', scopeColumn: 'project_id', scopeId: col.project_id, index: data.index, excludeId: col.id,
      });
      await c.query('UPDATE board_columns SET position = $1 WHERE id = $2', [position, col.id]);
    }
  });
  refreshBoard(col.project_id, 'column');
  const { rows } = await db.query('SELECT * FROM board_columns WHERE id = $1', [col.id]);
  res.json({ column: toColumn(rows[0]) });
});

// DELETE /api/columns/:id?moveTo=<columnId>
router.delete('/columns/:id', async (req, res) => {
  const col = await requireColumn(req.params.id, req.user.id, 'admin');
  await db.tx(async (c) => {
    const { rows: cols } = await c.query('SELECT id FROM board_columns WHERE project_id = $1', [col.project_id]);
    if (cols.length <= 1) throw new HttpError(400, 'A board needs at least one column');
    const { rows: cnt } = await c.query('SELECT COUNT(*)::int AS n FROM tasks WHERE column_id = $1', [col.id]);
    if (cnt[0].n > 0) {
      const target = toId(req.query.moveTo);
      if (!target || !cols.some((x) => x.id === target) || target === col.id) {
        throw new HttpError(409, `This column has ${cnt[0].n} task(s). Choose a column to move them to.`);
      }
      await c.query(
        `UPDATE tasks SET column_id = $1, updated_at = NOW(),
                position = (SELECT COALESCE(MAX(position), 0) FROM tasks WHERE column_id = $1) + 1024 * id
          WHERE column_id = $2`,
        [target, col.id],
      );
    }
    await c.query('DELETE FROM board_columns WHERE id = $1', [col.id]);
  });
  refreshBoard(col.project_id, 'column');
  res.status(204).end();
});

// ---------------------------------------------------------------- labels
router.post('/projects/:id/labels', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id, 'member');
  const data = validate(z.object({ name: z.string().trim().min(1).max(30), color: hex }), req.body);
  try {
    const { rows } = await db.query('INSERT INTO labels (project_id, name, color) VALUES ($1, $2, $3) RETURNING *', [p.id, data.name, data.color]);
    refreshBoard(p.id, 'label');
    res.status(201).json({ label: toLabel(rows[0]) });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'A label with that name already exists', { name: 'Already exists' });
    throw err;
  }
});

router.delete('/labels/:id', async (req, res) => {
  const { rows } = await db.query('SELECT project_id FROM labels WHERE id = $1', [toId(req.params.id)]);
  if (!rows[0]) throw notFound('Label');
  await requireProject(rows[0].project_id, req.user.id, 'member');
  await db.query('DELETE FROM labels WHERE id = $1', [toId(req.params.id)]);
  refreshBoard(rows[0].project_id, 'label');
  res.status(204).end();
});

// ---------------------------------------------------------------- create task
const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  columnId: z.number().int().positive().optional(),
  description: z.string().max(20000).optional().default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),
  assigneeId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  labelIds: z.array(z.number().int().positive()).max(10).optional().default([]),
});

router.post('/projects/:id/tasks', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id, 'member');
  const data = validate(createTaskSchema, req.body);
  if (data.assigneeId && !(await isMember(p.workspace_id, data.assigneeId))) {
    throw new HttpError(400, 'Assignee must be a member of this workspace', { assigneeId: 'Not a member' });
  }

  const taskId = await db.tx(async (c) => {
    // Target column (default: first column) + WIP limit check
    const { rows: cols } = await c.query(
      `SELECT * FROM board_columns WHERE project_id = $1 AND ($2::int IS NULL OR id = $2) ORDER BY position LIMIT 1`,
      [p.id, data.columnId ?? null],
    );
    const col = cols[0];
    if (!col) throw new HttpError(400, 'Column not found on this board');
    if (col.wip_limit) {
      const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM tasks WHERE column_id = $1', [col.id]);
      if (rows[0].n >= col.wip_limit) throw new HttpError(409, `WIP limit reached: "${col.name}" allows ${col.wip_limit} task(s)`);
    }

    // Atomic per-project counter => human-friendly keys WEB-1, WEB-2 ... with no duplicates under concurrency
    const { rows: seq } = await c.query('UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq', [p.id]);
    const { position } = await positionAt(c, { table: 'tasks', scopeColumn: 'column_id', scopeId: col.id });

    const { rows } = await c.query(
      `INSERT INTO tasks (project_id, column_id, number, title, description, priority, assignee_id, reporter_id,
                          due_date, story_points, position, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN NOW() END) RETURNING id`,
      [p.id, col.id, seq[0].task_seq, data.title, data.description, data.priority, data.assigneeId ?? null, req.user.id,
        data.dueDate ?? null, data.storyPoints ?? null, position, col.is_done],
    );
    const id = rows[0].id;
    if (data.labelIds.length) {
      await c.query(
        `INSERT INTO task_labels (task_id, label_id) SELECT $1, id FROM labels WHERE project_id = $2 AND id = ANY($3::int[])`,
        [id, p.id, data.labelIds],
      );
    }
    await logActivity(c, { projectId: p.id, taskId: id, userId: req.user.id, action: 'task_created', details: { title: data.title, column: col.name } });
    return id;
  });

  const task = await fetchSummary(taskId);
  emitToProject(p.id, 'task:upsert', task);
  if (task.assignee) {
    notify({
      userId: task.assignee.id, actorId: req.user.id, type: 'assigned',
      title: `${req.user.name} assigned you ${task.key}`, body: task.title, link: `/p/${p.id}?task=${task.id}`,
    });
  }
  res.status(201).json({ task });
});

// ---------------------------------------------------------------- analytics
router.get('/projects/:id/analytics', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 7), 60);
  const [totals, byColumn, byPriority, byAssignee, daily] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND due_date < CURRENT_DATE)::int AS overdue,
              COALESCE(SUM(story_points), 0)::int AS points,
              COALESCE(SUM(story_points) FILTER (WHERE completed_at IS NOT NULL), 0)::int AS points_done,
              ROUND(AVG(EXTRACT(EPOCH FROM completed_at - created_at) / 3600)::numeric, 1) AS avg_cycle_hours
         FROM tasks WHERE project_id = $1`,
      [p.id],
    ),
    db.query(
      `SELECT c.id, c.name, c.wip_limit, c.is_done, COUNT(t.id)::int AS count
         FROM board_columns c LEFT JOIN tasks t ON t.column_id = c.id
        WHERE c.project_id = $1 GROUP BY c.id ORDER BY c.position`,
      [p.id],
    ),
    db.query(`SELECT priority, COUNT(*)::int AS count FROM tasks WHERE project_id = $1 AND completed_at IS NULL GROUP BY priority`, [p.id]),
    db.query(
      `SELECT u.id, u.name, u.avatar_color,
              COUNT(t.id) FILTER (WHERE t.completed_at IS NULL)::int AS open,
              COUNT(t.id) FILTER (WHERE t.completed_at IS NOT NULL)::int AS done,
              COALESCE(SUM(t.story_points) FILTER (WHERE t.completed_at IS NULL), 0)::int AS open_points
         FROM tasks t JOIN users u ON u.id = t.assignee_id
        WHERE t.project_id = $1 GROUP BY u.id ORDER BY open DESC, u.name`,
      [p.id],
    ),
    // For each day: tasks created, tasks completed, and tasks still open at the end of that day (burndown)
    db.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = $1 AND t.created_at::date = d)::int AS created,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = $1 AND t.completed_at::date = d)::int AS completed,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = $1 AND t.created_at < d + 1
                  AND (t.completed_at IS NULL OR t.completed_at >= d + 1))::int AS open
         FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, '1 day') AS g(d0),
              LATERAL (SELECT g.d0::date AS d) x
        ORDER BY d`,
      [p.id, days],
    ),
  ]);
  const t = totals.rows[0];
  res.json({
    totals: {
      total: t.total, done: t.done, open: t.total - t.done, overdue: t.overdue,
      points: t.points, pointsDone: t.points_done,
      avgCycleHours: t.avg_cycle_hours === null ? null : Number(t.avg_cycle_hours),
      completionRate: t.total ? Math.round((t.done / t.total) * 100) : 0,
    },
    byColumn: byColumn.rows.map((c) => ({ id: c.id, name: c.name, count: c.count, wipLimit: c.wip_limit, isDone: c.is_done })),
    byPriority: Object.fromEntries(byPriority.rows.map((r) => [r.priority, r.count])),
    byAssignee: byAssignee.rows.map((a) => ({ id: a.id, name: a.name, color: a.avatar_color, open: a.open, done: a.done, openPoints: a.open_points })),
    daily: daily.rows,
  });
});

// ---------------------------------------------------------------- activity feed
router.get('/projects/:id/activity', async (req, res) => {
  const p = await requireProject(req.params.id, req.user.id);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.details, a.created_at, a.task_id, u.name AS user_name, u.avatar_color,
            t.number, t.title AS task_title
       FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [p.id, limit],
  );
  res.json({
    activity: rows.map((r) => ({
      id: Number(r.id), action: r.action, details: r.details, createdAt: r.created_at,
      user: r.user_name ? { name: r.user_name, color: r.avatar_color } : null,
      task: r.task_id ? { id: r.task_id, key: `${p.key}-${r.number}`, title: r.task_title } : null,
    })),
  });
});

module.exports = router;
