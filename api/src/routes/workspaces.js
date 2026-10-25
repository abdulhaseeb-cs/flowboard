const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../lib/db');
const { HttpError, validate, notFound, forbidden } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { requireWorkspace, atLeast, toId, ROLE_RANK } = require('../lib/access');
const { logActivity, notify } = require('../lib/events');
const { emitToUser } = require('../lib/realtime');

const router = express.Router();
router.use(requireAuth);

// Unambiguous characters only (no 0/O, 1/I/L)
const newInviteCode = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
};

const DEFAULT_COLUMNS = [
  { name: 'To Do', isDone: false },
  { name: 'In Progress', isDone: false, wip: 5 },
  { name: 'Review', isDone: false, wip: 3 },
  { name: 'Done', isDone: true },
];
const DEFAULT_LABELS = [
  ['Bug', '#ef4444'],
  ['Feature', '#6366f1'],
  ['Improvement', '#14b8a6'],
  ['Docs', '#f59e0b'],
];

// ---------------------------------------------------------------- workspaces
router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT w.id, w.name, w.created_at, m.role,
            CASE WHEN m.role IN ('owner','admin') THEN w.invite_code END AS invite_code,
            (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id)::int AS member_count,
            (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id)::int AS project_count
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
      ORDER BY w.name`,
    [req.user.id],
  );
  res.json({
    workspaces: rows.map((w) => ({
      id: w.id, name: w.name, role: w.role, inviteCode: w.invite_code,
      memberCount: w.member_count, projectCount: w.project_count, createdAt: w.created_at,
    })),
  });
});

router.post('/', async (req, res) => {
  const { name } = validate(z.object({ name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80) }), req.body);
  const ws = await db.tx(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO workspaces (name, invite_code, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, newInviteCode(), req.user.id],
    );
    await c.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [rows[0].id, req.user.id]);
    return rows[0];
  });
  res.status(201).json({ workspace: { id: ws.id, name: ws.name, role: 'owner', inviteCode: ws.invite_code } });
});

router.get('/:id', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id);
  const [members, projects] = await Promise.all([
    db.query(
      `SELECT u.id, u.name, u.email, u.avatar_color, m.role, m.joined_at,
              (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id
                WHERE p.workspace_id = $1 AND t.assignee_id = u.id AND t.completed_at IS NULL)::int AS open_tasks
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`,
      [ws.id],
    ),
    db.query(
      `SELECT p.id, p.name, p.key, p.description, p.color, p.created_at,
              COUNT(t.id)::int AS task_count,
              COUNT(t.id) FILTER (WHERE t.completed_at IS NOT NULL)::int AS done_count,
              COUNT(t.id) FILTER (WHERE t.completed_at IS NULL AND t.due_date < CURRENT_DATE)::int AS overdue_count
         FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
        WHERE p.workspace_id = $1 GROUP BY p.id ORDER BY p.created_at`,
      [ws.id],
    ),
  ]);
  res.json({
    workspace: {
      id: ws.id, name: ws.name, role: ws.role, createdAt: ws.created_at,
      inviteCode: atLeast(ws.role, 'admin') ? ws.invite_code : null,
    },
    members: members.rows.map((m) => ({
      id: m.id, name: m.name, email: m.email, color: m.avatar_color, role: m.role, joinedAt: m.joined_at, openTasks: m.open_tasks,
    })),
    projects: projects.rows.map((p) => ({
      id: p.id, name: p.name, key: p.key, description: p.description, color: p.color, createdAt: p.created_at,
      taskCount: p.task_count, doneCount: p.done_count, overdueCount: p.overdue_count,
    })),
  });
});

router.patch('/:id', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id, 'admin');
  const { name } = validate(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  await db.query('UPDATE workspaces SET name = $1 WHERE id = $2', [name, ws.id]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id, 'owner');
  await db.query('DELETE FROM workspaces WHERE id = $1', [ws.id]);
  res.status(204).end();
});

router.post('/:id/invite/regenerate', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id, 'admin');
  const code = newInviteCode();
  await db.query('UPDATE workspaces SET invite_code = $1 WHERE id = $2', [code, ws.id]);
  res.json({ inviteCode: code });
});

// Join with an invite code (POST /api/workspaces/join)
router.post('/join', async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const { rows } = await db.query('SELECT * FROM workspaces WHERE invite_code = $1', [code]);
  const ws = rows[0];
  if (!ws) throw new HttpError(404, 'That invite code is not valid', { code: 'Invalid or expired code' });

  const inserted = await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT DO NOTHING RETURNING role`,
    [ws.id, req.user.id],
  );
  if (inserted.rowCount) {
    const admins = await db.query(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role IN ('owner','admin')`, [ws.id]);
    for (const a of admins.rows) {
      notify({ userId: a.user_id, actorId: req.user.id, type: 'joined', title: `${req.user.name} joined ${ws.name}`, link: `/w/${ws.id}` });
    }
  }
  res.json({ workspace: { id: ws.id, name: ws.name }, alreadyMember: inserted.rowCount === 0 });
});

// ---------------------------------------------------------------- members
router.patch('/:id/members/:userId', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id, 'admin');
  const targetId = toId(req.params.userId);
  const { role } = validate(z.object({ role: z.enum(['admin', 'member', 'viewer']) }), req.body);
  if (targetId === req.user.id) throw new HttpError(400, 'You cannot change your own role');
  if (role === 'admin' && ws.role !== 'owner') throw forbidden('Only the owner can make admins');

  const { rows } = await db.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, targetId]);
  if (!rows[0]) throw notFound('Member');
  if (ROLE_RANK[rows[0].role] >= ROLE_RANK[ws.role]) throw forbidden('You cannot change the role of someone at or above your level');

  await db.query('UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3', [role, ws.id, targetId]);
  notify({ userId: targetId, actorId: req.user.id, type: 'role', title: `Your role in ${ws.name} is now ${role}`, link: `/w/${ws.id}` });
  emitToUser(targetId, 'workspace:changed', { workspaceId: ws.id });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', async (req, res) => {
  const targetId = toId(req.params.userId);
  const self = targetId === req.user.id;
  const ws = await requireWorkspace(req.params.id, req.user.id, self ? 'viewer' : 'admin');

  const { rows } = await db.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, targetId]);
  if (!rows[0]) throw notFound('Member');
  if (rows[0].role === 'owner') throw new HttpError(400, 'The owner cannot leave or be removed. Delete the workspace instead.');
  if (!self && ROLE_RANK[rows[0].role] >= ROLE_RANK[ws.role]) throw forbidden('You cannot remove someone at or above your level');

  await db.tx(async (c) => {
    await c.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, targetId]);
    // Unassign their open work so nothing is silently stuck with an ex-member
    await c.query(
      `UPDATE tasks SET assignee_id = NULL, updated_at = NOW()
        WHERE assignee_id = $2 AND project_id IN (SELECT id FROM projects WHERE workspace_id = $1)`,
      [ws.id, targetId],
    );
  });
  emitToUser(targetId, 'workspace:changed', { workspaceId: ws.id, removed: true });
  res.status(204).end();
});

// ---------------------------------------------------------------- projects
const projectSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,5}$/, 'Key must be 2–6 letters/digits, starting with a letter'),
  description: z.string().trim().max(2000).optional().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#6366f1'),
});

router.post('/:id/projects', async (req, res) => {
  const ws = await requireWorkspace(req.params.id, req.user.id, 'member');
  const data = validate(projectSchema, req.body);
  try {
    const project = await db.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO projects (workspace_id, name, key, description, color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [ws.id, data.name, data.key, data.description, data.color, req.user.id],
      );
      const p = rows[0];
      for (const [i, col] of DEFAULT_COLUMNS.entries()) {
        await c.query('INSERT INTO board_columns (project_id, name, position, wip_limit, is_done) VALUES ($1, $2, $3, $4, $5)', [
          p.id, col.name, (i + 1) * 1024, col.wip || null, col.isDone,
        ]);
      }
      for (const [name, color] of DEFAULT_LABELS) {
        await c.query('INSERT INTO labels (project_id, name, color) VALUES ($1, $2, $3)', [p.id, name, color]);
      }
      await logActivity(c, { projectId: p.id, userId: req.user.id, action: 'project_created', details: { name: p.name } });
      return p;
    });
    res.status(201).json({ project: { id: project.id, name: project.name, key: project.key } });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `Key "${data.key}" is already used in this workspace`, { key: 'Already in use' });
    throw err;
  }
});

module.exports = router;
