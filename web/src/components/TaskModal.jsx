import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { describeAction, fmtDate, fmtSize, PRIORITIES, timeAgo } from '../lib/util.js';
import { Avatar, Modal, PriorityIcon, Spinner } from './ui.jsx';

export default function TaskModal({ taskId, board, canEdit, onClose }) {
  const { socket, user } = useSession();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('comments');
  const reloadTimer = useRef(null);

  const load = useCallback(() => api.get(`/tasks/${taskId}`).then((d) => { setData(d); setError(null); }).catch(setError), [taskId]);
  useEffect(() => { setData(null); load(); }, [load]);

  // Someone else edited this task? Refresh the open modal (debounced).
  useEffect(() => {
    if (!socket) return undefined;
    const schedule = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 250); };
    const onUpsert = (t) => t.id === taskId && schedule();
    const onComment = ({ taskId: id }) => id === taskId && schedule();
    const onDeleted = ({ id }) => { if (id === taskId) { toast('This task was deleted'); onClose(); } };
    socket.on('task:upsert', onUpsert);
    socket.on('comment:new', onComment);
    socket.on('task:deleted', onDeleted);
    return () => {
      clearTimeout(reloadTimer.current);
      socket.off('task:upsert', onUpsert);
      socket.off('comment:new', onComment);
      socket.off('task:deleted', onDeleted);
    };
  }, [socket, taskId, load, onClose, toast]);

  const patch = async (body, msg) => {
    try {
      await api.patch(`/tasks/${taskId}`, body);
      if (msg) toast(msg);
      load();
    } catch (err) { toast(err.message, 'error'); load(); }
  };

  if (error) return <Modal title="Task" onClose={onClose}><div className="modal-body"><p>{error.message}</p></div></Modal>;
  if (!data) return <Modal title="" onClose={onClose}><div className="modal-body"><Spinner /></div></Modal>;

  const { task, checklist, comments, attachments, activity } = data;
  const edit = canEdit && task.canEdit;

  const moveTo = async (columnId) => {
    const count = board.tasks.filter((t) => t.columnId === columnId && t.id !== task.id).length;
    try { await api.post(`/tasks/${task.id}/move`, { columnId, index: count }); load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const toggleLabel = (id) => {
    const next = task.labelIds.includes(id) ? task.labelIds.filter((x) => x !== id) : [...task.labelIds, id];
    patch({ labelIds: next });
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${task.key}? This cannot be undone.`)) return;
    await api.del(`/tasks/${task.id}`);
    toast(`${task.key} deleted`);
    onClose();
  };

  const done = checklist.filter((c) => c.done).length;
  const pct = checklist.length ? Math.round((done / checklist.length) * 100) : 0;

  return (
    <Modal onClose={onClose} wide testId="task-modal">
      <div className="task-modal">
        <div className="task-main">
          <div className="task-top">
            <span className="mono muted" id="task-key">{task.key}</span>
            <span className="muted small">in {task.projectName}</span>
            <span className="grow" />
            <button className="icon-btn" type="button" aria-label="Close" onClick={onClose} id="close-task">✕</button>
          </div>

          <TitleEditor task={task} edit={edit} onSave={(title) => patch({ title })} />
          <DescriptionEditor task={task} edit={edit} onSave={(description) => patch({ description }, 'Description saved')} />

          <section className="task-section">
            <div className="section-row">
              <h3>Checklist</h3>
              {checklist.length > 0 && <span className="muted small" id="checklist-progress">{done}/{checklist.length} · {pct}%</span>}
            </div>
            {checklist.length > 0 && <div className="progress"><span style={{ width: `${pct}%` }} /></div>}
            <ul className="checklist">
              {checklist.map((item) => (
                <li key={item.id} data-testid="checklist-item" className={item.done ? 'checked' : ''}>
                  <label>
                    <input type="checkbox" checked={item.done} disabled={!edit}
                      onChange={async (e) => { await api.patch(`/checklist/${item.id}`, { done: e.target.checked }).catch((er) => toast(er.message, 'error')); load(); }} />
                    <span>{item.text}</span>
                  </label>
                  {edit && <button className="icon-btn icon-btn-sm" type="button" aria-label="Delete item" onClick={async () => { await api.del(`/checklist/${item.id}`); load(); }}>✕</button>}
                </li>
              ))}
            </ul>
            {edit && <ChecklistAdd taskId={task.id} onAdded={load} />}
          </section>

          <section className="task-section">
            <div className="tabs" role="tablist">
              <button role="tab" type="button" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'tab tab-on' : 'tab'} onClick={() => setTab('comments')}>Comments ({comments.length})</button>
              <button role="tab" type="button" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'tab tab-on' : 'tab'} onClick={() => setTab('activity')} id="activity-tab">Activity</button>
            </div>
            {tab === 'comments' ? (
              <>
                <div className="comments" id="comments">
                  {comments.length === 0 && <p className="muted small">No comments yet. Use @firstname to mention a teammate.</p>}
                  {comments.map((c) => (
                    <div key={c.id} className="comment" data-testid="comment">
                      <Avatar user={c.author} size={30} />
                      <div className="comment-main">
                        <div className="comment-head"><strong>{c.author.name}</strong><span className="muted small" title={fmtDate(c.createdAt)}>{timeAgo(c.createdAt)}</span>
                          {(c.author.id === user.id) && edit && <button className="link-btn small" type="button" onClick={async () => { await api.del(`/comments/${c.id}`); load(); }}>Delete</button>}
                        </div>
                        <p className="comment-body">{renderMentions(c.body)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {edit && <CommentBox taskId={task.id} onPosted={load} />}
              </>
            ) : (
              <ul className="timeline" id="timeline">
                {activity.map((a) => (
                  <li key={a.id}><strong>{a.user?.name || 'Someone'}</strong> {describeAction(a)} <time className="muted small">{timeAgo(a.createdAt)}</time></li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="task-side">
          <div className="field"><label htmlFor="task-status">Status</label>
            <select id="task-status" className="input" value={task.columnId} disabled={!edit} onChange={(e) => moveTo(Number(e.target.value))}>
              {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="task-assignee">Assignee</label>
            <select id="task-assignee" className="input" value={task.assignee?.id || ''} disabled={!edit}
              onChange={(e) => patch({ assigneeId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Unassigned</option>
              {board.members.filter((m) => m.role !== 'viewer').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></div>
          <div className="form-row">
            <div className="field grow"><label htmlFor="task-priority">Priority</label>
              <select id="task-priority" className="input" value={task.priority} disabled={!edit} onChange={(e) => patch({ priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></div>
            <div className="field" style={{ width: 84 }}><label htmlFor="task-points">Points</label>
              <input id="task-points" className="input" type="number" min="0" max="100" disabled={!edit} defaultValue={task.storyPoints ?? ''} key={`p${task.storyPoints}`}
                onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== task.storyPoints) patch({ storyPoints: v }); }} /></div>
          </div>
          <div className="field"><label htmlFor="task-due">Due date</label>
            <input id="task-due" className="input" type="date" disabled={!edit} value={task.dueDate || ''} onChange={(e) => patch({ dueDate: e.target.value || null })} /></div>

          <div className="field"><label>Labels</label>
            <div className="label-picker">
              {board.labels.map((l) => (
                <button key={l.id} type="button" disabled={!edit} className={`label-chip label-toggle${task.labelIds.includes(l.id) ? ' on' : ''}`} style={{ '--c': l.color }} onClick={() => toggleLabel(l.id)} data-testid="label-toggle">
                  {l.name}
                </button>
              ))}
            </div></div>

          <dl className="meta-list">
            <div><dt>Reporter</dt><dd className="person-sm"><Avatar user={task.reporter} size={20} /> {task.reporter?.name}</dd></div>
            <div><dt>Created</dt><dd>{fmtDate(task.createdAt)}</dd></div>
            <div><dt>Updated</dt><dd>{timeAgo(task.updatedAt)}</dd></div>
            {task.completedAt && <div><dt>Completed</dt><dd>{fmtDate(task.completedAt)}</dd></div>}
            <div><dt>Priority</dt><dd className="person-sm"><PriorityIcon priority={task.priority} /> {task.priority}</dd></div>
          </dl>

          <div className="field"><label>Attachments</label>
            <ul className="files" id="attachments">
              {attachments.map((a) => (
                <li key={a.id} data-testid="attachment">
                  <button type="button" className="link-btn truncate" onClick={() => api.download(`/attachments/${a.id}/download`, a.name).catch((e) => toast(e.message, 'error'))}>{a.name}</button>
                  <span className="muted small">{fmtSize(a.size)}</span>
                  {edit && <button className="icon-btn icon-btn-sm" type="button" aria-label="Delete file" onClick={async () => { await api.del(`/attachments/${a.id}`); load(); }}>✕</button>}
                </li>
              ))}
              {!attachments.length && <li className="muted small">No files</li>}
            </ul>
            {edit && (
              <label className="btn btn-ghost btn-sm upload-btn">
                Upload file
                <input type="file" id="file-input" hidden accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.zip"
                  onChange={async (e) => {
                    const f = e.target.files[0];
                    e.target.value = '';
                    if (!f) return;
                    try { await api.upload(`/tasks/${task.id}/attachments`, f); toast('File uploaded'); load(); }
                    catch (err) { toast(err.message, 'error'); }
                  }} />
              </label>
            )}
          </div>

          {edit && <button className="btn btn-danger btn-sm btn-block" type="button" id="delete-task" onClick={remove}>Delete task</button>}
        </aside>
      </div>
    </Modal>
  );
}

const renderMentions = (text) =>
  text.split(/(@[\p{L}\p{N}._-]+)/u).map((part, i) => (part.startsWith('@') ? <span key={i} className="mention">{part}</span> : part));

function TitleEditor({ task, edit, onSave }) {
  const [value, setValue] = useState(task.title);
  useEffect(() => setValue(task.title), [task.title]);
  if (!edit) return <h2 className="task-title" id="task-title">{task.title}</h2>;
  return (
    <textarea
      className="task-title task-title-input" id="task-title-input" rows={1} value={value} maxLength={200} aria-label="Task title"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      onBlur={() => { const v = value.trim(); if (v && v !== task.title) onSave(v); else setValue(task.title); }}
    />
  );
}

function DescriptionEditor({ task, edit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.description);
  useEffect(() => { if (!editing) setValue(task.description); }, [task.description, editing]);

  if (editing) {
    return (
      <section className="task-section">
        <h3>Description</h3>
        <textarea className="input" rows={6} autoFocus value={value} onChange={(e) => setValue(e.target.value)} id="description-input" />
        <div className="row gap" style={{ marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" type="button" id="save-description" onClick={() => { onSave(value); setEditing(false); }}>Save</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </section>
    );
  }
  return (
    <section className="task-section">
      <h3>Description</h3>
      <div className={`description${edit ? ' description-edit' : ''}`} id="task-description"
        onClick={() => edit && setEditing(true)} role={edit ? 'button' : undefined} tabIndex={edit ? 0 : undefined}
        onKeyDown={(e) => edit && e.key === 'Enter' && setEditing(true)}>
        {task.description || <span className="muted">{edit ? 'Add a more detailed description…' : 'No description'}</span>}
      </div>
    </section>
  );
}

function ChecklistAdd({ taskId, onAdded }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await api.post(`/tasks/${taskId}/checklist`, { text: text.trim() }); setText(''); onAdded(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <form className="row gap" onSubmit={submit}>
      <input className="input input-sm grow" id="checklist-input" placeholder="Add an item…" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn-sm" type="submit" id="checklist-add">Add</button>
    </form>
  );
}

function CommentBox({ taskId, onPosted }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try { await api.post(`/tasks/${taskId}/comments`, { body }); setBody(''); onPosted(); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <form className="comment-box" onSubmit={submit}>
      <textarea className="input" rows={2} id="comment-input" placeholder="Write a comment… use @name to mention" value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }} />
      <div className="row gap right"><span className="muted small">Ctrl+Enter to send</span>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy} id="comment-submit">Comment</button></div>
    </form>
  );
}
