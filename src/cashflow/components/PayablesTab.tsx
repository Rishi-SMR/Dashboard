import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchStrivenAP, fetchStrivenVendors, fetchStrivenPO, fetchStrivenBillPayments,
  type ApResult, type VendorsResult, type PoResult, type BillPaymentsResult,
} from '../strivenApi';
import { formatCurrency, formatPhone } from '../format';
import { StatusPill } from './StatusPill';
import { C, AGING_LABELS } from '../chartTheme';
import { ChartCard, RankBar, AgingBar, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const VENDOR_CAP = 50;
const PAGE_SIZE = 8;

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const daysPast = (dueDate: string | null, refMs = Date.now()): number => {
  if (!dueDate) return 0;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.floor((refMs - due) / 86_400_000);
};

// Bill status straight from the due date: overdue / due today / due in Xd.
function DuePill({ dueDate, refMs }: { dueDate: string | null; refMs?: number }) {
  const d = daysPast(dueDate, refMs);
  if (!dueDate) return <span className="pill-tag tag-muted">No due date</span>;
  if (d > 0) return <span className="pill-tag tag-danger">Overdue</span>;
  if (d === 0) return <span className="pill-tag tag-warn">Due Today</span>;
  return <span className="pill-tag tag-info">Due in {-d}d</span>;
}

// A recorded bill payment means the vendor bill HAS been settled — show it as paid,
// unless Striven explicitly voided/cancelled the charge.
const isPaid = (status: string) => !/cancel|void|fail|reject|denied/i.test(status || '');
const PaidBadge = ({ status }: { status: string }) =>
  isPaid(status)
    ? <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>
    : <StatusPill status={status} />;

type SortKey = 'due' | 'total' | 'open' | 'days';

export function PayablesTab() {
  const [ap, setAp] = useState<ApResult | null>(null);
  const [vendors, setVendors] = useState<VendorsResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [bp, setBp] = useState<BillPaymentsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  // Dynamic controls.
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [dueF, setDueF] = useState<'All' | 'overdue' | 'today' | 'upcoming'>('All');
  const [asOfPick, setAsOfPick] = useState<string | null>(null); // YYYY-MM-DD
  const todayStr = new Date().toISOString().slice(0, 10);
  const asOfStr = asOfPick && asOfPick <= todayStr ? asOfPick : todayStr;
  const refMs = new Date(`${asOfStr}T23:59:59`).getTime();

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [a, v, o, p] = await Promise.all([
        fetchStrivenAP(), fetchStrivenVendors(), fetchStrivenPO(), fetchStrivenBillPayments(),
      ]);
      setAp(a); setVendors(v); setPo(o); setBp(p);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load Payables data.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const bills = ap?.bills ?? [];
  const payments = bp?.recent ?? [];
  const paidCount = useMemo(() => payments.filter((p) => isPaid(p.status)).length, [payments]);

  // Aging by bill count for the toggle.
  const bucketK = (d: number) => (d <= 0 ? 'current' : d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90plus');
  const agingCount = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of bills) m[bucketK(daysPast(b.dueDate, refMs))] += 1;
    return m;
  }, [bills, refMs]);
  // Amount aging bucketed client-side so the as-of date applies.
  const agingEff = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of bills) m[bucketK(daysPast(b.dueDate, refMs))] += b.open;
    return m;
  }, [bills, refMs]);

  // Top vendors by PO spend — brand-blue ranked bars, click to drill into POs.
  const vendorData = useMemo(
    () => [...(po?.byVendor ?? [])]
      .filter((v) => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 7)
      .map((v) => ({ name: v.vendor || '—', value: v.total })),
    [po],
  );
  function openVendorDrill(name: string) {
    const rows = (po?.recent ?? [])
      .filter((r) => (r.vendor || '—') === name)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((r) => ({ ref: r.ref || '—', date: fmtDate(r.date), amt: formatCurrency(r.total) }));
    setDrill({
      title: name, sub: `${rows.length} purchase order${rows.length === 1 ? '' : 's'} on record`,
      columns: [{ key: 'ref', label: 'PO ref' }, { key: 'date', label: 'Date' }, { key: 'amt', label: 'Amount', num: true }],
      rows,
    });
  }

  // Open-bills table: search → sort → paginate.
  const dueGroup = (b: typeof bills[number]) => { const d = daysPast(b.dueDate, refMs); return !b.dueDate ? 'upcoming' : d > 0 ? 'overdue' : d === 0 ? 'today' : 'upcoming'; };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bills.filter((b) =>
      (dueF === 'All' || dueGroup(b) === dueF) &&
      (!q || String(b.number).toLowerCase().includes(q) || (b.vendor || '').toLowerCase().includes(q)));
  }, [bills, query, dueF, refMs]);
  const sorted = useMemo(() => {
    const v = (b: typeof bills[number]): number => sort.key === 'total' ? b.total : sort.key === 'open' ? b.open
      : sort.key === 'days' ? daysPast(b.dueDate, refMs) : (b.dueDate ? new Date(b.dueDate).getTime() : 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort, refMs]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const fTotal = filtered.reduce((s, b) => s + (b.total || 0), 0);
  const fOpen = filtered.reduce((s, b) => s + (b.open || 0), 0);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // Export the filtered bills as CSV (client-side, nothing leaves the browser).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Bill #', 'Vendor', 'Due date', 'Total', 'Open', 'Days past due'].map(esc).join(','),
      ...sorted.map((b) => [b.number, b.vendor || '', b.dueDate?.slice(0, 10) || '', b.total, b.open, Math.max(0, daysPast(b.dueDate, refMs))].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'open-bills.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // Click an aging bar → the bills inside that bucket.
  const drillApBucket = (label: string) => {
    const inBucket = (b: typeof bills[number]) => {
      const d = daysPast(b.dueDate, refMs);
      const bl = d <= 0 ? 'Current' : d <= 30 ? '1–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+';
      return bl === label;
    };
    setDrill({
      title: `AP Aging · ${label}`, sub: label === 'Current' ? 'Bills not yet due' : `Bills ${label} days past due`,
      columns: [{ key: 'n', label: 'Bill #' }, { key: 'v', label: 'Vendor' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
      rows: bills.filter((b) => b.open > 0 && inBucket(b)).sort((a, b) => b.open - a.open)
        .map((b) => ({ n: `#${b.number}`, v: b.vendor || '—', d: fmtDate(b.dueDate), o: formatCurrency(b.open) })),
    });
  };

  // Tap-to-explain drills.
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const explainAp = () => setDrill({
    title: 'AP Open', sub: 'Unpaid balance across every open vendor bill, split by days past due',
    ...kv([...AGING_LABELS.map((b) => ({ k: b.label, v: formatCurrency(ap?.aging[b.key] || 0) })), { k: 'Total', v: formatCurrency(ap?.totalOpen || 0) }]),
  });
  const explainPo = () => setDrill({
    title: 'PO Total', sub: 'Value of ACTIVE purchase orders — cancelled/voided POs excluded',
    ...kv([
      ...[...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total).slice(0, 5).map((v) => ({ k: v.vendor || '—', v: formatCurrency(v.total) })),
      ...(po?.cancelledValue ? [{ k: 'Cancelled (excluded)', v: formatCurrency(po.cancelledValue) }] : []),
      { k: 'Active total', v: formatCurrency(po?.totalValue ?? 0) },
    ]),
  });
  const explainPaid = () => setDrill({
    title: 'Bills Paid', sub: 'Vendor bill payments recorded in Striven — the cash side of payables',
    columns: [{ key: 'r', label: 'Reference' }, { key: 'v', label: 'Vendor' }, { key: 'd', label: 'Paid on' }, { key: 'a', label: 'Amount', num: true }],
    rows: payments.map((p) => ({ r: p.ref || '—', v: p.vendor || '—', d: fmtDate(p.date), a: formatCurrency(p.amount) })),
  });

  const vendorRows = (vendors?.vendors ?? []).slice(0, VENDOR_CAP);
  const moreVendors = Math.max(0, (vendors?.vendors.length ?? 0) - vendorRows.length);
  const ready = !!ap;

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Payables</h1>
          <div className="page-sub">
            <span className="live-dot" /> Striven · {ready ? `${ap!.count} open bills` : 'loading…'}{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <label className="ov-filter"><span className="fl">As of</span>
            <input type="date" value={asOfStr} max={todayStr} onChange={(e) => setAsOfPick(e.target.value || null)} />
          </label>
          {asOfPick && <button className="card-link" style={{ marginTop: 0 }} onClick={() => setAsOfPick(null)}>Today</button>}
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ap && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="doc" tint="#2563EB" label="AP Open" value={ap!.totalOpen} format={formatCurrency}
              deltaText={`${ap!.count} open bills`} foot="excludes voided bills" onClick={explainAp} />
            <KpiR ico="clip" tint="#16A34A" label="# Open Bills" value={ap!.count}
              deltaText="awaiting payment" foot="matches Striven AP aging" />
            <KpiR ico="box" tint="#7C3AED" label="PO Total" value={po?.totalValue ?? 0} format={formatCurrency}
              deltaText={`${po?.count ?? 0} active POs`} foot={po?.cancelledCount ? `${po.cancelledCount} cancelled excluded` : 'active only'} onClick={explainPo} />
            <KpiR ico="wallet" tint="#D97706" label="Bills Paid" value={bp?.total ?? 0} format={formatCurrency}
              deltaText={`${paidCount} of ${bp?.count ?? 0} paid`} foot="recorded bill payments" onClick={explainPaid} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-7" title="Top Vendors by PO Spend" sub={`Active POs only${po?.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''} · click a bar`}>
              <RankBar data={vendorData} money colorAt={() => C.brand} onSelect={openVendorDrill} />
            </ChartCard>

            <ChartCard className="g12-5" title="AP Aging" sub="Open payables by days past due"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
                  <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
                </div>
              }>
              <AgingBar aging={agingMode === 'amount' ? agingEff : agingCount} money={agingMode === 'amount'} onSelect={drillApBucket} />
            </ChartCard>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Open Bills</h2><div className="section-sub">Unpaid vendor bills with a remaining balance</div></div>
                <div className="tbl-controls">
                  <input className="tbl-search" placeholder="Search bills / vendor" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  <select className="tbl-select" value={dueF} onChange={(e) => { setDueF(e.target.value as typeof dueF); setPage(1); }}>
                    <option value="All">All bills</option>
                    <option value="overdue">Overdue</option>
                    <option value="today">Due today</option>
                    <option value="upcoming">Upcoming</option>
                  </select>
                  <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered bills" onClick={exportCsv}>⤓ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Bill #</th>
                      <th>Vendor</th>
                      <th className="sortable" onClick={() => setSortKey('due')}>Due Date {sortInd('due')}</th>
                      <th className="num sortable" onClick={() => setSortKey('total')}>Total {sortInd('total')}</th>
                      <th className="num sortable" onClick={() => setSortKey('open')}>Open {sortInd('open')}</th>
                      <th className="num sortable" onClick={() => setSortKey('days')}>Days Past Due {sortInd('days')}</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((b) => {
                      const d = daysPast(b.dueDate, refMs);
                      return (
                        <tr key={b.id}>
                          <td><strong>#{b.number}</strong></td>
                          <td>{b.vendor || '—'}</td>
                          <td>{fmtDate(b.dueDate)}</td>
                          <td className="num">{formatCurrency(b.total)}</td>
                          <td className="num cell-neg">{formatCurrency(b.open)}</td>
                          <td className="num cell-neg">{d > 0 ? d : '—'}</td>
                          <td><DuePill dueDate={b.dueDate} refMs={refMs} /></td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr><td colSpan={7} style={{ color: C.muted }}>No bills match.</td></tr>
                    )}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td>{filtered.length} bill{filtered.length === 1 ? '' : 's'}</td>
                        <td></td>
                        <td className="num">{formatCurrency(fTotal)}</td>
                        <td className="num">{formatCurrency(fOpen)}</td>
                        <td></td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pgn">
                <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
                <div className="pgn-pages">
                  <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                  {Array.from({ length: pages }, (_, i) => i + 1).slice(0, 7).map((p) => (
                    <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                  ))}
                  <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
                </div>
              </div>
            </div>

            <div className="section chart-card g12-7">
              <div className="section-head">
                <div><h2 className="section-title">Bills Paid</h2><div className="section-sub">Vendor bills settled through Striven · {formatCurrency(bp?.total ?? 0)} paid</div></div>
              </div>
              {payments.length > 0 && (
                <div className="paid-banner">
                  <span className="paid-banner-check">✓</span>
                  <span><strong>All settled.</strong> {paidCount === payments.length ? 'Every' : `${paidCount} of ${payments.length}`} recorded bill payment{payments.length === 1 ? ' has' : 's have'} been paid to the vendor.</span>
                </div>
              )}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Vendor</th>
                      <th>Paid from</th>
                      <th>Paid on</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.ref || '—'}</strong></td>
                        <td>{p.vendor || '—'}</td>
                        <td>{p.account || '—'}</td>
                        <td>{fmtDate(p.date)}</td>
                        <td className="num cell-pos">{formatCurrency(p.amount)}</td>
                        <td><PaidBadge status={p.status} /></td>
                      </tr>
                    ))}
                    {payments.length === 0 && (
                      <tr><td colSpan={6} style={{ color: C.muted }}>No bills paid yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Paid</div><div className="v pos">{formatCurrency(bp?.total ?? 0)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Payments</div><div className="v">{(bp?.count ?? 0).toLocaleString()}</div></div>
              </div>
            </div>

            <div className="section chart-card g12-5">
              <div className="section-head"><div><h2 className="section-title">Vendors</h2><div className="section-sub">{vendors?.count ?? 0} suppliers on record · scroll for more</div></div></div>
              <div className="table-wrap" style={{ maxHeight: 430, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Terms</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorRows.map((v) => (
                      <tr key={v.id}>
                        <td><strong>{v.name || '—'}</strong></td>
                        <td><StatusPill status={v.status} /></td>
                        <td>{v.terms || '—'}</td>
                        <td>{formatPhone(v.phone)}</td>
                      </tr>
                    ))}
                    {vendorRows.length === 0 && (
                      <tr><td colSpan={4} style={{ color: C.muted }}>No vendors on record.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {moreVendors > 0 && <div className="muted-note">Showing first {VENDOR_CAP} of {vendors?.vendors.length ?? 0} vendors.</div>}
            </div>
          </div>
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
