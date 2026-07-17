import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenAP, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenBillPayments,
  fetchStrivenOrders, fetchStrivenExceptions,
  type ArResult, type ApResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type BillPaymentsResult,
  type OrdersResult, type ExceptionsResult, type Aging,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C, SERIES, CAT6, AGING, AGING_LABELS, compactMoney, monthLabel, statusTone } from '../chartTheme';
import { ChartCard, BarsLine, LegendDots, DonutList, BarList, GaugeRing } from '../chartKit';

const trunc = (v: string, n = 22) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '•';

// Honest MoM: compare the two most-recent COMPLETE months (never the partial current month).
const nowYm = new Date().toISOString().slice(0, 7);
const momDelta = (series: { month: string; value: number }[]): { pct: number; up: boolean } | null => {
  const done = series.filter((p) => p.month < nowYm && (p.value ?? 0) > 0);
  if (done.length < 2) return null;
  const cur = done[done.length - 1].value, prev = done[done.length - 2].value;
  if (!prev) return null;
  return { pct: Math.round(((cur - prev) / prev) * 100), up: cur >= prev };
};
const completeVals = (series: { month: string; value: number }[]): number[] =>
  series.filter((p) => p.month < nowYm).map((p) => p.value ?? 0);

// 7 KPI hues — reused verbatim as the chart palette so strip + charts read as one system.
type Hue = { from: string; to: string; glow: string };
const HUE = {
  revenue: { from: '#3B82F6', to: '#2563EB', glow: 'rgba(37,99,235,0.28)' } as Hue,
  cash: { from: '#22C55E', to: '#16A34A', glow: 'rgba(22,163,74,0.26)' } as Hue,
  ar: { from: '#14B8A6', to: '#0D9488', glow: 'rgba(13,148,136,0.26)' } as Hue,
  ap: { from: '#A855F7', to: '#7C3AED', glow: 'rgba(124,58,237,0.28)' } as Hue,
  sales: { from: '#FBBF24', to: '#D97706', glow: 'rgba(217,119,6,0.28)' } as Hue,
  po: { from: '#EC4899', to: '#BE185D', glow: 'rgba(190,24,93,0.26)' } as Hue,
  exc: { from: '#FB7185', to: '#E11D48', glow: 'rgba(225,29,72,0.28)' } as Hue,
};

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const w = 72, h = 30, pad = 2;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="ke-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polygon points={`${pad},${h - pad} ${pts} ${w - pad},${h - pad}`} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function KpiExec({ label, value, hue, delta, sub, chip, spark, onClick }: {
  label: string; value: string; hue: Hue;
  delta?: { pct: number; up: boolean } | null; sub?: string; chip?: string; spark?: number[]; onClick?: () => void;
}) {
  return (
    <div
      className={`kpi--exec${onClick ? ' clickable' : ''}`}
      style={{ ['--k-from' as any]: hue.from, ['--k-to' as any]: hue.to, ['--k-glow' as any]: hue.glow }}
      onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="ke-label">{label}</div>
      <div className="ke-row">
        <div className="ke-value">{value}</div>
        {spark && spark.length > 1 && <Spark values={spark} color={hue.to} />}
      </div>
      <div className="ke-delta">
        {delta
          ? <><b className={delta.up ? 'up' : 'down'}>{delta.up ? '▲' : '▼'} {Math.abs(delta.pct)}%</b><span>vs prior month</span></>
          : <span>{sub}</span>}
      </div>
      {chip && <div className="ke-foot"><span className="ke-chip">{chip}</span></div>}
    </div>
  );
}

const INS_TONES: Record<string, { bg: string; fg: string }> = {
  pos: { bg: 'rgba(22,163,74,0.12)', fg: '#16A34A' },
  neg: { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626' },
  brand: { bg: 'rgba(37,99,235,0.10)', fg: '#2563EB' },
  purple: { bg: 'rgba(124,58,237,0.10)', fg: '#7C3AED' },
  teal: { bg: 'rgba(13,148,136,0.10)', fg: '#0D9488' },
};

export function OverviewCharts() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [ap, setAp] = useState<ApResult | null>(null);
  const [pl, setPl] = useState<PlResult | null>(null);
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [trends, setTrends] = useState<TrendsResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [billpay, setBillpay] = useState<BillPaymentsResult | null>(null);
  const [orders, setOrders] = useState<OrdersResult | null>(null);
  const [exc, setExc] = useState<ExceptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, b, p, s, o, t, pay, bp, ord, ex] = await Promise.all([
        fetchStrivenAR(), fetchStrivenAP(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(), fetchStrivenBillPayments().catch(() => null),
        fetchStrivenOrders().catch(() => null), fetchStrivenExceptions().catch(() => null),
      ]);
      setAr(a); setAp(b); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay);
      setBillpay(bp); setOrders(ord); setExc(ex);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Striven data.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const go = (v: string) => () => { location.hash = v; };

  // ---- derived views (real data only) ----
  const revSeries = (trends?.series ?? []).map((s) => ({ month: s.month, value: s.revenue }));
  const cashSeries = (payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount }));
  const revD = momDelta(revSeries);
  const cashD = momDelta(cashSeries);

  // Cash flow: customer payments in vs vendor bill payments out, by month.
  const cashOutBy: Record<string, number> = {};
  for (const r of billpay?.recent ?? []) {
    const m = String(r.date ?? '').slice(0, 7);
    if (m) cashOutBy[m] = (cashOutBy[m] || 0) + r.amount;
  }
  const inBy: Record<string, number> = Object.fromEntries((payments?.byMonth ?? []).map((m) => [m.month, m.amount]));
  const cfMonths = Array.from(new Set([...Object.keys(inBy), ...Object.keys(cashOutBy)])).sort().slice(-12);
  const cashData = cfMonths.map((m) => ({
    month: m, cashIn: inBy[m] || 0, cashOut: Math.round(cashOutBy[m] || 0), net: Math.round((inBy[m] || 0) - (cashOutBy[m] || 0)),
  }));
  const cfIn = cashData.reduce((s, d) => s + d.cashIn, 0);
  const cfOut = cashData.reduce((s, d) => s + d.cashOut, 0);

  // Revenue vs expense with profit line.
  const finData = (trends?.series ?? []).map((s) => ({ month: s.month, revenue: s.revenue, expenses: s.expenses, profit: s.net }));
  const fRev = finData.reduce((s, d) => s + d.revenue, 0);
  const fExp = finData.reduce((s, d) => s + d.expenses, 0);
  const margin = fRev > 0 ? Math.round(((fRev - fExp) / fRev) * 1000) / 10 : 0;

  const collectionPct = pl && pl.revenue > 0 ? Math.round((payments?.total ?? 0) / pl.revenue * 100) : 0;
  const dsoApprox = pl && pl.revenue > 0 ? Math.round((ar?.totalOpen ?? 0) / (pl.revenue / (revSeries.filter((r) => r.value > 0).length * 30 || 30))) : null;

  // Action Center — items derived live from the same datasets.
  const now = Date.now();
  const soon = now + 7 * 86_400_000;
  const overdue = (ar?.invoices ?? []).filter((i) => i.open > 0 && i.dueDate && new Date(i.dueDate).getTime() < now);
  const overdueSum = overdue.reduce((s, i) => s + i.open, 0);
  const billsDue = (ap?.bills ?? []).filter((b) => b.open > 0 && b.dueDate && new Date(b.dueDate).getTime() <= soon);
  const billsDueSum = billsDue.reduce((s, b) => s + b.open, 0);
  const waitingPo = (orders?.orders ?? []).filter((o) => o.pos.length === 0 && !/cancel|void|complete|closed/i.test(o.status));
  type AcItem = { n: string; l1: string; l2: string; view: string; ico: ReactNode };
  const acItems: AcItem[] = [];
  if (overdue.length) acItems.push({ n: String(overdue.length), l1: 'Invoices Overdue', l2: formatCurrency(overdueSum), view: 'receivables', ico: '!' });
  if (billsDue.length) acItems.push({ n: String(billsDue.length), l1: 'Vendor Bills Due', l2: formatCurrency(billsDueSum), view: 'payables', ico: '$' });
  if (waitingPo.length) acItems.push({ n: String(waitingPo.length), l1: 'Sales Orders', l2: 'Waiting for PO', view: 'tracking', ico: '›' });
  if (exc?.totalOpen) acItems.push({ n: String(exc.totalOpen), l1: 'Exceptions', l2: 'Needs Review', view: 'exceptions', ico: '▲' });
  if (cashD && !cashD.up) acItems.push({ n: `${Math.abs(cashD.pct)}%`, l1: 'Collection Drop', l2: 'vs last month', view: 'accounts', ico: '↓' });

  // Aging donuts.
  const agingData = (a: Aging) =>
    AGING_LABELS.map((b, i) => ({ name: b.label, value: Math.round(a[b.key] || 0), color: AGING[i] })).filter((d) => d.value > 0);

  // Sales orders by program (real classification off SO type).
  const programBars = so ? ([
    { name: 'PI', ...so.piva.PI, color: SERIES[0] },
    { name: 'VA', ...so.piva.VA, color: SERIES[1] },
    { name: 'Tri-Care', ...so.piva.TriCare, color: SERIES[2] },
    ...(so.piva.Other.count > 0 ? [{ name: 'Other', ...so.piva.Other, color: SERIES[3] }] : []),
  ].filter((d) => d.count > 0).map((d) => ({ name: d.name, value: d.count, color: d.color, meta: `${d.count} orders` }))) : [];

  // PO spend by vendor (top 5) — slices sum to committed spend.
  const vendorBars = [...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total).slice(0, 5)
    .map((v, i) => ({ name: trunc(v.vendor), value: v.total, color: CAT6[i % CAT6.length] }));

  // Top payers by open AR — payer (law firm / VA / insurer) is the non-PHI
  // counterparty; patient customer names arrive masked.
  const custAgg = new Map<string, number>();
  for (const i of ar?.invoices ?? []) {
    if (i.open <= 0) continue;
    const who = i.payer || i.customer || 'Unassigned';
    custAgg.set(who, (custAgg.get(who) || 0) + i.open);
  }
  const topCust = [...custAgg].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open).slice(0, 5);

  const topVend = [...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total).slice(0, 5);

  // Financial insights — every line computed from the data above.
  const doneRev = (trends?.series ?? []).filter((s) => s.month < nowYm && s.revenue > 0);
  const bestMonth = doneRev.length ? doneRev.reduce((m, s) => (s.revenue > m.revenue ? s : m)) : null;
  type Ins = { tone: keyof typeof INS_TONES; ico: string; text: ReactNode };
  const insights: Ins[] = [];
  if (revD) insights.push({ tone: revD.up ? 'pos' : 'neg', ico: revD.up ? '▲' : '▼', text: <>Revenue {revD.up ? 'increased' : 'decreased'} <b>{Math.abs(revD.pct)}%</b> vs last month</> });
  if (cashD) insights.push({ tone: cashD.up ? 'pos' : 'neg', ico: cashD.up ? '▲' : '▼', text: <>Collections {cashD.up ? 'up' : 'dropped'} <b>{Math.abs(cashD.pct)}%</b> vs last month</> });
  if (bestMonth) insights.push({ tone: 'brand', ico: '★', text: <>Highest revenue month: <b>{monthLabel(bestMonth.month)}</b> ({compactMoney(bestMonth.revenue)})</> });
  if (pl?.avgInvoice) insights.push({ tone: 'purple', ico: '$', text: <>Avg invoice value <b>{formatCurrency(pl.avgInvoice)}</b></> });
  if (topCust[0]) insights.push({ tone: 'teal', ico: '◆', text: <>Top AR payer: <b>{trunc(topCust[0].name, 18)}</b> ({formatCurrency(topCust[0].open)} open)</> });

  // Recent activity — a few of each stream (payments / orders / POs) so one
  // busy source can't crowd out the others; merged newest first.
  type Act = { date: string | null; bg: string; fg: string; ico: string; text: ReactNode; amt: string; cls?: string };
  const money0 = (n: number) => (n > 0 ? formatCurrency(n) : '—');
  const acts: Act[] = [
    ...(payments?.recent ?? []).slice(0, 4).map((r): Act => ({
      date: r.date, bg: 'rgba(22,163,74,0.12)', fg: '#16A34A', ico: '$',
      text: <>Payment <b>{r.ref}</b> received{r.customer ? <> from <b>{trunc(r.customer, 24)}</b></> : null}</>,
      amt: `+${formatCurrency(r.amount)}`, cls: 'pos',
    })),
    ...(so?.recent ?? []).slice(0, 3).map((r): Act => ({
      date: r.date, bg: 'rgba(37,99,235,0.10)', fg: '#2563EB', ico: '›',
      text: <>Sales Order <b>{r.ref}</b> created · {r.type || 'order'}</>, amt: money0(r.value),
    })),
    ...(po?.recent ?? []).slice(0, 3).map((r): Act => ({
      date: r.date, bg: 'rgba(124,58,237,0.10)', fg: '#7C3AED', ico: '◧',
      text: <>PO <b>{r.ref}</b> · {trunc(r.vendor, 22)}</>, amt: money0(r.total),
    })),
  ].filter((a) => a.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);

  // Pending approvals — POs whose status reads as pending/awaiting.
  const approvals = (po?.recent ?? []).filter((r) => statusTone(r.status || '') === 'warn').slice(0, 6);

  const excGroups = exc ? [...exc.groups].sort((a, b) => b.count - a.count).slice(0, 6) : [];

  const ready = ar && ap && pl && payments && so && po && trends;
  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fy = new Date().getFullYear();

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Financial Overview</h1>
          <div className="page-sub">Executive Summary Dashboard · Sports Med Recovery</div>
        </div>
        <div className="ov-headright">
          <span className="deck-pill"><span className="live-dot" /> Live sync</span>
          <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
          <button className="ov-bell" onClick={go('exceptions')} aria-label="Notifications" title="Items needing attention">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 20a2 2 0 0 1-3.4 0" />
            </svg>
            {acItems.length > 0 && <span className="bell-badge">{acItems.length}</span>}
          </button>
        </div>
      </div>

      <div className="ov-filters">
        <span className="ov-filter"><span className="fl">Fiscal Year</span><b>FY{fy}</b></span>
        <span className="ov-filter"><span className="fl">As of</span><b>{asOf}</b></span>
        <span className="ov-filter"><span className="fl">Programs</span><b>PI · VA · Tri-Care</b></span>
        <span className="ov-filter"><span className="fl">🔒</span><b>PHI masked</b></span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          {acItems.length > 0 && (
            <div className="action-center">
              <div className="ac-head">
                <span className="ac-flag">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3 2.8 19.2a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><line x1="12" y1="17.2" x2="12" y2="17.3" />
                  </svg>
                </span>
                <div>
                  <div className="t">Action Center</div>
                  <div className="s">Items that need your attention</div>
                </div>
              </div>
              <div className="ac-items">
                {acItems.map((it) => (
                  <button key={it.l1 + it.l2} className="ac-item" onClick={go(it.view)}>
                    <span className="ico">{it.ico}</span>
                    <span>
                      <span className="n">{it.n}</span>
                      <span className="l" style={{ display: 'block' }}>{it.l1}<br />{it.l2}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button className="ac-review" onClick={go('exceptions')}>Review All</button>
            </div>
          )}

          <div className="kpi-strip">
            <KpiExec label="Revenue YTD" value={formatCurrency(pl.revenue)} hue={HUE.revenue}
              delta={revD} sub="invoiced this year" spark={completeVals(revSeries)} chip={`${pl.invoiceCount} invoices`} onClick={go('pl')} />
            <KpiExec label="Cash Received" value={formatCurrency(payments.total)} hue={HUE.cash}
              delta={cashD} sub="customer payments" spark={completeVals(cashSeries)} chip={`${payments.count} payments`} onClick={go('accounts')} />
            <KpiExec label="AR Open" value={formatCurrency(ar.totalOpen)} hue={HUE.ar}
              sub={`${ar.count} unpaid invoices`} chip={dsoApprox != null ? `Avg DSO: ${dsoApprox} days` : undefined} onClick={go('receivables')} />
            <KpiExec label="AP Open" value={formatCurrency(ap.totalOpen)} hue={HUE.ap}
              sub="unpaid bills" chip={`${ap.count} bills`} onClick={go('payables')} />
            <KpiExec label="Sales Orders" value={formatCurrency(so.totalValue)} hue={HUE.sales}
              sub="order book (not revenue)" chip={`${so.count} orders`} onClick={go('orders')} />
            <KpiExec label="PO Spend" value={formatCurrency(po.totalValue)} hue={HUE.po}
              sub="committed · active only" chip={`${po.count} POs`} onClick={go('tracking')} />
            <KpiExec label="Open Exceptions" value={String(exc?.totalOpen ?? 0)} hue={HUE.exc}
              sub="data-quality items" chip="Needs review" onClick={go('exceptions')} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="Cash Flow Overview" sub="Customer payments in vs vendor bill payments out · monthly">
              <LegendDots items={[{ name: 'Cash In', color: C.positive }, { name: 'Cash Out', color: C.negative }, { name: 'Net Cash', color: C.brand }]} />
              <BarsLine data={cashData}
                bars={[{ key: 'cashIn', name: 'Cash In', color: C.positive }, { key: 'cashOut', name: 'Cash Out', color: C.negative }]}
                line={{ key: 'net', name: 'Net Cash', color: C.brand }} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Cash In</div><div className="v pos">{formatCurrency(cfIn)}</div></div>
                <div className="cf-i"><div className="l">Cash Out</div><div className="v neg">{formatCurrency(cfOut)}</div></div>
                <div className="cf-i"><div className="l">Net Cash</div><div className="v accent">{formatCurrency(cfIn - cfOut)}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-4" title="Revenue vs Expense" sub="Invoiced revenue vs billed expenses · monthly">
              <LegendDots items={[{ name: 'Revenue', color: C.positive }, { name: 'Expense', color: C.negative }, { name: 'Profit', color: C.brand }]} />
              <BarsLine data={finData}
                bars={[{ key: 'revenue', name: 'Revenue', color: C.positive }, { key: 'expenses', name: 'Expense', color: C.negative }]}
                line={{ key: 'profit', name: 'Profit', color: C.brand }} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Revenue</div><div className="v pos">{formatCurrency(fRev)}</div></div>
                <div className="cf-i"><div className="l">Expense</div><div className="v neg">{formatCurrency(fExp)}</div></div>
                <div className="cf-i"><div className="l">Profit</div><div className="v accent">{formatCurrency(fRev - fExp)}</div></div>
                <div className="cf-i"><div className="l">Margin</div><div className="v">{margin}%</div></div>
              </div>
            </ChartCard>

            <div className="exec-rail">
              <div className="section chart-card">
                <div className="section-head"><div><h2 className="section-title">Top Payers (by AR)</h2><div className="section-sub">Largest open balances</div></div></div>
                <div className="rank-list">
                  {topCust.map((c) => (
                    <div key={c.name} className="rk-row">
                      <span className="rk-ico">{initials(c.name)}</span>
                      <span className="rk-name" title={c.name}>{trunc(c.name, 26)}</span>
                      <span className="rk-val">{formatCurrency(c.open)}</span>
                    </div>
                  ))}
                  {topCust.length === 0 && <div className="muted-note">No open receivables.</div>}
                </div>
                <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }} onClick={go('receivables')}>View all receivables →</button>
              </div>

              <div className="section chart-card">
                <div className="section-head"><div><h2 className="section-title">Top Vendors (by Spend)</h2><div className="section-sub">Committed PO spend</div></div></div>
                <div className="rank-list">
                  {topVend.map((v) => (
                    <div key={v.vendor} className="rk-row">
                      <span className="rk-ico" style={{ background: 'rgba(124,58,237,0.10)', color: '#7C3AED' }}>{initials(v.vendor)}</span>
                      <span className="rk-name" title={v.vendor}>{trunc(v.vendor, 26)}</span>
                      <span className="rk-val">{formatCurrency(v.total)}</span>
                    </div>
                  ))}
                  {topVend.length === 0 && <div className="muted-note">No active POs.</div>}
                </div>
                <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }} onClick={go('vendors')}>View all vendors →</button>
              </div>

              <div className="section chart-card">
                <div className="section-head"><div><h2 className="section-title">Financial Insights</h2><div className="section-sub">Computed from live data</div></div></div>
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

            <ChartCard className="g12-3" title="Collection Rate" sub="Cash received ÷ revenue YTD">
              <GaugeRing value={collectionPct} centerValue={`${collectionPct}%`} centerLabel="Collected" color={C.positive} height={150} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Collected</div><div className="v pos">{formatCurrency(payments.total)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Outstanding</div><div className="v">{formatCurrency(ar.totalOpen)}</div></div>
              </div>
              <div className="cfoot" style={{ marginTop: 0 }}>
                <div className="cf-i"><div className="l">vs Last Month</div><div className={`v ${cashD ? (cashD.up ? 'pos' : 'neg') : ''}`}>{cashD ? `${cashD.up ? '▲' : '▼'} ${Math.abs(cashD.pct)}%` : '—'}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">DSO</div><div className="v">{dsoApprox != null ? `${dsoApprox} days` : '—'}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-3" title="AR Aging Summary" sub="Open receivables · days past due">
              <DonutList data={agingData(ar.aging)} totalLabel="Total" />
            </ChartCard>

            <ChartCard className="g12-3" title="AP Aging Summary" sub="Open bills · days past due">
              <DonutList data={agingData(ap.aging)} totalLabel="Total" />
            </ChartCard>

            <ChartCard className="g12-6" title="Sales Orders by Program" sub={`${so.count} orders · PI / VA / Tri-Care split`}>
              <BarList data={programBars} money={false} onSelect={go('orders')} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Orders</div><div className="v">{so.count.toLocaleString()}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Order Book</div><div className="v accent">{formatCurrency(so.totalValue)}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-6" title="PO Spend by Vendor (Top 5)" sub="Committed spend · active POs only">
              <BarList data={vendorBars} showPct={false} onSelect={go('tracking')} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Spend</div><div className="v">{formatCurrency(po.totalValue)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Active POs</div><div className="v accent">{po.count.toLocaleString()}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-5" title="Recent Activity" sub="Payments · orders · POs"
              right={<button className="card-link" style={{ marginTop: 0 }} onClick={go('accounts')}>View all →</button>}>
              <div className="act-list">
                {acts.map((a, i) => (
                  <div key={i} className="act-row">
                    <span className="act-time">{shortDate(a.date)}</span>
                    <span className="act-ico" style={{ background: a.bg, color: a.fg }}>{a.ico}</span>
                    <span className="act-text">{a.text}</span>
                    <span className={`act-amt${a.cls ? ` ${a.cls}` : ''}`}>{a.amt}</span>
                  </div>
                ))}
                {acts.length === 0 && <div className="muted-note">No recent activity.</div>}
              </div>
            </ChartCard>

            <ChartCard className="g12-4" title="Pending Approvals" sub="POs awaiting action"
              right={<button className="card-link" style={{ marginTop: 0 }} onClick={go('orders')}>View all →</button>}>
              {approvals.length ? (
                <div className="appr-list">
                  {approvals.map((r) => (
                    <div key={r.id} className="appr-row">
                      <div className="appr-main">
                        <div className="t">{r.ref} · {trunc(r.vendor, 24)}</div>
                        <div className="s">{shortDate(r.date)}</div>
                      </div>
                      <span className="appr-amt">{formatCurrency(r.total)}</span>
                      <StatusPill status={r.status || 'Pending'} />
                    </div>
                  ))}
                </div>
              ) : <div className="qb-placeholder"><span className="qb-icon">✓</span>Nothing awaiting approval</div>}
            </ChartCard>

            <ChartCard className="g12-3" title="Exceptions" sub={`${exc?.totalOpen ?? 0} data-quality items`}
              right={<button className="card-link" style={{ marginTop: 0 }} onClick={go('exceptions')}>View all →</button>}>
              {excGroups.length ? (
                <div className="exc-list">
                  {excGroups.map((g) => (
                    <div key={g.key} className="exc-row" onClick={go('exceptions')}>
                      <span className={`exc-badge ${g.severity}`}>{g.count}</span>
                      <span className="exc-title" title={g.title}>{g.title}</span>
                      <span className="exc-val">{g.value ? formatCurrency(g.value) : ''}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="qb-placeholder"><span className="qb-icon">✓</span>No open exceptions</div>}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
