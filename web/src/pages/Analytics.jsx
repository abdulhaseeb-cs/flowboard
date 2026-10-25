import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { describeAction, timeAgo } from '../lib/util.js';
import { Avatar, ErrorState, Spinner } from '../components/ui.jsx';
import { GroupedColumns, HBars, Legend, LineChart } from '../components/Charts.jsx';

const C1 = 'var(--series-1)';
const C2 = 'var(--series-3)';

export default function Analytics() {
  const { id } = useParams();
  const { socket } = useSession();
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [project, setProject] = useState(null);
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [a, b, act] = await Promise.all([
        api.get(`/projects/${id}/analytics?days=${days}`),
        api.get(`/projects/${id}`),
        api.get(`/projects/${id}/activity?limit=15`),
      ]);
      setData(a); setProject(b.project); setActivity(act.activity);
    } catch (err) { setError(err); }
  }, [id, days]);
  useEffect(() => { load(); }, [load]);

  // Live: refresh numbers when anything on this board changes
  useEffect(() => {
    if (!socket) return undefined;
    let t;
    const refresh = () => { clearTimeout(t); t = setTimeout(load, 600); };
    socket.emit('board:join', { projectId: Number(id) });
    ['task:upsert', 'task:deleted', 'board:refresh'].forEach((ev) => socket.on(ev, refresh));
    return () => {
      clearTimeout(t);
      socket.emit('board:leave', { projectId: Number(id) });
      ['task:upsert', 'task:deleted', 'board:refresh'].forEach((ev) => socket.off(ev, refresh));
    };
  }, [socket, id, load]);

  if (error) return <ErrorState error={error}><Link className="btn" to="/">Back home</Link></ErrorState>;
  if (!data) return <div className="page-pad"><Spinner /></div>;
  const { totals } = data;

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to={`/w/${project.workspaceId}`}>{project.workspaceName}</Link> / <Link to={`/p/${project.id}`}>{project.key}</Link> / Analytics</div>
          <h1 id="page-title">{project.name} — Analytics</h1>
        </div>
        <div className="row gap">
          <div className="segmented" role="group" aria-label="Time range">
            {[7, 14, 30].map((d) => <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>)}
          </div>
          <Link className="btn btn-ghost" to={`/p/${project.id}`}>Back to board</Link>
        </div>
      </div>

      <div className="kpis" id="kpis">
        <Kpi label="Completion" value={`${totals.completionRate}%`} hint={`${totals.done} of ${totals.total} tasks`} testId="kpi-completion" />
        <Kpi label="Open tasks" value={totals.open} hint={`${totals.overdue} overdue`} warn={totals.overdue > 0} testId="kpi-open" />
        <Kpi label="Story points" value={`${totals.pointsDone}/${totals.points}`} hint="done / total" />
        <Kpi label="Avg. cycle time" value={totals.avgCycleHours === null ? '—' : totals.avgCycleHours < 48 ? `${totals.avgCycleHours}h` : `${(totals.avgCycleHours / 24).toFixed(1)}d`} hint="created → done" />
      </div>

      <div className="charts-grid">
        <section className="card card-pad">
          <h2>Burndown — open tasks</h2>
          <p className="muted small">Tasks still open at the end of each day.</p>
          <LineChart data={data.daily} valueKey="open" label="Open tasks" color={C1} />
        </section>
        <section className="card card-pad">
          <h2>Throughput</h2>
          <Legend items={[{ label: 'Created', color: C1 }, { label: 'Completed', color: C2 }]} />
          <GroupedColumns data={data.daily} series={[{ key: 'created', label: 'Created', color: C1 }, { key: 'completed', label: 'Completed', color: C2 }]} />
        </section>
        <section className="card card-pad">
          <h2>Tasks per column</h2>
          <p className="muted small">The tick marks a column's WIP limit.</p>
          <HBars rows={data.byColumn} segments={[{ key: 'count', label: 'Tasks', color: C1 }]} marker="wipLimit" />
        </section>
        <section className="card card-pad">
          <h2>Workload by assignee</h2>
          <Legend items={[{ label: 'Open', color: C1 }, { label: 'Done', color: C2 }]} />
          <HBars rows={data.byAssignee} segments={[{ key: 'open', label: 'Open', color: C1 }, { key: 'done', label: 'Done', color: C2 }]} />
        </section>
        <section className="card card-pad">
          <h2>Open tasks by priority</h2>
          <HBars rows={['urgent', 'high', 'medium', 'low'].map((p) => ({ name: p, count: data.byPriority[p] || 0 }))} segments={[{ key: 'count', label: 'Open', color: C1 }]} labelWidth={80} />
        </section>
        <section className="card card-pad">
          <h2>Recent activity</h2>
          <ul className="activity-feed">
            {activity.map((a) => (
              <li key={a.id}>
                <Avatar user={a.user ? { name: a.user.name, color: a.user.color } : null} size={24} />
                <span><strong>{a.user?.name || 'Someone'}</strong> {describeAction(a)}
                  {a.task && <> · <Link to={`/p/${project.id}?task=${a.task.id}`} className="mono">{a.task.key}</Link></>}
                  <span className="muted small"> · {timeAgo(a.createdAt)}</span></span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint, warn, testId }) {
  return (
    <div className="card kpi" data-testid={testId}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className={`kpi-hint${warn ? ' kpi-warn' : ''}`}>{warn && '⚠ '}{hint}</span>
    </div>
  );
}
