import { useEffect, useState, type ReactNode } from 'react';
import { BalanceSheetView } from './BalanceSheetView';
import { HealthRemarks, type HealthRemark } from './HealthRemarks';
import { fetchQbPL, type QbPlResult, type QbPlMonth, type QbLine, type QbCategory, type QbSalesVertical, type QbCommissionTeam, type PlPeriod } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS, monthLabel } from '../chartTheme';
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
/**
 * DISPLAY NAMES FOR QUICKBOOKS ACCOUNTS (26 Oct 2026, on request). QuickBooks
 * keeps its own names; this page shows the business's. "Contract labor" is what
 * the reps are paid, so it reads as Rep Commissions — on the category, its
 * accounts and any "(not itemised)" remainder. Matched case-insensitively on the
 * start of the name, so the books renaming the account to its own new name just
 * stops matching rather than breaking anything.
 */
const QB_DISPLAY_NAMES: [RegExp, string][] = [
  [/^contract labou?r(?![a-z])/i, 'Rep Commissions'],
];
const qbName = (name: string) => {
  for (const [re, to] of QB_DISPLAY_NAMES) if (re.test(name)) return name.replace(re, to);
  return name;
};
const relabelQb = (r: QbPlResult): QbPlResult => ({
  ...r,
  categories: (r.categories ?? []).map((c) => ({
    ...c, category: qbName(c.category), accounts: c.accounts.map((a) => ({ ...a, label: qbName(a.label) })),
  })),
});

/** "2026-10-27" → "Oct 27, 2026", split by hand so no timezone moves the day. */
const fmtDay = (d: string) => { const [y, m, day] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };

export function PLTab() {
  // ── TWO VIEWS OF THE BOOKS (27 Oct 2026, on request) ──────────────────────
  // Profit & Loss (a period's performance) and Balance Sheet (the position at
  // the END of that same period). One period picker drives both. Remembered
  // for the session so a reload lands on the view the reader was using.
  const [view, setView] = useState<'pl' | 'bs'>(() => {
    try { return sessionStorage.getItem('smr.plView') === 'bs' ? 'bs' : 'pl'; } catch { return 'pl'; }
  });
  const pickView = (v: 'pl' | 'bs') => { setView(v); try { sessionStorage.setItem('smr.plView', v); } catch { /* private mode: not remembered */ } };
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
      setPl(relabelQb(await fetchQbPL({ start: period.start, end: period.end })));
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

  // ── P&L HEALTH, IN WORDS (27 Oct 2026, on request) ─────────────────────────
  // The Balance Sheet's remarks, for the P&L: every finding worked out from the
  // figures on this page, its threshold stated here and in the footnote.
  // Trends compare COMPLETE months only — the running month is a part-month and
  // would always read as a fall.
  const plRemarks: HealthRemark[] = [];
  if (pl && income > 0) {
    const pc = (n: number) => `${n.toFixed(1)}%`;
    const cents = (n: number) => `${Math.round((n / income) * 100)}¢`;
    // 1. NET MARGIN: >= 15% healthy, above 0 thin, at or below 0 a loss.
    const nm = (netIncome / income) * 100;
    plRemarks.push({
      tone: nm >= 15 ? 'good' : nm > 0 ? 'watch' : 'concern',
      title: nm >= 15 ? 'Profitable, with a healthy margin' : nm > 0 ? 'Profitable, on a thin margin' : 'Losing money',
      text: <>Net income {formatCurrency(netIncome)} on {formatCurrency(income)} of sales: <b>{pc(nm)}</b> of every dollar is kept after every cost.</>,
    });
    // 2. GROSS MARGIN: >= 50% healthy, 30-50% watch, below 30% a concern.
    const gm = (grossProfit / income) * 100;
    plRemarks.push({
      tone: gm >= 50 ? 'good' : gm >= 30 ? 'watch' : 'concern',
      title: gm >= 50 ? 'Strong mark-up on the devices' : gm >= 30 ? 'Modest mark-up on the devices' : 'Devices cost too much of the sale',
      text: <>Cost of goods is {formatCurrency(cogs)}, {cents(cogs)} of every $1 of sales, leaving a <b>{pc(gm)}</b> gross margin to pay for everything else.</>,
    });
    // 3. OPERATING MARGIN: >= 10% healthy, 0-10% watch, below 0 a concern.
    const om = (netOperating / income) * 100;
    plRemarks.push({
      tone: om >= 10 ? 'good' : om >= 0 ? 'watch' : 'concern',
      title: om >= 10 ? 'The core business makes money on its own' : om >= 0 ? 'The core business barely covers its costs' : 'The core business loses money before other income',
      text: <>Net operating income {formatCurrency(netOperating)}, a <b>{pc(om)}</b> operating margin, before other income and expenses.</>,
    });
    // 4. COST CONCENTRATION: one expense category above 35% of sales is
    //    worth watching; all running costs above 70% of sales too.
    const top = [...opexCats].sort((a, b) => b.total - a.total)[0];
    if (top && top.total / income > 0.35) {
      plRemarks.push({ tone: 'watch', title: `${top.category} takes ${cents(top.total)} of every $1 of sales`,
        text: <>{formatCurrency(top.total)} so far. It is the single biggest cost, larger than cost of goods ({formatCurrency(cogs)}), so the margin moves with it more than with anything else.</> });
    }
    if (opexTotal / income > 0.7) {
      plRemarks.push({ tone: 'watch', title: 'Running costs are high against sales',
        text: <>Expenses are {formatCurrency(opexTotal)}, {cents(opexTotal)} of every $1 of sales, leaving little room if sales dip.</> });
    }
    // 5. TRENDS — complete months only.
    const done = series.filter((m) => m.month < nowYm && (m.revenue !== 0 || (m.cogs ?? 0) !== 0 || (m.opex ?? 0) !== 0));
    const mon = (ym: string) => `${monthLabel(ym)} ${ym.slice(0, 4)}`;
    if (done.length >= 2) {
      const [prev, last] = done.slice(-2);
      if (prev.revenue > 0) {
        const ch = ((last.revenue - prev.revenue) / prev.revenue) * 100;
        plRemarks.push({
          tone: ch >= 0 ? 'good' : ch > -25 ? 'watch' : 'concern',
          title: ch >= 0 ? `Sales grew ${Math.round(ch)}% in ${monthLabel(last.month)}` : `Sales fell ${Math.round(-ch)}% in ${monthLabel(last.month)}`,
          text: <>{formatCurrency(last.revenue)} in {mon(last.month)} against {formatCurrency(prev.revenue)} in {mon(prev.month)} (the last two complete months).</>,
        });
      }
      if (last.net < 0) {
        plRemarks.push({ tone: 'concern', title: `${monthLabel(last.month)} made a loss`, text: <>Net income {formatCurrency(last.net)} in {mon(last.month)}, the latest complete month.</> });
      } else if (prev.net > 0) {
        const ch = ((last.net - prev.net) / prev.net) * 100;
        plRemarks.push({
          tone: ch >= 0 ? 'good' : ch > -25 ? 'watch' : 'concern',
          title: ch >= 0 ? `Profit rose ${Math.round(ch)}% in ${monthLabel(last.month)}` : `Profit fell ${Math.round(-ch)}% in ${monthLabel(last.month)}`,
          text: <>Net income {formatCurrency(last.net)} in {mon(last.month)} against {formatCurrency(prev.net)} in {mon(prev.month)}.</>,
        });
      }
    }
    // 6. COSTS AGAINST SALES: last 3 complete months against the 3 before.
    //    Costs growing 5+ points faster than sales is worth watching.
    if (done.length >= 6) {
      const sumOf = (ms: typeof done, f: (m: (typeof done)[number]) => number) => ms.reduce((t, m) => t + f(m), 0);
      const a = done.slice(-6, -3), b = done.slice(-3);
      const salesA = sumOf(a, (m) => m.revenue), salesB = sumOf(b, (m) => m.revenue);
      const costA = sumOf(a, (m) => (m.cogs ?? 0) + (m.opex ?? 0)), costB = sumOf(b, (m) => (m.cogs ?? 0) + (m.opex ?? 0));
      if (salesA > 0 && costA > 0) {
        const gs = ((salesB - salesA) / salesA) * 100, gc = ((costB - costA) / costA) * 100;
        plRemarks.push({
          tone: gc - gs >= 5 ? 'watch' : 'good',
          title: gc - gs >= 5 ? 'Costs are growing faster than sales' : 'Sales are growing at least as fast as costs',
          text: <>Last three complete months against the three before: sales {gs >= 0 ? 'up' : 'down'} {Math.abs(Math.round(gs))}%, costs {gc >= 0 ? 'up' : 'down'} {Math.abs(Math.round(gc))}% (cost of goods + expenses).</>,
        });
      }
    }
    // 7. LOSS-MAKING MONTHS in the period (complete months).
    const losses = done.filter((m) => m.net < 0);
    if (losses.length) {
      plRemarks.push({ tone: 'watch', title: `${losses.length} month${losses.length === 1 ? '' : 's'} made a loss`,
        text: <>{losses.map((m) => `${mon(m.month)} (${formatCurrency(m.net)})`).join(', ')}.</> });
    }
    // 8. OTHER INCOME: above 15% of net income means the bottom line leans on
    //    reimbursements and one-offs rather than the core business.
    const netOther = otherIncome - otherExpenses;
    if (netIncome > 0 && netOther / netIncome > 0.15) {
      plRemarks.push({ tone: 'watch', title: 'Profit leans on other income',
        text: <>{formatCurrency(netOther)} of the {formatCurrency(netIncome)} net income ({Math.round((netOther / netIncome) * 100)}%) is other income (reimbursements, demo sales and the like), not the core business.</> });
    }
    // 9. BOOK-KEEPING: money QuickBooks could not place.
    const uncategorised = (pl.incomeAccounts ?? []).filter((a) => /uncategori[sz]ed/i.test(a.name)).reduce((t, a) => t + a.value, 0)
      + (pl.categories ?? []).flatMap((c) => c.accounts).filter((a) => /uncategori[sz]ed/i.test(a.label)).reduce((t, a) => t + a.value, 0);
    if (uncategorised > 0.5) {
      plRemarks.push({ tone: 'watch', book: true, title: 'Uncategorised amounts in the books',
        text: <>{formatCurrency(uncategorised)} sits in an "Uncategorized" account. Assign it to the right income or expense account in QuickBooks.</> });
    }
    const unitemised = [...(pl.incomeAccounts ?? []).filter((a) => /not itemised/i.test(a.name)).map((a) => ({ label: a.name, value: a.value })),
      ...(pl.categories ?? []).flatMap((c) => c.accounts).filter((a) => /not itemised/i.test(a.label))];
    if (unitemised.length) {
      const amt = unitemised.reduce((t, a) => t + a.value, 0);
      plRemarks.push({ tone: 'watch', book: true, title: 'Amounts posted to parent accounts',
        text: <>{formatCurrency(amt)} is posted straight to a parent account with no sub-account under it: {unitemised.map((a) => `${a.label.replace(/\s*\(not itemised\)/i, '')} ${formatCurrency(a.value)}`).join(', ')}. Moving it to the right sub-account makes the breakdown complete.</> });
    }
  }

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
  // SALES BY VERTICAL (9 Nov 2026, on request): who paid, matched on the
  // deposit's payer — CMC → TriCare, Integrated Surg / Hi-Dow → VA, Lienstar →
  // PI. See salesByVertical in api/_qb.js.
  const verticals = pl?.salesByVertical ?? [];
  const VERTICAL_PAYERS: Record<string, string> = {
    TriCare: 'CMC Solutions', VA: 'Integrated Surg Distributor, Hi-Dow', PI: 'Lienstar', Other: 'all other payers',
  };
  // Every receipt with its date and amount (9 Nov 2026, on request), oldest
  // first; a vertical paid by several payers closes with each payer's total.
  const explainVertical = (v: QbSalesVertical) => {
    const deps = v.deposits ?? [];
    if (!deps.length) {
      setDrill({
        title: `Sales · ${v.vertical}`, sub: qbSub(`by payer · ${v.count} deposit${v.count === 1 ? '' : 's'}`),
        ...kv([
          ...v.payers.map((p) => ({ k: `${p.name}${p.count ? ` (${p.count})` : ''}`, v: formatCurrency(p.value) })),
          { k: `Total ${v.vertical}`, v: formatCurrency(v.value), rowClass: 'total-row' },
        ]),
      });
      return;
    }
    const money = (n: number) => formatCurrency(n, true);
    const rows: Record<string, ReactNode>[] = deps.map((d) => ({
      date: d.date ? fmtDay(d.date) : '-', payer: d.payer, amount: money(d.amount),
    }));
    // A gap between the detail report and the statement has no deposit row.
    const listed = deps.reduce((t, d) => t + d.amount, 0);
    if (Math.abs(v.value - listed) >= 0.01) rows.push({ date: '-', payer: 'Not itemised in the detail report', amount: money(v.value - listed) });
    if (v.payers.length > 1) {
      for (const p of v.payers) rows.push({ date: '', payer: `${p.name} total${p.count ? ` (${p.count})` : ''}`, amount: money(p.value), rowClass: 'sub-row' });
    }
    rows.push({ date: '', payer: `Total ${v.vertical}`, amount: money(v.value), rowClass: 'total-row' });
    setDrill({
      title: `Sales · ${v.vertical}`, sub: qbSub(`${deps.length} receipt${deps.length === 1 ? '' : 's'}, oldest first`),
      columns: [{ key: 'date', label: 'Date received' }, { key: 'payer', label: 'Received from' }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainVerticals = () => setDrill({
    title: 'Sales by vertical', sub: qbSub('by who paid'),
    ...kv([
      ...verticals.map((v) => ({ k: `${v.vertical} · ${VERTICAL_PAYERS[v.vertical]}`, v: `${formatCurrency(v.value)} · ${shareText(v.value)}` })),
      { k: 'Total income', v: formatCurrency(income), rowClass: 'total-row' },
    ]),
  });
  // REP COMMISSIONS BY TEAM (10 Nov 2026, on request): Operations is a named
  // list of payees, Upwork stands on its own, everyone else is Sales. See
  // qbCommissionTeams and COMMISSION_ALLOCATIONS in api/_qb.js.
  const teams = pl?.commissionTeams ?? [];
  const isRepComm = (c: QbCategory) => /^rep commissions/i.test(c.category);
  const TEAM_COLORS: Record<string, string> = { Sales: '#0A369F', Operations: '#D97706', Upwork: '#6B7280' };
  const teamName = (t: QbCommissionTeam) => (t.team === 'Upwork' ? 'Upwork' : `${t.team} team`);
  // A team opens as one row per payee (collective); clicking a payee lists
  // that payee's payments, with a way back to the team.
  const linkBtn = (label: string, onClick: () => void, title?: string) => (
    <button type="button" onClick={onClick} title={title}
      style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--accent, #0A369F)', cursor: 'pointer', textDecoration: 'underline' }}>{label}</button>
  );
  const paymentsOf = (t: QbCommissionTeam, name: string) =>
    t.payments.filter((p) => p.payee === name || p.payee.startsWith(`${name} (`));
  // A payee paid to several people (Maverick Medical: Alle Ann, Jillian) opens
  // as one row per person; clicking a person lists that person's payments.
  const personOf = (name: string, label: string) => (label.startsWith(`${name} (`) ? label.slice(name.length + 2, -1) : name);
  const explainPayments = (t: QbCommissionTeam, name: string, person: string | null) => {
    const money = (n: number) => formatCurrency(n, true);
    const all = paymentsOf(t, name);
    const pays = person == null ? all : all.filter((p) => personOf(name, p.payee) === person);
    const value = person == null ? (t.payees.find((p) => p.name === name)?.value ?? 0) : pays.reduce((x, p) => x + p.amount, 0);
    const rows: Record<string, ReactNode>[] = pays.map((p) => ({
      date: p.date ? fmtDay(p.date) : '-', payee: p.payee, amount: money(p.amount),
    }));
    if (!pays.length) rows.push({ date: '-', payee: 'Not itemised in the detail report', amount: money(value) });
    const who = person == null || person === name ? name : `${person} (${name})`;
    rows.push({ date: '', payee: `Total ${who}`, amount: money(value), rowClass: 'total-row' });
    const people = new Set(all.map((p) => personOf(name, p.payee)));
    rows.push({ date: '', payee: person != null && people.size > 1
      ? linkBtn(`← Back to ${name}`, () => explainPayee(t, name))
      : linkBtn(`← Back to ${teamName(t).toLowerCase()}`, () => explainTeam(t)), amount: '' });
    setDrill({
      title: `${who} · ${teamName(t)}`, sub: qbSub(`${pays.length} payment${pays.length === 1 ? '' : 's'}, oldest first`),
      columns: [{ key: 'date', label: 'Date paid' }, { key: 'payee', label: 'Paid to' }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainPayee = (t: QbCommissionTeam, name: string) => {
    const all = paymentsOf(t, name);
    const people = [...new Set(all.map((p) => personOf(name, p.payee)))];
    if (people.length < 2) return explainPayments(t, name, null);
    const money = (n: number) => formatCurrency(n, true);
    const groups = people.map((person) => {
      const pays = all.filter((p) => personOf(name, p.payee) === person);
      return { person, pays, value: pays.reduce((x, p) => x + p.amount, 0) };
    }).sort((x, y) => y.value - x.value);
    const rows: Record<string, ReactNode>[] = groups.map((g) => ({
      payee: linkBtn(g.person, () => explainPayments(t, name, g.person), `Click for every payment to ${g.person}`),
      count: String(g.pays.length), last: fmtDay(g.pays[g.pays.length - 1].date), amount: money(g.value),
    }));
    rows.push({ payee: `Total ${name}`, count: String(all.length), last: '', amount: money(t.payees.find((p) => p.name === name)?.value ?? 0), rowClass: 'total-row' });
    rows.push({ payee: linkBtn(`← Back to ${teamName(t).toLowerCase()}`, () => explainTeam(t)), count: '', last: '', amount: '' });
    setDrill({
      title: `${name} · ${teamName(t)}`, sub: qbSub('by person · click a name for its payments'),
      columns: [{ key: 'payee', label: 'Paid to' }, { key: 'count', label: 'Payments', num: true }, { key: 'last', label: 'Last paid' }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainTeamByPayee = (t: QbCommissionTeam) => {
    const money = (n: number) => formatCurrency(n, true);
    const rows: Record<string, ReactNode>[] = t.payees.map((p) => {
      const pays = paymentsOf(t, p.name);
      const last = pays.length ? pays[pays.length - 1].date : '';
      return {
        payee: pays.length ? linkBtn(p.name, () => explainPayee(t, p.name), `Click for every payment to ${p.name}`) : p.name,
        count: String(pays.length || '-'), last: last ? fmtDay(last) : '-', amount: money(p.value),
      };
    });
    rows.push({ payee: `Total ${teamName(t).toLowerCase()}`, count: String(t.count), last: '', amount: money(t.value), rowClass: 'total-row' });
    setDrill({
      title: `Rep Commissions · ${teamName(t)}`, sub: qbSub('by payee, biggest first · click a name for its payments'),
      columns: [{ key: 'payee', label: 'Paid to' }, { key: 'count', label: 'Payments', num: true }, { key: 'last', label: 'Last paid' }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  // SALES TEAM BY VERTICAL (owner's sheet, 10 Nov 2026): Sales team opens by
  // vertical, a vertical by rep, a rep by its dated payments. The vertical of
  // each payment is set in api/_qb.js (QuickBooks has none).
  const NO_VERTICAL = 'Not yet split by vertical';
  const vOf = (p: QbCommissionTeam['payments'][number]) => p.vertical ?? NO_VERTICAL;
  const repName = (label: string) => {
    const m = /^(.*) \((.*)\)$/.exec(label);
    return m && m[1] === 'Maverick Medical' ? `${m[2]} (${m[1]})` : label;
  };
  const explainVerticalRep = (t: QbCommissionTeam, v: string, label: string) => {
    const money = (n: number) => formatCurrency(n, true);
    const pays = t.payments.filter((p) => vOf(p) === v && p.payee === label);
    const value = pays.reduce((x, p) => x + p.amount, 0);
    const rows: Record<string, ReactNode>[] = pays.map((p) => ({ date: p.date ? fmtDay(p.date) : '-', payee: repName(p.payee), amount: money(p.amount) }));
    rows.push({ date: '', payee: `Total ${repName(label)} · ${v}`, amount: money(value), rowClass: 'total-row' });
    rows.push({ date: '', payee: linkBtn(`← Back to ${v}`, () => explainTeamVertical(t, v)), amount: '' });
    setDrill({
      title: `${repName(label)} · ${v}`, sub: qbSub(`Sales team · ${pays.length} payment${pays.length === 1 ? '' : 's'}, oldest first`),
      columns: [{ key: 'date', label: 'Date paid' }, { key: 'payee', label: 'Paid to' }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainTeamVertical = (t: QbCommissionTeam, v: string) => {
    const money = (n: number) => formatCurrency(n, true);
    const pays = t.payments.filter((p) => vOf(p) === v);
    const total = pays.reduce((x, p) => x + p.amount, 0);
    const reps = [...new Set(pays.map((p) => p.payee))].map((label) => {
      const ps = pays.filter((p) => p.payee === label);
      return { label, ps, value: ps.reduce((x, p) => x + p.amount, 0) };
    }).sort((a, b) => b.value - a.value);
    const rows: Record<string, ReactNode>[] = reps.map((r) => ({
      payee: linkBtn(repName(r.label), () => explainVerticalRep(t, v, r.label), `Click for every ${v} payment to ${repName(r.label)}`),
      count: String(r.ps.length), share: total ? `${((r.value / total) * 100).toFixed(1)}%` : '-', amount: money(r.value),
    }));
    rows.push({ payee: `Total ${v}`, count: String(pays.length), share: '', amount: money(total), rowClass: 'total-row' });
    rows.push({ payee: linkBtn('← Back to sales team', () => explainTeam(t)), count: '', share: '', amount: '' });
    setDrill({
      title: `Sales team · ${v}`, sub: qbSub('by rep, biggest first · click a name for its payments'),
      columns: [{ key: 'payee', label: 'Rep' }, { key: 'count', label: 'Payments', num: true }, { key: 'share', label: 'Share', num: true }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainTeam = (t: QbCommissionTeam) => {
    if (t.team !== 'Sales' || !t.payments.some((p) => p.vertical)) return explainTeamByPayee(t);
    const money = (n: number) => formatCurrency(n, true);
    const order = ['VA', 'TriCare', 'PI', NO_VERTICAL];
    const vs = [...new Set(t.payments.map(vOf))].map((v) => ({ v, value: t.payments.filter((p) => vOf(p) === v).reduce((x, p) => x + p.amount, 0) }))
      .sort((a, b) => (a.v === NO_VERTICAL ? 1 : b.v === NO_VERTICAL ? -1 : b.value - a.value || order.indexOf(a.v) - order.indexOf(b.v)));
    const listed = vs.reduce((x, r) => x + r.value, 0);
    const rows: Record<string, ReactNode>[] = vs.map((r) => ({
      vertical: <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, marginRight: 8, background: (VERTICAL_COLORS as Record<string, string>)[r.v] ?? C.muted }} />
        {linkBtn(r.v, () => explainTeamVertical(t, r.v), `Click for ${r.v} by rep`)}</span>,
      share: t.value ? `${((r.value / t.value) * 100).toFixed(1)}%` : '-', amount: money(r.value),
    }));
    if (Math.abs(t.value - listed) >= 0.01) rows.push({ vertical: 'Not itemised in the detail report', share: '', amount: money(t.value - listed) });
    rows.push({ vertical: 'Total sales team', share: '', amount: money(t.value), rowClass: 'total-row' });
    rows.push({ vertical: linkBtn('See the sales team by rep instead', () => explainTeamByPayee(t)), share: '', amount: '' });
    setDrill({
      title: 'Rep Commissions · Sales team', sub: qbSub('by vertical · click a vertical for its reps'),
      columns: [{ key: 'vertical', label: 'Vertical' }, { key: 'share', label: 'Share', num: true }, { key: 'amount', label: 'Amount', num: true }],
      rows,
    });
  };
  const explainCategory = (c: QbCategory) => (isRepComm(c) && teams.length ? setDrill({
    title: c.category, sub: qbSub('by team, then by payee'),
    ...kv([
      ...teams.flatMap((t) => [
        { k: <b>{teamName(t)}</b>, v: <b>{formatCurrency(t.value, true)}</b> },
        ...t.payees.map((p) => ({ k: `${p.name}${p.count ? ` (${p.count})` : ''}`, v: formatCurrency(p.value, true) })),
      ]),
      { k: `Total ${c.category.toLowerCase()}`, v: formatCurrency(c.total, true), rowClass: 'total-row' },
    ]),
  }) : explainLines(
    c.category, `${c.section === 'cogs' ? 'Cost of goods sold' : 'Expenses'}, by account`,
    c.accounts.map((a) => ({ name: a.label, value: a.value })), c.total, `Total ${c.category.toLowerCase()}`,
  ));
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
      {/* THE VIEW TOGGLE — the same full-width tab bar as Payables' AP Overview |
          AP Register (ArApTab's SideTabs), at the top of the page. */}
      <div className="ov-tabs" role="tablist" aria-label="Statement" style={{ marginBottom: 4 }}>
        <button type="button" role="tab" aria-selected={view === 'pl'} className={`ov-tab${view === 'pl' ? ' active' : ''}`} onClick={() => pickView('pl')}>Profit &amp; Loss</button>
        <button type="button" role="tab" aria-selected={view === 'bs'} className={`ov-tab${view === 'bs' ? ' active' : ''}`} onClick={() => pickView('bs')}>Balance Sheet</button>
      </div>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>{view === 'bs' ? 'Balance Sheet' : <>Profit &amp; Loss</>}</h1>
          <div className="page-sub">
            {view === 'bs'
              ? <><span className="live-dot" /> Sports Med Recovery · as of {fmtDay(period.end)} · accrual basis · every figure from <b>QuickBooks</b></>
              : <><span className="live-dot" /> Sports Med Recovery · {period.label} · {(pl?.basis ?? 'accrual').toLowerCase()} basis ·{' '}
                every figure from <b>QuickBooks</b>
                {agoText ? ` · updated ${agoText}` : ''}</>}
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
          <span className="ov-filter"><span className="fl">📅</span><b>{view === 'bs' ? `As of ${fmtDay(period.end)}` : rangeChip}</b></span>
          {view === 'pl' && <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>}
        </div>
      </div>

      {view === 'bs' && (
        <BalanceSheetView asOf={period.end} asOfLabel={fmtDay(period.end)}
          plNetYtd={part === 'all' && pl ? pl.net : null}
          pl={pl ? {
            label: period.label, income, net: pl.net, margin: pl.margin,
            // RUNWAY USES CURRENT SPENDING: the last three COMPLETE months'
            // average cost of goods + expenses. The page's own per-month
            // average divides by every month of the year, including months
            // before trading began, which understates the monthly burn.
            costsPerMonth: (() => {
              const done = series.filter((m) => m.month < nowYm).slice(-3);
              return done.length ? done.reduce((t, m) => t + (m.cogs ?? 0) + (m.opex ?? 0), 0) / done.length : perMonth(cogs + opexTotal);
            })(),
            costsBasis: (() => {
              const done = series.filter((m) => m.month < nowYm).slice(-3);
              return done.length ? `the last ${done.length} complete month${done.length === 1 ? '' : 's'}'` : `the ${period.label}`;
            })(),
            months: monthCount,
          } : null} />
      )}

      {qbNotice && <div className={qbNotice.ok ? 'qb-banner ok' : 'qb-banner warn'}>{qbNotice.text}</div>}

      {view === 'pl' && error && (
        <div className="qb-banner warn">
          <span><b>QuickBooks could not be read.</b> {error}</span>
          {notConnected && <a className="btn" href="/api/qb/connect">Connect QuickBooks →</a>}
        </div>
      )}

      {view === 'pl' && loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading from QuickBooks…</div>}

      {view === 'pl' && pl && (
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
              foot="payroll, rep commissions & overhead"
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

                  {secHead('income', 1, 'Income', verticals.length ? 'by income account, then by vertical' : 'by income account', pl.incomeAccounts.length + verticals.length)}
                  {open.income && pl.incomeAccounts.map((a) => (
                    <div key={a.name} className="pl-line pl-indent pl-click"
                      onClick={() => explainLines('Income', 'by account', pl.incomeAccounts, income, 'Total income')}>
                      <span className="lbl">{a.name}</span>
                      <span className="pct">{shareText(a.value)}</span>
                      <span className="val">{formatCurrency(a.value)}</span>
                    </div>
                  ))}
                  {open.income && verticals.length > 0 && (
                    <>
                      <div className="pl-line pl-indent pl-click" onClick={explainVerticals}>
                        <span className="lbl" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>Sales by vertical</span>
                        <span className="pct" /><span className="val" />
                      </div>
                      {verticals.map((v) => (
                        <div key={v.vertical} className="pl-line pl-indent pl-click" style={{ paddingLeft: 28 }}
                          title={`Click for the payers behind ${v.vertical}`} onClick={() => explainVertical(v)}>
                          <span className="lbl">
                            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, marginRight: 8, background: VERTICAL_COLORS[v.vertical] ?? C.muted }} />
                            <b style={{ color: 'var(--text)' }}>{v.vertical}</b>
                            <span style={{ marginLeft: 6, fontSize: 12.5 }}>{VERTICAL_PAYERS[v.vertical]}</span>
                          </span>
                          <span className="pct">{shareText(v.value)}</span>
                          <span className="val">{formatCurrency(v.value)}</span>
                        </div>
                      ))}
                    </>
                  )}
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
                    <div key={c.category}>
                      <div className="pl-line pl-indent pl-click" onClick={() => explainCategory(c)}>
                        <span className="lbl">{c.category}</span>
                        <span className="pct">{shareText(c.total)}</span>
                        <span className="val neg">−{formatCurrency(c.total)}</span>
                      </div>
                      {isRepComm(c) && teams.map((t) => (
                        <div key={t.team} className="pl-line pl-indent pl-click" style={{ paddingLeft: 28 }}
                          title={`Click for every payment to ${teamName(t)}`} onClick={() => explainTeam(t)}>
                          <span className="lbl">
                            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, marginRight: 8, background: TEAM_COLORS[t.team] ?? C.muted }} />
                            <b style={{ color: 'var(--text)' }}>{teamName(t)}</b>
                            <span style={{ marginLeft: 6, fontSize: 12.5 }}>{t.payees.length} payee{t.payees.length === 1 ? '' : 's'}</span>
                          </span>
                          <span className="pct">{shareText(t.value)}</span>
                          <span className="val neg">−{formatCurrency(t.value)}</span>
                        </div>
                      ))}
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

            {/* P&L HEALTH — the same grouped remarks as the Balance Sheet. */}
            {plRemarks.length > 0 && (
              <div className="section chart-card g12-12">
                <HealthRemarks title={`P&L health · ${period.label}`} subject="the P&L" remarks={plRemarks}
                  footnote={<>Thresholds: net margin 15%; gross margin 50% and 30%; operating margin 10% and 0%; one expense above 35% of sales or all expenses above 70%; month-on-month falls of 25%; costs growing 5 points faster than sales; other income above 15% of net income. Trends use complete months only.</>} />
              </div>
            )}
          </div>
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
