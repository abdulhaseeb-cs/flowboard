import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { PROJECT_COLORS, timeAgo } from '../lib/util.js';
import { Avatar, ErrorState, Modal, Spinner } from '../components/ui.jsx';

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const suggestKey = (name) => {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || '').slice(0, 4);
  return key.replace(/^[0-9]+/, '').slice(0, 6);
};

export default function WorkspacePage() {
  const { id } = useParams();
  const { user, refreshWorkspaces } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => api.get(`/workspaces/${id}`).then(setData).catch(setError), [id]);
  useEffect(() => { setData(null); setError(null); load(); }, [load]);

  if (error) return <ErrorState error={error}><Link className="btn" to="/">Back home</Link></ErrorState>;
  if (!data) return <div className="page-pad"><Spinner /></div>;

  const { workspace: ws, members, projects } = data;
  const isAdmin = RANK[ws.role] >= RANK.admin;
  const canEdit = RANK[ws.role] >= RANK.member;
  const inviteLink = ws.inviteCode ? `${window.location.origin}/join/${ws.inviteCode}` : '';

  const changeRole = async (m, role) => {
    try { await api.patch(`/workspaces/${ws.id}/members/${m.id}`, { role }); toast(`${m.name} is now ${role}`); load(); }
    catch (err) { toast(err.message, 'error'); load(); }
  };
  const removeMember = async (m) => {
    const self = m.id === user.id;
    if (!window.confirm(self ? `Leave ${ws.name}?` : `Remove ${m.name} from ${ws.name}?`)) return;
    try {
      await api.del(`/workspaces/${ws.id}/members/${m.id}`);
      if (self) { await refreshWorkspaces(); navigate('/'); toast(`You left ${ws.name}`); }
      else { toast(`${m.name} removed`); load(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  const regenerate = async () => {
    if (!window.confirm('Generate a new invite code? The old one will stop working.')) return;
    const { inviteCode } = await api.post(`/workspaces/${ws.id}/invite/regenerate`);
    setData((d) => ({ ...d, workspace: { ...d.workspace, inviteCode } }));
    toast('New invite code generated');
  };
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => {});
  const deleteWorkspace = async () => {
    if (window.prompt(`Type the workspace name to delete it permanently:\n${ws.name}`) !== ws.name) return;
    await api.del(`/workspaces/${ws.id}`);
    await refreshWorkspaces();
    toast('Workspace deleted');
    navigate('/');
  };

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/">Home</Link> / Workspace</div>
          <h1 id="page-title">{ws.name}</h1>
          <p className="muted">You are <span className={`role-pill role-${ws.role}`} id="my-role">{ws.role}</span> · {members.length} member{members.length === 1 ? '' : 's'} · {projects.length} project{projects.length === 1 ? '' : 's'}</p>
        </div>
        {canEdit && <button className="btn btn-primary" id="new-project-btn" type="button" onClick={() => setShowNew(true)}>+ New project</button>}
      </div>

      <h2 className="section-title">Projects</h2>
      {projects.length === 0 ? (
        <div className="card empty-card"><strong>No projects yet</strong><p className="muted">Create a project to get a Kanban board with To Do, In Progress, Review and Done columns.</p></div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => {
            const pct = p.taskCount ? Math.round((p.doneCount / p.taskCount) * 100) : 0;
            return (
              <Link key={p.id} to={`/p/${p.id}`} className="card project-card" data-testid="project-card" style={{ '--accent': p.color }}>
                <div className="project-top">
                  <span className="project-key">{p.key}</span>
                  {p.overdueCount > 0 && <span className="due due-overdue">{p.overdueCount} overdue</span>}
                </div>
                <strong className="project-name">{p.name}</strong>
                <p className="muted small clamp-2">{p.description || 'No description'}</p>
                <div className="progress" aria-label={`${pct}% complete`}><span style={{ width: `${pct}%` }} /></div>
                <span className="muted small">{p.doneCount}/{p.taskCount} tasks done · {pct}%</span>
              </Link>
            );
          })}
        </div>
      )}

      <div className="ws-bottom">
        <section className="card">
          <div className="card-head"><h2>Members</h2></div>
          <table className="table" id="members-table">
            <thead><tr><th>Name</th><th className="hide-sm">Open tasks</th><th className="hide-sm">Joined</th><th>Role</th><th /></tr></thead>
            <tbody>
              {members.map((m) => {
                const editable = isAdmin && m.id !== user.id && RANK[m.role] < RANK[ws.role];
                return (
                  <tr key={m.id} data-testid="member-row">
                    <td><div className="person"><Avatar user={m} size={30} /><div><strong>{m.name}{m.id === user.id && ' (you)'}</strong><span className="muted small">{m.email}</span></div></div></td>
                    <td className="hide-sm">{m.openTasks}</td>
                    <td className="hide-sm muted small">{timeAgo(m.joinedAt)}</td>
                    <td>
                      {editable ? (
                        <select className="input input-sm" value={m.role} onChange={(e) => changeRole(m, e.target.value)} aria-label={`Role for ${m.name}`}>
                          {ws.role === 'owner' && <option value="admin">admin</option>}
                          <option value="member">member</option>
                          <option value="viewer">viewer</option>
                        </select>
                      ) : <span className={`role-pill role-${m.role}`}>{m.role}</span>}
                    </td>
                    <td className="right">
                      {(editable || (m.id === user.id && m.role !== 'owner')) && (
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => removeMember(m)}>{m.id === user.id ? 'Leave' : 'Remove'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <aside className="stack">
          {isAdmin && (
            <section className="card card-pad" id="invite-panel">
              <h2>Invite people</h2>
              <p className="muted small">Anyone with this code joins as a <b>member</b>.</p>
              <div className="invite-code" id="invite-code" data-testid="invite-code">{ws.inviteCode}</div>
              <div className="row gap">
                <button className="btn btn-sm" type="button" onClick={() => copy(inviteLink, 'Invite link')}>Copy link</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => copy(ws.inviteCode, 'Code')}>Copy code</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={regenerate}>Regenerate</button>
              </div>
            </section>
          )}
          <section className="card card-pad">
            <h2>Roles</h2>
            <ul className="role-help">
              <li><span className="role-pill role-owner">owner</span> everything, incl. deleting the workspace</li>
              <li><span className="role-pill role-admin">admin</span> manage members, columns, projects</li>
              <li><span className="role-pill role-member">member</span> create and edit tasks</li>
              <li><span className="role-pill role-viewer">viewer</span> read-only</li>
            </ul>
            {ws.role === 'owner' && <button className="btn btn-danger btn-sm btn-block" type="button" onClick={deleteWorkspace}>Delete workspace</button>}
          </section>
        </aside>
      </div>

      {showNew && <NewProjectModal workspaceId={ws.id} onClose={() => setShowNew(false)} onCreated={(p) => navigate(`/p/${p.id}`)} />}
    </div>
  );
}

function NewProjectModal({ workspaceId, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', key: '', description: '', color: PROJECT_COLORS[0] });
  const [keyTouched, setKeyTouched] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const { project } = await api.post(`/workspaces/${workspaceId}/projects`, form);
      toast(`Project ${project.key} created`);
      onCreated(project);
    } catch (err) { setError(err); }
  };
  const err = (k) => error?.details?.[k];

  return (
    <Modal title="New project" onClose={onClose} testId="new-project-modal">
      <form className="modal-body" onSubmit={submit}>
        {error && !error.details?.name && !error.details?.key && <div className="alert alert-error">{error.message}</div>}
        <div className="form-row">
          <div className="field grow">
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" className="input" autoFocus value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, key: keyTouched ? f.key : suggestKey(e.target.value) }))} />
            {err('name') && <span className="field-error">{err('name')}</span>}
          </div>
          <div className="field" style={{ width: 120 }}>
            <label htmlFor="project-key">Key</label>
            <input id="project-key" className="input mono" maxLength={6} value={form.key}
              onChange={(e) => { setKeyTouched(true); setForm((f) => ({ ...f, key: e.target.value.toUpperCase() })); }} />
            {err('key') && <span className="field-error">{err('key')}</span>}
          </div>
        </div>
        <div className="field">
          <label htmlFor="project-desc">Description <span className="muted">(optional)</span></label>
          <textarea id="project-desc" className="input" rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </div>
        <div className="field">
          <label>Colour</label>
          <div className="swatches">
            {PROJECT_COLORS.map((c) => (
              <button key={c} type="button" className={`swatch${form.color === c ? ' swatch-on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setForm((f) => ({ ...f, color: c }))} />
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" id="create-project-submit">Create project</button>
        </div>
      </form>
    </Modal>
  );
}
