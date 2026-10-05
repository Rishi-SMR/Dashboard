import { useEffect, useState, type ReactNode } from 'react';
import { fetchStrivenPL, fetchStrivenPayments, type PlResult, type PaymentsResult, type PlPeriod } from '../strivenApi';
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
 * WHICH PERIOD THE STATEMENT COVERS.
 *
 * A year on its own, a quarter, or a single month — the three slices anyone
 * actually asks a P&L for. Held as a year plus a part rather than as two dates
 * because it is what the reader picked, and it is what the heading has to say:
 * "Aug 2026", not "2026-08-01 – 2026-08-31".
 *
 * ONE DEFINITION, USED FOR BOTH THE REQUEST AND THE LABEL. The dates the server
 * is asked for and the words above the numbers come out of the same function,
 * so the heading cannot claim a period the figures were not fetched for.
 */
type PlPart = 'all' | 'q1' | 'q2' | 'q3' | 'q4'
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12';

const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));
const THIS_MONTH = Number(TODAY.slice(5, 7));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The last day of a month, in UTC.
 *
 * `Date.UTC(y, m, 0)` is day zero of the NEXT month — i.e. the last day of this
 * one — and it knows about February and leap years, which a table of 30s and
 * 31s does not. UTC deliberately: a local-time Date on a machine west of
 * Greenwich rolls the 31st back to the 30th and quietly drops a day of trading.
 */
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
/** No period ends in the future: a month still running ends today, not on the 31st. */
const notAfterToday = (d: string) => (d > TODAY ? TODAY : d);

function periodOf(year: number, part: PlPart): PlPeriod & { start: string; end: string; label: string } {
  if (part === 'all') {
    return {
      start: `${year}-01-01`,
      end: year === THIS_YEAR ? TODAY : `${year}-12-31`,
      // "YTD" is a claim about an unfinished year. A closed one is just the year.
      label: year === THIS_YEAR ? `YTD ${year}` : `FY ${year}`,
    };
  }
  if (part[0] === 'q') {
    const q = Number(part[1]);
    const first = q * 3 - 2;
    return {
      start: `${year}-${String(first).padStart(2, '0')}-01`,
      end: notAfterToday(lastDayOf(year, first + 2)),
      label: `Q${q} ${year}`,
    };
  }
  const m = Number(part);
  return { start: `${year}-${part}-01`, end: notAfterToday(lastDayOf(year, m)), label: `${MONTHS[m - 1]} ${year}` };
}

/** The parts that have actually happened. The current year has no October yet,
 *  and offering one only produces an empty statement nobody asked for. */
const partsFor = (year: number) => {
  const months = year === THIS_YEAR ? THIS_MONTH : 12;
  return {
    quarters: [1, 2, 3, 4].filter((q) => q * 3 - 2 <= months),
    months: Array.from({ length: months }, (_, i) => i + 1),
  };
};

export function PLTab() {
  const [year, setYear] = useState<number>(THIS_YEAR);
  const [part, setPart] = useState<PlPart>('all');
  const period = periodOf(year, part);
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
      // Striven's payments endpoint does not take a period, so `cashReceived`
      // stays the year to date: the tile that shows it says "collected to
      // date", not "collected this month".
      const range = { start: period.start, end: period.end };
      const [p, pay] = await Promise.all([fetchStrivenPL(range), fetchStrivenPayments().catch(() => null)]);
      setPl(p); setPayments(pay);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load P&L.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    // Drop the previous period's figures FIRST, so one period's number can never
    // sit under another's heading while the request is in flight.
    setPl(null); setPayments(null);
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, part]);

  const revD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.revenue })));
  const expD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.expenses })));
  const netD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.net })));
  const cashD = momDelta((payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount })));

  const vendorData = (pl?.byVendor ?? []).slice(0, 8).map((v) => ({ name: v.name, value: v.value }));

  /** Every statement line as a share of revenue — the common-size column an
   *  accountant reads before the dollars, because it is the only figure that
   *  survives a change in volume. Zero revenue divides by nothing, so it prints
   *  a dash rather than Infinity. */
  const share = (v: number) => (pl?.revenue ? (v / pl.revenue) * 100 : 0);
  const shareText = (v: number) => (pl?.revenue ? pct(share(v)) : '-');
  /**
   * Months the per-month averages divide by.
   *
   * NOT `series.length`. On the 1st of a month the series already carries that
   * month as a row of zeros, so YTD revenue was being divided by nine on a book
   * with eight months of trading — an average understated by an eighth, printed
   * as "across 9 months". A month counts once it is COMPLETE, or as soon as it
   * has anything booked in it: a genuinely quiet February still belongs in the
   * denominator and still drags the average down, which is the honest answer;
   * a September that is one day old does not.
   */
  const monthCount = (pl?.series ?? []).filter(
    (mo) => mo.month < nowYm || (mo.revenue ?? 0) !== 0 || (mo.expenses ?? 0) !== 0,
  ).length;
  const perMonth = (v: number) => (monthCount ? v / monthCount : 0);

  // Tap-to-explain drills.
  const kv = (rows: { k: ReactNode; v: ReactNode; rowClass?: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => (r.rowClass ? { k: r.k, v: r.v, rowClass: r.rowClass } : { k: r.k, v: r.v })),
  });

  const explainRevenue = () => setDrill({
    title: 'Revenue', sub: `Every customer invoice in ${period.label} (voided excluded), by month`,
    ...kv([
      ...(pl?.series ?? []).map((m) => ({ k: `${monthLabel(m.month)} ${m.month.slice(0, 4)}`, v: formatCurrency(m.revenue) })),
      { k: 'Total revenue', v: formatCurrency(pl?.revenue ?? 0), rowClass: 'total-row' },
    ]),
  });
  const explainExpenses = () => setDrill({
    title: 'Expenses',
    sub: `Every vendor bill in ${period.label} (voided excluded), by vendor`,
    // NO SILENT CAP. This listed the top 10 and then printed the true total
    // underneath, so any book with an eleventh line showed a column that did not
    // add up, and gave the reader no way to know rows had been dropped. A
    // breakdown whose rows do not reconcile to its own total is worse than a
    // long list. If the list ever gets unwieldy the fix is an explicit
    // "+N more" row carrying the remainder, not a quiet slice.
    ...kv([
      ...(pl?.byVendor ?? []).map((v) => ({ k: v.name, v: formatCurrency(v.value) })),
      { k: 'Total expenses', v: formatCurrency(pl?.expenses ?? 0), rowClass: 'total-row' },
    ]),
  });
  const explainNet = () => setDrill({
    title: 'Net Profit', sub: 'Revenue − Expenses · net margin = net ÷ revenue',
    ...kv([
      { k: 'Revenue', v: formatCurrency(pl?.revenue ?? 0) },
      { k: 'Expenses', v: `−${formatCurrency(pl?.expenses ?? 0)}` },
      { k: 'Net profit', v: formatCurrency(pl?.net ?? 0), rowClass: 'total-row' },
      { k: 'Net margin', v: pct(pl?.margin ?? 0) },
    ]),
  });

  // THE CHIP READS THE PERIOD, NOT THE CLOCK. It printed "… – today" whatever was
  // being shown, so a closed month came with a date range running to this
  // morning. Dates are formatted from the YYYY-MM-DD text, split by hand: a
  // `new Date('2026-08-31')` is parsed as UTC midnight and prints as the 30th to
  // anyone west of Greenwich.
  //
  // THE MONTH AND YEAR ARE NOT REPEATED WHEN BOTH ENDS SHARE THEM. "Aug 1 – Aug
  // 31, 2026" is three words of noise in a chip that has to sit in a header row
  // beside three other controls; "Aug 1–31, 2026" says the same thing in half
  // the width, which is the difference between the chip fitting and wrapping.
  const dayParts = (d: string) => { const [y, m, day] = d.split('-').map(Number); return { y, m, day }; };
  const rangeChip = (() => {
    const a = dayParts(period.start), b = dayParts(period.end);
    // A period one day long — the current month, opened on the 1st — is a date,
    // not a range: "Sep 1–1, 2026" reads like a typo.
    if (period.start === period.end) return `${MONTHS[a.m - 1]} ${a.day}, ${a.y}`;
    if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.day}–${b.day}, ${b.y}`;
    if (a.y === b.y) return `${MONTHS[a.m - 1]} ${a.day} – ${MONTHS[b.m - 1]} ${b.day}, ${b.y}`;
    return `${MONTHS[a.m - 1]} ${a.day}, ${a.y} – ${MONTHS[b.m - 1]} ${b.day}, ${b.y}`;
  })();

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Profit &amp; Loss</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · {period.label} · accrual basis ·{' '}
            computed live from <b>Striven</b> Invoices &amp; Bills
            {agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          {/* WHICH PERIOD. Year and part are two controls rather than one list of
              every month of every year, which is 40-odd options to scroll. The
              part list is rebuilt when the year changes, and a part that does not
              exist in the new year (September, on a year that has not reached it)
              falls back to the whole year rather than fetching an empty one. */}
          <label className="ov-filter" style={{ flex: 'none' }}>
            <span className="fl">Year</span>
            <select value={year} onChange={(e) => {
              const y = Number(e.target.value);
              const avail = partsFor(y);
              const stillThere = part === 'all'
                || (part[0] === 'q' ? avail.quarters.includes(Number(part[1])) : avail.months.includes(Number(part)));
              setYear(y);
              if (!stillThere) setPart('all');
            }} style={{ color: C.ink }}>
              {[0, 1, 2, 3].map((back) => THIS_YEAR - back).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="ov-filter" style={{ flex: 'none' }}>
            <span className="fl">Period</span>
            <select value={part} onChange={(e) => setPart(e.target.value as PlPart)}
              title="The whole year, one quarter, or a single month" style={{ color: C.ink }}>
              <option value="all">{year === THIS_YEAR ? 'Year to date' : 'Full year'}</option>
              <optgroup label="Quarter">
                {partsFor(year).quarters.map((q) => <option key={q} value={`q${q}`}>Q{q}</option>)}
              </optgroup>
              <optgroup label="Month">
                {partsFor(year).months.map((m) => (
                  <option key={m} value={String(m).padStart(2, '0')}>{MONTHS[m - 1]}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <span className="ov-filter"><span className="fl">📅</span><b>{rangeChip}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {pl && (
        <>
          {/* EVERY FOOT CARRIES A FACT THE VALUE CANNOT. A count or a margin,
              never a restatement of the number above it. */}
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Revenue" value={pl.revenue} format={formatCurrency}
              delta={revD} deltaText={`${pl.invoiceCount.toLocaleString()} invoices`}
              foot={`${pl.invoiceCount.toLocaleString()} invoices · voided excluded`}
              onClick={explainRevenue} />
            <KpiR ico="trend" tint="#DC2626" label="Expenses" value={pl.expenses} format={formatCurrency}
              delta={expD} deltaInvert deltaText={`${pl.billCount.toLocaleString()} bills`}
              foot={`${pl.billCount.toLocaleString()} vendor bills`} onClick={explainExpenses} />
            <KpiR ico="wallet" tint="#4F46E5" label="Cash Received" value={pl.cashReceived} format={formatCurrency}
              delta={cashD} deltaText="collected to date" foot={`${(payments?.count ?? 0).toLocaleString()} payments collected`} />

            {/* NET PROFIT CLOSES THE ROW, because it is what the other three
                come to: the same parts-then-total rule the commission strip
                follows. */}
            <KpiR ico="pie" tint="#0A369F" label="Net Profit" value={pl.net} format={formatCurrency}
              delta={netD} deltaText={`${pct(pl.margin)} net margin`}
              foot="revenue − expenses"
              onClick={explainNet} />
          </div>

          <div className="exec-grid12">
            <div className="section chart-card g12-12">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Income Statement · {period.label}</h2>
                  <div className="section-sub">Accrual basis = invoices as revenue, bills as expense</div>
                  {/* AN EMPTY PERIOD SAYS SO. A full cascade of zeros is
                      indistinguishable from a business that earned and spent
                      nothing, and the reader's next move — pick another period
                      — depends on knowing which of the two they are looking at. */}
                  {pl.revenue === 0 && pl.expenses === 0 && (
                    <div className="muted-note" style={{ marginTop: 6 }}>
                      Nothing is booked in {period.label}. Try another period.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {/* THE % OF REVENUE COLUMN is the common-size statement an
                    accountant reads before the dollars: the one figure that
                    survives a change in volume, and the only way this year is
                    comparable with a bigger or smaller one.

                    Rows with a breakdown behind them open it on click. */}
                <div className="pl-statement" style={{ flex: '1 1 420px', maxWidth: 660 }}>
                  <div className="pl-head">
                    <span className="lbl">Line</span><span className="pct">% of revenue</span><span className="val">Amount</span>
                  </div>
                  <div className="pl-line pl-click" onClick={explainRevenue}>
                    <span className="lbl">Revenue</span>
                    <span className="pct">{pl.revenue ? '100.0%' : '-'}</span>
                    <span className="val">{formatCurrency(pl.revenue)}</span>
                  </div>
                  <div className="pl-line pl-click" onClick={explainExpenses}>
                    <span className="lbl">Less: Expenses</span>
                    <span className="pct">{shareText(pl.expenses)}</span>
                    <span className="val neg">−{formatCurrency(pl.expenses)}</span>
                  </div>
                  <div className="pl-line pl-total pl-click" onClick={explainNet}>
                    <span className="lbl">Net Profit</span>
                    <span className="pct">{pct(pl.margin)}</span>
                    <span className="val">{formatCurrency(pl.net)}</span>
                  </div>
                  {monthCount > 0 && (
                    <div className="pl-line pl-sub">
                      <span className="lbl">
                        Per month across {monthCount} month{monthCount === 1 ? '' : 's'} · {formatCurrency(perMonth(pl.revenue))} revenue
                      </span>
                      <span className="pct" />
                      <span className="val">{formatCurrency(perMonth(pl.net))} net</span>
                    </div>
                  )}
                </div>
                <div style={{ flex: '0 0 240px', margin: '0 auto' }}>
                  <GaugeRing value={Math.max(0, Math.min(100, pl.margin))} centerValue={pct(pl.margin)} centerLabel="Net Margin" color={pl.net >= 0 ? C.positive : C.negative} height={180} />
                </div>
              </div>
              <div className="pl-meta">
                <div><span>Avg invoice</span><strong>{formatCurrency(pl.avgInvoice)}</strong></div>
                <div><span>Avg bill</span><strong>{formatCurrency(pl.avgBill)}</strong></div>
                <div><span>Revenue per month</span><strong>{formatCurrency(perMonth(pl.revenue))}</strong></div>
                <div><span>Net margin</span><strong>{pct(pl.margin)}</strong></div>
                <div><span>Cash collected</span><strong>{formatCurrency(pl.cashReceived)}</strong></div>
              </div>
            </div>

            <ChartCard className="g12-7" title="Revenue vs Expenses by Month" sub={`${pl.series.length} month${pl.series.length === 1 ? '' : 's'} · ${period.label}`}>
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

            <ChartCard className="g12-5" title="Expenses by Vendor"
              sub={`${formatCurrency(pl.expenses)} across ${pl.billCount} bill${pl.billCount === 1 ? '' : 's'}`}>
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
                Accrual basis · {period.label} · computed from {pl.invoiceCount} invoices &amp; {pl.billCount} bills. Striven's API has no P&amp;L report endpoint, so this statement is derived live from the underlying transactions.
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
