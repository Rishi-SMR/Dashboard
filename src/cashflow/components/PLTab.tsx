import { useEffect, useState, type ReactNode } from 'react';
import { fetchStrivenPL, fetchStrivenPayments, fetchQbPL, type PlResult, type PaymentsResult, type QbPl, type PlPeriod } from '../strivenApi';
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
  const [year, setYear] = useState<number>(THIS_YEAR);
  const [part, setPart] = useState<PlPart>('all');
  const period = periodOf(year, part);
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
      // BOTH SOURCES GET THE SAME DATES. Striven's payments endpoint does not
      // take a period, so `cashReceived` there stays the year to date — the tile
      // that shows it says "collected to date", not "collected this month".
      const range = { start: period.start, end: period.end };
      if (source === 'quickbooks') {
        const q = await fetchQbPL(range);
        setQb(q); setPl(qbToPl(q)); setPayments(null);
      } else {
        const [p, pay] = await Promise.all([fetchStrivenPL(range), fetchStrivenPayments().catch(() => null)]);
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
  }, [source, year, part]);

  const revD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.revenue })));
  const expD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.expenses })));
  const netD = momDelta((pl?.series ?? []).map((m) => ({ month: m.month, value: m.net })));
  const cashD = momDelta((payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount })));

  const vendorData = (pl?.byVendor ?? []).slice(0, 8).map((v) => ({ name: v.name, value: v.value }));

  // ── The two ratios the statement turns on, and the cost that dominates it ──
  // GROSS margin is not net margin: it is what survives the cost of the goods
  // themselves, before any overhead, and on this book the two are 40 points
  // apart — a gap that says where the money actually goes. Computed here rather
  // than in a tile so the statement below reads the same numbers.
  //
  // Guarded against a zero-revenue period: a P&L opened in January divides by
  // nothing, and "Infinity% margin" is a worse answer than 0.
  const grossMargin = qb?.income ? ((qb.grossProfit ?? 0) / qb.income) * 100 : 0;
  const opexRatio = qb?.income ? ((qb.expenses ?? 0) / qb.income) * 100 : 0;
  /** Every statement line as a share of revenue — the common-size column an
   *  accountant reads before the dollars, because it is the only figure that
   *  survives a change in volume. Zero revenue divides by nothing, so it prints
   *  a dash rather than Infinity. */
  const share = (v: number) => (pl?.revenue ? (v / pl.revenue) * 100 : 0);
  const shareText = (v: number) => (pl?.revenue ? pct(share(v)) : '-');
  const cogsRatio = share(qb?.cogs ?? 0);
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
  /**
   * OPERATING INCOME vs NET PROFIT. They differ only where the book carries
   * income or expense outside operations — interest, tax, a one-off. Printing
   * both when they agree is a line that says nothing twice, so the extra rows
   * appear only when there is genuinely something between them.
   */
  const otherIncome = (qb?.netIncome ?? 0) - (qb?.netOperating ?? 0);
  const hasOther = qb?.netOperating != null && Math.abs(otherIncome) >= 1;
  /** Categories split by the cost line they belong to. A response cached before
   *  the API tagged them carries no section — then the breakdown is omitted
   *  rather than guessed, and the statement simply reads as it did before. */
  const catsTagged = (qb?.categories ?? []).some((c) => c.section);
  const catsOf = (section: 'cogs' | 'opex') =>
    (qb?.categories ?? []).filter((c) => c.section === section && c.total > 0).sort((a, b) => b.total - a.total);
  /**
   * WHERE EACH REVENUE DOLLAR GOES — the cascade's own three figures as one
   * bar, so the mix reads without arithmetic. Widths are shares of the bar's
   * own total, which IS revenue whenever the period is profitable; on a loss
   * the profit segment drops out and cost fills the bar.
   *
   * Colours are this app's existing tokens, kept because they already carry the
   * same meaning on the tiles above. Checked as an adjacent set for colour-vision
   * separation (the amber that first sat here failed against the red), and every
   * segment is directly labelled, so identity never rests on colour alone.
   */
  const dollarSegs = [
    { name: 'Cost of goods', v: qb?.cogs ?? 0, c: C.negative },
    { name: 'Operating', v: qb?.expenses ?? 0, c: C.purple },
    { name: 'Profit', v: Math.max(0, pl?.net ?? 0), c: C.positive },
  ].filter((d) => d.v > 0);
  const dollarBase = dollarSegs.reduce((sum, d) => sum + d.v, 0) || 1;
  /** The single largest cost category — the one line worth naming on a tile. */
  const topCategory = (qb?.categories ?? []).reduce<null | { category: string; total: number }>(
    (best, c) => (best == null || c.total > best.total ? { category: c.category, total: c.total } : best), null);

  // Tap-to-explain drills.
  const kv = (rows: { k: ReactNode; v: ReactNode; rowClass?: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => (r.rowClass ? { k: r.k, v: r.v, rowClass: r.rowClass } : { k: r.k, v: r.v })),
  });

  /**
   * The categories inside one cost line, indented under it.
   *
   * WHY IT RECONCILES. If the categories do not account for the whole line the
   * remainder is named on its own row rather than left as a silent gap — an
   * indented block that does not sum to the line above it is worse than no
   * block at all, because a reader has no way to see that anything is missing.
   */
  const costDetail = (section: 'cogs' | 'opex', lineTotal: number) => {
    if (!catsTagged) return null;
    const cats = catsOf(section);
    if (!cats.length) return null;
    const rest = lineTotal - cats.reduce((sum, c) => sum + c.total, 0);
    // ONE CATEGORY NAMED AFTER ITS OWN LINE ADDS NOTHING. "Cost of goods sold"
    // indented under "Less: Cost of goods sold", at the same figure, is the line
    // said twice — the same rule the expenses drill already applies to accounts.
    const lineName = section === 'cogs' ? 'cost of goods sold' : 'operating expenses';
    if (cats.length === 1 && Math.abs(rest) < 1 && cats[0].category.trim().toLowerCase() === lineName) return null;
    return (
      <>
        {cats.map((c) => (
          <div className="pl-line pl-item" key={`${section}-${c.category}`}>
            <span className="lbl">{c.category}</span>
            <span className="pct">{shareText(c.total)}</span>
            <span className="val">{formatCurrency(c.total)}</span>
          </div>
        ))}
        {Math.abs(rest) >= 1 && (
          <div className="pl-line pl-item">
            <span className="lbl">Other {section === 'cogs' ? 'cost of goods' : 'operating costs'}</span>
            <span className="pct">{shareText(rest)}</span>
            <span className="val">{formatCurrency(rest)}</span>
          </div>
        )}
      </>
    );
  };
  const explainRevenue = () => setDrill({
    title: 'Revenue', sub: `Every customer invoice in ${period.label} (voided excluded), by month`,
    ...kv([
      ...(pl?.series ?? []).map((m) => ({ k: `${monthLabel(m.month)} ${m.month.slice(0, 4)}`, v: formatCurrency(m.revenue) })),
      { k: 'Total revenue', v: formatCurrency(pl?.revenue ?? 0), rowClass: 'total-row' },
    ]),
  });
  const explainExpenses = () => setDrill({
    title: 'Expenses',
    sub: source === 'quickbooks'
      ? 'Cost of goods sold and operating expenses, by category, with the accounts inside each'
      : `Every vendor bill in ${period.label} (voided excluded), by vendor`,
    // CATEGORY, THEN THE ACCOUNTS INSIDE IT — the shape of a P&L, not a flat
    // ledger. Each category's accounts sum to the category line above them.
    //
    // THE TWO LEVELS ARE STYLED, NOT SPACED. The indent used to be four leading
    // SPACES in the label, and HTML collapses those to one — so "Payroll
    // expenses $228,373" was followed by a flush-left "Wages $228,373" and the
    // reader saw the same money twice with nothing to say one contained the
    // other. Categories are now header rows and accounts are indented in the
    // markup, so the hierarchy survives the render.
    //
    // AND A CATEGORY WITH ONE ACCOUNT IS ONE ROW. Where a category holds a
    // single account at the same figure, the second row adds a name and no
    // information — so the name moves onto the category's own row
    // ("Payroll expenses · Wages") and the duplicate value disappears.
    //
    // NO SILENT CAP. This listed the top 10 and then printed the true total
    // underneath, so any book with an eleventh line showed a column that did not
    // add up — and gave the reader no way to know rows had been dropped. A
    // breakdown whose rows do not reconcile to its own total is worse than a
    // long list. If the list ever gets unwieldy the fix is an explicit
    // "+N more" row carrying the remainder, not a quiet slice.
    ...kv([
      ...(source === 'quickbooks' && qb?.categories?.length
        ? qb.categories.filter((c) => c.total > 0).flatMap((c) => {
          const only = c.accounts.length === 1 ? c.accounts[0] : null;
          if (only && Math.abs(only.value - c.total) < 1) {
            return [{
              // "Office expenses / Office expenses" was already noise; the account
              // name is only worth printing when it says something the category does not.
              k: only.label === c.category ? c.category : <>{c.category} <span className="drill-in">· {only.label}</span></>,
              v: formatCurrency(c.total),
              rowClass: 'subtotal-row',
            }];
          }
          return [
            { k: c.category, v: formatCurrency(c.total), rowClass: 'subtotal-row' },
            ...c.accounts.map((a) => ({ k: <span className="drill-acct">{a.label}</span>, v: formatCurrency(a.value) })),
          ];
        })
        : (pl?.byVendor ?? []).map((v) => ({ k: v.name, v: formatCurrency(v.value) }))),
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
            <span className="live-dot" /> Sports Med Recovery · {period.label} · {qb ? `${qb.basis.toLowerCase()} basis` : 'accrual basis'} ·{' '}
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
          {/* ── THE TILES ARE THE STATEMENT, IN ORDER ──────────────────────────
              Revenue → less COGS → Gross profit → less operating → Net profit.
              Each tile is the next line of the P&L, so reading left to right IS
              reading the statement.

              WHAT THIS REPLACED, and why it was worth restructuring rather than
              restyling. The strip was Revenue · Expenses · Net Profit · Gross
              Profit, which had two faults that no amount of polish fixes:
                · GROSS PROFIT CAME AFTER NET PROFIT — the cascade ran backwards,
                  and the one tile that explains the gap between the other two
                  sat past the answer.
                · "EXPENSES" WAS COGS + OPERATING, sitting beside a Gross Profit
                  that had already deducted COGS. The same $118k was inside two
                  tiles at once, so the four figures could not be read as a
                  sequence — only as four unrelated totals.
              Splitting cost into its two real lines makes the row add up on
              sight: 564,305 − 118,363 = 445,942, less 229,513 = 216,429.

              EVERY FOOT CARRIES A FACT THE VALUE CANNOT. A margin, a share, or
              the largest component — never a restatement of the number above it. */}
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Revenue" value={pl.revenue} format={formatCurrency}
              delta={revD} deltaText={source === 'quickbooks' ? 'income, all sources' : `${pl.invoiceCount.toLocaleString()} invoices`}
              foot={source === 'quickbooks' ? 'Income, per the chart of accounts' : `${pl.invoiceCount.toLocaleString()} invoices · voided excluded`}
              onClick={explainRevenue} />

            {source === 'quickbooks' ? (
              <>
                <KpiR ico="wallet" tint="#4F46E5" label="Gross Profit" value={qb?.grossProfit ?? 0} format={formatCurrency}
                  deltaText={`${pct(grossMargin)} gross margin`}
                  foot={`after ${formatCurrency(qb?.cogs ?? 0)} cost of goods sold`} />
                <KpiR ico="trend" tint="#DC2626" label="Operating Expenses" value={qb?.expenses ?? 0} format={formatCurrency}
                  deltaInvert deltaText={`${pct(opexRatio)} of revenue`}
                  foot={topCategory ? `largest: ${topCategory.category} ${formatCurrency(topCategory.total)}` : 'excludes cost of goods sold'}
                  onClick={explainExpenses} />
              </>
            ) : (
              <>
                <KpiR ico="trend" tint="#DC2626" label="Expenses" value={pl.expenses} format={formatCurrency}
                  delta={expD} deltaInvert deltaText={`${pl.billCount.toLocaleString()} bills`}
                  foot={`${pl.billCount.toLocaleString()} vendor bills`} onClick={explainExpenses} />
                <KpiR ico="wallet" tint="#4F46E5" label="Cash Received" value={pl.cashReceived} format={formatCurrency}
                  delta={cashD} deltaText="collected to date" foot={`${(payments?.count ?? 0).toLocaleString()} payments collected`} />
              </>
            )}

            {/* NET PROFIT CLOSES THE ROW, because it is what the other three
                come to — the same parts-then-total rule the commission strip
                follows. */}
            <KpiR ico="pie" tint="#0A369F" label="Net Profit" value={pl.net} format={formatCurrency}
              delta={netD} deltaText={`${pct(pl.margin)} net margin`}
              foot={source === 'quickbooks' ? 'gross profit less operating expenses' : 'revenue − expenses'}
              onClick={explainNet} />
          </div>

          <div className="exec-grid12">
            <div className="section chart-card g12-12">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Income Statement · {period.label}</h2>
                  <div className="section-sub">{source === 'quickbooks'
                    ? `${qb?.basis ?? 'Accrual'} basis · income, cost of goods sold and operating expenses as QuickBooks reports them`
                    : 'Accrual basis = invoices as revenue, bills as expense'}</div>
                  {/* AN EMPTY PERIOD SAYS SO. A full cascade of zeros is
                      indistinguishable from a business that earned and spent
                      nothing, and the reader's next move — pick another period
                      — depends on knowing which of the two they are looking at. */}
                  {pl.revenue === 0 && pl.expenses === 0 && (
                    <div className="muted-note" style={{ marginTop: 6 }}>
                      Nothing is booked in {period.label} on this source. Try another period, or switch <b>Source</b>.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {/* THE FULL CASCADE, not a three-line summary.
                    This showed Revenue → Less: Expenses → Net Profit, which
                    folded cost of goods and overhead into one line and hid the
                    single most useful figure on the statement: gross profit.
                    QuickBooks reports the two costs separately, so showing them
                    separately costs nothing and answers "is the problem what we
                    buy, or what we spend running the place".

                    AND NOW WHAT EACH LINE IS MADE OF. Five bare totals said what
                    the period came to and nothing about why: a reader looking at
                    $233,096 of operating expense had to open a drill to learn
                    that nearly all of it is payroll. The categories QuickBooks
                    already subtotals at now sit indented under the line they
                    belong to, and every block sums to that line — anything the
                    categories do not account for is named, never dropped.

                    THE % OF REVENUE COLUMN is the common-size statement an
                    accountant reads before the dollars: the one figure that
                    survives a change in volume, and the only way this year is
                    comparable with a bigger or smaller one. It also retires the
                    two "margin" sub-rows, which restated a number already shown.

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
                  {source === 'quickbooks' ? (
                    <>
                      <div className="pl-line pl-click" onClick={explainExpenses}>
                        <span className="lbl">Less: Cost of goods sold</span>
                        <span className="pct">{shareText(qb?.cogs ?? 0)}</span>
                        <span className="val neg">−{formatCurrency(qb?.cogs ?? 0)}</span>
                      </div>
                      {costDetail('cogs', qb?.cogs ?? 0)}
                      <div className="pl-line pl-total">
                        <span className="lbl">Gross Profit</span>
                        <span className="pct">{shareText(qb?.grossProfit ?? 0)}</span>
                        <span className="val">{formatCurrency(qb?.grossProfit ?? 0)}</span>
                      </div>
                      <div className="pl-line pl-click" onClick={explainExpenses}>
                        <span className="lbl">Less: Operating expenses</span>
                        <span className="pct">{shareText(qb?.expenses ?? 0)}</span>
                        <span className="val neg">−{formatCurrency(qb?.expenses ?? 0)}</span>
                      </div>
                      {costDetail('opex', qb?.expenses ?? 0)}
                      {/* OPERATING INCOME, and whatever sits below it, appear only
                          when the book actually carries something between the two
                          — interest, tax, a one-off. Where it does not, this row
                          and Net Profit are the same number printed twice. */}
                      {hasOther && (
                        <>
                          <div className="pl-line pl-total">
                            <span className="lbl">Operating Income</span>
                            <span className="pct">{shareText(qb?.netOperating ?? 0)}</span>
                            <span className="val">{formatCurrency(qb?.netOperating ?? 0)}</span>
                          </div>
                          <div className="pl-line">
                            <span className="lbl">{otherIncome >= 0 ? 'Plus: Other income' : 'Less: Other expense'}</span>
                            <span className="pct">{shareText(Math.abs(otherIncome))}</span>
                            <span className={otherIncome < 0 ? 'val neg' : 'val'}>
                              {otherIncome < 0 ? '−' : ''}{formatCurrency(Math.abs(otherIncome))}
                            </span>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="pl-line pl-click" onClick={explainExpenses}>
                      <span className="lbl">Less: Expenses</span>
                      <span className="pct">{shareText(pl.expenses)}</span>
                      <span className="val neg">−{formatCurrency(pl.expenses)}</span>
                    </div>
                  )}
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
                  {source === 'quickbooks' && dollarSegs.length > 0 && (
                    <div className="pl-dollar">
                      <div className="t">Where each revenue dollar goes</div>
                      <div className="bar">
                        {dollarSegs.map((d) => (
                          <span key={d.name} className="seg" title={`${d.name} · ${formatCurrency(d.v)}`}
                            style={{ width: `${(d.v / dollarBase) * 100}%`, background: d.c }} />
                        ))}
                      </div>
                      <div className="keys">
                        {dollarSegs.map((d) => (
                          <span key={d.name}><i style={{ background: d.c }} />{d.name} {pct((d.v / dollarBase) * 100)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {/* THIS ROW WAS PRINTING $0 · $0 · $0 ON QUICKBOOKS.
                  Avg invoice, Avg bill and Cash collected are Striven-derived;
                  a QuickBooks P&L carries none of them, and the adapter sets
                  them to zero. Three confident zeros under a real statement read
                  as "we collected nothing" rather than "this source does not
                  report that" — the exact failure the Cash Received tile was
                  already fixed for.
                  Each source now shows facts it actually has. */}
              <div className="pl-meta">
                {source === 'quickbooks' ? (
                  <>
                    <div><span>Gross margin</span><strong>{pct(grossMargin)}</strong></div>
                    <div><span>Cost of goods ratio</span><strong>{pct(cogsRatio)}</strong></div>
                    <div><span>Operating cost ratio</span><strong>{pct(opexRatio)}</strong></div>
                    <div><span>Net margin</span><strong>{pct(pl.margin)}</strong></div>
                    <div><span>Revenue per month</span><strong>{formatCurrency(perMonth(pl.revenue))}</strong></div>
                    {/* HOW MUCH REVENUE THE PERIOD HAS TO EARN BEFORE IT KEEPS
                        ANYTHING: operating cost divided by gross margin. It is
                        the one figure here that is a target rather than a result,
                        and it is undefined without a positive gross margin — a
                        book selling below cost never breaks even, and printing a
                        number there would be a lie. */}
                    <div><span>Break-even revenue</span><strong>{grossMargin > 0 ? formatCurrency((qb?.expenses ?? 0) / (grossMargin / 100)) : '-'}</strong></div>
                    <div className="wide"><span>Largest cost</span><strong>{topCategory ? `${topCategory.category} · ${formatCurrency(topCategory.total)}` : '-'}</strong></div>
                  </>
                ) : (
                  <>
                    <div><span>Avg invoice</span><strong>{formatCurrency(pl.avgInvoice)}</strong></div>
                    <div><span>Avg bill</span><strong>{formatCurrency(pl.avgBill)}</strong></div>
                    <div><span>Revenue per month</span><strong>{formatCurrency(perMonth(pl.revenue))}</strong></div>
                    <div><span>Net margin</span><strong>{pct(pl.margin)}</strong></div>
                    <div><span>Cash collected</span><strong>{formatCurrency(pl.cashReceived)}</strong></div>
                  </>
                )}
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
              {/* ONE FOOTNOTE PER SOURCE. This printed Striven's explanation —
                  "Striven's API has no P&L report endpoint" — under the
                  QuickBooks statement too, which is both untrue there and the
                  wrong caveat: QuickBooks' figures are its own, and what limits
                  them is how much of the book has been posted across. */}
              <div className="muted-note">
                {source === 'quickbooks'
                  ? <>{qb?.basis ?? 'Accrual'} basis · {period.label} · QuickBooks' own monthly Profit &amp; Loss, one column per month. It reports only what has been posted to it — see the coverage note above.</>
                  : <>Accrual basis · {period.label} · computed from {pl.invoiceCount} invoices &amp; {pl.billCount} bills. Striven's API has no P&amp;L report endpoint, so this statement is derived live from the underlying transactions.</>}
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
