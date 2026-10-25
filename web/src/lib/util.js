export const initials = (name = '?') =>
  name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(date).toLocaleDateString();
}

export const fmtDate = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const today = () => new Date().toISOString().slice(0, 10);

/** "overdue" | "today" | "soon" | "later" | null for a YYYY-MM-DD due date */
export function dueState(due, completed) {
  if (!due || completed) return null;
  const t = today();
  if (due < t) return 'overdue';
  if (due === t) return 'today';
  const diff = (new Date(due) - new Date(t)) / 86400000;
  return diff <= 3 ? 'soon' : 'later';
}

export const fmtDue = (due) =>
  new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const ROLES = ['owner', 'admin', 'member', 'viewer'];
export const PROJECT_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#475569'];
export const LABEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

export const ACTION_TEXT = {
  project_created: () => 'created the project',
  task_created: (d) => `created the task${d.column ? ` in ${d.column}` : ''}`,
  task_moved: (d) => `moved it from ${d.from} to ${d.to}`,
  task_deleted: (d) => `deleted ${d.key} "${d.title}"`,
  field_changed: (d) => {
    const name = { title: 'title', priority: 'priority', assignee_id: 'assignee', due_date: 'due date', story_points: 'story points' }[d.field] || d.field;
    if (d.field === 'assignee_id') return d.to ? 'changed the assignee' : 'removed the assignee';
    if (d.field === 'title') return `renamed it to "${d.to}"`;
    return `set ${name} to ${d.to ?? 'none'}`;
  },
  description_edited: () => 'edited the description',
  commented: () => 'commented',
  checklist_done: (d) => `completed "${d.text}"`,
  checklist_undone: (d) => `reopened "${d.text}"`,
  attachment_added: (d) => `attached ${d.name}`,
};
export const describeAction = (a) => (ACTION_TEXT[a.action] || (() => a.action.replace(/_/g, ' ')))(a.details || {});
