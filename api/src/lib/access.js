// Authorisation helpers. Every resource belongs to a workspace; your role in
// that workspace decides what you may do:
//   viewer < member < admin < owner
const db = require('./db');
const { notFound, forbidden } = require('./errors');

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (role, min) => ROLE_RANK[role] >= ROLE_RANK[min];

function check(row, min, what) {
  // Non-members get 404 (not 403) so they can't even learn the resource exists.
  if (!row || !row.role) throw notFound(what);
  if (!atLeast(row.role, min)) {
    throw forbidden(min === 'member' ? 'Viewers have read-only access' : `Only workspace ${min}s can do this`);
  }
  return row;
}

const toId = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

async function requireWorkspace(workspaceId, userId, min = 'viewer') {
  const { rows } = await db.query(
    `SELECT w.*, m.role FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
      WHERE w.id = $1`,
    [toId(workspaceId), userId],
  );
  return check(rows[0], min, 'Workspace');
}

async function requireProject(projectId, userId, min = 'viewer') {
  const { rows } = await db.query(
    `SELECT p.*, m.role, w.name AS workspace_name FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.id = $1`,
    [toId(projectId), userId],
  );
  return check(rows[0], min, 'Project');
}

async function requireColumn(columnId, userId, min = 'viewer') {
  const { rows } = await db.query(
    `SELECT c.*, p.workspace_id, m.role FROM board_columns c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE c.id = $1`,
    [toId(columnId), userId],
  );
  return check(rows[0], min, 'Column');
}

async function requireTask(taskId, userId, min = 'viewer') {
  const { rows } = await db.query(
    `SELECT t.*, p.key AS project_key, p.workspace_id, p.name AS project_name, m.role FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE t.id = $1`,
    [toId(taskId), userId],
  );
  return check(rows[0], min, 'Task');
}

/** Is userId a member of the workspace? (used to validate assignees) */
async function isMember(workspaceId, userId) {
  const { rowCount } = await db.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    workspaceId,
    userId,
  ]);
  return rowCount > 0;
}

module.exports = { ROLE_RANK, atLeast, toId, requireWorkspace, requireProject, requireColumn, requireTask, isMember };
