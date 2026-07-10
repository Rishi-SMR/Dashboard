import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchStrivenCustomers, type CustomersResult, type Customer } from '../strivenApi';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { ChartCard, StatCards, DrillModal } from '../chartKit';

const ROW_CAP = 80;

const fmtDate = (s: string | null): string =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const isActive = (status: string): boolean => (status || '').trim().toLowerCase() === 'active';

export function PatientsTab() {
  const [data, setData] = useState<CustomersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [drill, setDrill] = useState<null | { title: string; sub?: string; rows: Record<string, ReactNode>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [c] = await Promise.all([fetchStrivenCustomers()]);
      setData(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load patients. Is the backend running?');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const patients: Customer[] = data?.customers ?? [];
  const total = data?.count ?? patients.length;
  const active = useMemo(() => patients.filter((p) => isActive(p.status)).length, [patients]);
  const activeRate = total > 0 ? Math.round((active / total) * 100) : 0;

  // Group patients by status → sorted [{ name, value }] for the ranked bar + KPI breakdowns.
  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of patients) {
      const key = (p.status || 'Unknown').trim() || 'Unknown';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [patients]);

  // Text filter across ref / masked name / status.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) =>
      (p.ref || '').toLowerCase().includes(q) ||
      (p.name || '').toLowerCase().includes(q) ||
      (p.status || '').toLowerCase().includes(q));
  }, [patients, query]);

  const shown = filtered.slice(0, ROW_CAP);
  const more = Math.max(0, filtered.length - ROW_CAP);

  // Clicking a status card drills into that cohort's patient rows ('Total' = all).
  function openDrillFor(status: string) {
    if (!status) return;
    const list = status === 'Total'
      ? patients
      : patients.filter((p) => ((p.status || 'Unknown').trim() || 'Unknown') === status);
    const rows = list.map((p) => ({
      ref: p.ref || '—',
      name: <strong>{p.name || '—'}</strong>,
      status: <StatusPill status={p.status} />,
      since: fmtDate(p.since),
    }));
    setDrill({ title: status === 'Total' ? 'All patients' : `${status} patients`, sub: `${rows.length} of ${total} · names masked (PHI protected)`, rows });
  }

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Patients</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark, border: `1px solid ${C.brand}33` }}>🔒 PHI masked</span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          {/* Prominent PHI note — patient identity never reaches the browser un-masked. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 14, padding: '11px 15px', borderRadius: 12, background: C.brandLight, color: C.brandDark, border: `1px solid ${C.brand}33`, fontSize: 13, fontWeight: 600 }}>
            <span style={{ fontSize: 16 }}>🔒</span>
            <span>Patient names are masked to initials server-side and every identifying detail is withheld — PHI protected (HIPAA). Nothing is un-masked in the browser.</span>
          </div>

          {/* One line: total + each status — no duplicated cards. */}
          <ChartCard title="Patients by Status" sub={`${total.toLocaleString()} on record · ${activeRate}% active · click a card to drill in`}>
            <StatCards
              data={[
                { name: 'Total', value: total, sub: 'all patients', tone: 'info', primary: true },
                ...byStatus.map((s) => ({ name: s.name, value: s.value })),
              ]}
              total={total}
              onSelect={openDrillFor}
            />
          </ChartCard>

          {/* Detail table: patient roster with text filter */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div><h2 className="section-title">Patient Roster</h2><div className="section-sub">{filtered.length.toLocaleString()} match{filtered.length === 1 ? '' : 'es'}</div></div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by ref, initials, or status…"
                style={{ fontSize: 13, padding: '6px 10px', border: `1px solid ${C.grid}`, borderRadius: 8, color: C.ink, minWidth: 220 }}
              />
            </div>
            <div className="muted-note">Patient names masked — PHI protected.</div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Patient ID</th>
                    <th>Patient</th>
                    <th>Status</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id}>
                      <td>{p.ref || '—'}</td>
                      <td><strong>{p.name || '—'}</strong></td>
                      <td><StatusPill status={p.status} /></td>
                      <td>{fmtDate(p.since)}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted-note" style={{ padding: '12px 10px' }}>
                        {query.trim() ? 'No patients match your filter.' : 'No patients on record.'}
                      </td>
                    </tr>
                  )}
                  {filtered.length > 0 && (
                    <tr className="total-row">
                      <td>TOTAL</td>
                      <td colSpan={3}>{filtered.length.toLocaleString()} patient{filtered.length === 1 ? '' : 's'}{more > 0 ? ` (showing first ${ROW_CAP})` : ''}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {more > 0 && <div className="muted-note">+{more.toLocaleString()} more</div>}
          </div>
        </>
      )}

      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={[
            { key: 'ref', label: 'Patient ID' },
            { key: 'name', label: 'Patient' },
            { key: 'status', label: 'Status' },
            { key: 'since', label: 'Since' },
          ]}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
