import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenPayments, fetchStrivenCustomers, fetchStrivenPL,
  type ArResult, type PaymentsResult, type CustomersResult, type PlResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C, AGING, AGING_LABELS, programOfPayer, type Program } from '../chartTheme';
import { ChartCard, AgingBar, TrendArea, DrillModal, GaugeRing, KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const trunc = (v: string, n = 24) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '•';

// Honest MoM on complete months only (never the partial current month).
const nowYm = new Date().toISOString().slice(0, 7);
const momDelta = (series: { month: string; value: number }[]): { pct: number; up: boolean } | null => {
  const done = series.filter((p) => p.month < nowYm && (p.value ?? 0) > 0);
  if (done.length < 2) return null;
  const cur = done[done.length - 1].value, prev = done[done.length - 2].value;
  if (!prev) return null;
  return { pct: Math.round(((cur - prev) / prev) * 100), up: cur >= prev };
};

const daysPast = (dueDate: string | null): number => {
  if (!dueDate) return 0;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.floor((Date.now() - due) / 86_400_000);
};
// Bucket labels match AGING_LABELS so bars/filters line up with Striven's aging.
const bucketOf = (dueDate: string | null): string => {
  const d = daysPast(dueDate);
  if (d <= 0) return 'Current';
  if (d <= 30) return '1–30';
  if (d <= 60) return '31–60';
  if (d <= 90) return '61–90';
  return '90+';
};

const INS_TONES: Record<string, { bg: string; fg: string }> = {
  pos: { bg: 'rgba(22,163,74,0.12)', fg: '#16A34A' },
  neg: { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626' },
  brand: { bg: 'rgba(37,99,235,0.10)', fg: '#2563EB' },
  warn: { bg: 'rgba(217,119,6,0.12)', fg: '#D97706' },
};

type SortKey = 'due' | 'total' | 'open' | 'days';
const PAGE_SIZE = 8;

export function ReceivablesTab() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [customers, setCustomers] = useState<CustomersResult | null>(null);
  const [pl, setPl] = useState<PlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);

  // Dynamic controls.
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [payRange, setPayRange] = useState<'year' | '6mo'>('year');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 });
  const [page, setPage] = useState(1);
  const [bucketFilter, setBucketFilter] = useState<string>('All');
  const [progFilter, setProgFilter] = useState<'All' | Program>('All');
  const [query, setQuery] = useState('');
  const tableRef = useRef<HTMLDivElement | null>(null);

  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [a, pay, cust, p] = await Promise.all([
        fetchStrivenAR(), fetchStrivenPayments(), fetchStrivenCustomers(), fetchStrivenPL().catch(() => null),
      ]);
      setAr(a); setPayments(pay); setCustomers(cust); setPl(p);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load Receivables data.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const invoices = ar?.invoices ?? [];
  const cashSeries = (payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount }));
  const cashD = momDelta(cashSeries);

  // DSO ≈ open AR ÷ average daily invoiced revenue.
  const revMonths = (pl?.series ?? []).filter((s) => s.revenue > 0).length;
  const dso = pl && pl.revenue > 0 ? Math.round((ar?.totalOpen ?? 0) / (pl.revenue / ((revMonths || 1) * 30))) : null;

  // Collection effectiveness = collected ÷ (collected + still open). Real, explainable.
  const collected = payments?.total ?? 0;
  const healthPct = collected + (ar?.totalOpen ?? 0) > 0 ? Math.round((collected / (collected + (ar?.totalOpen ?? 0))) * 100) : 0;
  const healthBand = healthPct >= 90 ? 'Excellent' : healthPct >= 75 ? 'Good' : healthPct >= 60 ? 'Fair' : 'Low';
  const healthColor = healthPct >= 75 ? C.positive : healthPct >= 60 ? '#D97706' : C.negative;

  // Aging by count (invoices per bucket) for the toggle.
  const agingCount = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const keyOf: Record<string, string> = { Current: 'current', '1–30': 'd1_30', '31–60': 'd31_60', '61–90': 'd61_90', '90+': 'd90plus' };
    for (const i of invoices) m[keyOf[bucketOf(i.dueDate)]] += 1;
    return m;
  }, [invoices]);

  const overdueRows = AGING_LABELS.filter((b) => b.key !== 'current')
    .map((b, i) => ({ label: `${b.label} days`, value: ar?.aging[b.key] || 0, color: AGING[i + 1] }));
  const totalOverdue = overdueRows.reduce((s, r) => s + r.value, 0);

  // Top payers by open balance.
  const topPayers = useMemo(() => {
    const agg = new Map<string, number>();
    for (const i of invoices) {
      if (i.open <= 0) continue;
      const who = i.payer || i.customer || 'Unassigned';
      agg.set(who, (agg.get(who) || 0) + i.open);
    }
    return [...agg].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open).slice(0, 5);
  }, [invoices]);

  // Insights — all computed from live data above.
  const biggestBucket = overdueRows.slice().sort((a, b) => b.value - a.value)[0];
  const insights: { tone: keyof typeof INS_TONES; ico: string; text: ReactNode }[] = [];
  if (cashD) insights.push({ tone: cashD.up ? 'pos' : 'neg', ico: cashD.up ? '▲' : '▼', text: <>Collections {cashD.up ? 'increased' : 'dropped'} <b>{Math.abs(cashD.pct)}%</b> vs last month</> });
  if (biggestBucket && biggestBucket.value > 0) insights.push({ tone: 'warn', ico: '!', text: <><b>{biggestBucket.label}</b> overdue is the largest bucket ({formatCurrency(biggestBucket.value)})</> });
  if (dso != null) insights.push({ tone: 'brand', ico: '◷', text: <>DSO is <b>{dso} days</b> (open AR ÷ avg daily revenue)</> });
  if ((ar?.unappliedCredits ?? 0) > 0.005) insights.push({ tone: 'warn', ico: '$', text: <><b>{formatCurrency(ar!.unappliedCredits!)}</b> paid but unapplied — netted out of AR</> });
  if (topPayers[0]) insights.push({ tone: 'pos', ico: '◆', text: <>Top balance: <b>{trunc(topPayers[0].name, 20)}</b> ({formatCurrency(topPayers[0].open)})</> });

  // Open-invoices table: filter → sort → paginate.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invoices.filter((i) =>
      (bucketFilter === 'All' || bucketOf(i.dueDate) === bucketFilter) &&
      (progFilter === 'All' || programOfPayer(i.payer || i.customer) === progFilter) &&
      (!q || String(i.number).toLowerCase().includes(q) || (i.payer || '').toLowerCase().includes(q)));
  }, [invoices, bucketFilter, progFilter, query]);
  const sorted = useMemo(() => {
    const v = (i: typeof invoices[number]): number => sort.key === 'total' ? i.total : sort.key === 'open' ? i.open
      : sort.key === 'days' ? daysPast(i.dueDate) : (i.dueDate ? new Date(i.dueDate).getTime() : 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const fTotal = filtered.reduce((s, i) => s + (i.total || 0), 0);
  const fOpen = filtered.reduce((s, i) => s + (i.open || 0), 0);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  const payRows = payments?.recent ?? [];
  const payShown = payRows.slice(0, 8);
  const payData = (payments?.byMonth ?? []).slice(payRange === '6mo' ? -6 : -12).map((m) => ({ month: m.month, amount: m.amount }));

  // Drills (tap-to-explain KPIs + aging bars + payments view-all).
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const explainAr = () => setDrill({
    title: 'AR Open', sub: 'Sum of every open invoice’s remaining balance, split by days past due',
    ...kv([...AGING_LABELS.map((b) => ({ k: `${b.label}`, v: formatCurrency(ar?.aging[b.key] || 0) })), { k: 'Total', v: formatCurrency(ar?.totalOpen || 0) }]),
  });
  const explainCash = () => setDrill({
    title: 'Cash Received', sub: 'Customer payments recorded in Striven — money actually in the door',
    ...kv([{ k: 'Payments recorded', v: String(payments?.count ?? 0) }, { k: 'Total received', v: formatCurrency(collected) }]),
  });
  const explainDso = () => setDrill({
    title: 'Days Sales Outstanding', sub: 'Open AR ÷ average daily invoiced revenue',
    ...kv([{ k: 'Open AR', v: formatCurrency(ar?.totalOpen || 0) }, { k: 'Revenue (period)', v: formatCurrency(pl?.revenue || 0) }, { k: 'DSO', v: dso != null ? `${dso} days` : '—' }]),
  });
  const drillBucket = (label: string) => setDrill({
    title: `Open Invoices · ${label}`, sub: `${invoices.filter((i) => bucketOf(i.dueDate) === label).length} invoices in this bucket`,
    columns: [{ key: 'n', label: 'Invoice #' }, { key: 'p', label: 'Payer' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
    rows: invoices.filter((i) => bucketOf(i.dueDate) === label).sort((a, b) => b.open - a.open)
      .map((i) => ({ n: `#${i.number}`, p: i.payer || '—', d: fmtDate(i.dueDate), o: formatCurrency(i.open) })),
  });
  const viewAllPayments = () => setDrill({
    title: 'Recent Payments', sub: `${payRows.length} latest customer payments`,
    columns: [{ key: 'r', label: 'Payment Ref' }, { key: 'd', label: 'Date' }, { key: 'a', label: 'Amount', num: true }, { key: 's', label: 'Status' }],
    rows: payRows.map((p) => ({ r: p.ref, d: fmtDate(p.date), a: formatCurrency(p.amount), s: <StatusPill status={p.status} /> })),
  });

  const today = new Date();
  const rangeChip = `${new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Receivables</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven{agoText ? ` · updated ${agoText}` : ''}
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark }}>🔒 PHI masked</span>
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{rangeChip}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ar && payments && customers && (
        <>
          <div className="kpi-r-strip">
            <KpiR ico="doc" tint="#2563EB" label="AR Open" value={ar.totalOpen} format={formatCurrency}
              deltaText={`${ar.count} open invoices`} foot="excludes voided invoices" onClick={explainAr} />
            <KpiR ico="clip" tint="#16A34A" label="Open Invoices" value={ar.count}
              deltaText="awaiting payment" foot="matches Striven A/R aging" />
            <KpiR ico="cash" tint="#059669" label="Cash Received" value={payments.total} format={formatCurrency}
              delta={cashD} foot={`${payments.count} payments`} onClick={explainCash} />
            <KpiR ico="users" tint="#7C3AED" label="Accounts" value={customers.count}
              deltaText={`${customers.customers.filter((c) => /active/i.test(c.status)).length} active`} foot="on record" />
            <KpiR ico="clock" tint="#D97706" label="Days Sales Outstanding" value={dso ?? 0}
              format={(n) => `${Math.round(n)} days`} deltaText="avg collection period" foot="open AR ÷ daily revenue" onClick={explainDso} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="AR Aging" sub="Open receivables by days past due · click a bar"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
                  <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
                </div>
              }>
              <AgingBar aging={agingMode === 'amount' ? ar.aging : agingCount} money={agingMode === 'amount'} onSelect={drillBucket} />
            </ChartCard>

            <ChartCard className="g12-4" title="Cash Received by Month" sub="Customer payments collected"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={payRange === 'year' ? 'active' : ''} onClick={() => setPayRange('year')}>12 mo</button>
                  <button className={payRange === '6mo' ? 'active' : ''} onClick={() => setPayRange('6mo')}>6 mo</button>
                </div>
              }>
              <TrendArea data={payData} idPrefix="rc-pay" series={[{ key: 'amount', name: 'Received', color: C.brand }]} />
            </ChartCard>

            <ChartCard className="g12-3" title="A/R Health Score" sub="Collected ÷ (collected + open AR)">
              <div className="card-body">
                <GaugeRing arc="semi" value={healthPct} centerValue={String(healthPct)} centerLabel={healthBand} color={healthColor} height={150} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Target</div><div className="v">90+</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Collected</div><div className="v pos">{formatCurrency(collected)}</div></div>
              </div>
            </ChartCard>

            <div className="section chart-card g12-4">
              <div className="section-head"><div><h2 className="section-title">Overdue Summary</h2><div className="section-sub">Past-due receivables by bucket</div></div></div>
              <div className="card-body" style={{ justifyContent: 'flex-start' }}>
                <div className="rank-list">
                  {overdueRows.map((r) => (
                    <div key={r.label} className="rk-row" style={{ cursor: 'pointer' }} onClick={() => drillBucket(r.label.replace(' days', ''))}>
                      <span className="donut-dot" style={{ background: r.color }} />
                      <span className="rk-name">{r.label}</span>
                      <span className="rk-val">{formatCurrency(r.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Overdue</div><div className="v neg">{formatCurrency(totalOverdue)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Current (not due)</div><div className="v pos">{formatCurrency(ar.aging.current || 0)}</div></div>
              </div>
            </div>

            <div className="section chart-card g12-4">
              <div className="section-head"><div><h2 className="section-title">Top Customers (by Balance)</h2><div className="section-sub">Payer · largest open balances</div></div></div>
              <div className="rank-list">
                {topPayers.map((c) => (
                  <div key={c.name} className="rk-row">
                    <span className="rk-ico">{initials(c.name)}</span>
                    <span className="rk-name" title={c.name}>{trunc(c.name, 26)}</span>
                    <span className="rk-val">{formatCurrency(c.open)}</span>
                  </div>
                ))}
                {topPayers.length === 0 && <div className="muted-note">No open balances.</div>}
              </div>
              <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }}
                onClick={() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>View all customers →</button>
            </div>

            <div className="section chart-card g12-4 g12-w">
              <div className="section-head"><div><h2 className="section-title">Insights</h2><div className="section-sub">Computed from live data</div></div></div>
              <div className="card-body" style={{ justifyContent: 'flex-start' }}>
                <div className="ins-list">
                  {insights.map((ins, i) => (
                    <div key={i} className="ins-item">
                      <span className="ins-dot" style={{ background: INS_TONES[ins.tone].bg, color: INS_TONES[ins.tone].fg }}>{ins.ico}</span>
                      <span>{ins.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="section chart-card g12-7" ref={tableRef}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">Open Invoices</h2>
                  <div className="section-sub">
                    Unpaid invoices with a remaining balance — matches Striven's A/R aging
                    {(ar.unappliedCredits ?? 0) > 0.005 && <> · <span style={{ color: '#047857', fontWeight: 700 }}>{formatCurrency(ar.unappliedCredits!)}</span> unapplied netted out</>}
                  </div>
                </div>
                <div className="tbl-controls">
                  <input className="tbl-search" placeholder="Search payer / invoice #" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  <select className="tbl-select" value={bucketFilter} onChange={(e) => { setBucketFilter(e.target.value); setPage(1); }}>
                    {['All', 'Current', '1–30', '31–60', '61–90', '90+'].map((b) => <option key={b} value={b}>{b === 'All' ? 'All buckets' : b}</option>)}
                  </select>
                  <select className="tbl-select" value={progFilter} onChange={(e) => { setProgFilter(e.target.value as 'All' | Program); setPage(1); }}>
                    <option value="All">All programs</option>
                    <option value="PI">PI</option>
                    <option value="VA">VA</option>
                    <option value="TriCare">Tri-Care</option>
                    <option value="Unassigned">Unassigned</option>
                  </select>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice #</th>
                      <th>Payer</th>
                      <th className="sortable" onClick={() => setSortKey('due')}>Due Date {sortInd('due')}</th>
                      <th className="num sortable" onClick={() => setSortKey('total')}>Total {sortInd('total')}</th>
                      <th className="num">Received</th>
                      <th className="num sortable" onClick={() => setSortKey('open')}>Open Balance {sortInd('open')}</th>
                      <th className="num sortable" onClick={() => setSortKey('days')}>Days Past Due {sortInd('days')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((inv) => {
                      const recv = (inv.total || 0) - (inv.open || 0);
                      const d = daysPast(inv.dueDate);
                      return (
                        <tr key={inv.id}>
                          <td>
                            <strong>#{inv.number}</strong>
                            {recv > 0.005 && <span className="pill-tag tag-ok" style={{ marginLeft: 8, fontSize: 10.5 }}>part-paid</span>}
                          </td>
                          <td>{inv.payer || '—'}</td>
                          <td>{fmtDate(inv.dueDate)}</td>
                          <td className="num">{formatCurrency(inv.total)}</td>
                          <td className="num cell-pos">{recv > 0.005 ? formatCurrency(recv) : '—'}</td>
                          <td className="num cell-neg">{formatCurrency(inv.open)}</td>
                          <td className="num cell-neg">{d > 0 ? d : '—'}</td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr><td colSpan={7} style={{ color: C.muted }}>No invoices match.</td></tr>
                    )}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td colSpan={3}>TOTAL</td>
                        <td className="num">{formatCurrency(fTotal)}</td>
                        <td className="num">{formatCurrency(fTotal - fOpen)}</td>
                        <td className="num">{formatCurrency(fOpen)}</td>
                        <td />
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

            <div className="section chart-card g12-5">
              <div className="section-head">
                <div><h2 className="section-title">Recent Payments</h2><div className="section-sub">Latest customer payments received</div></div>
                <button className="card-link" style={{ marginTop: 0 }} onClick={viewAllPayments}>View All →</button>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payment Ref</th>
                      <th>Date</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payShown.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.ref || '—'}</strong></td>
                        <td>{fmtDate(p.date)}</td>
                        <td className="num cell-pos">{formatCurrency(p.amount)}</td>
                        <td><StatusPill status={p.status} /></td>
                      </tr>
                    ))}
                    {payShown.length === 0 && (
                      <tr><td colSpan={4} style={{ color: C.muted }}>No recent payments.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Received</div><div className="v pos">{formatCurrency(collected)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Payments</div><div className="v">{(payments.count).toLocaleString()}</div></div>
              </div>
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
