import { useEffect, useState, type ReactNode } from 'react';
import { fetchStrivenPL, fetchStrivenPayments, fetchQbPL, type PlResult, type PaymentsResult, type QbPl } from '../strivenApi';
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

/**
 * WHICH BOOKS THIS PAGE IS READING.
 *
 * 'quickbooks' is the accounting system of record — the statement an accountant
 * would close the year on. 'striven' is the original behaviour: revenue derived
 * from Striven invoices, expenses from Striven bills, which is an OPERATIONAL
 * view of the same business.
 *
 * They do not agree, and they are not meant to. QuickBooks can only report on
 * documents that have been posted to it, and this portal posts invoices one at
 * a time on request — so the QuickBooks view carries a coverage banner naming
 * exactly how much of the book it holds. Without that line a reader has no way
 * to tell a real loss from an unposted one.
 */
type PlSource = 'quickbooks' | 'striven';

/**
 * QuickBooks → the shape this page already renders.
 *
 * Mapping rather than branching the whole component: every tile, chart and drill
 * below was written against `PlResult`, and forking them per source is how two
 * layouts drift into disagreeing about the same figure.
 *
 * `expenses` is COGS PLUS operating expenses. QuickBooks reports them as two
 * lines and this page has one Expenses tile, and folding them together is what
 * makes `revenue − expenses = net` hold on screen — omitting COGS would leave
 * the statement visibly not adding up.
 */
function qbToPl(q: QbPl): PlResult {
  const revenue = q.income ?? 0;
  const expenses = (q.cogs ?? 0) + (q.expenses ?? 0);
  const net = q.netIncome ?? (revenue - expenses);
  return {
    periodFrom: q.periodFrom,
    revenue, expenses, net,
    margin: q.margin ?? (revenue ? (net / revenue) * 100 : 0),
    // QuickBooks' P&L carries no cash figure; the tile is replaced on this
    // source rather than filled with a number from somewhere else.
    cashReceived: 0,
    invoiceCount: q.coverage?.qbInvoices ?? 0,
    billCount: q.coverage?.qbBills ?? 0,
    avgInvoice: 0, avgBill: 0,
    series: q.series ?? [],
    // Expenses BY CATEGORY, not by vendor — QuickBooks groups cost by chart of
    // accounts and knows nothing about which supplier it came from. The card's
    // heading changes with it, so the axis is never mislabelled.
    //
    // CATEGORY, not leaf account. A flat leaf list put "Direct supplies &
    // materials" beside "Bank and credit card fees" with nothing to say one is
    // cost of goods and the other is $14 of overhead — and it scattered payroll
    // into individual people while the category they belong to, the largest cost
    // in the business, appeared nowhere. Categories are the level QuickBooks
    // itself subtotals at, so the chart now reads as a P&L rather than a ledger
    // dump. The accounts are still there, one level down, in the drill.
    byVendor: (q.categories ?? []).filter((c) => c.total > 0)
      .map((c) => ({ name: c.category, value: c.total }))
      .sort((a, b) => b.value - a.value),
    approximate: false,
  };
}

export function PLTab() {
  const [source, setSource] = useState<PlSource>('quickbooks');
  const [qb, setQb] = useState<QbPl | null>(null);
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
      if (source === 'quickbooks') {
        const q = await fetchQbPL();
        setQb(q); setPl(qbToPl(q)); setPayments(null);
      } else {
        const [p, pay] = await Promise.all([fetchStrivenPL(), fetchStrivenPayments().catch(() => null)]);
        setQb(null); setPl(p); setPayments(pay);
      }
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load P&L.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    // Drop the previous source's figures FIRST, so a QuickBooks number can never
    // sit under a "Striven" heading while the other request is in flight.
    setPl(null); setQb(null); setPayments(null);
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
    title: 'Expenses',
    sub: source === 'quickbooks'
      ? 'Cost of goods sold and operating expenses, by category, with the accounts inside each'
      : 'Every vendor bill for the year (voided excluded), by vendor',
    // CATEGORY, THEN THE ACCOUNTS INSIDE IT — the shape of a P&L, not a flat
    // ledger. Accounts are indented under their category so the two levels are
    // distinguishable in a plain two-column table, and each category's accounts
    // sum to the category line above them.
    //
    // NO SILENT CAP. This listed the top 10 and then printed the true total
    // underneath, so any book with an eleventh line showed a column that did not
    // add up — and gave the reader no way to know rows had been dropped. A
    // breakdown whose rows do not reconcile to its own total is worse than a
    // long list. If the list ever gets unwieldy the fix is an explicit
    // "+N more" row carrying the remainder, not a quiet slice.
    ...kv([
      ...(source === 'quickbooks' && qb?.categories?.length
        ? qb.categories.filter((c) => c.total > 0).flatMap((c) => [
          { k: c.category, v: formatCurrency(c.total) },
          // A category whose single account repeats its own name adds nothing —
          // "Office expenses / Office expenses" is noise, so it is not repeated.
          ...(c.accounts.length === 1 && c.accounts[0].label === c.category
            ? []
            : c.accounts.map((a) => ({ k: `    ${a.label}`, v: formatCurrency(a.value) }))),
        ])
        : (pl?.byVendor ?? []).map((v) => ({ k: v.name, v: formatCurrency(v.value) }))),
      { k: 'Total expenses', v: formatCurrency(pl?.expenses ?? 0) },
    ]),
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
            <span className="live-dot" /> Sports Med Recovery · YTD {year} · {qb ? `${qb.basis.toLowerCase()} basis` : 'accrual basis'} ·{' '}
            {source === 'quickbooks'
              ? <>read from <b>QuickBooks</b> — the accounting system of record</>
              : <>computed live from <b>Striven</b> Invoices &amp; Bills</>}
            {agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          {/* WHICH BOOKS. Same control style as every other filter on the app so
              it reads as a filter, not as a mode switch hidden in a header. */}
          <label className="ov-filter" style={{ flex: 'none' }}>
            <span className="fl">Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value as PlSource)}
              title="QuickBooks is the accounting system of record; Striven is the operational view of the same business"
              style={{ color: C.ink }}>
              <option value="quickbooks">QuickBooks</option>
              <option value="striven">Striven</option>
            </select>
          </label>
          {rangeChip && <span className="ov-filter"><span className="fl">📅</span><b>{rangeChip}</b></span>}
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* ── WHAT THE BOOKS ACTUALLY HOLD ────────────────────────────────────────
          A P&L can only report on documents posted to it. This portal posts
          Striven invoices to QuickBooks ONE AT A TIME, on request, so the books
          can be missing most of the revenue while carrying all of the cost —
          which prints as a loss that never happened. Naming the coverage is the
          difference between a statement a reader can act on and one that quietly
          misleads them. Shown whenever anything is missing, never suppressed. */}
      {qb?.coverage && (qb.coverage.qbInvoices ?? 0) >= 0 && (
        <div className="qb-flash warn" style={{ marginBottom: 14 }}>
          <b>These are QuickBooks' own figures, and QuickBooks holds only part of the book.</b>{' '}
          It has <b>{(qb.coverage.qbInvoices ?? 0).toLocaleString()}</b> invoice{qb.coverage.qbInvoices === 1 ? '' : 's'} and{' '}
          <b>{(qb.coverage.qbBills ?? 0).toLocaleString()}</b> bill{qb.coverage.qbBills === 1 ? '' : 's'};{' '}
          <b>{qb.coverage.postedFromStriven.toLocaleString()}</b> Striven invoice{qb.coverage.postedFromStriven === 1 ? ' has' : 's have'} been posted across.
          {' '}Costs entered directly in QuickBooks are therefore weighed against revenue that may not have been posted yet, so a
          negative net here is not necessarily a loss. Switch <b>Source</b> to <b>Striven</b> for the operational view of the
          same period.
        </div>
      )}
      {loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {pl && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Revenue" value={pl.revenue} format={formatCurrency}
              delta={revD} deltaText={`${pl.invoiceCount.toLocaleString()} invoices`}
              foot={source === 'quickbooks' ? 'Income, per the chart of accounts' : `${pl.invoiceCount.toLocaleString()} invoices · voided excluded`} onClick={explainRevenue} />
            <KpiR ico="trend" tint="#DC2626" label="Expenses" value={pl.expenses} format={formatCurrency}
              delta={expD} deltaInvert deltaText={`${pl.billCount.toLocaleString()} bills`}
              foot={source === 'quickbooks' ? `${formatCurrency(qb?.cogs ?? 0)} COGS + ${formatCurrency(qb?.expenses ?? 0)} operating` : `${pl.billCount.toLocaleString()} vendor bills`} onClick={explainExpenses} />
            <KpiR ico="pie" tint="#0A369F" label="Net Profit" value={pl.net} format={formatCurrency}
              delta={netD} deltaText="revenue − expenses" foot={`${pct(pl.margin)} net margin`} onClick={explainNet} />
            {source === 'quickbooks' ? (
              /* NOT "Cash Received". A QuickBooks P&L carries no cash figure,
                 and this tile would have printed $0 beside real revenue — a
                 number that reads as "we collected nothing". Gross profit is
                 the statement's own next line, so the tile stays useful and
                 stays true to the source. */
              <KpiR ico="wallet" tint="#4F46E5" label="Gross Profit" value={qb?.grossProfit ?? 0} format={formatCurrency}
                deltaText="income − cost of goods sold"
                foot={`${formatCurrency(qb?.income ?? 0)} income less ${formatCurrency(qb?.cogs ?? 0)} COGS`} />
            ) : (
              <KpiR ico="wallet" tint="#4F46E5" label="Cash Received" value={pl.cashReceived} format={formatCurrency}
                delta={cashD} deltaText="collected to date" foot={`${(payments?.count ?? 0).toLocaleString()} payments collected`} />
            )}
          </div>

          <div className="exec-grid12">
            <div className="section chart-card g12-12">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Income Statement · YTD {year}</h2>
                  <div className="section-sub">{source === 'quickbooks'
                    ? `${qb?.basis ?? 'Accrual'} basis · income, cost of goods sold and operating expenses as QuickBooks reports them`
                    : 'Accrual basis = invoices as revenue, bills as expense'}</div>
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

            <ChartCard className="g12-5"
              title={source === 'quickbooks' ? 'Expenses by Category' : 'Expenses by Vendor'}
              sub={source === 'quickbooks'
                ? `${formatCurrency(pl.expenses)} across ${pl.byVendor.length} categor${pl.byVendor.length === 1 ? 'y' : 'ies'} · chart of accounts`
                : `${formatCurrency(pl.expenses)} across ${pl.billCount} bill${pl.billCount === 1 ? '' : 's'}`}>
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
                        <td className="num">{m.revenue ? pct((m.net / m.revenue) * 100) : '-'}</td>
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
