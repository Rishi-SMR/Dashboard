import { useEffect, useState } from 'react';
import {
  fetchStrivenAR, fetchStrivenAP, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenCustomers, fetchStrivenVendors,
  fetchStrivenItems, fetchStrivenOrders, fetchStrivenExceptions,
  type ArResult, type ApResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type CustomersResult,
  type VendorsResult, type ItemsResult, type OrdersResult, type ExceptionsResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C, SERIES, CAT6, compactMoney } from '../chartTheme';
import { ChartCard, RankBar, AgingBar, TrendArea, GroupedBars, Donut, GaugeRing, DrillModal } from '../chartKit';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const trunc = (v: string, n = 16) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const bucketOf = (dueDate: string | null): string => {
  const now = Date.now();
  const due = dueDate ? new Date(dueDate).getTime() : now;
  const d = Math.floor((now - due) / 86_400_000);
  if (d <= 0) return 'Current';
  if (d <= 30) return '1–30';
  if (d <= 60) return '31–60';
  if (d <= 90) return '61–90';
  return '90+';
};

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

// 7 KPI hues — reuse the shipped chart palette so cards + charts read as one system.
type Hue = { from: string; to: string; glow: string };
const HUE = {
  purple: { from: '#8B5CF6', to: '#5A2FCE', glow: 'rgba(139,92,246,.45)' } as Hue,
  blue: { from: '#5B8DEF', to: '#2E5FD0', glow: 'rgba(91,141,239,.45)' } as Hue,
  teal: { from: '#2ED3E8', to: '#0E9BB8', glow: 'rgba(46,211,232,.42)' } as Hue,
  green: { from: '#86E05C', to: '#3C8A18', glow: 'rgba(134,224,92,.42)' } as Hue,
  orange: { from: '#F7B24C', to: '#EA6A0C', glow: 'rgba(247,178,76,.42)' } as Hue,
  violet: { from: '#B58CFB', to: '#7C3AED', glow: 'rgba(181,140,251,.45)' } as Hue,
  red: { from: '#FB7793', to: '#E11D48', glow: 'rgba(251,119,147,.45)' } as Hue,
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 74, h = 26, pad = 2;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="k-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.92)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function KpiGrad({ label, value, period, hue, delta, chip, spark, onClick }: {
  label: string; value: string; period: string; hue: Hue;
  delta?: { pct: number; up: boolean } | null; chip?: string; spark?: number[]; onClick?: () => void;
}) {
  return (
    <div
      className={`kpi--grad${onClick ? ' clickable' : ''}`}
      style={{ ['--k-from' as any]: hue.from, ['--k-to' as any]: hue.to, ['--k-glow' as any]: hue.glow }}
      onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
      <div className="k-period">{period}</div>
      {delta ? (
        <span className={`k-delta${delta.up ? '' : ' down'}`}>{delta.up ? '▲' : '▼'} {Math.abs(delta.pct)}% MoM</span>
      ) : chip ? (
        <span className="k-delta">{chip}</span>
      ) : null}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  );
}

type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, React.ReactNode>[] };

export function OverviewCharts() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [ap, setAp] = useState<ApResult | null>(null);
  const [pl, setPl] = useState<PlResult | null>(null);
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [trends, setTrends] = useState<TrendsResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [customers, setCustomers] = useState<CustomersResult | null>(null);
  const [vendors, setVendors] = useState<VendorsResult | null>(null);
  const [items, setItems] = useState<ItemsResult | null>(null);
  const [orders, setOrders] = useState<OrdersResult | null>(null);
  const [exc, setExc] = useState<ExceptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, b, p, s, o, t, pay, cust, ven, it, ord, ex] = await Promise.all([
        fetchStrivenAR(), fetchStrivenAP(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(), fetchStrivenCustomers(), fetchStrivenVendors(),
        fetchStrivenItems(), fetchStrivenOrders(), fetchStrivenExceptions(),
      ]);
      setAr(a); setAp(b); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay);
      setCustomers(cust); setVendors(ven); setItems(it); setOrders(ord); setExc(ex);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Striven data.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const go = (v: string) => () => { location.hash = v; };

  // ---- derived views (real data only) ----
  const revSeries = (trends?.series ?? []).map((s) => ({ month: s.month, value: s.revenue }));
  const cashSeries = (payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount }));
  const finData = (trends?.series ?? []).map((s) => ({ month: s.month, revenue: s.revenue, expenses: s.expenses }));

  const soData = [...(so?.byStatus ?? [])].sort((x, y) => y.count - x.count).map((s) => ({ name: s.status, value: s.count }));
  const collectionPct = pl && pl.revenue > 0 ? Math.round((payments?.total ?? 0) / pl.revenue * 100) : 0;
  const dsoApprox = pl && pl.revenue > 0 ? Math.round((ar?.totalOpen ?? 0) / (pl.revenue / (revSeries.filter((r) => r.value > 0).length * 30 || 30))) : null;

  // Sales orders by program (PI / VA / Tri-Care) — real classification off SO type.
  const programDonut = so ? ([
    { name: 'PI', value: so.piva.PI.value, color: SERIES[0] },
    { name: 'VA', value: so.piva.VA.value, color: SERIES[1] },
    { name: 'Tri-Care', value: so.piva.TriCare.value, color: SERIES[2] },
    ...(so.piva.Other.value > 0 ? [{ name: 'Other', value: so.piva.Other.value, color: SERIES[3] }] : []),
  ].filter((d) => d.value > 0)) : [];

  // PO spend by vendor (top 5 + Other) — honest: slices sum to committed spend.
  const sortedV = [...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total);
  const restV = sortedV.slice(5).reduce((s, v) => s + v.total, 0);
  const vendorDonut = sortedV.slice(0, 5).map((v, i) => ({ name: trunc(v.vendor), value: v.total, color: CAT6[i] }))
    .concat(restV > 0 ? [{ name: 'Other vendors', value: restV, color: C.muted }] : []);

  // Order chain funnel (live from linked cache).
  const chainTotal = orders?.count ?? 0;
  const chainPo = (orders?.orders ?? []).filter((o) => o.pos.length > 0).length;
  const chainInv = (orders?.orders ?? []).filter((o) => o.invoices.length > 0).length;

  // ---- drills ----
  const drillAging = (label: string) => setDrill({
    title: `AR Aging · ${label}`, sub: `Open invoices ${label} days past due`,
    columns: [{ key: 'inv', label: 'Invoice' }, { key: 'due', label: 'Due' }, { key: 'open', label: 'Open', num: true }],
    rows: (ar?.invoices ?? []).filter((i) => i.open > 0 && bucketOf(i.dueDate) === label).map((i) => ({ inv: `#${i.number}`, due: fmtDate(i.dueDate), open: formatCurrency(i.open) })),
  });
  const drillSo = (status: string) => setDrill({
    title: `Sales Orders · ${status}`, sub: 'Recent orders in this status',
    columns: [{ key: 'ref', label: 'Order' }, { key: 'type', label: 'Program' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Created' }],
    rows: (so?.recent ?? []).filter((r) => r.status === status).map((r) => ({ ref: r.ref, type: r.type, status: <StatusPill status={r.status} />, date: fmtDate(r.date) })),
  });
  const openVendors = () => setDrill({ title: 'Vendors', sub: `${vendors?.count ?? 0} suppliers`, columns: [{ key: 'name', label: 'Vendor' }, { key: 'status', label: 'Status' }, { key: 'terms', label: 'Terms' }, { key: 'phone', label: 'Phone' }], rows: (vendors?.vendors ?? []).slice(0, 200).map((v) => ({ name: v.name, status: <StatusPill status={v.status} />, terms: v.terms || '—', phone: v.phone || '—' })) });
  const openCatalog = () => setDrill({ title: 'Catalog', sub: `${items?.count ?? 0} items & services`, columns: [{ key: 'num', label: 'Item No' }, { key: 'name', label: 'Item Name' }, { key: 'type', label: 'Type' }, { key: 'price', label: 'Price', num: true }, { key: 'cost', label: 'Cost', num: true }], rows: (items?.items ?? []).slice(0, 200).map((i) => ({ num: i.number || '—', name: i.name, type: i.type || '—', price: formatCurrency(i.price), cost: formatCurrency(i.cost) })) });

  const ready = ar && ap && pl && payments && so && po;

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Executive Overview</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · financials from Striven (6-hourly sync)
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--border-strong)' }}>🔒 PHI masked</span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          {/* ── vivid KPI strip (the visual hero) ── */}
          <div className="kpi-strip">
            <KpiGrad label="Revenue YTD" value={formatCurrency(pl.revenue)} period="invoiced this year" hue={HUE.purple}
              delta={momDelta(revSeries)} spark={completeVals(revSeries)} onClick={go('pl')} />
            <KpiGrad label="Cash Received" value={formatCurrency(payments.total)} period={`${payments.count} payments`} hue={HUE.blue}
              delta={momDelta(cashSeries)} spark={completeVals(cashSeries)} onClick={go('accounts')} />
            <KpiGrad label="AR Open" value={formatCurrency(ar.totalOpen)} period="unpaid invoices" hue={HUE.teal}
              chip={`${ar.count} invoices`} onClick={go('receivables')} />
            <KpiGrad label="AP Open" value={formatCurrency(ap.totalOpen)} period="unpaid bills" hue={HUE.green}
              chip={`${ap.count} bills`} onClick={go('payables')} />
            <KpiGrad label="Sales Orders" value={formatCurrency(so.totalValue)} period="order book (not revenue)" hue={HUE.orange}
              chip={`${so.count} orders`} onClick={go('orders')} />
            <KpiGrad label="PO Spend" value={formatCurrency(po.totalValue)} period="committed · active only" hue={HUE.violet}
              chip={`${po.count} POs`} onClick={go('tracking')} />
            <KpiGrad label="Open Exceptions" value={String(exc?.totalOpen ?? 0)} period="data-quality items" hue={HUE.red}
              chip="needs review" onClick={go('exceptions')} />
          </div>

          {/* ── dense analytics grid ── */}
          <div className="exec-grid">
            <ChartCard span={1} title="Cash Collection Rate" sub="Cash received ÷ revenue YTD">
              <GaugeRing value={collectionPct} centerValue={`${collectionPct}%`} centerLabel="Collected" color={C.info} height={150} />
              <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                {formatCurrency(payments.total)} of {formatCurrency(pl.revenue)}
                {dsoApprox != null && <><br />DSO ≈ {dsoApprox} days <span style={{ opacity: 0.7 }}>(approx)</span></>}
              </div>
            </ChartCard>

            <ChartCard span={3} title="Financial Performance Over Time" sub="Invoiced revenue vs. billed expenses by month">
              <GroupedBars data={finData} series={[{ key: 'revenue', name: 'Revenue', color: C.positive }, { key: 'expenses', name: 'Expenses', color: C.negative }]} />
            </ChartCard>

            <ChartCard span={2} title="Sales Orders by Program" sub={`${so.count} orders · PI / VA / Tri-Care split`}>
              <Donut data={programDonut} centerValue={compactMoney(so.totalValue)} centerLabel="order book" onSelect={go('orders')} />
            </ChartCard>

            <ChartCard span={2} title="PO Spend by Vendor" sub="Committed spend · active POs only">
              <Donut data={vendorDonut} centerValue={compactMoney(po.totalValue)} centerLabel="committed" onSelect={go('tracking')} />
            </ChartCard>

            <ChartCard span={2} title="AR Aging" sub="Open receivables by days past due · click a bar">
              <AgingBar aging={ar.aging} onSelect={drillAging} />
            </ChartCard>

            <ChartCard span={2} title="Sales Orders by Status" sub={`${so.count} orders · click a bar`}>
              <RankBar data={soData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={drillSo} />
            </ChartCard>

            <ChartCard span={2} title="Cash Received by Month" sub="Customer payments collected">
              <TrendArea data={(payments.byMonth ?? []).map((m) => ({ month: m.month, amount: m.amount }))} idPrefix="ov-pay" series={[{ key: 'amount', name: 'Received', color: C.brand }]} />
            </ChartCard>

            <ChartCard span={2} title="Order → PO → Invoice" sub={`${chainTotal} orders traced through fulfilment`}>
              <div className="exec-funnel">
                <div className="exec-funnel-step"><div className="n">{chainTotal}</div><div className="l">Orders</div></div>
                <div className="exec-funnel-arrow">›</div>
                <div className="exec-funnel-step"><div className="n">{chainPo}</div><div className="l">With PO</div></div>
                <div className="exec-funnel-arrow">›</div>
                <div className="exec-funnel-step"><div className="n">{chainInv}</div><div className="l">Invoiced</div></div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12 }}>
                {chainTotal ? Math.round((chainInv / chainTotal) * 100) : 0}% of orders have reached invoicing · <span className="link-like" onClick={go('tracking')} style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>trace orders →</span>
              </div>
            </ChartCard>

            <ChartCard span={2} title="Master Data" sub="Records under management" right={<button className="btn ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={go('vendors')}>Vendors →</button>}>
              <div className="exec-mini">
                <div><div className="n">{(customers?.count ?? 0).toLocaleString()}</div><div className="l">Customers</div></div>
                <div style={{ cursor: 'pointer' }} onClick={openVendors}><div className="n">{(vendors?.count ?? 0).toLocaleString()}</div><div className="l">Vendors</div></div>
                <div style={{ cursor: 'pointer' }} onClick={openCatalog}><div className="n">{(items?.count ?? 0).toLocaleString()}</div><div className="l">Catalog Items</div></div>
              </div>
            </ChartCard>

            <ChartCard span={2} title="Open Exceptions" sub={`${exc?.totalOpen ?? 0} data-quality items to review`} right={<button className="btn ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={go('exceptions')}>View all →</button>}>
              {exc && exc.groups.length ? (
                <RankBar data={[...exc.groups].sort((a, b) => b.count - a.count).slice(0, 6).map((g) => ({ name: g.title, value: g.count }))} colorAt={(i) => [C.negative, C.warning, C.info, C.brand, C.purple, C.muted][i % 6]} onSelect={go('exceptions')} />
              ) : <div className="qb-placeholder"><span className="qb-icon">✓</span>No open exceptions</div>}
            </ChartCard>

            {/* Honest placeholders — these need the accounting source (QuickBooks) that Striven's API doesn't expose. */}
            <ChartCard span={2} title="Margins & Working Capital" sub="Balance sheet, EBITDA, cash-on-hand">
              <div className="qb-placeholder">
                <span className="qb-icon">🔗</span>
                <div>Bank balance, real P&amp;L and working-capital metrics aren't in Striven's API.</div>
                <div className="qb-cta">Connect QuickBooks to unlock</div>
              </div>
            </ChartCard>
          </div>
        </>
      )}

      {drill && <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
