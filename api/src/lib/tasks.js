// Shared task queries + the fractional-indexing ordering algorithm.
const db = require('./db');

// One row per task with everything a board card needs (no N+1 queries on the client)
const SUMMARY_SQL = `
  SELECT t.id, t.project_id, t.column_id, t.number, t.title, t.priority, t.assignee_id,
         t.due_date, t.story_points, t.position, t.completed_at, t.created_at, t.updated_at,
         p.key AS project_key, u.name AS assignee_name, u.avatar_color AS assignee_color,
         COALESCE((SELECT json_agg(tl.label_id ORDER BY tl.label_id) FROM task_labels tl WHERE tl.task_id = t.id), '[]') AS label_ids,
         (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id)::int AS checklist_total,
         (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id AND c.done)::int AS checklist_done,
         (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id)::int AS comment_count,
         (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id)::int AS attachment_count
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id`;

const toSummary = (r) => ({
  id: r.id,
  projectId: r.project_id,
  columnId: r.column_id,
  key: `${r.project_key}-${r.number}`,
  number: r.number,
  title: r.title,
  priority: r.priority,
  assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name, color: r.assignee_color } : null,
  dueDate: r.due_date,
  storyPoints: r.story_points,
  position: r.position,
  completedAt: r.completed_at,
  labelIds: r.label_ids,
  checklist: { done: r.checklist_done, total: r.checklist_total },
  commentCount: r.comment_count,
  attachmentCount: r.attachment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function fetchSummary(taskId, client = db) {
  const { rows } = await client.query(`${SUMMARY_SQL} WHERE t.id = $1`, [taskId]);
  return rows[0] ? toSummary(rows[0]) : null;
}

async function fetchProjectSummaries(projectId) {
  const { rows } = await db.query(`${SUMMARY_SQL} WHERE t.project_id = $1 ORDER BY t.column_id, t.position`, [projectId]);
  return rows.map(toSummary);
}

const GAP = 1024;
const MIN_GAP = 1e-6;

/**
 * Fractional indexing: to put an item at `index` we give it a position halfway
 * between its new neighbours, so only ONE row is updated per move. When the gap
 * between two neighbours gets too small (after many moves into the same spot)
 * the whole column is renumbered 1024, 2048, 3072 ... ("rebalancing").
 *
 * Returns { position, rebalanced }.
 */
async function positionAt(client, { table, scopeColumn, scopeId, index, excludeId }) {
  const load = () =>
    client.query(
      `SELECT id, position FROM ${table} WHERE ${scopeColumn} = $1 AND id <> $2 ORDER BY position FOR UPDATE`,
      [scopeId, excludeId || 0],
    );
  let { rows } = await load();
  const i = Math.max(0, Math.min(index ?? rows.length, rows.length));
  const prev = rows[i - 1]?.position;
  const next = rows[i]?.position;

  if (prev === undefined && next === undefined) return { position: GAP, rebalanced: false };
  if (prev === undefined) return { position: next - GAP, rebalanced: false };
  if (next === undefined) return { position: prev + GAP, rebalanced: false };
  if (next - prev > MIN_GAP) return { position: (prev + next) / 2, rebalanced: false };

  // Gap exhausted -> renumber the scope, leaving a hole at i
  for (let k = 0; k < rows.length; k++) {
    const pos = (k < i ? k + 1 : k + 2) * GAP;
    await client.query(`UPDATE ${table} SET position = $1 WHERE id = $2`, [pos, rows[k].id]);
  }
  return { position: (i + 1) * GAP, rebalanced: true };
}

module.exports = { SUMMARY_SQL, toSummary, fetchSummary, fetchProjectSummaries, positionAt };
