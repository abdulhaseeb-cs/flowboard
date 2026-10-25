// Activity log + notifications, shared by the routes and the background worker.
const db = require('./db');
const { emitToUser } = require('./realtime');

/** Append to the project's audit trail. Pass a transaction client when inside db.tx(). */
function logActivity(client, { projectId, taskId = null, userId, action, details = {} }) {
  return (client || db).query(
    'INSERT INTO activity (project_id, task_id, user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
    [projectId, taskId, userId, action, details],
  );
}

/**
 * Store a notification and push it instantly to the user's open browser tabs.
 * Called AFTER the main transaction commits so we never notify about a change
 * that was rolled back. Never notifies you about your own actions.
 */
async function notify({ userId, actorId = null, type, title, body = '', link = '' }, emit = emitToUser) {
  if (!userId || userId === actorId) return null;
  const { rows } = await db.query(
    `WITH n AS (
       INSERT INTO notifications (user_id, actor_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *)
     SELECT n.*, a.name AS actor_name, a.avatar_color AS actor_color
       FROM n LEFT JOIN users a ON a.id = n.actor_id`,
    [userId, actorId, type, title, body, link],
  );
  const n = toNotification(rows[0]);
  emit(userId, 'notification', n);
  return n;
}

const toNotification = (r) => ({
  id: Number(r.id),
  type: r.type,
  title: r.title,
  body: r.body,
  link: r.link,
  read: !!r.read_at,
  createdAt: r.created_at,
  actor: r.actor_name ? { id: r.actor_id, name: r.actor_name, color: r.actor_color } : null,
});

module.exports = { logActivity, notify, toNotification };
