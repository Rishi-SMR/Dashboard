import { useEffect, useState } from 'react';
import {
  fetchStrivenAR, fetchStrivenAP, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenCustomers, fetchStrivenVendors,
  fetchStrivenItems, fetchStrivenTasks,
  type ArResult, type ApResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type TasksResult, type CustomersResult,
  type VendorsResult, type ItemsResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, SERIES, AGING_LABELS } from '../chartTheme';
import { ChartCard, RankBar, AgingBar, TrendArea, DrillModal } from '../chartKit';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
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

type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, React.ReactNode>[] };

export function OverviewCharts() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [ap, setAp] = useState<ApResult | null>(null);
  const [pl, setPl] = useState<PlResult | null>(null);
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [trends, setTrends] = useState<TrendsResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [tasks, setTasks] = useState<TasksResult | null>(null);
  const [customers, setCustomers] = useState<CustomersResult | null>(null);
  const [vendors, setVendors] = useState<VendorsResult | null>(null);
  const [items, setItems] = useState<ItemsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, b, p, s, o, t, pay, cust, ven, it, tk] = await Promise.all([
        fetchStrivenAR(), fetchStrivenAP(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(), fetchStrivenCustomers(), fetchStrivenVendors(),
        fetchStrivenItems(), fetchStrivenTasks(),
      ]);
      setAr(a); setAp(b); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay); setTasks(tk);
      setCustomers(cust); setVendors(ven); setItems(it);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Striven data.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const trendData = (trends?.series ?? []).map((s) => ({ month: s.month, revenue: s.revenue, expenses: s.expenses }));
  const payData = (payments?.byMonth ?? []).map((m) => ({ month: m.month, amount: m.amount }));
  const soData = [...(so?.byStatus ?? [])].sort((x, y) => y.count - x.count).map((s) => ({ name: s.status, value: s.count }));
  const vendorData = [...(po?.byVendor ?? [])].sort((x, y) => y.total - x.total).slice(0, 8).map((v) => ({ name: v.vendor, value: v.total }));
  const taskData = [...(tasks?.byStatus ?? [])].sort((a, b) => b.count - a.count).map((t) => ({ name: t.name, value: t.count }));

  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });

  // ---- chart drills (popups, in place) ----
  const drillAging = (label: string) => setDrill({
    title: `AR Aging · ${label}`, sub: `Open invoices ${label} days past due`,
    columns: [{ key: 'inv', label: 'Invoice' }, { key: 'patient', label: 'Patient' }, { key: 'due', label: 'Due' }, { key: 'open', label: 'Open', num: true }],
    rows: (ar?.invoices ?? []).filter((i) => i.open > 0 && bucketOf(i.dueDate) === label).map((i) => ({ inv: `#${i.number}`, patient: i.customer, due: fmtDate(i.dueDate), open: formatCurrency(i.open) })),
  });
  const drillVendor = (name: string) => setDrill({
    title: `Purchase Orders · ${name}`, sub: 'Recent POs for this vendor',
    columns: [{ key: 'ref', label: 'PO' }, { key: 'vendor', label: 'Vendor' }, { key: 'total', label: 'Total', num: true }, { key: 'date', label: 'Created' }],
    rows: (po?.recent ?? []).filter((r) => r.vendor === name).map((r) => ({ ref: r.ref, vendor: r.vendor, total: formatCurrency(r.total), date: fmtDate(r.date) })),
  });
  const drillSo = (status: string) => setDrill({
    title: `Sales Orders · ${status}`, sub: 'Recent orders in this status',
    columns: [{ key: 'ref', label: 'Order' }, { key: 'patient', label: 'Patient' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Created' }],
    rows: (so?.recent ?? []).filter((r) => r.status === status).map((r) => ({ ref: r.ref, patient: r.customer, status: <StatusPill status={r.status} />, date: fmtDate(r.date) })),
  });
  const drillTask = (status: string) => setDrill({
    title: `Tasks · ${status}`, sub: 'Recent tasks in this status',
    columns: [{ key: 'title', label: 'Task' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Created' }],
    rows: (tasks?.recent ?? []).filter((r) => r.status === status).map((r) => ({ title: r.title, type: r.type, status: <StatusPill status={r.status} />, date: fmtDate(r.date) })),
  });

  // ---- section stat-tile popups (open in place, don't navigate away) ----
  const openers: Record<string, () => void> = {
    patients: () => setDrill({ title: 'Patients', sub: `${customers?.count ?? 0} on record · names masked (PHI)`, columns: [{ key: 'ref', label: 'Patient ID' }, { key: 'name', label: 'Patient' }, { key: 'status', label: 'Status' }, { key: 'since', label: 'Since' }], rows: (customers?.customers ?? []).slice(0, 200).map((c) => ({ ref: c.ref, name: c.name, status: <StatusPill status={c.status} />, since: fmtDate(c.since) })) }),
    orders: () => setDrill({ title: 'Sales Orders', sub: `${so?.count ?? 0} orders · recent`, columns: [{ key: 'ref', label: 'Order' }, { key: 'patient', label: 'Patient' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Created' }], rows: (so?.recent ?? []).map((r) => ({ ref: r.ref, patient: r.customer, status: <StatusPill status={r.status} />, date: fmtDate(r.date) })) }),
    po: () => setDrill({ title: 'Purchase Orders', sub: `${po?.count ?? 0} orders · ${formatCurrency(po?.totalValue ?? 0)} total`, columns: [{ key: 'ref', label: 'PO' }, { key: 'vendor', label: 'Vendor' }, { key: 'total', label: 'Total', num: true }, { key: 'date', label: 'Created' }], rows: (po?.recent ?? []).map((r) => ({ ref: r.ref, vendor: r.vendor, total: formatCurrency(r.total), date: fmtDate(r.date) })) }),
    vendors: () => setDrill({ title: 'Vendors', sub: `${vendors?.count ?? 0} suppliers`, columns: [{ key: 'name', label: 'Vendor' }, { key: 'status', label: 'Status' }, { key: 'terms', label: 'Terms' }, { key: 'phone', label: 'Phone' }], rows: (vendors?.vendors ?? []).slice(0, 200).map((v) => ({ name: v.name, status: <StatusPill status={v.status} />, terms: v.terms || '—', phone: v.phone || '—' })) }),
    catalog: () => setDrill({ title: 'Catalog', sub: `${items?.count ?? 0} items & services`, columns: [{ key: 'num', label: 'Item No' }, { key: 'name', label: 'Item Name' }, { key: 'type', label: 'Type' }, { key: 'price', label: 'Price', num: true }, { key: 'cost', label: 'Cost', num: true }], rows: (items?.items ?? []).slice(0, 200).map((i) => ({ num: i.number || '—', name: i.name, type: i.type || '—', price: formatCurrency(i.price), cost: formatCurrency(i.cost) })) }),
    tasks: () => setDrill({ title: 'Tasks', sub: `${tasks?.count ?? 0} tasks · titles masked (PHI)`, columns: [{ key: 'title', label: 'Task' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Created' }], rows: (tasks?.recent ?? []).map((r) => ({ title: r.title, type: r.type, status: <StatusPill status={r.status} />, date: fmtDate(r.date) })) }),
  };

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark, border: `1px solid #c7d5f2` }}>🔒 PHI masked</span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ar && ap && pl && payments && (
        <>
          <div className="kpis">
            <KpiCard label="AR Open" period={`${ar.count} open invoices`} value={formatCurrency(ar.totalOpen)}
              info={{ formula: 'Sum of open balances on unpaid invoices' }}
              breakdown={AGING_LABELS.map((b) => ({ label: b.label, value: formatCurrency(ar.aging[b.key] || 0) })).concat([{ label: 'Total open', value: formatCurrency(ar.totalOpen), strong: true } as any])}
              {...kpi(0)} active={openKpi === 0} />
            <KpiCard label="AP Open" period={`${ap.count} open bills`} value={formatCurrency(ap.totalOpen)}
              info={{ formula: 'Sum of open balances on unpaid vendor bills' }} {...kpi(1)} active={openKpi === 1} />
            <KpiCard label="Cash Received" period={`${payments.count} payments`} value={formatCurrency(payments.total)} trend="up"
              info={{ formula: 'Total customer payments recorded in Striven' }} {...kpi(2)} active={openKpi === 2} />
            <KpiCard label="Net P&L (YTD)" period="revenue − expenses" value={formatCurrency(pl.net)} trend={pl.net >= 0 ? 'up' : 'down'}
              info={{ formula: 'Invoiced YTD − Billed YTD (approx.)' }}
              breakdown={[{ label: 'Revenue (YTD)', value: formatCurrency(pl.revenue) }, { label: 'Expenses (YTD)', value: formatCurrency(pl.expenses) }, { label: 'Net', value: formatCurrency(pl.net), strong: true }]}
              {...kpi(3)} active={openKpi === 3} />
          </div>

          {/* Every section — click a tile to open its list right here. */}
          <div className="mini-stats">
            <button className="mini-stat" onClick={openers.patients}><div className="n">{customers?.count ?? 0}</div><div className="l">Patients</div></button>
            <button className="mini-stat" onClick={openers.orders}><div className="n">{so?.count ?? 0}</div><div className="l">Sales Orders</div></button>
            <button className="mini-stat" onClick={openers.po}><div className="n">{po?.count ?? 0}</div><div className="l">Purchase Orders</div></button>
            <button className="mini-stat" onClick={openers.vendors}><div className="n">{vendors?.count ?? 0}</div><div className="l">Vendors</div></button>
            <button className="mini-stat" onClick={openers.catalog}><div className="n">{items?.count ?? 0}</div><div className="l">Catalog Items</div></button>
            <button className="mini-stat" onClick={openers.tasks}><div className="n">{tasks?.count ?? 0}</div><div className="l">Tasks</div></button>
          </div>

          <div className="chart-grid">
            <ChartCard title="Cash In vs Out" sub="Invoiced revenue vs. billed expenses by month">
              <TrendArea data={trendData} idPrefix="ov-cash" series={[{ key: 'revenue', name: 'Revenue', color: C.positive }, { key: 'expenses', name: 'Expenses', color: C.negative }]} />
            </ChartCard>

            <ChartCard title="Cash Received by Month" sub="Customer payments collected">
              <TrendArea data={payData} idPrefix="ov-pay" series={[{ key: 'amount', name: 'Received', color: C.brand }]} />
            </ChartCard>

            <ChartCard title="AR Aging" sub="Open receivables by days past due · click a bar to drill">
              <AgingBar aging={ar.aging} onSelect={drillAging} />
            </ChartCard>

            <ChartCard title="Top Vendors by PO Spend" sub="Largest suppliers · click a bar to drill">
              <RankBar data={vendorData} money colorAt={() => C.brand} onSelect={drillVendor} />
            </ChartCard>

            <ChartCard title="Sales Orders by Status" sub={`${so?.count ?? 0} orders · click a bar to drill`}>
              <RankBar data={soData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={drillSo} />
            </ChartCard>

            <ChartCard title="Tasks by Status" sub={`${tasks?.count ?? 0} tasks · click a bar to drill`}>
              <RankBar data={taskData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={drillTask} />
            </ChartCard>
          </div>
        </>
      )}

      {drill && <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
