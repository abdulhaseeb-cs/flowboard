import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { dueState, fmtDue } from '../lib/util.js';
import { Modal, PriorityIcon, Spinner } from '../components/ui.jsx';

export default function Home() {
  const { user, workspaces, refreshWorkspaces } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [myTasks, setMyTasks] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    refreshWorkspaces().catch(() => {});
    api.get('/me/tasks').then((d) => setMyTasks(d.tasks)).catch(() => setMyTasks([]));
  }, [refreshWorkspaces]);

  const createWorkspace = async (e) => {
    e.preventDefault();
    try {
      const { workspace } = await api.post('/workspaces', { name });
      await refreshWorkspaces();
      toast(`Workspace "${workspace.name}" created`);
      navigate(`/w/${workspace.id}`);
    } catch (err) { setError(err); }
  };

  const join = async (e) => {
    e.preventDefault();
    if (code.trim()) navigate(`/join/${code.trim()}`);
  };

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <h1 id="page-title">{greet}, {user.name.split(' ')[0]}</h1>
          <p className="muted">Here's your work across every workspace.</p>
        </div>
        <button className="btn btn-primary" id="new-workspace-btn" type="button" onClick={() => { setShowCreate(true); setError(null); }}>+ New workspace</button>
      </div>

      <div className="home-grid">
        <section>
          <h2 className="section-title">Your workspaces</h2>
          {workspaces.length === 0 ? (
            <div className="card empty-card">
              <strong>No workspaces yet</strong>
              <p className="muted">Create one for your team, or join an existing one with an invite code.</p>
            </div>
          ) : (
            <div className="ws-grid">
              {workspaces.map((w) => (
                <Link key={w.id} to={`/w/${w.id}`} className="card ws-card" data-testid="workspace-card">
                  <span className="ws-chip ws-chip-lg">{w.name[0]?.toUpperCase()}</span>
                  <div>
                    <strong>{w.name}</strong>
                    <span className="muted small">{w.projectCount} project{w.projectCount === 1 ? '' : 's'} · {w.memberCount} member{w.memberCount === 1 ? '' : 's'}</span>
                  </div>
                  <span className={`role-pill role-${w.role}`}>{w.role}</span>
                </Link>
              ))}
            </div>
          )}

          <form className="card join-card" onSubmit={join}>
            <div>
              <strong>Have an invite code?</strong>
              <p className="muted small">Ask a workspace admin for the 8-character code.</p>
            </div>
            <input className="input mono" id="join-code" placeholder="e.g. K7M2QX9P" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={16} />
            <button className="btn" type="submit" id="join-btn">Join</button>
          </form>
        </section>

        <section>
          <h2 className="section-title">Assigned to me</h2>
          <div className="card list-card" id="my-tasks">
            {myTasks === null ? <Spinner /> : myTasks.length === 0 ? (
              <p className="muted empty-inline">Nothing assigned to you. Enjoy the calm ☕</p>
            ) : myTasks.map((t) => {
              const ds = dueState(t.dueDate);
              return (
                <Link key={t.id} to={`/p/${t.project.id}?task=${t.id}`} className="my-task" data-testid="my-task">
                  <PriorityIcon priority={t.priority} />
                  <span className="mono muted small">{t.key}</span>
                  <span className="truncate grow">{t.title}</span>
                  <span className="col-pill">{t.column}</span>
                  {t.dueDate && <span className={`due due-${ds}`}>{fmtDue(t.dueDate)}</span>}
                </Link>
              );
            })}
          </div>
        </section>
      </div>

      {showCreate && (
        <Modal title="Create a workspace" onClose={() => setShowCreate(false)} testId="create-workspace-modal">
          <form onSubmit={createWorkspace} className="modal-body">
            <div className="field">
              <label htmlFor="ws-name">Workspace name</label>
              <input id="ws-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CS Semester Project" autoFocus />
              {error && <span className="field-error">{error.details?.name || error.message}</span>}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" id="create-workspace-submit">Create workspace</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
