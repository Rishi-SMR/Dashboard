import { useEffect, useMemo, useState } from 'react';
import {
  fetchStrivenVendors, fetchStrivenPO,
  type VendorsResult, type PoResult, type Vendor,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard, type KpiBreakdownRow } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { ChartCard, RankBar, StatCards, DrillModal } from '../chartKit';

const ROW_CAP = 80;

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export function VendorsTab() {
  const [vendorsData, setVendorsData] = useState<VendorsResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, React.ReactNode>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [v, p] = await Promise.all([fetchStrivenVendors(), fetchStrivenPO()]);
      setVendorsData(v); setPo(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vendor data. Is the backend running?');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const vendors: Vendor[] = vendorsData?.vendors ?? [];
  const vendorCount = vendorsData?.count ?? vendors.length;

  // Vendors grouped by status → drives the "# Vendors" tap-to-explain breakdown.
  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vendors) {
      const key = (v.status || 'Unknown').trim() || 'Unknown';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [vendors]);

  const vendorBreakdown: KpiBreakdownRow[] = byStatus.slice(0, 6).map((s) => ({
    label: s.name,
    value: String(s.value),
    sub: vendorCount > 0 ? `${Math.round((s.value / vendorCount) * 100)}%` : undefined,
  }));

  // PO spend ranked by vendor (top 12) — hero chart + the PO-spend breakdown.
  const spendData = useMemo(
    () => [...(po?.byVendor ?? [])]
      .filter((v) => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
      .map((v) => ({ name: v.vendor || '—', value: v.total })),
    [po],
  );

  const spendBreakdown: KpiBreakdownRow[] = useMemo(() => {
    const rows: KpiBreakdownRow[] = spendData.slice(0, 5).map((v) => ({ label: v.name, value: formatCurrency(v.value) }));
    rows.push({ label: 'Total PO spend', value: formatCurrency(po?.totalValue ?? 0), strong: true });
    return rows;
  }, [spendData, po]);

  // Click a vendor bar → drill into that vendor's purchase orders (from PO.recent).
  function openDrillFor(name: string) {
    const rows = (po?.recent ?? [])
      .filter((r) => (r.vendor || '—') === name)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .map((r) => ({ ref: r.ref, date: fmtDate(r.date), amt: formatCurrency(r.total) }));
    setDrill({
      title: name,
      sub: `${rows.length} purchase order${rows.length === 1 ? '' : 's'} · ${formatCurrency((po?.byVendor ?? []).find((v) => (v.vendor || '—') === name)?.total ?? 0)}`,
      columns: [{ key: 'ref', label: 'PO Ref' }, { key: 'date', label: 'Date' }, { key: 'amt', label: 'Amount', num: true }],
      rows,
    });
  }

  // Click a status card → drill into the vendors carrying that status.
  function openStatusDrill(status: string) {
    const rows = vendors
      .filter((v) => ((v.status || 'Unknown').trim() || 'Unknown') === status)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((v) => ({
        name: <strong>{v.name || '—'}</strong>,
        number: v.number || '—',
        status: <StatusPill status={v.status} />,
        terms: v.terms || '—',
        phone: v.phone || '—',
      }));
    setDrill({
      title: `${status} vendors`,
      sub: `${rows.length} of ${vendorCount} supplier${rows.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'name', label: 'Vendor' }, { key: 'number', label: 'Vendor No' },
        { key: 'status', label: 'Status' }, { key: 'terms', label: 'Terms' }, { key: 'phone', label: 'Phone' },
      ],
      rows,
    });
  }

  // Text filter across name / number / status / terms / phone.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      (v.name || '').toLowerCase().includes(q) ||
      (v.number || '').toLowerCase().includes(q) ||
      (v.status || '').toLowerCase().includes(q) ||
      (v.terms || '').toLowerCase().includes(q) ||
      (v.phone || '').toLowerCase().includes(q));
  }, [vendors, query]);

  const shown = filtered.slice(0, ROW_CAP);
  const more = Math.max(0, filtered.length - ROW_CAP);

  const kpi = (i: number) => ({
    open: openKpi === i,
    onClick: () => setOpenKpi((o) => (o === i ? null : i)),
    onClose: () => setOpenKpi(null),
  });

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">VENDORS</h1>
          <div className="page-sub">
            <span className="live-dot" /> Striven · {vendorCount.toLocaleString()} suppliers on record
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !vendorsData && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {vendorsData && po && (
        <>
          {/* Headline KPIs — tap any card for the formula. */}
          <div className="kpis">
            <KpiCard label="# Vendors" period="suppliers on record" value={vendorCount.toLocaleString()}
              info={{ formula: 'Count of every vendor (supplier) record returned by Striven, grouped below by their status.' }}
              breakdown={vendorBreakdown}
              {...kpi(0)} active={openKpi === 0} />
            <KpiCard label="PO Spend" period="across all purchase orders" value={formatCurrency(po.totalValue)} trend="up"
              info={{ formula: 'Total value of every purchase order raised in Striven — what we have committed to spend with vendors. The biggest vendors are listed below.' }}
              breakdown={spendBreakdown}
              {...kpi(1)} active={openKpi === 1} />
          </div>

          {/* Vendors by status — compact cards (Active, Prospect, …). Click to drill. */}
          <ChartCard title="Vendors by Status" sub={`${vendorCount.toLocaleString()} suppliers · click a status to drill in`}>
            <StatCards data={byStatus} total={vendorCount} onSelect={openStatusDrill} />
          </ChartCard>

          {/* Charts — uniform 2-col grid. Click a bar to drill into that vendor's POs. */}
          <div className="chart-grid">
            <ChartCard title="PO Spend by Vendor" sub="Largest purchase-order suppliers — click a bar for detail">
              <RankBar data={spendData} money colorAt={() => C.brand} onSelect={openDrillFor} />
            </ChartCard>
          </div>

          {/* Vendor directory — text filter + row cap. */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 className="section-title">Vendor Directory</h2>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, number, status, terms…"
                style={{ fontSize: 13, padding: '6px 10px', border: `1px solid ${C.grid}`, borderRadius: 8, color: C.ink, minWidth: 220 }}
              />
            </div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Vendor No</th>
                    <th>Status</th>
                    <th>Terms</th>
                    <th>Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((v) => (
                    <tr key={v.id}>
                      <td><strong>{v.name || '—'}</strong></td>
                      <td>{v.number || '—'}</td>
                      <td><StatusPill status={v.status} /></td>
                      <td>{v.terms || '—'}</td>
                      <td>{v.phone || '—'}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted-note" style={{ padding: '12px 10px' }}>
                        {query.trim() ? 'No vendors match your filter.' : 'No vendors on record.'}
                      </td>
                    </tr>
                  )}
                  {filtered.length > 0 && (
                    <tr className="total-row">
                      <td>Total</td>
                      <td colSpan={4}>
                        {filtered.length.toLocaleString()} vendor{filtered.length === 1 ? '' : 's'}
                        {more > 0 ? ` (showing first ${ROW_CAP})` : ''}
                      </td>
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
          columns={drill.columns}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
