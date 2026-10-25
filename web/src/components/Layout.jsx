import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session.jsx';
import { Avatar } from './ui.jsx';
import NotificationBell from './NotificationBell.jsx';

export default function Layout() {
  const { user, logout, workspaces, connected, server } = useSession();
  const navigate = useNavigate();

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="logo" aria-label="FlowBoard home">
          <span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>FlowBoard</span>
        </NavLink>

        <nav className="side-nav" aria-label="Main">
          <NavLink to="/" end id="nav-home">Home</NavLink>
        </nav>

        <div className="side-section">
          <div className="side-heading">Workspaces</div>
          <nav className="side-nav" aria-label="Workspaces" id="workspace-nav">
            {workspaces.map((w) => (
              <NavLink key={w.id} to={`/w/${w.id}`} data-testid="nav-workspace">
                <span className="ws-chip">{w.name[0]?.toUpperCase()}</span>
                <span className="truncate">{w.name}</span>
              </NavLink>
            ))}
            {!workspaces.length && <span className="side-empty">No workspaces yet</span>}
          </nav>
        </div>

        <div className="side-footer">
          <div className="conn" title="Real-time connection status">
            <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} id="socket-status" data-connected={connected} />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
          {server && (
            <div className="served" title="Which EC2 instance / container served this page">
              <span>Instance</span><code id="instance-id">{server.instanceId}</code>
              <span>AZ</span><code id="az-id">{server.availabilityZone}</code>
              <span>Container</span><code id="container-id">{server.container}</code>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-spacer" />
          <NotificationBell />
          <div className="user-menu">
            <Avatar user={user} size={30} />
            <div className="user-meta">
              <strong id="user-name">{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              id="logout-btn"
              type="button"
              onClick={() => { logout(); navigate('/login'); }}
            >
              Log out
            </button>
          </div>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
