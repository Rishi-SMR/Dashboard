import { useEffect, useMemo, useState } from 'react';
import { fetchStrivenAccounts, type AccountsResult, type GlAccount } from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, SERIES } from '../chartTheme';
import { ChartCard, RankBar, DrillModal } from '../chartKit';

export function AccountsTab() {
  const [data, setData] = useState<AccountsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub?: string; rows: Record<string, string>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const res = await fetchStrivenAccounts();
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const accounts: GlAccount[] = data?.accounts ?? [];
  const activeCount = useMemo(() => accounts.filter((a) => a.active).length, [accounts]);
  const inactiveCount = accounts.length - activeCount;

  // Group accounts by type → counts. Ranked bar, per-cell SERIES color, sorted desc.
  const typeData = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) {
      const t = (a.type || 'Uncategorized').trim() || 'Uncategorized';
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [accounts]);

  // Table rows sorted by type (then number, then name).
  const sorted = useMemo(
    () =>
      [...accounts].sort(
        (x, y) =>
          (x.type || '').localeCompare(y.type || '') ||
          (x.number || '').localeCompare(y.number || '', undefined, { numeric: true }) ||
          (x.name || '').localeCompare(y.name || ''),
      ),
    [accounts],
  );

  // Clicking a type bar drills into the accounts of that type.
  function openDrillFor(type: string) {
    const rows = accounts
      .filter((a) => ((a.type || 'Uncategorized').trim() || 'Uncategorized') === type)
      .sort((x, y) => (x.number || '').localeCompare(y.number || '', undefined, { numeric: true }))
      .map((a) => ({ number: a.number || '—', name: a.name || '—', active: a.active ? '✓' : '–' }));
    setDrill({ title: type, sub: `${rows.length} account${rows.length === 1 ? '' : 's'} of this type`, rows });
  }

  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · chart of accounts from Striven
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          {/* Tap any card for the formula. */}
          <div className="kpis">
            <KpiCard label="Accounts" period={`${typeData.length} account types`} value={accounts.length.toLocaleString()}
              info={{ formula: 'Count of every general-ledger account in the Striven chart of accounts, broken out by type below.' }}
              breakdown={typeData.slice(0, 6).map((t, i) => ({ label: t.name, value: t.value.toLocaleString(), strong: i === 0 }))
                .concat([{ label: 'Total accounts', value: accounts.length.toLocaleString(), strong: true } as any])}
              {...kpi(0)} active={openKpi === 0} />
            <KpiCard label="Active" period="currently in use" value={activeCount.toLocaleString()} trend={activeCount >= inactiveCount ? 'up' : 'down'}
              info={{ formula: 'GL accounts flagged active in Striven (Active ÷ Total). Active accounts post to the ledger; inactive are archived.' }}
              breakdown={[
                { label: 'Active', value: activeCount.toLocaleString(), strong: true },
                { label: 'Inactive', value: inactiveCount.toLocaleString() },
                { label: 'Total', value: accounts.length.toLocaleString() },
              ]}
              {...kpi(1)} active={openKpi === 1} />
          </div>

          <div className="chart-grid">
            <ChartCard title="Accounts by Type" sub={`${accounts.length.toLocaleString()} accounts · click a bar to drill in`}>
              <RankBar data={typeData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={(name) => openDrillFor(name)} />
            </ChartCard>
          </div>

          <ChartCard title="Chart of Accounts" sub={`${accounts.length.toLocaleString()} GL accounts · sorted by type`}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Account No</th>
                    <th>Account Name</th>
                    <th>Type</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((a) => (
                    <tr key={a.id}>
                      <td>{a.number || '—'}</td>
                      <td><strong>{a.name || '—'}</strong></td>
                      <td>{a.type || '—'}</td>
                      <td>{a.active ? <StatusPill status="Active" /> : <span className="muted-note" style={{ margin: 0 }}>–</span>}</td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr><td colSpan={4} className="muted-note">No GL accounts on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {data.note && <div className="muted-note">{data.note}</div>}
          </ChartCard>
        </>
      )}

      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={[
            { key: 'number', label: 'Account No' },
            { key: 'name', label: 'Account Name' },
            { key: 'active', label: 'Active' },
          ]}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
