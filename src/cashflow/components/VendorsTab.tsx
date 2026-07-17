import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchStrivenVendors, fetchStrivenPO,
  type VendorsResult, type PoResult, type Vendor,
} from '../strivenApi';
import { formatCurrency, formatPhone } from '../format';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { ChartCard, RankBar, BarList, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const PAGE_SIZE = 10;
type SortKey = 'name' | 'number' | 'status' | 'terms';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const STATUS_HUE = (name: string): string => {
  const s = (name || '').toLowerCase();
  if (/active/.test(s)) return '#16A34A';
  if (/prospect/.test(s)) return '#2563EB';
  if (/inactive|hold|blocked/.test(s)) return '#DC2626';
  return C.muted;
};

// Windowed page list: 1 2 3 … N.
function pageList(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, 2, 3, cur - 1, cur, cur + 1, total]);
  const nums = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push('…');
    out.push(nums[i]);
  }
  return out;
}

export function VendorsTab() {
  const [vendorsData, setVendorsData] = useState<VendorsResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [page, setPage] = useState(1);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [v, p] = await Promise.all([fetchStrivenVendors(), fetchStrivenPO()]);
      setVendorsData(v); setPo(p);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load vendor data. Is the backend running?');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const vendors: Vendor[] = vendorsData?.vendors ?? [];
  const vendorCount = vendorsData?.count ?? vendors.length;

  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vendors) {
      const key = (v.status || 'Unknown').trim() || 'Unknown';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [vendors]);
  const statusCount = (re: RegExp) => byStatus.filter((s) => re.test(s.name.toLowerCase())).reduce((t, s) => t + s.value, 0);
  const activeCount = statusCount(/active/);
  const prospectCount = statusCount(/prospect/);
  const pctOf = (n: number) => (vendorCount ? Math.round((n / vendorCount) * 100) : 0);

  // PO spend ranked by vendor — hero chart, click a bar to drill into that vendor's POs.
  const spendData = useMemo(
    () => [...(po?.byVendor ?? [])]
      .filter((v) => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
      .map((v) => ({ name: v.vendor || '—', value: v.total })),
    [po],
  );
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

  // Click a status (KPI or bar) → the vendors carrying that status ('Total' = all).
  function openStatusDrill(status: string) {
    const rows = vendors
      .filter((v) => status === 'Total' || ((v.status || 'Unknown').trim() || 'Unknown') === status)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((v) => ({
        name: <strong>{v.name || '—'}</strong>,
        number: v.number || '—',
        status: <StatusPill status={v.status} />,
        terms: v.terms || '—',
        phone: formatPhone(v.phone),
      }));
    setDrill({
      title: status === 'Total' ? 'All vendors' : `${status} vendors`,
      sub: `${rows.length} of ${vendorCount} supplier${rows.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'name', label: 'Vendor' }, { key: 'number', label: 'Vendor No' },
        { key: 'status', label: 'Status' }, { key: 'terms', label: 'Terms' }, { key: 'phone', label: 'Phone' },
      ],
      rows,
    });
  }

  // Directory: text filter → sort → paginate.
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
  const sorted = useMemo(() => {
    const v = (x: Vendor): string => (sort.key === 'number' ? x.number : sort.key === 'status' ? x.status : sort.key === 'terms' ? x.terms : x.name) || '';
    return [...filtered].sort((a, b) => v(a).localeCompare(v(b), undefined, { numeric: true }) * sort.dir);
  }, [filtered, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // Export the filtered directory as CSV (client-side only).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Vendor', 'Vendor no', 'Status', 'Terms', 'Phone'].map(esc).join(','),
      ...sorted.map((v) => [v.name || '', v.number || '', v.status || '', v.terms || '', v.phone || ''].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'vendors.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Vendors</h1>
          <div className="page-sub">
            <span className="live-dot" /> Striven · {vendorCount.toLocaleString()} suppliers on record{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !vendorsData && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {vendorsData && po && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="users" tint="#2563EB" label="Suppliers" value={vendorCount}
              deltaText="on record" foot="all vendors in Striven" onClick={() => openStatusDrill('Total')} />
            <KpiR ico="shield" tint="#16A34A" label="Active" value={activeCount}
              deltaText={`${pctOf(activeCount)}% of total`} foot="currently trading" onClick={() => openStatusDrill('Active')} />
            <KpiR ico="clip" tint="#D97706" label="Prospect" value={prospectCount}
              deltaText={`${pctOf(prospectCount)}% of total`} foot="not yet active" onClick={() => openStatusDrill('Prospect')} />
            <KpiR ico="cash" tint="#7C3AED" label="PO Spend" value={po.totalValue} format={formatCurrency}
              deltaText={`${po.count} active POs`} foot={po.cancelledCount ? `${po.cancelledCount} cancelled excluded` : 'active POs only'} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-7" title="PO Spend by Vendor" sub={`Active POs only${po.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''} · click a bar for detail`}>
              <RankBar data={spendData} money colorAt={() => C.brand} onSelect={openDrillFor} />
            </ChartCard>

            <ChartCard className="g12-5" title="Vendors by Status" sub={`${vendorCount.toLocaleString()} suppliers · click a row to drill in`}>
              <BarList
                data={byStatus.map((s) => ({ name: s.name, value: s.value, color: STATUS_HUE(s.name), meta: `${s.value} vendors` }))}
                money={false}
                onSelect={openStatusDrill}
              />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Suppliers</div><div className="v">{vendorCount.toLocaleString()}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">With PO Spend</div><div className="v accent">{spendData.length}</div></div>
              </div>
            </ChartCard>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Vendor Directory</h2><div className="section-sub">{filtered.length.toLocaleString()} suppliers</div></div>
                <div className="tbl-controls">
                  <input className="tbl-search" style={{ width: 230 }} type="text" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                    placeholder="Filter by name, number, status, terms…" />
                  <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered vendors" onClick={exportCsv}>⤓ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sortable" onClick={() => setSortKey('name')}>Vendor {sortInd('name')}</th>
                      <th className="sortable" onClick={() => setSortKey('number')}>Vendor No {sortInd('number')}</th>
                      <th className="sortable" onClick={() => setSortKey('status')}>Status {sortInd('status')}</th>
                      <th className="sortable" onClick={() => setSortKey('terms')}>Terms {sortInd('terms')}</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((v) => (
                      <tr key={v.id} onClick={() => openDrillFor(v.name || '—')} style={{ cursor: 'pointer' }}>
                        <td><strong>{v.name || '—'}</strong></td>
                        <td>{v.number || '—'}</td>
                        <td><StatusPill status={v.status} /></td>
                        <td>{v.terms || '—'}</td>
                        <td>{formatPhone(v.phone)}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={5} className="muted-note" style={{ padding: '12px 10px' }}>
                          {query.trim() ? 'No vendors match your filter.' : 'No vendors on record.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pgn">
                <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()} entries</span>
                <div className="pgn-pages">
                  <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                  {pageList(pageSafe, pages).map((p, i) => (
                    p === '…'
                      ? <button key={`e${i}`} disabled>…</button>
                      : <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                  ))}
                  <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
                </div>
              </div>
            </div>
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
