import { useEffect, useState, type ReactNode } from 'react';
import { fetchQbPL, type QbPlResult, type QbPlMonth, type QbLine, type QbCategory, type PlPeriod } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, monthLabel } from '../chartTheme';
import { ChartCard, RankBar, TrendArea, LegendDots, DrillModal, KpiR, useSyncAgo } from '../chartKit';

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


/**
 * THE P&L IS QUICKBOOKS' P&L.
 *
 * Every figure on this tab is read from QuickBooks' own Profit and Loss report
 * (/api/qb/pl): income by account, cost of goods and expenses by the category
 * the chart of accounts groups them under, other income, net income, and the
 * month-by-month split. Nothing is mixed in from Striven invoices, the AP
 * workbook or the commission book — QuickBooks is the books, and a statement
 * assembled from three other systems disagreed with it by six figures (payroll
 * and contract labour, recorded only there, were missing entirely).
 */
export function PLTab() {
  const [year, setYear] = useState<number>(THIS_YEAR);
  const [part, setPart] = useState<PlPart>('all');
  const period = periodOf(year, part);
  const [pl, setPl] = useState<QbPlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  // The outcome of a QuickBooks connect, which Intuit's redirect hands back as
  // ?qb=connected or ?qb=error&reason=… — shown once, then cleared from the URL.
  const [qbNotice] = useState<null | { ok: boolean; text: string }>(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get('qb');
    if (!v) return null;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    return v === 'connected'
      ? { ok: true, text: 'QuickBooks connected.' }
      : { ok: false, text: `QuickBooks connection failed: ${p.get('reason') || 'unknown error'}` };
  });
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setPl(await fetchQbPL({ start: period.start, end: period.end }));
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load the QuickBooks P&L.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    // Drop the previous period's figures FIRST, so they can never sit under the
    // new period's heading while the request is in flight.
    setPl(null);
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, part]);

  const series = pl?.series ?? [];
  const revD = momDelta(series.map((m) => ({ month: m.month, value: m.revenue })));
  const expD = momDelta(series.map((m) => ({ month: m.month, value: m.opex ?? 0 })));
  const netD = momDelta(series.map((m) => ({ month: m.month, value: m.net })));

  // The statement's figures, each as QuickBooks reports it.
  const income = pl?.income ?? 0;
  const cogs = pl?.cogs ?? 0;
  const grossProfit = pl?.grossProfit ?? income - cogs;
  const opexTotal = pl?.expenses ?? 0;
  const netOperating = pl?.netOperating ?? grossProfit - opexTotal;
  const otherIncome = pl?.otherIncome ?? 0;
  const otherExpenses = pl?.otherExpenses ?? 0;
  const netIncome = pl?.net ?? 0;
  const cogsCats = (pl?.categories ?? []).filter((c) => c.section === 'cogs');
  const opexCats = (pl?.categories ?? []).filter((c) => c.section === 'opex');
  const hasOther = otherIncome !== 0 || otherExpenses !== 0;

  // COLLAPSIBLE SECTIONS. The statement opens folded to its totals — the
  // shape of the year at a glance — and a section heading unfolds its lines.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const secHead = (k: string, step: number, title: string, hint: string, count: number) => (
    <div className={`pl-sec pl-sec-toggle${open[k] ? ' open' : ''}`} role="button" tabIndex={0}
      aria-expanded={!!open[k]} onClick={() => toggle(k)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(k); } }}>
      <span className="pl-chev" aria-hidden>▸</span>
      <span className="pl-step">{step}</span>{title}
      <span className="pl-hint">{open[k] ? hint : `${count} line${count === 1 ? '' : 's'} · click to show`}</span>
    </div>
  );

  /** Every statement line as a share of sales — the common-size column. Zero
   *  sales divides by nothing, so it prints a dash rather than Infinity. */
  const share = (v: number) => (income ? (v / income) * 100 : 0);
  const shareText = (v: number) => (income ? pct(share(v)) : '-');
  /** A share of sales as cents of a dollar: plainer than a percentage. */
  const cents = (v: number) => (income ? `${Math.round(share(v))}¢` : '-');
  /** Months the averages divide by: complete months, plus the running one only
   *  once something is booked in it (see the git history for why). */
  const monthCount = series.filter((mo) => mo.month < nowYm || mo.revenue !== 0 || mo.expenses !== 0).length;
  const perMonth = (v: number) => (monthCount ? v / monthCount : 0);

  // Tap-to-explain drills.
  const kv = (rows: { k: ReactNode; v: ReactNode; rowClass?: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => (r.rowClass ? { k: r.k, v: r.v, rowClass: r.rowClass } : { k: r.k, v: r.v })),
  });
  const qbSub = (what: string) => `QuickBooks Profit & Loss · ${period.label} · ${what}`;
  const byMonth = (title: string, pickV: (m: QbPlMonth) => number, total: number, totalLabel: string) => setDrill({
    title, sub: qbSub('by month'),
    ...kv([
      ...series.map((m) => ({ k: `${monthLabel(m.month)} ${m.month.slice(0, 4)}`, v: formatCurrency(pickV(m)) })),
      { k: totalLabel, v: formatCurrency(total), rowClass: 'total-row' },
    ]),
  });
  const explainLines = (title: string, what: string, lines: QbLine[], total: number, totalLabel: string) => setDrill({
    title, sub: qbSub(what),
    ...kv([
      ...lines.map((l) => ({ k: l.name, v: formatCurrency(l.value) })),
      { k: totalLabel, v: formatCurrency(total), rowClass: 'total-row' },
    ]),
  });
  const explainCategory = (c: QbCategory) => explainLines(
    c.category, `${c.section === 'cogs' ? 'Cost of goods sold' : 'Expenses'}, by account`,
    c.accounts.map((a) => ({ name: a.label, value: a.value })), c.total, `Total ${c.category.toLowerCase()}`,
  );
  const explainSection = (title: string, cats: QbCategory[], total: number) => explainLines(
    title, 'by category', cats.map((c) => ({ name: c.category, value: c.total })), total, `Total ${title.toLowerCase()}`,
  );
  const explainNet = () => setDrill({
    title: 'Net income', sub: qbSub('top to bottom'),
    ...kv([
      { k: 'Income', v: formatCurrency(income) },
      { k: 'Cost of goods sold', v: `−${formatCurrency(cogs)}` },
      { k: 'Gross profit', v: formatCurrency(grossProfit) },
      { k: 'Expenses', v: `−${formatCurrency(opexTotal)}` },
      { k: 'Net operating income', v: formatCurrency(netOperating) },
      ...(otherIncome ? [{ k: 'Other income', v: formatCurrency(otherIncome) }] : []),
      ...(otherExpenses ? [{ k: 'Other expenses', v: `−${formatCurrency(otherExpenses)}` }] : []),
      { k: 'Net income', v: formatCurrency(netIncome), rowClass: 'total-row' },
      { k: 'Net margin', v: pct(pl?.margin ?? 0) },
    ]),
  });

  // THE CHIP READS THE PERIOD, NOT THE CLOCK. Dates are formatted from the
  // YYYY-MM-DD text, split by hand: a `new Date('2026-08-31')` is parsed as UTC
  // midnight and prints as the 30th to anyone west of Greenwich. Month and year
  // are not repeated when both ends share them.
  const dayParts = (d: string) => { const [y, m, day] = d.split('-').map(Number); return { y, m, day }; };
  const rangeChip = (() => {
    const a = dayParts(period.start), b = dayParts(period.end);
    if (period.start === period.end) return `${MONTHS[a.m - 1]} ${a.day}, ${a.y}`;
    if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.day}–${b.day}, ${b.y}`;
    if (a.y === b.y) return `${MONTHS[a.m - 1]} ${a.day} – ${MONTHS[b.m - 1]} ${b.day}, ${b.y}`;
    return `${MONTHS[a.m - 1]} ${a.day}, ${a.y} – ${MONTHS[b.m - 1]} ${b.day}, ${b.y}`;
  })();

  // WHERE EACH DOLLAR GOES. Cost of goods, the three biggest expense
  // categories, the rest of the expenses as one bar, and what operations left
  // over — which adds back to exactly $1 of sales. Other income is not a share
  // of sales, so it is named underneath rather than drawn as a bar.
  const topOpex = [...opexCats].sort((a, b) => b.total - a.total).slice(0, 3);
  const restOpex = opexTotal - topOpex.reduce((s, c) => s + c.total, 0);
  const dollarRows = [
    { name: 'Cost of goods sold', value: cogs, color: '#F59E0B' },
    ...topOpex.map((c, i) => ({ name: c.category, value: c.total, color: ['#DC2626', '#EC4899', '#8B5CF6'][i] })),
    ...(restOpex > 0.5 ? [{ name: 'All other expenses', value: restOpex, color: '#94A3B8' }] : []),
    { name: netOperating >= 0 ? 'Left over from operations' : 'Operations short by', value: Math.abs(netOperating), color: netOperating >= 0 ? C.positive : C.negative },
  ];

  const notConnected = !!error && /not connected|reconnect|token|invalid_grant/i.test(error);

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Profit &amp; Loss</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · {period.label} · {(pl?.basis ?? 'accrual').toLowerCase()} basis ·{' '}
            every figure from <b>QuickBooks</b>
            {agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          {/* WHICH PERIOD. Year and part are two controls; a part that does not
              exist in the newly picked year falls back to the whole year. */}
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

      {qbNotice && <div className={qbNotice.ok ? 'qb-banner ok' : 'qb-banner warn'}>{qbNotice.text}</div>}

      {error && (
        <div className="qb-banner warn">
          <span><b>QuickBooks could not be read.</b> {error}</span>
          {notConnected && <a className="btn" href="/api/qb/connect">Connect QuickBooks →</a>}
        </div>
      )}

      {loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading from QuickBooks…</div>}

      {pl && (
        <>
          {/* FOUR NUMBERS, IN THE ORDER THE MONEY FLOWS. */}
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Sales" value={income} format={formatCurrency}
              delta={revD} deltaText="vs prior month"
              foot="QuickBooks · total income"
              onClick={() => byMonth('Sales', (m) => m.revenue, income, 'Total income')} />
            <KpiR ico="wallet" tint="#4F46E5" label="Gross profit" value={grossProfit} format={formatCurrency}
              deltaText={`keeps ${cents(grossProfit)} of every $1`}
              foot={`sales − ${formatCurrency(cogs)} cost of goods`}
              onClick={() => explainSection('Cost of goods sold', cogsCats, cogs)} />
            <KpiR ico="trend" tint="#DC2626" label="Expenses" value={opexTotal} format={formatCurrency}
              delta={expD} deltaInvert deltaText={`${cents(opexTotal)} of every $1`}
              foot="payroll, contract labour & overhead"
              onClick={() => explainSection('Expenses', opexCats, opexTotal)} />
            <KpiR ico="pie" tint="#0A369F" label="Net income" value={netIncome} format={formatCurrency}
              delta={netD} deltaText={`keeps ${cents(netIncome)} of every $1`}
              foot="QuickBooks' bottom line"
              onClick={explainNet} />
          </div>

          <div className="exec-grid12">
            <div className="section chart-card g12-12">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Profit &amp; Loss · {period.label}</h2>
                  <div className="section-sub">QuickBooks' statement, read top to bottom. Click any line to see the accounts behind it.</div>
                  {income === 0 && cogs === 0 && opexTotal === 0 && (
                    <div className="muted-note" style={{ marginTop: 6 }}>
                      Nothing is booked in QuickBooks for {period.label}. Try another period.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="pl-statement" style={{ flex: '1 1 440px', maxWidth: 680 }}>
                  <div className="pl-head">
                    <span className="lbl" /><span className="pct">Of sales</span><span className="val">Amount</span>
                  </div>

                  {secHead('income', 1, 'Income', 'by income account', pl.incomeAccounts.length)}
                  {open.income && pl.incomeAccounts.map((a) => (
                    <div key={a.name} className="pl-line pl-indent pl-click"
                      onClick={() => explainLines('Income', 'by account', pl.incomeAccounts, income, 'Total income')}>
                      <span className="lbl">{a.name}</span>
                      <span className="pct">{shareText(a.value)}</span>
                      <span className="val">{formatCurrency(a.value)}</span>
                    </div>
                  ))}
                  <div className="pl-line pl-subtotal pl-click" onClick={() => byMonth('Sales', (m) => m.revenue, income, 'Total income')}>
                    <span className="lbl">Total income</span>
                    <span className="pct">{income ? '100%' : '-'}</span>
                    <span className="val">{formatCurrency(income)}</span>
                  </div>

                  {secHead('cogs', 2, 'Cost of goods sold', 'devices, supplies & materials', cogsCats.length)}
                  {open.cogs && cogsCats.map((c) => (
                    <div key={c.category} className="pl-line pl-indent pl-click" onClick={() => explainCategory(c)}>
                      <span className="lbl">{c.category}</span>
                      <span className="pct">{shareText(c.total)}</span>
                      <span className="val neg">−{formatCurrency(c.total)}</span>
                    </div>
                  ))}
                  <div className="pl-line pl-subtotal pl-click" onClick={() => toggle('cogs')}>
                    <span className="lbl">Total cost of goods sold</span>
                    <span className="pct">{shareText(cogs)}</span>
                    <span className="val neg">−{formatCurrency(cogs)}</span>
                  </div>
                  <div className="pl-line pl-total pl-click" onClick={() => explainSection('Cost of goods sold', cogsCats, cogs)}>
                    <span className="lbl">Gross profit</span>
                    <span className="pct">{shareText(grossProfit)}</span>
                    <span className="val">{formatCurrency(grossProfit)}</span>
                  </div>

                  {secHead('opex', 3, 'Expenses', 'by category, biggest first', opexCats.length)}
                  {open.opex && [...opexCats].sort((a, b) => b.total - a.total).map((c) => (
                    <div key={c.category} className="pl-line pl-indent pl-click" onClick={() => explainCategory(c)}>
                      <span className="lbl">{c.category}</span>
                      <span className="pct">{shareText(c.total)}</span>
                      <span className="val neg">−{formatCurrency(c.total)}</span>
                    </div>
                  ))}
                  <div className="pl-line pl-subtotal pl-click" onClick={() => toggle('opex')}>
                    <span className="lbl">Total expenses</span>
                    <span className="pct">{shareText(opexTotal)}</span>
                    <span className="val neg">−{formatCurrency(opexTotal)}</span>
                  </div>
                  <div className="pl-line pl-total pl-click" onClick={() => explainSection('Expenses', opexCats, opexTotal)}>
                    <span className="lbl">Net operating income</span>
                    <span className="pct">{shareText(netOperating)}</span>
                    <span className="val">{formatCurrency(netOperating)}</span>
                  </div>

                  {hasOther && (
                    <>
                      {secHead('other', 4, 'Other income & expenses', 'outside normal operations',
                        (pl.otherIncomeAccounts ?? []).length + (pl.otherExpenseAccounts ?? []).length)}
                      {open.other && (pl.otherIncomeAccounts ?? []).map((a) => (
                        <div key={`oi-${a.name}`} className="pl-line pl-indent pl-click"
                          onClick={() => explainLines('Other income', 'by account', pl.otherIncomeAccounts ?? [], otherIncome, 'Total other income')}>
                          <span className="lbl">{a.name}</span>
                          <span className="pct">{shareText(a.value)}</span>
                          <span className="val">{formatCurrency(a.value)}</span>
                        </div>
                      ))}
                      {open.other && (pl.otherExpenseAccounts ?? []).map((a) => (
                        <div key={`oe-${a.name}`} className="pl-line pl-indent pl-click"
                          onClick={() => explainLines('Other expenses', 'by account', pl.otherExpenseAccounts ?? [], otherExpenses, 'Total other expenses')}>
                          <span className="lbl">{a.name}</span>
                          <span className="pct">{shareText(a.value)}</span>
                          <span className="val neg">−{formatCurrency(a.value)}</span>
                        </div>
                      ))}
                      <div className="pl-line pl-subtotal pl-click" onClick={() => toggle('other')}>
                        <span className="lbl">Net other income</span>
                        <span className="pct">{shareText(otherIncome - otherExpenses)}</span>
                        <span className="val">{formatCurrency(otherIncome - otherExpenses)}</span>
                      </div>
                    </>
                  )}
                  <div className="pl-line pl-total pl-final pl-click" onClick={explainNet}>
                    <span className="lbl">Net income</span>
                    <span className="pct">{pct(pl.margin)}</span>
                    <span className="val">{formatCurrency(netIncome)}</span>
                  </div>
                </div>

                <div className="dollar-split" style={{ flex: '0 1 300px' }}>
                  <div className="ds-title">Where each $1 of sales goes</div>
                  {dollarRows.map((r) => (
                    <div key={r.name} className="ds-row">
                      <div className="ds-lbl"><span>{r.name}</span><b>{cents(r.value)}</b></div>
                      <div className="ds-track"><div className="ds-bar" style={{ width: `${Math.max(0, Math.min(100, share(r.value)))}%`, background: r.color }} /></div>
                    </div>
                  ))}
                  {hasOther && (
                    <div className="ds-foot">
                      Plus <b>{formatCurrency(otherIncome - otherExpenses)}</b> net other income, for a net income of <b>{formatCurrency(netIncome)}</b>.
                    </div>
                  )}
                  {monthCount > 0 && (
                    <div className="ds-foot">
                      On average per month: <b>{formatCurrency(perMonth(income))}</b> in sales,{' '}
                      <b>{formatCurrency(perMonth(netIncome))}</b> net income.
                    </div>
                  )}
                </div>
              </div>
              <div className="pl-meta">
                <div><span>Gross margin</span><strong>{shareText(grossProfit)}</strong></div>
                <div><span>Operating margin</span><strong>{shareText(netOperating)}</strong></div>
                <div><span>Net margin</span><strong>{pct(pl.margin)}</strong></div>
                <div><span>Sales per month</span><strong>{formatCurrency(perMonth(income))}</strong></div>
                <div><span>Expenses per month</span><strong>{formatCurrency(perMonth(opexTotal))}</strong></div>
              </div>
            </div>

            <ChartCard className="g12-7" title="Sales vs Costs, Month by Month" sub={`${series.length} month${series.length === 1 ? '' : 's'} · ${period.label}`}>
              <LegendDots items={[{ name: 'Sales', color: C.positive }, { name: 'Cost of goods + expenses', color: C.negative }]} />
              <TrendArea
                data={series}
                series={[{ key: 'revenue', name: 'Sales', color: C.positive }, { key: 'expenses', name: 'Costs', color: C.negative }]}
                idPrefix="pl-rev" dots
              />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Sales</div><div className="v pos">{formatCurrency(income)}</div></div>
                <div className="cf-i"><div className="l">All costs</div><div className="v neg">{formatCurrency(cogs + opexTotal)}</div></div>
                <div className="cf-i"><div className="l">Net income</div><div className="v accent">{formatCurrency(netIncome)}</div></div>
                <div className="cf-i"><div className="l">Margin</div><div className="v">{pct(pl.margin)}</div></div>
              </div>
            </ChartCard>

            <ChartCard className="g12-5" title="Biggest Costs"
              sub={`${formatCurrency(cogs + opexTotal)} across ${(pl.categories ?? []).length} QuickBooks categories`}>
              <RankBar
                data={(pl.categories ?? []).slice(0, 8).map((c) => ({ name: c.category, value: c.total }))}
                money colorAt={() => C.negative}
                onSelect={(name) => { const c = pl.categories.find((x) => x.category === name); if (c) explainCategory(c); }}
              />
            </ChartCard>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Monthly P&amp;L</h2><div className="section-sub">QuickBooks' statement, one row per month</div></div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Month</th><th className="num">Sales</th><th className="num">Cost of goods</th>
                      <th className="num">Gross profit</th><th className="num">Expenses</th>
                      {hasOther && <th className="num">Other</th>}
                      <th className="num">Net income</th><th className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((m) => (
                      <tr key={m.month}>
                        <td><strong>{monthLabel(m.month)} {m.month.slice(0, 4)}</strong></td>
                        <td className="num">{formatCurrency(m.revenue)}</td>
                        <td className="num">{formatCurrency(m.cogs ?? 0)}</td>
                        <td className="num">{formatCurrency(m.grossProfit ?? (m.revenue - (m.cogs ?? 0)))}</td>
                        <td className="num">{formatCurrency(m.opex ?? 0)}</td>
                        {hasOther && <td className="num">{formatCurrency(m.other ?? 0)}</td>}
                        <td className="num" style={{ color: m.net >= 0 ? '#047857' : '#b91c1c', fontWeight: 700 }}>{formatCurrency(m.net)}</td>
                        <td className="num">{m.revenue ? pct((m.net / m.revenue) * 100) : '-'}</td>
                      </tr>
                    ))}
                    {series.length === 0 && <tr><td colSpan={hasOther ? 8 : 7} className="muted-note">No transactions in the period.</td></tr>}
                    {series.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td className="num">{formatCurrency(income)}</td>
                        <td className="num">{formatCurrency(cogs)}</td>
                        <td className="num">{formatCurrency(grossProfit)}</td>
                        <td className="num">{formatCurrency(opexTotal)}</td>
                        {hasOther && <td className="num">{formatCurrency(otherIncome - otherExpenses)}</td>}
                        <td className="num">{formatCurrency(netIncome)}</td>
                        <td className="num">{pct(pl.margin)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="muted-note">
                {pl.basis} basis · {period.label} · QuickBooks Profit and Loss report
                {pl.generatedAt ? `, generated ${new Date(pl.generatedAt).toLocaleString()}` : ''}. Figures are exactly what is posted in QuickBooks.
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
