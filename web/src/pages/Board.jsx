import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { dueState, fmtDue, PRIORITIES } from '../lib/util.js';
import { Avatar, ErrorState, Modal, PriorityIcon, Spinner } from '../components/ui.jsx';
import TaskModal from '../components/TaskModal.jsx';

const DRAG_THRESHOLD = 5;
const byPosition = (a, b) => a.position - b.position;

// Same fractional-indexing rule as the server, so the optimistic UI matches
function positionBetween(prev, next) {
  if (prev === undefined && next === undefined) return 1024;
  if (prev === undefined) return next - 1024;
  if (next === undefined) return prev + 1024;
  return (prev + next) / 2;
}

export default function Board() {
  const { id } = useParams();
  const projectId = Number(id);
  const [params, setParams] = useSearchParams();
  const openTaskId = Number(params.get('task')) || null;
  const { user, socket } = useSession();
  const toast = useToast();
  const navigate = useNavigate();

  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [presence, setPresence] = useState([]);
  const [flash, setFlash] = useState({});
  const [filters, setFilters] = useState({ q: '', assignee: '', priority: '', label: '' });
  const [drag, setDrag] = useState(null);
  const [editColumn, setEditColumn] = useState(null);
  const [addingColumn, setAddingColumn] = useState(false);

  const dragRef = useRef(null);
  const bodiesRef = useRef(new Map());
  const scrollerRef = useRef(null);

  const load = useCallback(
    () => api.get(`/projects/${projectId}`).then((b) => { setBoard(b); setError(null); }).catch(setError),
    [projectId],
  );
  useEffect(() => { setBoard(null); load(); }, [load]);

  const canEdit = board && board.project.role !== 'viewer';
  const isAdmin = board && ['owner', 'admin'].includes(board.project.role);

  // ------------------------------------------------------------ real-time
  useEffect(() => {
    if (!socket) return undefined;
    const join = () => socket.emit('board:join', { projectId }, (ack) => ack && !ack.ok && toast(ack.error, 'error'));
    const flashCard = (taskId) => {
      setFlash((f) => ({ ...f, [taskId]: true }));
      setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[taskId]; return n; }), 1600);
    };
    const onUpsert = (task) => {
      if (task.projectId !== projectId) return;
      setBoard((b) => {
        if (!b) return b;
        const exists = b.tasks.some((t) => t.id === task.id);
        return { ...b, tasks: exists ? b.tasks.map((t) => (t.id === task.id ? task : t)) : [...b.tasks, task] };
      });
      if (dragRef.current?.taskId !== task.id) flashCard(task.id);
    };
    const onDeleted = ({ id: taskId }) => setBoard((b) => (b ? { ...b, tasks: b.tasks.filter((t) => t.id !== taskId) } : b));
    const onRefresh = ({ projectId: pid }) => pid === projectId && load();
    const onPresence = ({ room, users }) => room === `project:${projectId}` && setPresence(users);
    const onProjectDeleted = ({ projectId: pid }) => {
      if (pid !== projectId) return;
      toast('This project was deleted', 'error');
      navigate('/');
    };
    const onReconnect = () => { join(); load(); }; // catch up on anything missed while offline

    if (socket.connected) join();
    socket.on('connect', onReconnect);
    socket.on('task:upsert', onUpsert);
    socket.on('task:deleted', onDeleted);
    socket.on('board:refresh', onRefresh);
    socket.on('presence', onPresence);
    socket.on('project:deleted', onProjectDeleted);
    return () => {
      socket.emit('board:leave', { projectId });
      socket.off('connect', onReconnect);
      socket.off('task:upsert', onUpsert);
      socket.off('task:deleted', onDeleted);
      socket.off('board:refresh', onRefresh);
      socket.off('presence', onPresence);
      socket.off('project:deleted', onProjectDeleted);
    };
  }, [socket, projectId, load, toast, navigate]);

  // ------------------------------------------------------------ filtering
  const matches = useCallback((t) => {
    const { q, assignee, priority, label } = filters;
    if (q) {
      const s = q.toLowerCase();
      if (!t.title.toLowerCase().includes(s) && !t.key.toLowerCase().includes(s)) return false;
    }
    if (assignee === 'me' && t.assignee?.id !== user.id) return false;
    if (assignee === 'none' && t.assignee) return false;
    if (assignee && !['me', 'none'].includes(assignee) && String(t.assignee?.id) !== assignee) return false;
    if (priority && t.priority !== priority) return false;
    if (label && !t.labelIds.includes(Number(label))) return false;
    return true;
  }, [filters, user.id]);

  const columnsTasks = useMemo(() => {
    const map = new Map();
    if (!board) return map;
    for (const c of board.columns) map.set(c.id, { all: [], visible: [] });
    for (const t of [...board.tasks].sort(byPosition)) {
      const entry = map.get(t.columnId);
      if (!entry) continue;
      entry.all.push(t);
      if (matches(t)) entry.visible.push(t);
    }
    return map;
  }, [board, matches]);

  const filtering = Object.values(filters).some(Boolean);
  const labelsById = useMemo(() => new Map((board?.labels || []).map((l) => [l.id, l])), [board]);

  // ------------------------------------------------------------ drag & drop (pointer events)
  const computeOver = useCallback((x, y) => {
    for (const [colId, el] of bodiesRef.current) {
      const r = el.parentElement.getBoundingClientRect(); // whole column, incl. header
      if (x >= r.left && x <= r.right) {
        const cards = [...el.querySelectorAll('.task-card[data-task-id]')];
        let index = 0;
        for (const c of cards) {
          const cr = c.getBoundingClientRect();
          if (y > cr.top + cr.height / 2) index++;
        }
        return { overCol: colId, overIndex: index };
      }
    }
    return null;
  }, []);

  const finishDrop = useCallback(async (d) => {
    const task = board.tasks.find((t) => t.id === d.taskId);
    const column = board.columns.find((c) => c.id === d.overCol);
    if (!task || !column) return;
    const { all, visible } = columnsTasks.get(column.id);
    const full = all.filter((t) => t.id !== task.id);
    const vis = visible.filter((t) => t.id !== task.id);

    // Translate "index among VISIBLE cards" into "index among ALL cards" (filters may hide some)
    let index;
    if (d.overIndex < vis.length) index = full.findIndex((t) => t.id === vis[d.overIndex].id);
    else if (vis.length) index = full.findIndex((t) => t.id === vis[vis.length - 1].id) + 1;
    else index = full.length;

    if (column.id === task.columnId && index === all.findIndex((t) => t.id === task.id)) return; // dropped where it was
    if (column.id !== task.columnId && column.wipLimit && full.length >= column.wipLimit) {
      toast(`WIP limit reached: "${column.name}" allows ${column.wipLimit} task(s)`, 'error');
      return;
    }

    const optimistic = { ...task, columnId: column.id, position: positionBetween(full[index - 1]?.position, full[index]?.position) };
    setBoard((b) => ({ ...b, tasks: b.tasks.map((t) => (t.id === task.id ? optimistic : t)) }));
    try {
      const { task: saved } = await api.post(`/tasks/${task.id}/move`, { columnId: column.id, index });
      setBoard((b) => ({ ...b, tasks: b.tasks.map((t) => (t.id === saved.id ? saved : t)) }));
    } catch (err) {
      toast(err.message, 'error');
      load();
    }
  }, [board, columnsTasks, toast, load]);

  const onPointerDown = (e, task) => {
    if (!canEdit || e.button !== 0 || e.target.closest('button, a, input, select')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const colEntry = columnsTasks.get(task.columnId);
    dragRef.current = {
      taskId: task.id, startX: e.clientX, startY: e.clientY, started: false,
      offX: e.clientX - rect.left, offY: e.clientY - rect.top, w: rect.width, h: rect.height,
      overCol: task.columnId, overIndex: colEntry.visible.findIndex((t) => t.id === task.id),
    };

    const move = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.started = true;
        document.body.classList.add('dragging');
      }
      const over = computeOver(ev.clientX, ev.clientY);
      if (over) Object.assign(d, over);
      // auto-scroll the board horizontally near the edges
      const sc = scrollerRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientX > r.right - 60) sc.scrollLeft += 14;
        else if (ev.clientX < r.left + 60) sc.scrollLeft -= 14;
      }
      setDrag({ ...d, x: ev.clientX, y: ev.clientY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging');
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (d.started) finishDrop(d);
      else setParams((p) => { p.set('task', task.id); return p; }); // simple click => open
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const openTask = (taskId) => setParams((p) => { p.set('task', taskId); return p; });
  const closeTask = useCallback(() => setParams((p) => { p.delete('task'); return p; }), [setParams]);

  // ------------------------------------------------------------ render
  if (error) return <ErrorState error={error}><Link className="btn" to="/">Back home</Link></ErrorState>;
  if (!board) return <div className="page-pad"><Spinner /></div>;

  const { project, columns, members, labels } = board;
  const draggedTask = drag?.started ? board.tasks.find((t) => t.id === drag.taskId) : null;

  return (
    <div className="board-page">
      <div className="board-head">
        <div>
          <div className="crumbs"><Link to={`/w/${project.workspaceId}`}>{project.workspaceName}</Link> / {project.key}</div>
          <h1 id="page-title"><span className="project-dot" style={{ background: project.color }} />{project.name}</h1>
        </div>
        <div className="board-head-right">
          <div className="presence" id="presence" aria-label="People viewing this board">
            <span className="muted small">Viewing now</span>
            <div className="avatar-stack">
              {presence.map((u) => <Avatar key={u.id} user={u} size={28} ring title={`${u.name} is viewing`} />)}
            </div>
          </div>
          <Link className="btn btn-ghost" to={`/p/${project.id}/analytics`} id="analytics-link">Analytics</Link>
        </div>
      </div>

      <div className="toolbar" role="search">
        <input className="input input-sm search" id="filter-q" placeholder="Search tasks or keys…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
        <div className="assignee-filter" aria-label="Filter by assignee">
          <button type="button" className={`chip${filters.assignee === 'me' ? ' chip-on' : ''}`} id="filter-mine" onClick={() => setFilters((f) => ({ ...f, assignee: f.assignee === 'me' ? '' : 'me' }))}>Only mine</button>
          {members.slice(0, 8).map((m) => (
            <button key={m.id} type="button" className={`avatar-btn${filters.assignee === String(m.id) ? ' avatar-btn-on' : ''}`} title={m.name}
              onClick={() => setFilters((f) => ({ ...f, assignee: f.assignee === String(m.id) ? '' : String(m.id) }))}>
              <Avatar user={m} size={26} />
            </button>
          ))}
        </div>
        <select className="input input-sm" id="filter-priority" value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input input-sm" id="filter-label" value={filters.label} onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}>
          <option value="">Any label</option>
          {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {filtering && <button className="link-btn" type="button" onClick={() => setFilters({ q: '', assignee: '', priority: '', label: '' })}>Clear filters</button>}
        {!canEdit && <span className="role-pill role-viewer">read-only</span>}
      </div>

      <div className="board" ref={scrollerRef} id="board">
        {columns.map((col) => {
          const { all, visible } = columnsTasks.get(col.id);
          const cards = visible.filter((t) => !(drag?.started && t.id === drag.taskId));
          const showPlaceholder = drag?.started && drag.overCol === col.id;
          const overLimit = col.wipLimit && all.length >= col.wipLimit;
          const items = cards.map((t) => ({ type: 'task', t }));
          if (showPlaceholder) items.splice(Math.min(drag.overIndex, items.length), 0, { type: 'placeholder' });

          return (
            <section key={col.id} className={`column${showPlaceholder ? ' column-over' : ''}${col.isDone ? ' column-done' : ''}`} data-column-id={col.id} data-column-name={col.name} data-testid="column">
              <header className="column-head">
                <span className="column-name">{col.name}</span>
                <span className={`count${overLimit ? ' count-limit' : ''}`} data-testid="column-count" title={col.wipLimit ? `WIP limit ${col.wipLimit}` : undefined}>
                  {filtering ? `${visible.length}/` : ''}{all.length}{col.wipLimit ? ` / ${col.wipLimit}` : ''}
                </span>
                {col.isDone && <span className="done-tag" title="Tasks here count as completed">✓</span>}
                {canEdit && <button className="icon-btn icon-btn-sm" type="button" aria-label={`Column settings for ${col.name}`} onClick={() => setEditColumn(col)}>⋯</button>}
              </header>
              <div className="column-body" ref={(el) => (el ? bodiesRef.current.set(col.id, el) : bodiesRef.current.delete(col.id))}>
                {items.map((it) =>
                  it.type === 'placeholder' ? (
                    <div key="ph" className="card-placeholder" style={{ height: drag.h }} />
                  ) : (
                    <TaskCard key={it.t.id} task={it.t} labelsById={labelsById} flash={flash[it.t.id]} onPointerDown={onPointerDown} onOpen={openTask} />
                  ),
                )}
                {!items.length && <div className="column-empty">{filtering ? 'No matching tasks' : 'Drop tasks here'}</div>}
              </div>
              {canEdit && <QuickAdd projectId={project.id} column={col} full={overLimit} />}
            </section>
          );
        })}

        {canEdit && (
          <div className="column column-add">
            {addingColumn ? (
              <AddColumn projectId={project.id} onDone={() => setAddingColumn(false)} />
            ) : (
              <button className="add-column-btn" type="button" id="add-column-btn" onClick={() => setAddingColumn(true)}>+ Add column</button>
            )}
          </div>
        )}
      </div>

      {draggedTask && (
        <div className="drag-ghost" style={{ width: drag.w, transform: `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) rotate(2deg)` }}>
          <TaskCard task={draggedTask} labelsById={labelsById} ghost />
        </div>
      )}

      {openTaskId && (
        <TaskModal taskId={openTaskId} board={board} canEdit={canEdit} onClose={closeTask} />
      )}
      {editColumn && (
        <ColumnSettings column={editColumn} columns={columns} isAdmin={isAdmin} count={columnsTasks.get(editColumn.id)?.all.length || 0} onClose={() => setEditColumn(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- card
function TaskCard({ task, labelsById, flash, onPointerDown, onOpen, ghost }) {
  const ds = dueState(task.dueDate, task.completedAt);
  return (
    <article
      className={`task-card${flash ? ' task-flash' : ''}${ghost ? ' task-ghost' : ''}${task.completedAt ? ' task-done' : ''}`}
      data-task-id={ghost ? undefined : task.id}
      data-testid={ghost ? undefined : 'task-card'}
      data-task-key={task.key}
      onPointerDown={onPointerDown ? (e) => onPointerDown(e, task) : undefined}
      onKeyDown={onOpen ? (e) => e.key === 'Enter' && onOpen(task.id) : undefined}
      tabIndex={ghost ? -1 : 0}
      aria-label={`${task.key} ${task.title}`}
    >
      {task.labelIds.length > 0 && (
        <div className="card-labels">
          {task.labelIds.map((id) => labelsById.get(id)).filter(Boolean).map((l) => (
            <span key={l.id} className="label-chip" style={{ '--c': l.color }}>{l.name}</span>
          ))}
        </div>
      )}
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <PriorityIcon priority={task.priority} />
        <span className="card-key">{task.key}</span>
        {task.storyPoints != null && <span className="points" title="Story points">{task.storyPoints}</span>}
        {task.checklist.total > 0 && (
          <span className={`meta-item${task.checklist.done === task.checklist.total ? ' meta-ok' : ''}`} title="Checklist" data-testid="card-checklist">
            ☑ {task.checklist.done}/{task.checklist.total}
          </span>
        )}
        {task.commentCount > 0 && <span className="meta-item" title="Comments">💬 {task.commentCount}</span>}
        {task.attachmentCount > 0 && <span className="meta-item" title="Attachments">📎 {task.attachmentCount}</span>}
        {task.dueDate && <span className={`due due-${ds || 'done'}`} title="Due date">{fmtDue(task.dueDate)}</span>}
        <span className="grow" />
        <Avatar user={task.assignee} size={24} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- quick add
function QuickAdd({ projectId, column, full }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/tasks`, { title: title.trim(), columnId: column.id });
      setTitle(''); // the new card arrives through the socket 'task:upsert' event
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="quick-add-btn" type="button" disabled={full} title={full ? 'WIP limit reached' : undefined} data-testid="quick-add-btn" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  }
  return (
    <form className="quick-add" onSubmit={submit}>
      <textarea
        className="input" rows={2} autoFocus placeholder="What needs to be done?" value={title} maxLength={200}
        data-testid="quick-add-input"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <div className="row gap">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy} data-testid="quick-add-submit">Add</button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function AddColumn({ projectId, onDone }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api.post(`/projects/${projectId}/columns`, { name }); onDone(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <form className="quick-add" onSubmit={submit}>
      <input className="input" autoFocus placeholder="Column name" value={name} onChange={(e) => setName(e.target.value)} id="new-column-name" maxLength={40} />
      <div className="row gap">
        <button className="btn btn-primary btn-sm" type="submit">Add column</button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- column settings
function ColumnSettings({ column, columns, isAdmin, count, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: column.name, wipLimit: column.wipLimit ?? '', isDone: column.isDone });
  const others = columns.filter((c) => c.id !== column.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id || '');
  const idx = columns.findIndex((c) => c.id === column.id);

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/columns/${column.id}`, { name: form.name, wipLimit: form.wipLimit === '' ? null : Number(form.wipLimit), isDone: form.isDone });
      toast('Column updated');
      onClose();
    } catch (err) { toast(err.message, 'error'); }
  };
  const moveColumn = async (delta) => {
    try { await api.patch(`/columns/${column.id}`, { index: idx + delta }); onClose(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete column "${column.name}"?`)) return;
    try { await api.del(`/columns/${column.id}${count ? `?moveTo=${moveTo}` : ''}`); toast('Column deleted'); onClose(); }
    catch (err) { toast(err.message, 'error'); }
  };

  return (
    <Modal title="Column settings" onClose={onClose} testId="column-settings">
      <form className="modal-body" onSubmit={save}>
        <div className="field"><label htmlFor="col-name">Name</label>
          <input id="col-name" className="input" value={form.name} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
        <div className="field"><label htmlFor="col-wip">WIP limit <span className="muted">(max tasks allowed, empty = no limit)</span></label>
          <input id="col-wip" className="input" type="number" min="1" max="999" value={form.wipLimit} onChange={(e) => setForm((f) => ({ ...f, wipLimit: e.target.value }))} /></div>
        <label className="check"><input type="checkbox" checked={form.isDone} onChange={(e) => setForm((f) => ({ ...f, isDone: e.target.checked }))} /> Tasks in this column count as <b>completed</b></label>
        <div className="row gap" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={idx === 0} onClick={() => moveColumn(-1)}>← Move left</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={idx === columns.length - 1} onClick={() => moveColumn(1)}>Move right →</button>
        </div>
        {isAdmin && others.length > 0 && (
          <div className="danger-zone">
            {count > 0 && (
              <div className="field"><label htmlFor="col-move">Move its {count} task(s) to</label>
                <select id="col-move" className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                  {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
            )}
            <button type="button" className="btn btn-danger btn-sm" onClick={remove}>Delete column</button>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" id="save-column">Save</button>
        </div>
      </form>
    </Modal>
  );
}
