import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenAP, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenBillPayments,
  fetchStrivenOrders, fetchStrivenExceptions, fetchCommission, fetchApLedger,
  type ArResult, type ApResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type BillPaymentsResult,
  type OrdersResult, type ExceptionsResult, type CommissionResult, type ApLedger,
} from '../strivenApi';
import { formatCurrency, clickableProps, isCancelledStatus, isCompletedStatus } from '../format';
import { C, SERIES, CAT6, VERTICAL_COLORS, compactMoney, monthLabel, programOfPayer, type Program } from '../chartTheme';
import { ChartCard, BarsLine, LegendDots, BarList, DonutList, GaugeRing, DrillModal, useSyncAgo, pctText, HUE, AnimatedNumber } from '../chartKit';
import { shortDeviceName } from './DeviceChips';
import { UnitsByDevice } from './UnitsByDevice';
import { CommissionBreakdown } from './CommissionBreakdown';
import { MetricDetail } from './MetricDetail';
import { SoLink } from './SoLink';

/**
 * Chip colour for a Striven label, by what the label MEANS — stopped, money in,
 * queued, moving. Four tones only; more would be decoration.
 *
 * Deliberately a local copy of the helper in OrdersTab rather than a shared
 * import: this change was scoped to the Company board, and lifting a function
 * out of another tab would edit a screen that was explicitly left alone. If a
 * third screen ever needs it, that is the point to promote it to chartTheme.
 */
const labelTone = (label: string): string => {
  const s = String(label || '').trim().toLowerCase();
  if (/hold|denied|dropped|cancel/.test(s)) return C.warning;
  if (/^paid$|tricare paid|settled/.test(s)) return C.positive;
  if (/waiting|negotiat|lop|lienstar|reimburse/.test(s)) return C.purple;
  return C.brand;
};

/** Month segments step from the base colour toward a lighter tint, so the rail
 *  reads as one metric over time rather than as unrelated categories. */
const shade = (base: string, i: number, n: number): string => {
  const t = n <= 1 ? 0 : (i / (n - 1)) * 0.55;      // 0 → 0.55 lightening
  const m = base.replace('#', '');
  const c = [0, 2, 4].map((p) => parseInt(m.slice(p, p + 2), 16));
  const mix = c.map((v) => Math.round(v + (255 - v) * t));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
import { fetchDeviceMix, fetchMe, type DeviceMixRow } from '../strivenApi';
import { useHidden, useViewProfile, setViewProfile, isKevinLogin, PROFILE_LABEL, type ViewProfile } from '../viewProfile';
import { BusinessGrowth } from './BusinessGrowth';

const trunc = (v: string, n = 22) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-');
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '•';
const PROG_LABEL: Record<string, string> = { All: 'All programs', PI: 'PI', VA: 'VA', TriCare: 'Tri-Care' };

// `bucketKeyOf` lived here to bucket invoices for the two aging donuts. Both
// are now AR Due / AP Due, which report days past due per party instead, so
// nothing on this board buckets by age any more. The aging CHARTS on the AR/AP
// and AP Sheet tabs are unaffected — they do their own bucketing.

// Honest MoM: compare the two most-recent COMPLETE months before the cutoff
// 7 KPI hues: reused verbatim as the chart palette so strip + charts read as one system.

// Honest MoM: compare the two most-recent COMPLETE months before the cutoff
// (never the partial as-of month).
const nowYm = new Date().toISOString().slice(0, 7);
const momDelta = (series: { month: string; value: number }[], cutoffYm = nowYm): { pct: number; up: boolean } | null => {
  const done = series.filter((p) => p.month < cutoffYm && (p.value ?? 0) > 0);
  if (done.length < 2) return null;
  const cur = done[done.length - 1].value, prev = done[done.length - 2].value;
  if (!prev) return null;
  return { pct: Math.round(((cur - prev) / prev) * 100), up: cur >= prev };
};

const INS_TONES: Record<string, { bg: string; fg: string }> = {
  pos: { bg: 'rgba(22,163,74,0.12)', fg: '#16A34A' },
  neg: { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626' },
  brand: { bg: 'rgba(10,54,159,0.10)', fg: '#0A369F' },
  purple: { bg: 'rgba(124,58,237,0.10)', fg: '#7C3AED' },
  teal: { bg: 'rgba(13,148,136,0.10)', fg: '#0D9488' },
};

export function OverviewCharts() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [ap, setAp] = useState<ApResult | null>(null);
  // The AP ledger sheet — the real payables book. See `apOpenF` below.
  const [apLedger, setApLedger] = useState<ApLedger | null>(null);
  const [pl, setPl] = useState<PlResult | null>(null);
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [trends, setTrends] = useState<TrendsResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [billpay, setBillpay] = useState<BillPaymentsResult | null>(null);
  const [orders, setOrders] = useState<OrdersResult | null>(null);
  const [exc, setExc] = useState<ExceptionsResult | null>(null);
  const [comm, setComm] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);
  type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] };
  const [drill, setDrill] = useState<Drill | null>(null);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      // COMMISSION STARTS FIRST, and is deliberately NOT awaited here.
      //
      // It is the slowest thing on the board by a wide margin — it downloads two
      // Google Sheets workbooks and the reconciliation sheet — and it used to be
      // kicked off AFTER the Promise.all below resolved, despite the comment
      // claiming it loaded "beside the rest". That put its several seconds END
      // TO END with the other ten calls instead of overlapping them, so the
      // Commission tile appeared seconds after everything around it had settled.
      //
      // Started here, it runs while the ten below are in flight and fills its
      // tile whenever it lands. Not awaited, so a slow or failed commission
      // derivation can never hold up the rest of the board.
      fetchCommission().then(setComm).catch(() => setComm(null));
      const [a, b, p, s, o, t, pay, bp, ord, ex, apl] = await Promise.all([
        fetchStrivenAR(), fetchStrivenAP(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(), fetchStrivenBillPayments().catch(() => null),
        fetchStrivenOrders().catch(() => null), fetchStrivenExceptions().catch(() => null),
        // THE AP BOOK, for the same reason the Payables tab reads it: vendor
        // bills are tracked by hand in this sheet and only a handful ever reach
        // Striven, so Striven's four open bills are not the payable. Never
        // fails the board — the AP figure falls back to Striven if it is
        // unreachable, which is a smaller number but not a broken page.
        fetchApLedger().catch(() => null),
      ]);
      setAr(a); setAp(b); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay);
      setBillpay(bp); setOrders(ord); setExc(ex); setApLedger(apl);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load Striven data.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s (charts/count-ups animate to new values).
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const go = (v: string) => () => { location.hash = v; };

  // Which login's layout is on screen. `hide(id)` is the gate every panel below
  // asks; `profile` drives the picker in the header.
  const profile = useViewProfile();
  const hide = useHidden();
  // Who actually signed in. The picker is hidden on Kevin's board, and that has
  // to hold for HIS LOGIN as well as for the profile — keyed on the profile
  // alone, Kevin on a fresh browser gets the default 'crystal' and sees the very
  // control the rule removes. `?view=crystal` remains the way back either way.
  const [meEmail, setMeEmail] = useState<string | null>(null);
  useEffect(() => { fetchMe().then((m) => setMeEmail(m?.email ?? null)).catch(() => setMeEmail(null)); }, []);
  // THE LOGIN DECIDES. Keyed on the profile, one preview of Kevin's board left
  // every later admin on that browser with no way to switch back — the picker
  // removed itself and took the only route out with it.
  const kevinBoard = isKevinLogin(meEmail);
  /**
   * KEVIN'S SKIN FOR THIS BOARD.
   *
   * Same tiles, same headings, same figures — a different SURFACE, so his
   * Financial Overview reads as his rather than as the finance/ops board with
   * panels missing. Presentation only, and one class: every rule hangs off
   * `.ov-kevin` in cashflow.css, so nothing here can change a number and no
   * other tab can inherit the look.
   *
   * BOTH THE LOGIN AND THE PROFILE, for the same reason the picker is hidden on
   * both: Kevin on a fresh browser carries the default 'crystal' profile, and an
   * admin previewing his board is meant to see what he sees — layout included.
   */
  const kevinLook = kevinBoard || profile === 'kevin';

  // ---- FY + Program + As-of scope (the header filters actually re-slice the data) ----
  const [fyPick, setFyPick] = useState<string | null>(null);
  // PERIOD DEFAULTS TO THE AS-OF MONTH — "how are we doing right now".
  //
  // It defaulted to the FISCAL YEAR for a while, and the reason is worth keeping
  // even though the default has gone: the month view opened the board on a month
  // with no invoices yet — early August showed Revenue $0, Cash Received $0 and
  // two empty charts beside snapshot cards full of real money. The zeroes were
  // correct and read as breakage.
  //
  // A year-to-date default hid that, at the cost of answering a question nobody
  // asked on open. The empty month is handled directly instead, by the effect
  // below: if the as-of month carries nothing, the board opens on the newest
  // month that does. Same protection, without a whole-year default.
  //
  // 'month'  the as-of month · 'fy' the fiscal year · 'pick' one named month
  // · 'custom' a from→to range.
  //
  // RANGES ARE MONTH-PRECISION, not day. Every period-scoped figure on this
  // board comes from a monthly series (trends, payments), so a day-level range
  // could not be honoured — it would silently round to whole months while
  // showing exact dates. Month inputs say what the data can actually answer.
  const [scope, setScope] = useState<'month' | 'fy' | 'pick' | 'custom'>('month');
  const [pickMonth, setPickMonth] = useState('');
  const [fromYm, setFromYm] = useState('');
  const [toYm, setToYm] = useState('');
  const [prog, setProg] = useState<'All' | Program>('All');
  const [asOfPick, setAsOfPick] = useState<string | null>(null); // YYYY-MM-DD
  const todayStr = new Date().toISOString().slice(0, 10);
  const asOfStr = asOfPick && asOfPick <= todayStr ? asOfPick : todayStr;
  const refMs = new Date(`${asOfStr}T23:59:59`).getTime();
  const asOfYm = asOfStr.slice(0, 7);
  const years = Array.from(new Set([
    ...(trends?.series ?? []).map((s) => s.month.slice(0, 4)),
    ...(payments?.byMonth ?? []).map((m) => m.month.slice(0, 4)),
  ])).sort();
  // When the user hasn't pinned a FY, follow the As-of year so moving As-of into
  // a prior year re-scopes the charts instead of blanking them.
  const asOfYear = asOfStr.slice(0, 4);
  const fy = (fyPick && years.includes(fyPick)) ? fyPick
    : (years.includes(asOfYear) ? asOfYear : (years[years.length - 1] ?? String(new Date().getFullYear())));
  // One predicate for every series on the page, so the KPIs, the charts and the
  // trend lines can never disagree about which period they are describing.
  // Every month the data actually covers, newest first — what the picker offers.
  // Only real months, so the list can never select an empty period.
  const dataMonths = Array.from(new Set([
    ...(trends?.series ?? []).map((s) => s.month),
    ...(payments?.byMonth ?? []).map((m) => m.month),
  ])).sort().reverse();
  const monthName = (m: string) => (m
    ? new Date(`${m}-01T00:00:00`).toLocaleString(undefined, { month: 'long', year: 'numeric' })
    : '');
  // THE EMPTY-MONTH GUARD, and the reason the fiscal-year default could go.
  //
  // Runs ONCE, and only while the board is still on its default: `touched` is
  // set by the Period control itself, so a month a person chose is never
  // second-guessed — picking an empty month deliberately is a legitimate thing
  // to do, and silently moving them off it would be worse than showing zeroes.
  //
  // Waits for the series to arrive (`dataMonths.length`), because before that
  // every month looks empty and this would fire on nothing.
  const touchedPeriod = useRef(false);
  useEffect(() => {
    if (touchedPeriod.current || !dataMonths.length) return;
    touchedPeriod.current = true;               // decide once, then leave it alone
    if (dataMonths.includes(asOfYm)) return;    // the current month has data: stay
    setPickMonth(dataMonths[0]);                // dataMonths is newest-first
    setScope('pick');
  }, [dataMonths, asOfYm]);

  const inFy = (m: string) => {
    if (scope === 'month') return m === asOfYm;
    if (scope === 'pick') return m === pickMonth;
    // An open end means "from here on" / "up to here" rather than nothing.
    if (scope === 'custom') return (!fromYm || m >= fromYm) && (!toYm || m <= toYm);
    return m.startsWith(fy) && m <= asOfYm;
  };
  /**
   * The period test for a BALANCE row, which carries a due date rather than a
   * month key.
   *
   * A missing date is IN every period. Every open AR invoice and AP bill in the
   * book currently has one, so this branch is a no-op today — it exists so that
   * a row arriving without a due date is never silently dropped from a
   * liability. Under-reporting what is owed is the worse way for a money card
   * to be wrong.
   *
   * NOT used for commission. Owed commission has 127 lines that tie to no live
   * sales order and so carry no date at all; letting those fall into every
   * period would count $52,381 five times over, and would make this board
   * disagree with the Rep × vertical table, which excludes them and says so.
   * See `commDue`.
   */
  const inPeriodDate = (d: string | null | undefined) => {
    const s = String(d ?? '').slice(0, 7);
    return !s || inFy(s);
  };
  /**
   * WHETHER THE BOARD IS SCOPED TO A SLICE AT ALL.
   *
   * The balance cards below read "as of today" when the whole book is in view
   * and "due in <period>" when it is not, so each of them has to know which
   * sentence it is telling. `fy` covers a whole year up to the as-of month,
   * which is the closest thing this board has to "everything".
   */
  const periodScoped = scope === 'month' || scope === 'pick' || scope === 'custom';

  // COMMISSION DUE, scoped to the PRODUCING REPS — the same population the
  // Commission tab shows when this tile is clicked.
  //
  // It read `striven.payableTotal`, which is the whole roster: it counted
  // Kinley Shepherd and House Account, neither of whom appears on the
  // Commission tab any more. The tile said $218,116 and the page it opened said
  // $209,815 — an $8,301 gap between a figure and the breakdown behind it.
  // (Cassie was in that gap too; she is now dropped server-side entirely, so
  // she is no longer part of what this scoping has to correct for.)
  //
  // `roster` is the server's producer list, empty for a non-admin; this board
  // is admin-only, but the fallback keeps it honest if that ever changes.
  // MUST STAY BELOW inPeriodDate(). It is a const arrow, so reading it from an
  // IIFE placed earlier in the render is a temporal-dead-zone crash, not a
  // hoisted call — this block used to sit above the period scope and was moved
  // down wholesale when it started following the filter.
  const commDue = (() => {
    const s = comm?.striven;
    if (!s) return { payable: comm?.payableTotal ?? 0, waiting: 0, offRoster: 0 };
    const roster = new Set(comm?.roster ?? []);
    const rows = roster.size ? (s.byRep ?? []).filter((r) => roster.has(r.rep)) : null;
    if (!rows) return { payable: s.payableTotal ?? 0, waiting: s.waitingTotal ?? 0, offRoster: 0 };
    // SCOPED BY THE SALES ORDER'S DATE, off the signed-off lines.
    //
    // A rep's `payableTotal` is a single all-time figure, so the period has to
    // be taken from the lines beneath it. Owed only — a 'paid' line has left the
    // bank and is not due — which is exactly the split that makes the line sum
    // equal `payableTotal` when nothing is filtered.
    //
    // AN UNDATED LINE IS IN NO PERIOD, and that is deliberate. 127 of them tie
    // to no live sales order, so they have no month; counting them in every
    // period put $52,381 into each one, made the months sum to more than the
    // all-time figure, and made this tile read $107,526 for July against the Rep
    // × vertical table's $55,145 — the same metric, two boards, two answers.
    // They are reported separately instead, exactly as that table does.
    type Line = { comm: number; state: string; date?: string | null };
    const owedLines = (r: { lines?: Line[] }) => (r.lines ?? []).filter((l) => l.state !== 'paid');
    const inScope = (l: Line) => !periodScoped || (Boolean(l.date) && inFy(String(l.date).slice(0, 7)));
    const owed = (r: { lines?: Line[]; payableTotal?: number }) => {
      const lines = owedLines(r);
      if (!(r.lines ?? []).length) return r.payableTotal ?? 0;   // no lines: nothing to scope by
      return lines.filter(inScope).reduce((a, l) => a + (l.comm ?? 0), 0);
    };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // What the roster filter LEAVES OUT. Non-producing reps are off the Reps
    // dashboard by request, but their commission is still owed — reporting the
    // tile without it would quietly understate the liability.
    const offRoster = r2((s.byRep ?? []).filter((r) => !roster.has(r.rep)).reduce((a, r) => a + owed(r), 0));
    // Owed, but belonging to no month — only meaningful while a period is on.
    const undated = periodScoped
      ? r2(rows.reduce((a, r) => a + owedLines(r).filter((l) => !l.date).reduce((b, l) => b + (l.comm ?? 0), 0), 0))
      : 0;
    return {
      payable: r2(rows.reduce((a, r) => a + owed(r), 0)),
      waiting: r2(rows.reduce((a, r) => a + (r.waitingTotal ?? 0), 0)),
      offRoster,
      undated,
    };
  })();


  // ---- derived views (real data only, FY-scoped where the data is monthly) ----
  const revSeries = (trends?.series ?? []).filter((s) => inFy(s.month)).map((s) => ({ month: s.month, value: s.revenue }));
  const cashSeries = (payments?.byMonth ?? []).filter((m) => inFy(m.month)).map((m) => ({ month: m.month, value: m.amount }));
  // ONE LABEL FOR THE ACTIVE PERIOD. Three cards used to hardcode "· FY2026"
  // while their data followed the Period toggle, so on the default month view
  // they showed a single month under a full-year heading — and with no August
  // rows yet, an empty chart captioned FY2026. Everything period-scoped reads
  // this, so a caption can no longer disagree with the data beneath it.
  const periodLabel = scope === 'month' ? monthName(asOfYm)
    : scope === 'pick' ? (monthName(pickMonth) || 'No month chosen')
      : scope === 'custom'
        ? (fromYm || toYm
          ? `${fromYm ? monthName(fromYm) : 'start'} → ${toYm ? monthName(toYm) : 'now'}`
          : 'Custom range')
        : `FY${fy}`;

  /**
   * What a BALANCE card is describing, in words.
   *
   * These cards hold current open balances filtered by DUE DATE, so under a
   * period they answer "still open today, and it fell due in this window" —
   * never "the balance as it stood then". The distinction is the whole reason
   * this string exists: the figure is honest, the default reading of it is not.
   */
  const balanceScopeLabel = periodScoped ? `due in ${periodLabel}` : 'as of today';
  // COUNTS IN THE ACTIVE PERIOD, not FY-wide. `pl.invoiceCount` is the whole
  // year and `payments.count` is every payment ever taken; either sitting under
  // a month-scoped figure contradicts it outright ("$0 this month · 165
  // invoices"). Older caches have no per-month counts, hence the fallbacks.
  //
  // The capability check is on the WHOLE series, not the filtered slice: a
  // period with no rows must report 0, not fall back to the FY count. Testing
  // the slice would make an empty August indistinguishable from an old cache
  // and put "165 invoices" back under "$0 invoiced this month".
  const hasInvCounts = (trends?.series ?? []).some((s) => s.invoices != null);
  const hasPayCounts = (payments?.byMonth ?? []).some((m) => m.count != null);
  const invCountP = hasInvCounts
    ? (trends?.series ?? []).filter((s) => inFy(s.month)).reduce((a, s) => a + (s.invoices ?? 0), 0)
    : null;
  const payCountP = hasPayCounts
    ? (payments?.byMonth ?? []).filter((m) => inFy(m.month)).reduce((a, m) => a + (m.count ?? 0), 0)
    : null;
  const cashD = momDelta(cashSeries, asOfYm);
  const cashFY = cashSeries.reduce((s, p) => s + p.value, 0);

  // Cash flow: customer payments in vs vendor bill payments out, by month (FY-scoped).
  //
  // CASH OUT COMES FROM THE AP LEDGER, not Striven's bill-payment records.
  // Striven holds ONE payment — $840 to HiDow, 30 Apr — while the ledger's
  // Debit column holds all 51, $76,026.06. Charting the one made vendor cash
  // out look like a rounding error against six figures of cash in, and the net
  // line was overstated by $75,186.06 every month it drew.
  //
  // Falls back to Striven's list if the sheet is unreachable: a small cash-out
  // line is wrong, but an empty chart is worse and hides that anything is off.
  const vendorCashOut: { date: string | null; amount: number }[] =
    apLedger?.ok && (apLedger.payments?.length ?? 0) > 0
      ? apLedger.payments!.map((p) => ({ date: p.date, amount: p.amount }))
      : (billpay?.recent ?? []).map((r) => ({ date: r.date, amount: r.amount }));
  const cashOutBy: Record<string, number> = {};
  for (const r of vendorCashOut) {
    const m = String(r.date ?? '').slice(0, 7);
    // An undated payment cannot be placed in a month. One row on the ledger has
    // no date ($303.67); it is left out of the monthly series rather than
    // dumped into an arbitrary bucket, exactly as before.
    if (m) cashOutBy[m] = (cashOutBy[m] || 0) + r.amount;
  }
  const inBy: Record<string, number> = Object.fromEntries((payments?.byMonth ?? []).map((m) => [m.month, m.amount]));
  const cfMonths = Array.from(new Set([...Object.keys(inBy), ...Object.keys(cashOutBy)])).filter(inFy).sort().slice(-12);
  const cashData = cfMonths.map((m) => ({
    month: m, cashIn: inBy[m] || 0, cashOut: Math.round(cashOutBy[m] || 0), net: Math.round((inBy[m] || 0) - (cashOutBy[m] || 0)),
  }));
  const cfIn = cashData.reduce((s, d) => s + d.cashIn, 0);
  const cfOut = cashData.reduce((s, d) => s + d.cashOut, 0);

  // Revenue vs expense with profit line (FY-scoped).
  const finData = (trends?.series ?? []).filter((s) => inFy(s.month)).map((s) => ({ month: s.month, revenue: s.revenue, expenses: s.expenses, profit: s.net }));
  const fRev = finData.reduce((s, d) => s + d.revenue, 0);
  const fExp = finData.reduce((s, d) => s + d.expenses, 0);
  const margin = fRev > 0 ? Math.round(((fRev - fExp) / fRev) * 1000) / 10 : 0;

  // Program-scoped AR: payer (law firm / VA / TriCare) classifies each invoice.
  //
  // PERIOD-SCOPED ON THE DUE DATE, which is the only date these rows carry.
  //
  // That makes a filtered figure "receivables STILL OPEN TODAY that fell due in
  // this period" — not "AR as it stood at the end of it". The second is not
  // computable from this payload and never was: `ArInvoice` holds a current
  // balance and a due date, and nothing anywhere stores what was outstanding on
  // a past date. The card titles say "due in <period>" so the number cannot be
  // read as a historical position.
  //
  // An invoice with no due date stays IN every period — see inPeriodDate. These
  // are liabilities and receivables; dropping an undated one would quietly
  // shrink the figure, which is the wrong way for a money card to be wrong.
  const arInv = (ar?.invoices ?? []).filter((i) => i.open > 0
    && (prog === 'All' || programOfPayer(i.payer) === prog)
    && inPeriodDate(i.dueDate));
  const arOpenF = arInv.reduce((s, i) => s + i.open, 0);
  // THE AP TWIN OF arOpenF, and the reason it has to exist: every balance card
  // below pairs the two, and they were reading `apOpenF` — the server's
  // whole-book figure — against a period-scoped AR. Netting a filtered
  // receivable against an unfiltered payable produces a "net position" that is
  // not a position at all, and it is the kind of wrong that looks plausible.
  //
  // OFF THE AP LEDGER SHEET, not Striven, and that is a $19,032.83 correction.
  // Striven holds four open vendor bills; the ledger holds forty-six, because
  // vendor bills are tracked by hand in that sheet and only a handful are ever
  // entered into Striven. This card read the four, so the dashboard's "we owe
  // out" — and the net position derived from it — understated payables by more
  // than the figure it printed.
  //
  // The Payables tab and the AP Register both read the sheet; leaving this on
  // Striven would have moved the contradiction from inside one tab to between
  // three of them, which is harder to notice and no more correct.
  //
  // `Math.abs(open) > 0` rather than `> 0`: a credit note carries a negative
  // balance and is money off the payable. The AP Register sums it the same way,
  // so the two agree by construction rather than by coincidence.
  // ONE LIST, normalised, used by every AP figure on this board. Five call sites
  // read the bills — this total, the AP Due vendor list, the aging rail, the
  // Action Center's "due soon", and the card's own bill count — and patching
  // them one at a time is how a card ends up printing "$30,455.00 across 4
  // unpaid bills". Whichever book is in play, they now read the same array.
  const apLedgerBills = (apLedger?.ok ? apLedger.bills : null) ?? null;
  const apBook = apLedgerBills
    ? apLedgerBills
      .filter((b) => Math.abs(b.open) > 0.005)
      .map((b) => ({ number: String(b.no), vendor: b.subLedger || '-', dueDate: b.due || null, open: b.open }))
    : (ap?.bills ?? [])
      .filter((b) => b.open > 0)
      .map((b) => ({ number: String(b.number), vendor: b.vendor || '-', dueDate: b.dueDate, open: b.open }));
  const apBookScoped = apBook.filter((b) => inPeriodDate(b.dueDate));
  const apOpenF = apBookScoped.reduce((s, b) => s + b.open, 0);
  // A credit note is money off the payable but nobody works it off a worklist,
  // so it counts toward the TOTAL and not toward the COUNT — the same split the
  // AP Register makes, which is why the two agree.
  const apBillCount = apBookScoped.filter((b) => b.open > 0).length;
  // Aging always client-bucketed so Program + As-of both apply.
  // The aging buckets are gone from this board: both summaries are now AR Due /
  // AP Due, which list the parties rather than the age bands. `emptyAging`,
  // `arAging`, `apAging`, `agingData` and the two per-bucket drills went with
  // them. Days past due survive on each row, so the age is still on screen —
  // attached to whoever owes or is owed, which is what makes it actionable.
  // The aging CHARTS still exist on the AR/AP and AP Sheet tabs, untouched.

  // AR DUE, by PAYER — the party billed (Veterans Affairs, TriCare, the PI law
  // firm), never the patient. Same shape as apDue below: one row per party,
  // `days` from the oldest invoice in the group, ordered by amount.
  const arDue = (() => {
    const m = new Map<string, { id: string; payer: string; number: string; open: number; dueDate: string | null; days: number; n: number }>();
    for (const i of arInv) {
      if (!(i.open > 0)) continue;
      const p = i.payer || '-';
      const days = i.dueDate ? Math.floor((refMs - new Date(i.dueDate).getTime()) / 86_400_000) : 0;
      const e = m.get(p) ?? { id: p, payer: p, number: i.number, open: 0, dueDate: i.dueDate, days: 0, n: 0 };
      e.open += i.open; e.n += 1;
      if (days > e.days) { e.days = days; e.dueDate = i.dueDate; e.number = i.number; }
      m.set(p, e);
    }
    return [...m.values()].sort((a, b) => b.open - a.open);
  })();

  // AP DUE, by payee. Bills are grouped per vendor because a payment run is
  // made to a vendor, not to a bill number — two bills for one supplier are one
  // cheque. `days` is the OLDEST bill's age in the group, so the row reports
  // the most overdue thing it contains rather than an average that hides it.
  // Ordered by amount: the biggest cheque is the first decision.
  const apDue = (() => {
    const m = new Map<string, { id: string; vendor: string; number: string; open: number; dueDate: string | null; days: number }>();
    for (const b of apBook) {
      // Same due-date scoping as AR above, and for the same reason: a bill
      // carries no date but the one it falls due on.
      if (!(b.open > 0) || !inPeriodDate(b.dueDate)) continue;
      const v = b.vendor || '-';
      const days = b.dueDate ? Math.floor((refMs - new Date(b.dueDate).getTime()) / 86_400_000) : 0;
      const e = m.get(v) ?? { id: v, vendor: v, number: b.number, open: 0, dueDate: b.dueDate, days: 0 };
      e.open += b.open;
      if (days > e.days) { e.days = days; e.dueDate = b.dueDate; e.number = b.number; }
      m.set(v, e);
    }
    return [...m.values()].sort((a, b) => b.open - a.open);
  })();

  // ── UNITS BY DEVICE ────────────────────────────────────────────────────────
  // Its own feed (/api/device-mix), not the commission ledger.
  //
  // The ledger was the wrong source twice over: it drops a HELD order entirely,
  // so it reports zero holds and the amber markers could never appear; and it
  // sums to 612 units against the order book's 670, so the card contradicted the
  // Devices tile beside it. The feed reads report_patient_items for the units and
  // joins the Striven label report for the holds, which is the only place a hold
  // survives.
  const [devMix, setDevMix] = useState<DeviceMixRow[]>([]);
  useEffect(() => { fetchDeviceMix().then((d) => setDevMix(d?.devices ?? [])).catch(() => setDevMix([])); }, []);
  // Program filter + display names. Merged CASE-INSENSITIVELY: item names are
  // typed by hand, so "PI TENS/NMES" and "PI Tens/NMES" are one device and must
  // not rank as two. shortDeviceName() strips the programme prefix and any
  // supplier code, the same helper the device chips use, so a device reads
  // identically wherever it appears.
  const devMixRows = (() => {
    const m = new Map<string, DeviceMixRow>();
    for (const d of devMix) {
      if (prog !== 'All' && d.vertical !== prog) continue;
      // SCOPED TO THE PERIOD off the per-month counts the server now sends.
      // Units are the one figure here with no date of its own — the device
      // report is keyed by sales order — so the months are joined server-side
      // and the row is rebuilt from just the ones in range.
      //
      // `held` is NOT re-scoped: the hold is a label on the order as it stands
      // today, with no month attached, so a month's share of it cannot be known.
      // Carried whole rather than apportioned, and the card reads it as a
      // whole-book caveat, which is what it is.
      let row: DeviceMixRow = { ...d, device: shortDeviceName(d.device) || d.device };
      if (periodScoped) {
        const inRange = Object.entries(d.byMonth ?? {}).filter(([mo]) => inFy(mo));
        const units = inRange.reduce((a, [, v]) => a + v.units, 0);
        const orders = inRange.reduce((a, [, v]) => a + v.orders, 0);
        if (units <= 0) continue;                 // nothing dispensed this period
        row = { ...row, units, orders };
      }
      // THE KEY HAS TO CARRY `demo`, or the two collapse into one row.
      // shortDeviceName() strips the vertical prefix, so "DEMO ManaRay Lumbar"
      // shortens to "ManaRay Lumbar" — the exact string a real ManaRay row
      // already has. Keyed on the name alone, demo units would be added
      // silently into the real device's count, which is the one outcome this
      // whole separate-cache design exists to prevent.
      const k = `${row.demo ? 'demo ' : ''}${row.device.toLowerCase()}`;
      const e = m.get(k);
      if (!e) { m.set(k, row); continue; }
      e.units += row.units; e.orders += row.orders;
      e.heldUnits += row.heldUnits; e.heldOrders += row.heldOrders;
    }
    return [...m.values()].filter((d) => d.units > 0);
  })();
  // TOTALLED SEPARATELY, because they are separate facts. The headline counts
  // what the business dispensed; demo is reported beside it, never inside it.
  const devMixTotal = devMixRows.filter((d) => !d.demo).reduce((s, d) => s + d.units, 0);
  const devMixDemoUnits = devMixRows.filter((d) => d.demo).reduce((s, d) => s + d.units, 0);
  const devMixRealRows = devMixRows.filter((d) => !d.demo).length;
  // DEMO orders used to sit outside every unit figure on this board:
  // gen-reports.mjs drops them from report_patient_items, so they carried no
  // device lines at all and the card could only say they were missing. Their
  // lines now come from `report_demo_items`, a cache nothing else reads — see
  // refreshDemoItems() — so they can be shown without reaching commission, the
  // leaderboard or any other figure.
  const demoOrders = so?.piva?.DEMO?.count ?? 0;
  const demoValue = so?.piva?.DEMO?.value ?? 0;

  // Doughnut slices for the money tiles. Each keeps the hue its own KPI card
  // uses, so a colour means the same thing in both places. A zero balance is
  // dropped rather than drawn — a 0% slice is a legend entry pretending to be
  // data, and it makes the ring look broken.
  const donutSlices = [
    { name: 'AR Expected', value: arOpenF, color: HUE.ar.to },
    { name: 'AP Due', value: apOpenF, color: HUE.ap.to },
    { name: 'Commission Due', value: commDue.payable, color: HUE.po.to },
  ].filter((s) => s.value > 0);

  // ── AR DETAIL ──────────────────────────────────────────────────────────────
  // Everything the "AR Expected · 11 unpaid" tile left unsaid: how overdue the
  // money is, how much of it rides on one payer, and how much sits in credits
  // that were never applied. Computed from the SAME `arInv` set the tile totals,
  // so the card and its headline cannot diverge, and it re-scopes with the
  // Program filter for free.
  const arDetail = (() => {
    const day = 86_400_000;
    const age = (i: { dueDate?: string | null }) => (i.dueDate
      ? Math.floor((refMs - new Date(i.dueDate).getTime()) / day) : 0);
    const b = { current: 0, d30: 0, d60: 0, d90: 0 };
    for (const i of arInv) {
      const d = age(i);
      if (d <= 0) b.current += i.open;
      else if (d <= 30) b.d30 += i.open;
      else if (d <= 60) b.d60 += i.open;
      else b.d90 += i.open;
    }
    const oldest = arInv.reduce((mx, i) => Math.max(mx, age(i)), 0);
    // Concentration: one payer going quiet is the risk a total cannot show.
    const byPayer = new Map<string, number>();
    for (const i of arInv) byPayer.set(i.payer || 'Unassigned', (byPayer.get(i.payer || 'Unassigned') ?? 0) + i.open);
    const top = [...byPayer.entries()].sort((a, b2) => b2[1] - a[1])[0] ?? null;
    return {
      buckets: [
        { name: 'Not yet due', value: b.current, color: C.positive },
        { name: '1–30d', value: b.d30, color: C.warning },
        { name: '31–60d', value: b.d60, color: '#EA580C' },
        { name: '60d+', value: b.d90, color: C.negative },
      ].filter((x) => x.value > 0),
      overdue: b.d30 + b.d60 + b.d90,
      oldest,
      payers: byPayer.size,
      top: top ? { name: top[0], value: top[1] } : null,
    };
  })();

  // ── AP DETAIL ──────────────────────────────────────────────────────────────
  // Same treatment as AR, and deliberately the same bands so the two read
  // against each other: what we are owed and what we owe, aged alike.
  const apDetail = (() => {
    const day = 86_400_000;
    const bills = apBookScoped.filter((b) => (b.open ?? 0) > 0);
    const age = (b: { dueDate?: string | null }) => (b.dueDate
      ? Math.floor((refMs - new Date(b.dueDate).getTime()) / day) : 0);
    const k = { current: 0, d30: 0, d60: 0, d90: 0 };
    for (const b of bills) {
      const d = age(b);
      if (d <= 0) k.current += b.open;
      else if (d <= 30) k.d30 += b.open;
      else if (d <= 60) k.d60 += b.open;
      else k.d90 += b.open;
    }
    const byVendor = new Map<string, number>();
    for (const b of bills) byVendor.set(b.vendor || 'Unassigned', (byVendor.get(b.vendor || 'Unassigned') ?? 0) + b.open);
    const top = [...byVendor.entries()].sort((a, b2) => b2[1] - a[1])[0] ?? null;
    return {
      rail: [
        { name: 'Not yet due', value: k.current, color: C.positive },
        { name: '1–30d', value: k.d30, color: C.warning },
        { name: '31–60d', value: k.d60, color: '#EA580C' },
        { name: '60d+', value: k.d90, color: C.negative },
      ],
      overdue: k.d30 + k.d60 + k.d90,
      oldest: bills.reduce((mx, b) => Math.max(mx, age(b)), 0),
      vendors: byVendor.size,
      top: top ? { name: top[0], value: top[1] } : null,
    };
  })();

  // ── REVENUE / CASH DETAIL ──────────────────────────────────────────────────
  // The rail is the MONTHS INSIDE THE ACTIVE PERIOD, which genuinely sum to the
  // headline — a composition, not a trend line dressed as one. Under a
  // single-month period it collapses to one segment, which is correct: there is
  // nothing to compose.
  const monthRail = (series: { month: string; value: number }[], base: string) => series
    .filter((s) => s.value > 0)
    .map((s, i) => ({ name: monthLabel(s.month), value: s.value, color: shade(base, i, series.length) }));
  const bestOf = (series: { month: string; value: number }[]) => series
    .reduce<{ month: string; value: number } | null>((m, s) => (!m || s.value > m.value ? s : m), null);
  const bestRev = bestOf(revSeries);
  const bestCash = bestOf(cashSeries);
  // Collection rate over the SAME period as both figures, so it cannot compare
  // a month of cash against a year of revenue.
  const collectedPct = fRev > 0 ? Math.round((cashFY / fRev) * 100) : null;

  // Rows for the interactive commission card. `onRoster` marks the producing
  // four; the rest are carried so their money is reported rather than dropped.
  // THE ROWS UNDER THE HEADLINE, on the same basis as the headline.
  //
  // `payable` and `lines` are both cut to the period here. They have to move
  // together with commDue.payable above, or the tile shows a total the list
  // beneath it does not add up to — and the list is what someone checks the
  // total against. Same rule throughout: owed only, and an undated line belongs
  // to no month.
  const commRows = (() => {
    const roster = new Set(comm?.roster ?? []);
    const inScope = (l: { date?: string | null }) =>
      !periodScoped || (Boolean(l.date) && inFy(String(l.date).slice(0, 7)));
    return (comm?.striven?.byRep ?? []).map((r) => {
      const owed = (r.lines ?? []).filter((l) => l.state !== 'paid' && inScope(l));
      return {
        rep: r.rep,
        payable: (r.lines ?? []).length
          ? Math.round(owed.reduce((a, l) => a + (l.comm ?? 0), 0) * 100) / 100
          : (r.payableTotal ?? 0),
        orders: r.orders ?? 0,
        units: r.units ?? 0,
        pi: r.pi ?? 0, va: r.va ?? 0, tricare: r.tricare ?? 0,
        onRoster: roster.size ? roster.has(r.rep) : true,
        // The drill lists the SAME lines the figure was built from, so opening a
        // rep can never show orders from outside the period on screen.
        lines: owed.map((l) => ({
          ref: l.ref, patient: l.patient ?? '', item: l.item ?? '', prog: l.prog ?? '', comm: l.comm ?? 0,
        })),
      };
    }).filter((r) => r.payable > 0);
  })();

  // ── THE OTHER TWO RINGS ────────────────────────────────────────────────────
  // Each doughnut is ONE unit and ONE genuine whole. That is the whole
  // discipline here: a ring claims its slices add up to something real, so
  // money, orders and units get their own rings rather than being mixed into a
  // single chart that would compute shares across incomparable things.

  // Sales Orders (481) split by where each one stands. Cancelled is excluded to
  // match the tile — the tile counts 481 and so must the ring.
  // FUNNEL STAGES. Each is a strict subset of the one above — raised, kept,
  // finished — which is what makes the widths comparable on one scale. Where a
  // programme filter is on, only the count is trustworthy (Striven does not
  // split status by programme), so the funnel collapses to that single bar.
  // ── ORDER STATUS BY STRIVEN LABEL ──────────────────────────────────────────
  // COMPANY BOARD ONLY (Crystal + Kevin). Reads the labels already carried on
  // so.recent; nothing here touches the PI/PIP pipelines or the Orders tab.
  //
  // Labels are shown in STRIVEN'S EXACT WORDING, unmapped and ungrouped. This
  // board is the place to see what staff actually tagged; the pipelines are
  // where labels get folded into stages, and doing that here as well would put
  // a second, quieter interpretation of the same data on a different screen.
  //
  // An order carrying several labels counts under each, so the rows total more
  // than the order count — stated on the card rather than left to be inferred.
  const [labelScope, setLabelScope] = useState<'all' | 'done'>('all');
  // SEGMENTED BY VERTICAL. The board's Program filter is the outer one, so when
  // it is set this control has nothing left to choose and defers to it rather
  // than offering a second answer to the same question.
  const [labelVert, setLabelVert] = useState<'All' | 'PI' | 'VA' | 'TriCare'>('All');
  const vertPick: string = prog !== 'All' ? prog : labelVert;
  const LABEL_VERTS = ['All', 'PI', 'VA', 'TriCare'] as const;
  /** Sentinel for "Striven has tagged this order with nothing". The parentheses
   *  keep it from colliding with a real label, which never has them — the same
   *  sentinel the pipeline's label filter uses, for the same reason. */
  const NO_LABEL = '(no label)';
  const labelStats = (() => {
    const src = (so?.recent ?? [])
      .filter((o) => !isCancelledStatus(o.status))
      .filter((o) => (vertPick === 'All' ? true : o.type === vertPick))
      .filter((o) => (labelScope === 'done' ? isCompletedStatus(o.status) : true));
    const m = new Map<string, { label: string; n: number; value: number; done: number; byVert: Map<string, number> }>();
    let untagged = 0;
    let untaggedValue = 0;
    for (const o of src) {
      const ls = o.labels ?? [];
      // The VALUE of the untagged orders as well as the count. A bare "37
      // orders" says how many are unclassified but not how much rides on them,
      // which is the thing that decides whether it is worth chasing.
      if (!ls.length) { untagged += 1; untaggedValue += o.value || 0; continue; }
      for (const l of ls) {
        const e = m.get(l) ?? { label: l, n: 0, value: 0, done: 0, byVert: new Map<string, number>() };
        e.n += 1;
        e.value += o.value || 0;
        if (isCompletedStatus(o.status)) e.done += 1;
        // Per-label vertical split, so a label that spans programmes shows it
        // instead of reading as a single-programme tag.
        e.byVert.set(o.type, (e.byVert.get(o.type) ?? 0) + 1);
        m.set(l, e);
      }
    }
    // Which verticals actually carry orders right now — the control offers only
    // those, so it can never land on an empty segment.
    const live = new Set(src.map((o) => o.type));
    return {
      orders: src.length,
      untagged,
      untaggedValue,
      verts: LABEL_VERTS.filter((v) => v === 'All' || live.has(v)),
      rows: [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    };
  })();
  // Drill: every order carrying the clicked label, in Striven's own wording.
  //
  // NO_LABEL is not a label. It is the sentinel for the orders Striven has
  // tagged with nothing — they were counted in the note under this card and
  // reachable from nowhere, so the one group that most needs working through was
  // the only one you could not open. The parentheses keep it from ever colliding
  // with a real label, which never has them; the same sentinel and the same
  // reasoning are already used by the pipeline's label filter.
  const drillLabel = (label: string) => {
    const untaggedDrill = label === NO_LABEL;
    const list = (so?.recent ?? [])
      .filter((o) => !isCancelledStatus(o.status))
      .filter((o) => (vertPick === 'All' ? true : o.type === vertPick))
      .filter((o) => (labelScope === 'done' ? isCompletedStatus(o.status) : true))
      .filter((o) => (untaggedDrill ? (o.labels ?? []).length === 0 : (o.labels ?? []).includes(label)))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    setDrill({
      title: untaggedDrill ? 'Orders with no Striven label' : label,
      sub: `${list.length} order${list.length === 1 ? '' : 's'} · ${formatCurrency(list.reduce((s, o) => s + (o.value || 0), 0))}${
        untaggedDrill ? ' · nothing tagged in Striven, so they sit at stage 1 on every pipeline' : ''}`,
      columns: [
        { key: 'ref', label: 'Order #' }, { key: 'patient', label: 'Patient' },
        { key: 'type', label: 'Programme' },
        { key: 'rep', label: 'Sales Rep' }, { key: 'status', label: 'Status' },
        { key: 'labels', label: 'All labels' }, { key: 'value', label: 'Value', num: true },
      ],
      rows: list.map((o) => ({
        // Openable, like every other order reference in the portal. This board
        // is company-side and admin-only (COMPANY_NAV), so the Striven jump is
        // offered — no rep can reach this drill to be shown a link they have no
        // login for.
        ref: <SoLink soId={o.id} label={o.ref} canOpenInStriven />,
        // First INITIAL + surname, as everywhere else this data appears. Placed
        // beside the order number because that is how staff recognise a row —
        // "SO-451" alone identifies nothing to a reader.
        patient: o.patient
          ? <strong>{o.patient}</strong>
          : <span style={{ color: C.muted }}>—</span>,
        type: o.type,
        rep: o.rep || '-',
        status: o.status,
        // An em dash, not an empty cell: on the no-label drill every row would
        // otherwise be blank here and read as a rendering fault rather than as
        // the very fact the drill was opened to show.
        labels: (o.labels ?? []).length
          ? (o.labels ?? []).join(', ')
          : <span style={{ color: C.muted }}>—</span>,
        value: formatCurrency(o.value || 0),
      })),
    });
  };

  // ── ORDER BOOK, BY STATE ───────────────────────────────────────────────────
  // A FUNNEL WAS THE WRONG SHAPE. Its last step read "−335 still working", which
  // frames work in progress as drop-off — and "invoiced" is not a subset of
  // "completed" (16 in-progress orders are already billed), so the stages could
  // never legitimately nest.
  //
  // These four states are MUTUALLY EXCLUSIVE and sum to the book, which is what
  // lets one bar carry all of it. Crossing status with invoicing is what makes
  // the card worth reading: it isolates orders that are DONE BUT NOT BILLED —
  // delivered work earning nothing — which the funnel hid entirely.
  const orderStates = (() => {
    const rows = (so?.recent ?? []).filter((o) => !isCancelledStatus(o.status));
    const done = (o: { status: string }) => isCompletedStatus(o.status);
    const billed = (o: { invStatus: string }) => /full/i.test(o.invStatus || '');
    const n = { workOpen: 0, workBilled: 0, doneUnbilled: 0, doneBilled: 0 };
    for (const o of rows) {
      if (done(o)) { if (billed(o)) n.doneBilled += 1; else n.doneUnbilled += 1; }
      else if (billed(o)) n.workBilled += 1;
      else n.workOpen += 1;
    }
    return {
      total: rows.length,
      ...n,
      rail: [
        { name: 'Working', value: n.workOpen, color: C.muted },
        { name: 'Working · billed', value: n.workBilled, color: C.brand },
        { name: 'Done · not billed', value: n.doneUnbilled, color: C.negative },
        { name: 'Done · billed', value: n.doneBilled, color: C.positive },
      ],
      cancelled: so?.statusGroups?.cancelled?.count ?? 0,
    };
  })();

  // Devices (670 units) split by programme. Uses the same feed as the device
  // breakdown, so the two cards cannot disagree about what a unit is.
  const unitSlices = (() => {
    const m = new Map<string, number>();
    for (const d of devMixRows) m.set(d.vertical, (m.get(d.vertical) ?? 0) + d.units);
    return [...m.entries()]
      .map(([name, value]) => ({ name, value, color: VERTICAL_COLORS[name] ?? C.muted }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
  })();

  // Program-scoped sales orders.
  const soCount = so ? (prog === 'All' ? so.count : so.piva[prog === 'Unassigned' ? 'Other' : prog].count) : 0;

  // Cap at 100 so the printed label can't exceed the gauge arc (which clamps).
  const collectionPct = fRev > 0 ? Math.min(100, Math.round((cashFY / fRev) * 100)) : 0;
  // DSO restricted to PI (client SOW): VA / TriCare pay on fixed cycles, so DSO
  // is meaningless there. Computed by the aging method: the amount-weighted
  // average age of OPEN PI receivables: because revenue isn't program-split, so
  // a sales-based DSO can't be scoped to PI honestly. Always PI, regardless of
  // the header program filter (DSO is inherently a PI metric here).
  const piOpenInv = (ar?.invoices ?? []).filter((i) => i.open > 0 && programOfPayer(i.payer) === 'PI');
  const piOpenSum = piOpenInv.reduce((s, i) => s + i.open, 0);
  const piDso = piOpenSum > 0
    ? Math.round(piOpenInv.reduce((s, i) => {
        const age = i.dueDate ? Math.max(0, Math.floor((refMs - new Date(i.dueDate).getTime()) / 86_400_000)) : 0;
        return s + i.open * age;
      }, 0) / piOpenSum)
    : null;

  // Action Center: items derived live from the same datasets.
  const soon = refMs + 7 * 86_400_000;
  const overdue = arInv.filter((i) => i.dueDate && new Date(i.dueDate).getTime() < refMs);
  const overdueSum = overdue.reduce((s, i) => s + i.open, 0);
  const billsDue = apBook.filter((b) => b.open > 0 && b.dueDate && new Date(b.dueDate).getTime() <= soon);
  const billsDueSum = billsDue.reduce((s, b) => s + b.open, 0);
  const waitingPo = (orders?.orders ?? []).filter((o) =>
    (prog === 'All' || o.pi === prog) && o.pos.length === 0 && !/cancel|void|complete|closed/i.test(o.status));
  type AcItem = { n: string; l1: string; l2: string; view: string; ico: ReactNode };
  const acItems: AcItem[] = [];
  if (overdue.length) acItems.push({ n: String(overdue.length), l1: 'Invoices Overdue', l2: formatCurrency(overdueSum), view: 'receivables', ico: '!' });
  if (billsDue.length) acItems.push({ n: String(billsDue.length), l1: 'Vendor Bills Due', l2: formatCurrency(billsDueSum), view: 'payables', ico: '$' });
  if (waitingPo.length) acItems.push({ n: String(waitingPo.length), l1: 'Sales Orders', l2: 'Waiting for PO', view: 'tracking', ico: '›' });
  if (exc?.totalOpen) acItems.push({ n: String(exc.totalOpen), l1: 'Exceptions', l2: 'Needs Review', view: 'exceptions', ico: '▲' });
  if (cashD && !cashD.up) acItems.push({ n: `${Math.abs(cashD.pct)}%`, l1: 'Collection Drop', l2: 'vs last month', view: 'accounts', ico: '↓' });


  // Sales orders by program (real classification off SO type). When a program
  // filter is active the other bars dim so the selection reads instantly.
  //
  // EVERY BUCKET THE SERVER SENDS, so the bars add up to the footer. PI + VA +
  // Tri-Care came to 473 under a "Total Orders 502", because DEMO's 29 orders
  // had no bar and nothing on the card said where they had gone — the reader is
  // left to find a 29-order hole by subtracting. The server's own piva buckets
  // sum to 502 exactly; drawing all of them is the whole fix.
  //
  // DEMO is drawn MUTED and is not clickable. It is a real Striven order type
  // and belongs in the count, but it is not a programme anyone sells into, and
  // colouring it like one would put test orders on the same footing as VA. The
  // click handler below already ignores anything that is not PI / VA / TriCare,
  // so the bar is inert by construction rather than by a second rule.
  const programBars = so ? ([
    { key: 'PI', name: 'PI', ...so.piva.PI, color: SERIES[0] },
    { key: 'VA', name: 'VA', ...so.piva.VA, color: SERIES[1] },
    { key: 'TriCare', name: 'Tri-Care', ...so.piva.TriCare, color: SERIES[2] },
    ...(so.piva.Contract?.count > 0 ? [{ key: 'Contract', name: 'Contract', ...so.piva.Contract, color: SERIES[3] }] : []),
    ...(so.piva.Other.count > 0 ? [{ key: 'Other', name: 'Other', ...so.piva.Other, color: SERIES[4] }] : []),
    ...(so.piva.DEMO?.count > 0 ? [{ key: 'DEMO', name: 'DEMO / test', ...so.piva.DEMO, color: C.muted }] : []),
  ].filter((d) => d.count > 0).map((d) => ({
    name: d.name, value: d.count, color: d.color,
    // The demo row says what it is worth NOT counting, since that is the
    // question it exists to answer.
    meta: d.key === 'DEMO' ? `${d.count} orders · no commission, no PO spend` : `${d.count} orders`,
    dim: prog !== 'All' && d.key !== prog,
  }))) : [];

  // PO spend by vendor (top 5): slices sum to committed spend.
  const vendorBars = [...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total).slice(0, 5)
    .map((v, i) => ({ name: trunc(v.vendor), value: v.total, color: CAT6[i % CAT6.length] }));

  // Top payers by open AR: payer (law firm / VA / insurer) is the non-PHI
  // counterparty; patient customer names arrive masked. Program-scoped.
  const custAgg = new Map<string, number>();
  for (const i of arInv) {
    const who = i.payer || i.customer || 'Unassigned';
    custAgg.set(who, (custAgg.get(who) || 0) + i.open);
  }
  const topCust = [...custAgg].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open).slice(0, 5);

  const topVend = [...(po?.byVendor ?? [])].sort((a, b) => b.total - a.total).slice(0, 5);

  // ---- click-through drills: every list/donut leads to its underlying rows ----
  // Every open invoice for one payer. Mirrors drillApBill.
  const drillArPayer = (payer: string) => setDrill({
    title: payer || 'Payer', sub: 'Open invoices for this payer',
    columns: [{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
    rows: arInv.filter((i) => i.open > 0 && (i.payer || '-') === payer)
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
      .map((i) => ({ n: `#${i.number}`, d: shortDate(i.dueDate), o: formatCurrency(i.open) })),
  });
  // drillApBucket ("AP Aging · 31–60") went with the donut that opened it.
  // drillApBill() went with the AP Due list it belonged to. Per-bill detail for
  // a vendor now lives on the Payables tab, which the AP Due card links to.
  const drillVendor = (name: string) => setDrill({
    title: name, sub: 'Recent purchase orders for this vendor',
    columns: [{ key: 'r', label: 'PO ref' }, { key: 'd', label: 'Date' }, { key: 'a', label: 'Amount', num: true }],
    rows: (po?.recent ?? []).filter((r) => (r.vendor || '-') === name).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .map((r) => ({ r: r.ref, d: shortDate(r.date), a: formatCurrency(r.total) })),
  });

  // ── FINANCIAL INSIGHTS, BY QUARTER ─────────────────────────────────────────
  // This panel used to read the page's MONTH scope, which is why it showed two
  // lines out of five: three of them compared against the current month, and
  // the current month has no rows yet. A quarter always contains completed
  // months, so the callouts have something to say.
  //
  // Quarters are calendar quarters of the active FY — /api/pl reports
  // periodFrom 2026-01-01, so Q1 is Jan–Mar.
  const qOf = (mm: string) => Math.floor((Number(mm.slice(5, 7)) - 1) / 3);      // 0..3
  const fySeries = (trends?.series ?? []).filter((s) => s.month.startsWith(fy));
  const fyCash = (payments?.byMonth ?? []).filter((p) => p.month.startsWith(fy));
  // Default to the latest quarter that actually has activity, not to "today's"
  // quarter — landing on an empty quarter is the bug this panel already had.
  const lastActive = [...fySeries].reverse().find((s) => s.revenue > 0 || s.expenses > 0);
  const [qPick, setQPick] = useState<number | 'fy' | null>(null);
  const activeQ: number | 'fy' = qPick ?? (lastActive ? qOf(lastActive.month) : 'fy');
  const inQ = (mm: string, q: number | 'fy') => (q === 'fy' ? true : qOf(mm) === q);

  const qSum = (q: number | 'fy') => {
    const rows = fySeries.filter((s) => inQ(s.month, q));
    const cash = fyCash.filter((p) => inQ(p.month, q)).reduce((a, p) => a + (p.amount || 0), 0);
    const revenue = rows.reduce((a, s) => a + (s.revenue || 0), 0);
    const expenses = rows.reduce((a, s) => a + (s.expenses || 0), 0);
    return { revenue, expenses, net: revenue - expenses, cash, rows };
  };
  const cur = qSum(activeQ);
  // Previous quarter, for the deltas. 'fy' has no predecessor inside this FY.
  const prev = typeof activeQ === 'number' && activeQ > 0 ? qSum(activeQ - 1) : null;
  const delta = (now: number, before: number) =>
    (before > 0 ? Math.round(((now - before) / before) * 100) : null);
  const revDelta = prev ? delta(cur.revenue, prev.revenue) : null;
  const cashDelta = prev ? delta(cur.cash, prev.cash) : null;
  // `qMargin`, not `margin`: the page already has an FY-scoped `margin` above.
  const qMargin = cur.revenue > 0 ? Math.round((cur.net / cur.revenue) * 100) : null;
  const collected = cur.revenue > 0 ? Math.round((cur.cash / cur.revenue) * 100) : null;
  const bestInQ = cur.rows.filter((s) => s.revenue > 0)
    .reduce<{ month: string; revenue: number } | null>((m, s) => (!m || s.revenue > m.revenue ? s : m), null);
  const qLabel = activeQ === 'fy' ? `FY${fy}` : `Q${activeQ + 1} ${fy}`;
  const prevLabel = typeof activeQ === 'number' && activeQ > 0 ? `Q${activeQ}` : '';
  // Quarters offered: only those with data, so the picker cannot land on a
  // blank one. 'fy' is always available as the whole-year view.
  //
  // CASH COUNTS AS ACTIVITY. The test used to be revenue-or-expenses alone,
  // which hid a quarter that collected money against invoices raised earlier —
  // exactly Q1's case, where $1,100 landed in March with no invoice dated
  // before April. A missing quarter reads as a broken filter, so a quarter is
  // offered whenever it has anything at all to report.
  const qHasCash = (q: number) => fyCash.some((p) => qOf(p.month) === q && (p.amount || 0) !== 0);
  const qOptions: (number | 'fy')[] = [
    ...[0, 1, 2, 3].filter((q) => fySeries.some((s) => qOf(s.month) === q && (s.revenue > 0 || s.expenses > 0)) || qHasCash(q)),
    'fy',
  ];
  // The earliest month with any activity, so the panel can say WHY a quarter is
  // absent instead of leaving a gap in the picker to be read as a bug. The
  // client's financial year is the calendar year, so Q1 is Jan–Mar.
  const firstMonth = [...fySeries.filter((s) => s.revenue > 0 || s.expenses > 0).map((s) => s.month),
    ...fyCash.filter((p) => (p.amount || 0) !== 0).map((p) => p.month)].sort()[0] ?? null;
  // Quarters BEFORE the data starts — genuinely empty, not filtered out. Later
  // quarters of the year are simply in the future and need no explanation.
  const missingQ = firstMonth
    ? [0, 1, 2, 3].filter((q) => q < qOf(firstMonth) && !qOptions.includes(q))
    : [];

  type Ins = { tone: keyof typeof INS_TONES; ico: string; text: ReactNode };
  const insights: Ins[] = [];
  // ── the quarter itself ──
  insights.push({ tone: 'brand', ico: '$', text: <>Revenue <b>{formatCurrency(cur.revenue)}</b> in {qLabel}</> });
  if (revDelta != null) insights.push({
    tone: revDelta >= 0 ? 'pos' : 'neg', ico: revDelta >= 0 ? '▲' : '▼',
    text: <>Revenue {revDelta >= 0 ? 'up' : 'down'} <b>{Math.abs(revDelta)}%</b> vs {prevLabel}</>,
  });
  if (qMargin != null) insights.push({
    tone: cur.net >= 0 ? 'pos' : 'neg', ico: cur.net >= 0 ? '◆' : '▼',
    text: <>Net <b>{formatCurrency(cur.net)}</b> · margin <b>{qMargin}%</b> (expenses {compactMoney(cur.expenses)})</>,
  });
  if (collected != null) insights.push({
    tone: collected >= 80 ? 'pos' : 'neg', ico: '↻',
    text: <>Collected <b>{formatCurrency(cur.cash)}</b> — <b>{collected}%</b> of what was invoiced</>,
  });
  if (cashDelta != null) insights.push({
    tone: cashDelta >= 0 ? 'pos' : 'neg', ico: cashDelta >= 0 ? '▲' : '▼',
    text: <>Collections {cashDelta >= 0 ? 'up' : 'down'} <b>{Math.abs(cashDelta)}%</b> vs {prevLabel}</>,
  });
  if (bestInQ) insights.push({ tone: 'brand', ico: '★', text: <>Best month: <b>{monthLabel(bestInQ.month)}</b> ({compactMoney(bestInQ.revenue)})</> });
  if (pl?.avgInvoice) insights.push({ tone: 'purple', ico: '#', text: <>Avg invoice <b>{formatCurrency(pl.avgInvoice)}</b> · {pl.invoiceCount} invoices FY{fy}</> });
  // ── as of today: balances are point-in-time and cannot be quarter-scoped ──
  if (topCust[0]) insights.push({ tone: 'teal', ico: '◆', text: <>Owed most now: <b>{trunc(topCust[0].name, 16)}</b> ({formatCurrency(topCust[0].open)})</> });
  if (apDue[0]) insights.push({
    tone: apDue[0].days > 60 ? 'neg' : 'purple', ico: '!',
    text: <>Oldest bill: <b>{trunc(apDue[0].vendor, 16)}</b> ({formatCurrency(apDue[0].open)}, {apDue[0].days}d)</>,
  });
  if (commDue.payable) insights.push({ tone: 'purple', ico: '%', text: <>Commission due <b>{formatCurrency(commDue.payable)}</b> to producing reps</> });

  const excGroups = exc ? [...exc.groups].sort((a, b) => b.count - a.count).slice(0, 6) : [];

  const ready = ar && ap && pl && payments && so && po && trends;
  return (
    // `ov-board` scopes the Company board's own typography. `exec-deck` is
    // shared by a dozen tabs, so styling through it would restyle the whole
    // portal — this class exists to keep the change on this screen.
    // NO INLINE PADDING ON THE BOARD ROOT. It carried `4px 2px`, which inset the
    // whole board by two pixels the page's own padding had already provided —
    // and put the header's left edge two pixels off the sidebar's rhythm.
    // Spacing belongs to the stylesheet and the scale, not to a style attribute.
    <div className={`exec-deck ov-board${kevinLook ? ' ov-kevin' : ''}`}>
      {/* The header's own bottom margin comes from `.deck-head` (one scale step),
          not from an inline 14. */}
      <div className="page-head deck-head">
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Financial Overview</h1>
          <div className="page-sub">Executive Summary Dashboard · Sports Med Recovery</div>
        </div>
        <div className="ov-headright">
          {/* VIEW-AS PICKER. Previews another login's dashboard by hiding the
              panels their profile drops. Presentation only — it changes nothing
              about what the server sent, so it is a preview of the LAYOUT, not
              of anybody's permissions.

              HIDDEN ON KEVIN'S BOARD, on request: his dashboard should read as
              his, not as a view someone selected. That makes the picker
              one-way, since the choice is persisted — so `?view=crystal` in the
              URL sets the profile back (see viewProfile.ts). That is the ONLY
              way out of Kevin's board; do not remove it without putting a
              control back on screen first. */}
          {!kevinBoard && (
            <label className="ov-viewas">
              <span>View as</span>
              <select value={profile} onChange={(e) => setViewProfile(e.target.value as ViewProfile)}>
                {(Object.keys(PROFILE_LABEL) as ViewProfile[]).map((p) => (
                  <option key={p} value={p}>{PROFILE_LABEL[p]}</option>
                ))}
              </select>
            </label>
          )}
          <span className="deck-pill"><span className="live-dot" /> Live{agoText ? ` · ${agoText}` : ' sync'}</span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
          <button className="ov-bell" onClick={go('exceptions')} aria-label="Notifications" title="Items needing attention">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 20a2 2 0 0 1-3.4 0" />
            </svg>
            {acItems.length > 0 && <span className="bell-badge">{acItems.length}</span>}
          </button>
        </div>
      </div>

      <div className="ov-filters">
        {/* PERIOD. One control carries four shapes: the current month, the
            fiscal year, any single month the data covers, or a from→to range.
            The named months come from the DATA, so the list can never offer a
            period with nothing in it. */}
        <label className="ov-filter"><span className="fl">Period</span>
          <select value={scope === 'pick' ? `m:${pickMonth}` : scope}
            onChange={(e) => {
              // A deliberate choice. Stops the empty-month guard above from ever
              // overriding it, including the choice of an empty month.
              touchedPeriod.current = true;
              const v = e.target.value;
              if (v.startsWith('m:')) { setPickMonth(v.slice(2)); setScope('pick'); return; }
              if (v === 'custom') {
                // Seed the range with the span the data covers, so the board
                // shows something the moment it is selected.
                if (!fromYm && dataMonths.length) setFromYm(dataMonths[dataMonths.length - 1]);
                if (!toYm && dataMonths.length) setToYm(dataMonths[0]);
              }
              setScope(v as 'month' | 'fy' | 'custom');
            }}>
            <option value="month">This month</option>
            <option value="fy">Fiscal year</option>
            {dataMonths.length > 0 && (
              <optgroup label="Single month">
                {dataMonths.map((m) => <option key={m} value={`m:${m}`}>{monthName(m)}</option>)}
              </optgroup>
            )}
            <option value="custom">Custom range…</option>
          </select>
        </label>
        {/* The range inputs appear only when a range is being used, so the
            header does not carry two dead fields the rest of the time.
            MONTH inputs, not dates: every period-scoped figure here comes from a
            monthly series, so day precision would be a promise the data cannot
            keep. */}
        {scope === 'custom' && (
          <label className="ov-filter"><span className="fl">From</span>
            <input type="month" value={fromYm} max={toYm || undefined} onChange={(e) => setFromYm(e.target.value)} />
            <span className="fl">to</span>
            <input type="month" value={toYm} min={fromYm || undefined} onChange={(e) => setToYm(e.target.value)} />
          </label>
        )}
        {/* FISCAL YEAR IS ACTIONABLE ON ITS OWN.
            It used to be `disabled` unless Period was already set to "Fiscal
            year", which made it a control that is visible, populated, and inert
            — with nothing on screen saying why. Picking a year now SELECTS that
            fiscal year, switching Period to it, which is the only thing choosing
            a year could reasonably mean.
            It is still disabled in one case, and an honest one: when the data
            covers a single year there is no other year to move to, and a live
            dropdown with one option invites a click that cannot do anything. The
            title says which case you are in. */}
        <label className="ov-filter"><span className="fl">Fiscal Year</span>
          <select value={fy}
            disabled={years.length < 2}
            title={years.length < 2
              ? `The data covers ${fy} only — there is no other fiscal year to switch to.`
              : 'Scope the board to this fiscal year'}
            onChange={(e) => { setFyPick(e.target.value); setScope('fy'); }}>
            {(years.length ? years : [fy]).map((y) => <option key={y} value={y}>FY{y}</option>)}
          </select>
        </label>
        <label className="ov-filter"><span className="fl">Program</span>
          <select value={prog} onChange={(e) => setProg(e.target.value as 'All' | Program)}>
            <option value="All">All</option>
            <option value="PI">PI</option>
            <option value="VA">VA</option>
            <option value="TriCare">Tri-Care</option>
          </select>
        </label>
        <label className="ov-filter"><span className="fl">As of</span>
          <input type="date" value={asOfStr} max={todayStr} onChange={(e) => setAsOfPick(e.target.value || null)} />
        </label>
        {asOfPick && <button className="card-link" style={{ marginTop: 0 }} onClick={() => setAsOfPick(null)}>Reset to today</button>}
        <span className="ov-filter"><span className="fl">🔒</span><b>PHI masked</b></span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          {/* The Action Center red alert bar was removed at the client's request: it
              led with problems on a board that is read for position, not triage. The
              exceptions it summarised are still one click away in their own tab. */}

          {/* THE KPI STRIP IS GONE. Every tile it held is now a detail card
              above — Commission, AR, AP, Revenue, Cash Received, the order
              funnel and the device panels. Each carries the same headline it
              always did plus the breakdown behind it, so nothing is lost and
              no figure appears in two places to drift apart. */}


          {/* ── OPEN BALANCES, AS A DOUGHNUT ──────────────────────────────
              The three MONEY tiles only.
              Sales Orders (481) and Devices (670) are deliberately absent: a
              doughnut states "these are parts of one whole", and slicing 481
              orders against $35,076 would draw a share out of two different
              units — a picture with no meaning. Revenue and Cash Received are
              period FLOWS, not balances, and both read $0 this month, so they
              would contribute invisible slices. Counts keep their tiles. */}
          <div className="exec-grid12">
            {/* COMMISSION, INTERACTIVE. Replaces the flat tile: same headline,
                but ranked by rep with a drill into programme split and the
                orders behind it. The tile above is gone — two copies of the
                same number would only invite them to disagree. */}
            {commRows.length > 0 && (
              <ChartCard className="g12-3" title="Commission Due"
                sub={`Click a rep for their programme split and top orders${periodScoped ? ` · orders booked in ${periodLabel}` : ''}`}>
                <CommissionBreakdown reps={commRows} onOpen={go('commission')} />
                {/* The owed commission that belongs to NO month, named wherever
                    a period is on. Without it this tile's months sum to less
                    than its own all-time figure and nothing on screen says why —
                    the same note the Rep × vertical table carries, so the two
                    boards explain the gap identically. */}
                {commDue.undated > 0 && (
                  <div className="lbl-note">
                    A further <b>{formatCurrency(commDue.undated)}</b> is owed on lines that tie to no live sales order,
                    so they belong to no month and are not counted above.
                  </div>
                )}
              </ChartCard>
            )}
            {donutSlices.length > 0 && (
              <ChartCard className="g12-3" title="Open balances"
                sub={`${formatCurrency(arOpenF)} owed to us · ${formatCurrency(apOpenF + commDue.payable)} owed out`}>
                <DonutList data={donutSlices} totalLabel="Total outstanding"
                  onSelect={(n) => { location.hash = n === 'AR Expected' ? 'receivables' : n === 'AP Due' ? 'payables' : 'commission'; }} />
              </ChartCard>
            )}
            {/* POSITION SUMMARY — the same three balances, summarised rather
                than split. The ring can only show composition, so its "total
                outstanding" adds money coming IN to money going OUT: a real
                sum of two opposite things. This says which way each runs and
                what is left, which is the question the ring raises. */}
            {donutSlices.length > 0 && (
              <ChartCard className="g12-3" title="Position summary" sub={`Open balances, netted · ${balanceScopeLabel}`}>
                <div className="pos">
                  <div className="pos-cap">Net position</div>
                  <div className={`pos-net ${arOpenF - (apOpenF + commDue.payable) < 0 ? 'neg' : 'pos'}`}>
                    <AnimatedNumber value={arOpenF - (apOpenF + commDue.payable)} format={formatCurrency} duration={700} />
                  </div>
                  <div className="pos-sub">
                    {arOpenF >= apOpenF + commDue.payable
                      ? 'More is owed to us than we owe out.'
                      : `We owe ${((apOpenF + commDue.payable) / Math.max(1, arOpenF)).toFixed(1)}× what we are owed.`}
                  </div>

                  {/* Both bars share ONE scale — the larger side is full width —
                      so the two lengths are directly comparable. Scaling each to
                      its own width would make them look equal. */}
                  <div className="pos-side">
                    <div className="pos-lab"><span className="t">Owed to us</span><span className="v">{formatCurrency(arOpenF)}</span></div>
                    <div className="pos-track">
                      <span className="seg" style={{ width: `${(arOpenF / Math.max(arOpenF, apOpenF + commDue.payable, 1)) * 100}%`, background: C.positive }} />
                    </div>
                    <div className="pos-key"><span className="k"><span className="d" style={{ background: C.positive }} />AR from {arInv.length} unpaid invoice{arInv.length === 1 ? '' : 's'}</span></div>
                  </div>

                  <div className="pos-side">
                    <div className="pos-lab"><span className="t">We owe out</span><span className="v">{formatCurrency(apOpenF + commDue.payable)}</span></div>
                    <div className="pos-track">
                      <span className="seg" style={{ width: `${(commDue.payable / Math.max(arOpenF, apOpenF + commDue.payable, 1)) * 100}%`, background: HUE.po.to }} />
                      <span className="seg" style={{ width: `${(apOpenF / Math.max(arOpenF, apOpenF + commDue.payable, 1)) * 100}%`, background: HUE.ap.to, animationDelay: '.08s' }} />
                    </div>
                    <div className="pos-key">
                      <span className="k"><span className="d" style={{ background: HUE.po.to }} />Commission <b>{formatCurrency(commDue.payable)}</b></span>
                      <span className="k"><span className="d" style={{ background: HUE.ap.to }} />Bills <b>{formatCurrency(apOpenF)}</b></span>
                    </div>
                  </div>

                  <div className="pos-note">
                    Balances, not cash: commission falls due as orders settle, and AR arrives on its own schedule
                    {piDso != null ? ` — PI is collecting in about ${piDso} days` : ''}.
                  </div>
                </div>
              </ChartCard>
            )}

            {/* DEMO IS STILL NOT IN THIS RING, deliberately. The ring is a
                share-of-programme chart, and demo is not a programme anyone
                sells into — a fourth slice would put test orders in the same
                comparison as VA. The note below carries the figure instead, and
                the Units by Device card lists the devices themselves. */}
            {unitSlices.length > 0 && (
              <ChartCard className="g12-3" title="Units by programme"
                sub={`${devMixTotal.toLocaleString()} units on the order book${devMixDemoUnits > 0 ? ` · ${devMixDemoUnits} demo units apart` : ''}`}>
                <DonutList data={unitSlices} money={false} totalLabel="Total units" onSelect={go('orders')} />
                {demoOrders > 0 && (
                  <div className="lbl-note">
                    <b>{demoOrders} DEMO order{demoOrders === 1 ? '' : 's'}</b> ({formatCurrency(demoValue)}){devMixDemoUnits > 0
                      ? <> carry <b>{devMixDemoUnits} unit{devMixDemoUnits === 1 ? '' : 's'}</b>, listed separately on Units by Device. They are outside this ring and earn no commission.</>
                      : <> are outside this ring and earn no commission.</>}
                  </div>
                )}
              </ChartCard>
            )}
            {/* AR EXPECTED, IN DETAIL. The tile said "$35,076 · 11 unpaid",
                which is a number without a risk attached. This adds the three
                things that change what you do about it: how overdue it is, how
                much rides on one payer, and what is sitting in unapplied
                credits. */}
            {arInv.length > 0 && (
              <ChartCard className="g12-4" title="AR Expected"
                sub={`Open receivables · ${PROG_LABEL[prog]} · ${balanceScopeLabel}`}>
                <div className="ard">
                  <div className="ard-top"><AnimatedNumber value={arOpenF} format={formatCurrency} duration={700} /></div>
                  <div className="ard-sub">
                    across {arInv.length} unpaid invoice{arInv.length === 1 ? '' : 's'}
                    {arDetail.overdue > 0 && <> · <b style={{ color: C.warning }}>{formatCurrency(arDetail.overdue)}</b> already overdue</>}
                  </div>

                  {/* Urgency rail: one bar, segments in due-date order, so the
                      weight of the overdue end reads without a legend. */}
                  {arDetail.buckets.length > 0 && (
                    <>
                      <div className="ard-rail">
                        {arDetail.buckets.map((x, i) => (
                          <span key={x.name} className="seg" title={`${x.name}: ${formatCurrency(x.value)}`}
                            style={{ width: `${(x.value / Math.max(1, arOpenF)) * 100}%`, background: x.color, animationDelay: `${i * 0.07}s` }} />
                        ))}
                      </div>
                      <div className="ard-key">
                        {arDetail.buckets.map((x) => (
                          <span key={x.name} className="k">
                            <span className="d" style={{ background: x.color }} />{x.name} <b>{formatCurrency(x.value)}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="ard-facts">
                    <div className="ard-f">
                      <div className="l">Oldest</div>
                      <div className={`v${arDetail.oldest > 30 ? ' warn' : ''}`}>{arDetail.oldest > 0 ? `${arDetail.oldest}d` : '—'}</div>
                      <div className="n">past due</div>
                    </div>
                    <div className="ard-f">
                      <div className="l">PI DSO</div>
                      <div className="v">{piDso != null ? `${piDso}d` : '—'}</div>
                      <div className="n">to collect</div>
                    </div>
                    {arDetail.top && (
                      <div className="ard-f" title={arDetail.top.name}>
                        <div className="l">Top payer</div>
                        <div className={`v${(arDetail.top.value / Math.max(1, arOpenF)) > 0.3 ? ' warn' : ''}`}>
                          {Math.round((arDetail.top.value / Math.max(1, arOpenF)) * 100)}%
                        </div>
                        <div className="n">{trunc(arDetail.top.name, 18)}</div>
                      </div>
                    )}
                    <div className="ard-f">
                      <div className="l">Payers</div>
                      <div className="v">{arDetail.payers}</div>
                      <div className="n">owing now</div>
                    </div>
                  </div>

                  {/* Unapplied credits are money already received that no invoice
                      has been matched to — it reduces what is really collectable
                      and is invisible in the AR total. */}
                  {prog === 'All' && (ar?.unappliedCredits ?? 0) > 0 && (
                    <div className="ard-note">
                      <b style={{ color: C.warning }}>{formatCurrency(ar.unappliedCredits)}</b> sits in unapplied credits —
                      payments received but not matched to an invoice, so the true collectable balance is lower than the figure above.
                    </div>
                  )}
                </div>
              </ChartCard>
            )}
            {/* AR DUE — the receivables themselves: "who owes us what" is the
                collection call, and days past due rides on each row.
                Takes SIX columns now that the AP Due list beside it is gone —
                its per-vendor detail was already carried by the AP Due card
                above (ageing, oldest bill, vendor concentration), so the list
                was a second answer to a question already answered. Payables
                keeps the full per-bill view, one click away. */}
            <div className="section chart-card g12-4">
              <div className="section-head"><div>
                <h2 className="section-title">AR Due</h2>
                <div className="section-sub">Open receivables · {PROG_LABEL[prog]} · {balanceScopeLabel}</div>
              </div></div>
              <div className="rank-list">
                {arDue.map((r) => (
                  <div key={r.id} className="rk-row" style={{ cursor: 'pointer' }} {...clickableProps(() => drillArPayer(r.payer))}>
                    <span className="rk-ico" style={{ background: 'rgba(13,148,136,0.10)', color: '#0D9488' }}>{initials(r.payer || '-')}</span>
                    <span className="rk-name" title={`${r.payer} · ${r.n} invoice${r.n === 1 ? '' : 's'}`}>
                      {trunc(r.payer || '-', 20)}
                      <span style={{ display: 'block', fontSize: 10.5, color: r.days > 0 ? C.negative : C.muted, fontWeight: 600 }}>
                        {r.days > 0 ? `${r.days}d past due` : r.dueDate ? `due ${shortDate(r.dueDate)}` : 'no due date'}
                        {r.n > 1 ? ` · ${r.n} invoices` : ''}
                      </span>
                    </span>
                    <span className="rk-val">{formatCurrency(r.open)}</span>
                  </div>
                ))}
                {arDue.length === 0 && <div className="muted-note">No open receivables.</div>}
              </div>
              <div className="cfoot" style={{ marginTop: 'auto' }}>
                <div className="cf-i"><div className="l">Total due</div><div className="v">{formatCurrency(arOpenF)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Invoices</div><div className="v accent">{arInv.length}</div></div>
              </div>
              <button className="card-link" onClick={go('receivables')}>Open receivables →</button>
            </div>

            {/* AP DUE — same bands as AR, so "what we are owed" and "what we
                owe" can be read against each other rather than in isolation. */}
            {apBillCount > 0 && (
              <ChartCard className="g12-4" title="AP Due"
                sub={`Open bills · ${balanceScopeLabel}${apLedgerBills ? ' · AP ledger' : ''}`}>
                {/* apBillCount, not ap.count: the value is the ledger's, and
                    pairing it with Striven's four made this card contradict
                    itself inside a single sentence. */}
                <MetricDetail
                  value={apOpenF} format={formatCurrency}
                  sub={<>across {apBillCount} unpaid bill{apBillCount === 1 ? '' : 's'}
                    {apDetail.overdue > 0 && <> · <b style={{ color: C.warning }}>{formatCurrency(apDetail.overdue)}</b> already overdue</>}</>}
                  rail={apDetail.rail}
                  facts={[
                    { label: 'Oldest', value: apDetail.oldest > 0 ? `${apDetail.oldest}d` : '—', note: 'past due', warn: apDetail.oldest > 30 },
                    ...(apDetail.top ? [{
                      label: 'Top vendor',
                      value: `${Math.round((apDetail.top.value / Math.max(1, apOpenF)) * 100)}%`,
                      note: trunc(apDetail.top.name, 18), title: apDetail.top.name,
                      warn: (apDetail.top.value / Math.max(1, apOpenF)) > 0.5,
                    }] : []),
                    { label: 'Vendors', value: String(apDetail.vendors), note: 'owed now' },
                  ]}
                />
              </ChartCard>
            )}

            {/* ORDER BOOK BY STATE — replaces the funnel. See the note on
                orderStates: the stages could not legitimately nest, and the old
                last step framed work-in-progress as drop-off. These four states
                are mutually exclusive and sum to the book. */}
            {orderStates.total > 0 && (
              <ChartCard className="g12-4" title="Order book"
                sub={`Every live order, by where it stands · ${PROG_LABEL[prog]}`}>
                <MetricDetail
                  value={orderStates.total} format={(n) => Math.round(n).toLocaleString()}
                  sub={<>live orders · {orderStates.cancelled} cancelled excluded</>}
                  rail={orderStates.rail}
                  facts={[
                    { label: 'Completed', value: String(orderStates.doneBilled + orderStates.doneUnbilled),
                      note: `${Math.round(((orderStates.doneBilled + orderStates.doneUnbilled) / orderStates.total) * 100)}% of the book` },
                    { label: 'Still working', value: String(orderStates.workOpen + orderStates.workBilled), note: 'in progress' },
                    { label: 'Done, unbilled', value: String(orderStates.doneUnbilled),
                      note: 'not fully invoiced', warn: orderStates.doneUnbilled > 0 },
                  ]}
                  note={orderStates.doneUnbilled > 0
                    ? <><b style={{ color: C.negative }}>{orderStates.doneUnbilled} completed order{orderStates.doneUnbilled === 1 ? '' : 's'}</b> {orderStates.doneUnbilled === 1 ? 'is' : 'are'} not fully invoiced — work delivered that has not been billed.</>
                    : undefined}
                />
              </ChartCard>
            )}
            {/* REVENUE — the rail is the months INSIDE the active period, which
                sum to the headline. Under a single-month period it is one
                segment, which is the honest picture. */}
            {fRev > 0 && (
              <ChartCard className="g12-4" title={`Revenue · ${periodLabel}`}
                sub={`Invoiced${asOfPick ? ` · as of ${shortDate(asOfStr)}` : ''}`}>
                <MetricDetail
                  value={fRev} format={formatCurrency}
                  sub={<>{invCountP != null ? `${invCountP} invoice${invCountP === 1 ? '' : 's'}` : `${pl.invoiceCount} invoices · FY${fy}`} in this period</>}
                  rail={monthRail(revSeries, C.brand)}
                  facts={[
                    { label: 'Avg invoice', value: invCountP ? formatCurrency(fRev / invCountP) : formatCurrency(pl.avgInvoice ?? 0), note: 'per invoice' },
                    ...(bestRev ? [{ label: 'Best month', value: monthLabel(bestRev.month), note: formatCurrency(bestRev.value) }] : []),
                    { label: 'Expenses', value: formatCurrency(fExp), note: 'billed in period' },
                    { label: 'Margin', value: fRev > 0 ? `${Math.round(((fRev - fExp) / fRev) * 100)}%` : '—', note: formatCurrency(fRev - fExp) },
                  ]}
                />
              </ChartCard>
            )}

            {/* CASH RECEIVED — collection rate compares cash and revenue over
                the SAME period, so it can never divide a month of cash by a
                year of invoicing. */}
            {cashFY > 0 && (
              <ChartCard className="g12-4" title={`Cash Received · ${periodLabel}`}
                sub="Customer payments">
                <MetricDetail
                  value={cashFY} format={formatCurrency}
                  sub={<>{payCountP != null ? `${payCountP} payment${payCountP === 1 ? '' : 's'}` : `${payments.count} payments · all time`} in this period</>}
                  rail={monthRail(cashSeries, C.positive)}
                  facts={[
                    { label: 'Collected', value: collectedPct != null ? `${collectedPct}%` : '—', note: 'of invoiced', warn: collectedPct != null && collectedPct < 60 },
                    { label: 'Avg payment', value: payCountP ? formatCurrency(cashFY / payCountP) : '—', note: 'per payment' },
                    ...(bestCash ? [{ label: 'Best month', value: monthLabel(bestCash.month), note: formatCurrency(bestCash.value) }] : []),
                  ]}
                  note={collectedPct != null && collectedPct > 100
                    ? <>Over 100% because payments in this period settle invoices raised earlier — cash and revenue are not the same cohort.</>
                    : undefined}
                />
              </ChartCard>
            )}

          </div>

          {/* BUSINESS GROWTH — the company's own trajectory, month by month, added
              to this board on request (it already sits on the team dashboard).
              It reads the P&L for BOTH revenue and net profit, so its margin is
              the statement's own; the Revenue vs Expense card below is the
              STRIVEN book over the selected period, which is a different set of
              documents. Two cards, two books, each saying which it is.

              Hideable like every other panel here, so a profile can drop it
              without touching this file. */}
          {!hide('overview.growth') && <BusinessGrowth />}

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="Cash Flow Overview" sub={`Customer payments in vs vendor bill payments out · ${periodLabel}`}>
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

            <ChartCard className={hide('overview.collectionRate') ? "g12-7" : "g12-4"} title="Revenue vs Expense" sub={`Invoiced revenue vs billed expenses · ${periodLabel}`}>
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

            {!hide('overview.collectionRate') && (
            <ChartCard className="g12-3" title="Collection Rate" sub={`Cash received ÷ revenue · ${periodLabel}`}>
              <div className="card-body">
                <GaugeRing value={collectionPct} centerValue={`${collectionPct}%`} centerLabel="Collected" color={C.positive} height={150} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Collected</div><div className="v pos">{formatCurrency(cashFY)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Outstanding</div><div className="v">{formatCurrency(arOpenF)}</div></div>
              </div>
              <div className="cfoot" style={{ marginTop: 0 }}>
                <div className="cf-i"><div className="l">vs Last Month</div><div className={`v ${cashD ? (cashD.up ? 'pos' : 'neg') : ''}`}>{cashD ? `${cashD.up ? '▲' : '▼'} ${pctText(cashD.pct)}` : '-'}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">PI DSO</div><div className="v">{piDso != null ? `${piDso} days` : '-'}</div></div>
              </div>
            </ChartCard>
            )}

            {!hide('overview.topVendors') && (
            <div className="section chart-card g12-4">
              <div className="section-head"><div><h2 className="section-title">Top Vendors (by Spend)</h2><div className="section-sub">Committed PO spend</div></div></div>
              <div className="rank-list">
                {topVend.map((v) => (
                  <div key={v.vendor} className="rk-row" style={{ cursor: 'pointer' }} {...clickableProps(() => drillVendor(v.vendor))}>
                    <span className="rk-ico" style={{ background: 'rgba(124,58,237,0.10)', color: '#7C3AED' }}>{initials(v.vendor)}</span>
                    <span className="rk-name" title={v.vendor}>{trunc(v.vendor, 26)}</span>
                    <span className="rk-val">{formatCurrency(v.total)}</span>
                  </div>
                ))}
                {topVend.length === 0 && <div className="muted-note">No active POs.</div>}
              </div>
              <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }} onClick={go('vendors')}>View all vendors →</button>
            </div>
            )}

            {/* The sub names the demo split rather than leaving a muted bar to
                explain itself — it is the one row on this card that is in the
                total but not in the business. */}
            <ChartCard className={hide('overview.topVendors') ? "g12-6" : "g12-4"} title="Sales Orders by Program"
              sub={`${so.count} orders · click a program to filter${(so.piva.DEMO?.count ?? 0) > 0 ? ` · includes ${so.piva.DEMO.count} DEMO / test` : ''}`}>
              <div className="card-body">
                <BarList data={programBars} money={false}
                  onSelect={(name) => setProg((p) => {
                    const key = name === 'Tri-Care' ? 'TriCare' : name;
                    return p === key ? 'All' : (key === 'PI' || key === 'VA' || key === 'TriCare' ? key : p);
                  })} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">{prog === 'All' ? 'Total Orders' : `${PROG_LABEL[prog]} Orders`}</div><div className="v">{soCount.toLocaleString()}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Programs</div><div className="v accent">{programBars.length || '-'}</div></div>
              </div>
            </ChartCard>

            {!hide('overview.poSpendTop5') && (
            <ChartCard className="g12-4" title="PO Spend by Vendor (Top 5)" sub="Committed spend · active POs only">
              <div className="card-body">
                <BarList data={vendorBars} showPct={false} onSelect={go('tracking')} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Spend</div><div className="v">{formatCurrency(po.totalValue)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Active POs</div><div className="v accent">{po.count.toLocaleString()}</div></div>
              </div>
            </ChartCard>
            )}

            <div className={`section chart-card ${hide('overview.exceptions') ? 'g12-6' : 'g12-8'}`}>
              <div className="section-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <h2 className="section-title">Financial Insights</h2>
                  <div className="section-sub">
                    {qLabel} · balances are as of today
                    {/* Says why a quarter is absent. Without this the picker
                        just skips it, which reads as a filter that failed
                        rather than as a period with nothing in it. */}
                    {missingQ.length > 0 && firstMonth && (
                      <> · {missingQ.map((q) => `Q${q + 1}`).join(', ')} not shown: no invoices, bills or payments
                      before {new Date(`${firstMonth}-01T00:00:00`).toLocaleString(undefined, { month: 'short', year: 'numeric' })}</>
                    )}
                  </div>
                </div>
                {/* Only quarters with activity are offered, so the picker
                    cannot land on an empty one. */}
                <div className="ins-qtabs">
                  {qOptions.map((q) => (
                    <button key={String(q)} className={`ins-qtab${activeQ === q ? ' on' : ''}`}
                      onClick={() => setQPick(q)}>
                      {q === 'fy' ? `FY${fy}` : `Q${q + 1}`}
                    </button>
                  ))}
                </div>
              </div>
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

            {!hide('overview.exceptions') && (
            <ChartCard className="g12-4" title="Exceptions" sub={`${exc?.totalOpen ?? 0} data-quality items`}
              right={<button className="card-link" style={{ marginTop: 0 }} onClick={go('exceptions')}>View all →</button>}>
              {excGroups.length ? (
                <div className="exc-list">
                  {excGroups.map((g) => (
                    <div key={g.key} className="exc-row" style={{ cursor: 'pointer' }} {...clickableProps(go('exceptions'))}>
                      <span className={`exc-badge ${g.severity}`}>{g.count}</span>
                      <span className="exc-title" title={g.title}>{g.title}</span>
                      <span className="exc-val">{g.value ? formatCurrency(g.value) : ''}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="qb-placeholder"><span className="qb-icon">✓</span>No open exceptions</div>}
            </ChartCard>
            )}
          </div>

          {/* ORDER STATUS BY STRIVEN LABEL — Company board only. Striven's exact
              wording, so this reads as the tag list staff maintain rather than
              as another interpretation of it. Click a label to list its orders. */}
          {labelStats.rows.length > 0 && (
            <ChartCard title="Order status by Striven label"
              sub={`${labelStats.orders.toLocaleString()} order${labelStats.orders === 1 ? '' : 's'} · ${labelStats.rows.length} label${labelStats.rows.length === 1 ? '' : 's'} in use · ${PROG_LABEL[prog]}`}
              right={(
                <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* Vertical segmentation. Hidden when the board's Program
                      filter is already set — two controls answering the same
                      question is how they end up disagreeing. */}
                  {prog === 'All' && labelStats.verts.length > 1 && (
                    <span className="ins-qtabs">
                      {labelStats.verts.map((v) => (
                        <button key={v} className={`ins-qtab${labelVert === v ? ' on' : ''}`} onClick={() => setLabelVert(v)}>
                          {v === 'All' ? 'All verticals' : v}
                        </button>
                      ))}
                    </span>
                  )}
                  <span className="ins-qtabs">
                    <button className={`ins-qtab${labelScope === 'all' ? ' on' : ''}`} onClick={() => setLabelScope('all')}>All orders</button>
                    <button className={`ins-qtab${labelScope === 'done' ? ' on' : ''}`} onClick={() => setLabelScope('done')}>Completed only</button>
                  </span>
                </span>
              )}>
              <div className="lbl-grid">
                {labelStats.rows.map((r) => (
                  <button key={r.label} className="lbl-cat" onClick={() => drillLabel(r.label)}
                    title={[`${r.label} · ${r.n} order${r.n === 1 ? '' : 's'} · ${formatCurrency(r.value)}`,
                      labelScope === 'all' ? `${r.done} completed` : '',
                      [...r.byVert.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(' · '),
                    ].filter(Boolean).join(' · ')}>
                    <span className="lbl-main">
                      <span className="pi-label" style={{ ['--lc' as string]: labelTone(r.label) }}>{r.label}</span>
                      <span className="n">{r.n}</span>
                      <span className="v">{formatCurrency(r.value)}</span>
                    </span>
                    {/* Vertical split for this label. Only when viewing all
                        verticals — under a single one it would draw a full bar
                        in a single colour, which states nothing. */}
                    {vertPick === 'All' && r.byVert.size > 1 && (
                      <span className="lbl-vert">
                        {[...r.byVert.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                          <span key={v} title={`${v}: ${n}`} style={{ width: `${(n / r.n) * 100}%`, background: VERTICAL_COLORS[v] ?? C.muted }} />
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="lbl-note">
                {/* Both caveats stated rather than left to be discovered: an
                    order can hold several labels, and some hold none. */}
                An order can carry more than one label, so the counts above sum to more than {labelStats.orders.toLocaleString()}.
                {/* THE UNTAGGED ORDERS ARE OPENABLE. This was a bare sentence —
                    a count of the one group that actually needs working through,
                    with no way to see which orders it meant. Every other number
                    on this card opens its list; so does this one now. */}
                {labelStats.untagged > 0 && (
                  <>
                    {' '}
                    <button type="button" className="lbl-untagged" onClick={() => drillLabel(NO_LABEL)}
                      title="List these orders — they carry no Striven label, so no pipeline can place them past stage 1">
                      <b>{labelStats.untagged.toLocaleString()}</b> order{labelStats.untagged === 1 ? '' : 's'}
                      {' '}({formatCurrency(labelStats.untaggedValue)}) carr{labelStats.untagged === 1 ? 'ies' : 'y'} no label at all
                    </button>
                    {' — click to see them.'}
                  </>
                )}
              </div>
            </ChartCard>
          )}

          {/* UNITS BY DEVICE — kept at the FOOT of the board. It is a
              reference list rather than a headline: you come to it once you
              have a question about the mix, not on the way in. The cards above
              answer "how are we doing"; this answers "made of what". */}
          {!hide('overview.devices') && devMixRows.length > 0 && (
            <ChartCard title="Units by device">
              <UnitsByDevice
                rows={devMixRows}
                subtitle={`${devMixTotal.toLocaleString()} units across ${devMixRealRows} device${devMixRealRows === 1 ? '' : 's'} · ${PROG_LABEL[prog]}${devMixDemoUnits > 0 ? ` · plus ${devMixDemoUnits} demo unit${devMixDemoUnits === 1 ? '' : 's'} across ${demoOrders} DEMO order${demoOrders === 1 ? '' : 's'}, listed separately` : ''}`}
                onOpen={go('orders')}
              />
            </ChartCard>
          )}
        </>
      )}

      {drill && <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
