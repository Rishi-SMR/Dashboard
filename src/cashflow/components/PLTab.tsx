import { useEffect, useState, type ReactNode } from 'react';
import { fetchStrivenPL, fetchStrivenPayments, type PlResult, type PaymentsResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, monthLabel } from '../chartTheme';
import { ChartCard, RankBar, TrendArea, LegendDots, GaugeRing, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const pct = (n: number) => `${(Number(n) || 0).toFixed(1)}%`;

// Honest MoM on complete months only (never the partial current month).
const nowYm = new Date().toISOString().slice(0, 7);
const momDelta = (series: { month: string; value: number }[]): { pct: number; up: boolean } | null => {
  const done = series.filter((p) => p.month < nowYm && (p.value ?? 0) > 0);
  if (done.length < 2) return null;
  const cur = done[done.length - 1].value, prev = done[done.length - 2].value;
  if (!prev) return null;
  return { pct: Math.round(((cur - prev) / prev) * 100), up: cur >= prev };
};

export function PLTab() {
  const [pl, setPl] = useState<PlResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [p, pay] = await Promise.all([fetchStrivenPL(), fetchStrivenPayments().catch(() => null)]);
      setPl(p); setPayments(pay);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load P&L.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const year = pl ? pl.periodFrom.slice(0, 4) : '';
  const revD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.revenue })));
  const expD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.expenses })));
  const netD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.net })));
  const cashD = momDelta((payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount })));

  const vendorData = (pl?.byVendor ?? []).slice(0, 8).map((v) => ({ name: v.name, value: v.value }));

  // Tap-to-explain drills.
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const explainRevenue = () => setDrill({
    title: 'Revenue', sub: 'Every customer invoice for the year (voided excluded), by month',
    ...kv([...(pl?.series ?? []).map((m) => ({ k: `${monthLabel(m.month)} ${m.month.slice(0, 4)}`, v: formatCurrency(m.revenue) })), { k: 'Total revenue', v: formatCurrency(pl?.revenue ?? 0) }]),
  });
  const explainExpenses = () => setDrill({
    title: 'Expenses', sub: 'Every vendor bill for the year (voided excluded), by vendor',
    ...kv([...(pl?.byVendor ?? []).slice(0, 10).map((v) => ({ k: v.name, v: formatCurrency(v.value) })), { k: 'Total expenses', v: formatCurrency(pl?.expenses ?? 0) }]),
  });
  const explainNet = () => setDrill({
    title: 'Net Profit', sub: 'Revenue − Expenses · net margin = net ÷ revenue',
    ...kv([
      { k: 'Revenue', v: formatCurrency(pl?.revenue ?? 0) },
      { k: 'Expenses', v: `−${formatCurrency(pl?.expenses ?? 0)}` },
      { k: 'Net profit', v: formatCurrency(pl?.net ?? 0) },
      { k: 'Net margin', v: pct(pl?.margin ?? 0) },
    ]),
  });

  const rangeChip = pl
    ? `${new Date(pl.periodFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Profit &amp; Loss</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · YTD {year} · accrual basis · computed live from Striven Invoices &amp; Bills{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          {rangeChip && <span className="ov-filter"><span className="fl">📅</span><b>{rangeChip}</b></span>}
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {pl && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Revenue" value={pl.revenue} format={formatCurrency}
              delta={revD} deltaText={`${pl.invoiceCount.toLocaleString()} invoices`} foot={`${pl.invoiceCount.toLocaleString()} invoices · voided excluded`} onClick={explainRevenue} />
            <KpiR ico="trend" tint="#DC2626" label="Expenses" value={pl.expenses} format={formatCurrency}
              delta={expD} deltaInvert deltaText={`${pl.billCount.toLocaleString()} bills`} foot={`${pl.billCount.toLocaleString()} vendor bills`} onClick={explainExpenses} />
            <KpiR ico="pie" tint="#2563EB" label="Net Profit" value={pl.net} format={formatCurrency}
              delta={netD} deltaText="revenue − expenses" foot={`${pct(pl.margin)} net margin`} onClick={explainNet} />
            <KpiR ico="wallet" tint="#4F46E5" label="Cash Received" value={pl.cashReceived} format={formatCurrency}
              delta={cashD} deltaText="collected to date" foot={`${(payments?.count ?? 0).toLocaleString()} payments collected`} />
          </div>

          <div className="exec-grid12">
            <div className="section chart-card g12-12">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Income Statement · YTD {year}</h2>
                  <div className="section-sub">Accrual basis = invoices as revenue, bills as expense</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="pl-statement" style={{ flex: '1 1 380px', maxWidth: 640 }}>
                  <div className="pl-line"><span className="lbl">Revenue</span><span className="val">{formatCurrency(pl.revenue)}</span></div>
                  <div className="pl-line"><span className="lbl">Less: Expenses</span><span className="val neg">−{formatCurrency(pl.expenses)}</span></div>
                  <div className="pl-line pl-total"><span className="lbl">Net Profit</span><span className="val">{formatCurrency(pl.net)}</span></div>
                  <div className="pl-line pl-sub"><span className="lbl">Net margin</span><span className="val">{pct(pl.margin)}</span></div>
                </div>
                <div style={{ flex: '0 0 240px', margin: '0 auto' }}>
                  <GaugeRing value={Math.max(0, Math.min(100, pl.margin))} centerValue={pct(pl.margin)} centerLabel="Net Margin" color={pl.net >= 0 ? C.positive : C.negative} height={180} />
                </div>
              </div>
              <div className="pl-meta">
                <div><span>Avg invoice</span><strong>{formatCurrency(pl.avgInvoice)}</strong></div>
                <div><span>Avg bill</span><strong>{formatCurrency(pl.avgBill)}</strong></div>
                <div><span>Cash collected</span><strong>{formatCurrency(pl.cashReceived)}</strong></div>
              </div>
            </div>

            <ChartCard className="g12-7" title="Revenue vs Expenses by Month" sub={`${pl.series.length} month${pl.series.length === 1 ? '' : 's'} · YTD ${year}`}>
              <LegendDots items={[{ name: 'Revenue', color: C.positive }, { name: 'Expenses', color: C.negative }]} />
              <TrendArea
                data={pl.series}
                series={[{ key: 'revenue', name: 'Revenue', color: C.positive }, { key: 'expenses', name: 'Expenses', color: C.negative }]}
                idPrefix="pl-rev" dots
              />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Revenue</div><div className="v pos">{formatCurrency(pl.revenue)}</div></div>
                <div className="cf-i"><div className="l">Total Expenses</div><div className="v neg">{formatCurrency(pl.expenses)}</div></div>
                <div className="cf-i"><div className="l">Net Profit</div><div className="v accent">{formatCurrency(pl.net)}</div></div>
                <div className="cf-i"><div className="l">Margin</div><div className="v">{pct(pl.margin)}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-5" title="Expenses by Vendor" sub={`${formatCurrency(pl.expenses)} across ${pl.billCount} bill${pl.billCount === 1 ? '' : 's'}`}>
              <RankBar data={vendorData} money colorAt={() => C.negative} />
              <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }} onClick={() => { location.hash = 'payables'; }}>View all bills →</button>
            </ChartCard>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Monthly P&amp;L</h2><div className="section-sub">Revenue, expenses and net profit per month</div></div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Month</th><th className="num">Revenue</th><th className="num">Expenses</th>
                      <th className="num">Net</th><th className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pl.series.map((m) => (
                      <tr key={m.month}>
                        <td><strong>{monthLabel(m.month)} {m.month.slice(0, 4)}</strong></td>
                        <td className="num">{formatCurrency(m.revenue)}</td>
                        <td className="num">{formatCurrency(m.expenses)}</td>
                        <td className="num" style={{ color: m.net >= 0 ? '#047857' : '#b91c1c', fontWeight: 700 }}>{formatCurrency(m.net)}</td>
                        <td className="num">{m.revenue ? pct((m.net / m.revenue) * 100) : '—'}</td>
                      </tr>
                    ))}
                    {pl.series.length === 0 && <tr><td colSpan={5} className="muted-note">No transactions in the period.</td></tr>}
                    {pl.series.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td className="num">{formatCurrency(pl.revenue)}</td>
                        <td className="num">{formatCurrency(pl.expenses)}</td>
                        <td className="num">{formatCurrency(pl.net)}</td>
                        <td className="num">{pct(pl.margin)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="muted-note">
                Accrual basis · computed from {pl.invoiceCount} invoices &amp; {pl.billCount} bills. Striven's API has no P&amp;L report endpoint, so this statement is derived live from the underlying transactions.
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
