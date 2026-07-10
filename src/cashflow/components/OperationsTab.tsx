import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { C, SERIES } from '../chartTheme';
import { ChartCard, RankBar, DrillModal } from '../chartKit';
import {
  fetchStrivenTasks,
  fetchStrivenProjects,
  type TasksResult,
  type ProjectsResult,
} from '../strivenApi';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';

// Chart-click drill payload (rendered by the shared kit DrillModal).
type Drill = {
  title: string;
  sub?: string;
  columns: { key: string; label: string; num?: boolean }[];
  rows: Record<string, ReactNode>[];
};

const fmtDate = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

export function OperationsTab() {
  const [tasks, setTasks] = useState<TasksResult | null>(null);
  const [projects, setProjects] = useState<ProjectsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);

  // Chart-click drill (shared kit DrillModal).
  const [drill, setDrill] = useState<Drill | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [t, p] = await Promise.all([fetchStrivenTasks(), fetchStrivenProjects()]);
      setTasks(t);
      setProjects(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load operations. Is the backend running on :4747?');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const kpi = (i: number) => ({
    open: openKpi === i,
    onClick: () => setOpenKpi((o) => (o === i ? null : i)),
    onClose: () => setOpenKpi(null),
  });

  // Ranked-bar data — sorted desc, empties dropped, mapped to {name, value}.
  const taskStatusData = [...(tasks?.byStatus ?? [])]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({ name: b.name || '—', value: b.count }));

  const taskTypeData = [...(tasks?.byType ?? [])]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({ name: b.name || '—', value: b.count }));

  const projectStatusData = [...(projects?.byStatus ?? [])]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({ name: b.name || '—', value: b.count }));

  // Chart drill: tasks in the clicked status.
  function drillTaskStatus(status: string) {
    const list = (tasks?.recent ?? []).filter((t) => (t.status || '—') === status);
    setDrill({
      title: `Tasks — ${status}`,
      sub: `${list.length} recent task${list.length === 1 ? '' : 's'} in this status`,
      columns: [
        { key: 'title', label: 'Task ref' },
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'created', label: 'Created' },
      ],
      rows: list.map((t) => ({
        title: <strong>{t.title || '—'}</strong>,
        type: t.type || '—',
        status: <StatusPill status={t.status} />,
        created: fmtDate(t.date),
      })),
    });
  }

  // Chart drill: tasks of the clicked type.
  function drillTaskType(type: string) {
    const list = (tasks?.recent ?? []).filter((t) => (t.type || '—') === type);
    setDrill({
      title: `Tasks — ${type}`,
      sub: `${list.length} recent task${list.length === 1 ? '' : 's'} of this type`,
      columns: [
        { key: 'title', label: 'Task ref' },
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'created', label: 'Created' },
      ],
      rows: list.map((t) => ({
        title: <strong>{t.title || '—'}</strong>,
        type: t.type || '—',
        status: <StatusPill status={t.status} />,
        created: fmtDate(t.date),
      })),
    });
  }

  // Chart drill: projects in the clicked status.
  function drillProjectStatus(status: string) {
    const list = (projects?.recent ?? []).filter((p) => (p.status || '—') === status);
    setDrill({
      title: `Projects — ${status}`,
      sub: `${list.length} recent project${list.length === 1 ? '' : 's'} in this status`,
      columns: [
        { key: 'name', label: 'Project ref' },
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'created', label: 'Created' },
      ],
      rows: list.map((p) => ({
        name: <strong>{p.name || '—'}</strong>,
        type: p.type || '—',
        status: <StatusPill status={p.status} />,
        created: fmtDate(p.date),
      })),
    });
  }

  const records = (tasks?.count ?? 0) + (projects?.count ?? 0);

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">OPERATIONS</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven · {records.toLocaleString()} records
            <span
              style={{
                marginLeft: 10,
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                background: C.brandLight,
                color: C.brandDark,
                border: '1px solid #bfd3f2',
              }}
            >
              🔒 PHI masked
            </span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          ↻ Refresh
        </button>
      </div>

      {error && <div className="error" style={{ margin: '10px 0' }}>{error}</div>}
      {loading && !tasks && !projects && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {tasks && projects && (
        <>
          {/* Headline counts — tap any card for the formula + breakdown. */}
          <div className="kpis" style={{ marginTop: 16 }}>
            <KpiCard
              label="Tasks"
              value={tasks.count.toLocaleString()}
              period={`${tasks.byStatus.length} distinct statuses`}
              info={{ formula: 'Count of every task on record in Striven — work items, broken out by status and type below.' }}
              breakdown={[
                ...[...tasks.byStatus]
                  .sort((a, b) => b.count - a.count)
                  .map((b) => ({ label: b.name || '—', value: b.count.toLocaleString() })),
                { label: 'Total', value: tasks.count.toLocaleString(), strong: true },
              ]}
              active={openKpi === 0}
              {...kpi(0)}
            />
            <KpiCard
              label="Projects"
              value={projects.count.toLocaleString()}
              period={`${projects.byStatus.length} distinct statuses`}
              info={{ formula: 'Count of every project on record in Striven — engagements, broken out by status below.' }}
              breakdown={[
                ...[...projects.byStatus]
                  .sort((a, b) => b.count - a.count)
                  .map((b) => ({ label: b.name || '—', value: b.count.toLocaleString() })),
                { label: 'Total', value: projects.count.toLocaleString(), strong: true },
              ]}
              active={openKpi === 1}
              {...kpi(1)}
            />
          </div>

          <div className="chart-grid">
            <ChartCard title="Tasks by Status" sub={`${tasks.count.toLocaleString()} tasks · click a bar to drill in`}>
              <RankBar
                data={taskStatusData}
                colorAt={(i) => SERIES[i % SERIES.length]}
                onSelect={drillTaskStatus}
              />
            </ChartCard>

            <ChartCard title="Tasks by Type" sub="Work items grouped by category · click a bar to drill in">
              <RankBar
                data={taskTypeData}
                colorAt={(i) => SERIES[i % SERIES.length]}
                onSelect={drillTaskType}
              />
            </ChartCard>

            <ChartCard title="Projects by Status" sub={`${projects.count.toLocaleString()} projects · click a bar to drill in`}>
              <RankBar
                data={projectStatusData}
                colorAt={(i) => SERIES[i % SERIES.length]}
                onSelect={drillProjectStatus}
              />
            </ChartCard>
          </div>

          {/* ── TASKS TABLE ──────────────────────────────────────────── */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><h2 className="section-title">Recent Tasks</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.recent.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.title || '—'}</strong></td>
                      <td>{t.type || '—'}</td>
                      <td><StatusPill status={t.status} /></td>
                      <td>{fmtDate(t.date)}</td>
                    </tr>
                  ))}
                  {tasks.recent.length === 0 && (
                    <tr><td colSpan={4} className="muted-note">No recent tasks.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Task titles masked to refs — PHI protected.</div>
          </div>

          {/* ── PROJECTS TABLE ───────────────────────────────────────── */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><h2 className="section-title">Recent Projects</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.recent.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.name || '—'}</strong></td>
                      <td>{p.type || '—'}</td>
                      <td><StatusPill status={p.status} /></td>
                      <td>{fmtDate(p.date)}</td>
                    </tr>
                  ))}
                  {projects.recent.length === 0 && (
                    <tr><td colSpan={4} className="muted-note">No recent projects.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Project names masked to refs — PHI protected.</div>
          </div>
        </>
      )}

      {/* ── CHART DRILL (shared kit modal) ───────────────────────── */}
      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={drill.columns}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
