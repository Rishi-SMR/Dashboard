import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenBillPayments,
  fetchStrivenOrders, fetchStrivenExceptions, fetchCommission, fetchApLedger,
  type ArResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type BillPaymentsResult,
  type OrdersResult, type ExceptionsResult, type CommissionResult, type ApLedger,
} from '../strivenApi';
import { formatCurrency, clickableProps, isCancelledStatus, isCompletedStatus } from '../format';
import { C, SERIES, CAT6, VERTICAL_COLORS, compactMoney, monthLabel, programOfPayer, type Program } from '../chartTheme';
import { sectionHref } from '../guideTrail';
import { arDueParts } from '../arDue';
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
import { fetchDeviceMix, fetchMe, fetchMasterFileAp, fetchArCei, fetchPiLienstar, fetchVaRemittances, type DeviceMixRow, type MasterFileAp, type ArCei, type PiLienstar, type VaRemittances } from '../strivenApi';
import { useHidden, useViewProfile, setViewProfile, isKevinLogin, PROFILE_LABEL, type ViewProfile } from '../viewProfile';
import { BusinessGrowth } from './BusinessGrowth';

const trunc = (v: string, n = 22) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-');
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '•';
const PROG_LABEL: Record<string, string> = { All: 'All programs', PI: 'PI', VA: 'VA', TriCare: 'Tri-Care', DOL: 'DOL' };

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
  // The AP ledger sheet — the real payables book. See `apOpenF` below.
  const [apLedger, setApLedger] = useState<ApLedger | null>(null);
  // AP TOTAL'S SOURCE (1 Oct 2026): Master File For SMR "AP" tab, by vendor,
  // no offsetting - the same figure as the Payables tab's AP Open card.
  const [mfAp, setMfAp] = useState<MasterFileAp | null>(null);
  // Monthly Collection Effectiveness Index, for the CEI tile beside Collection Rate.
  const [cei, setCei] = useState<ArCei | null>(null);
  useEffect(() => { fetchArCei().then(setCei).catch(() => setCei(null)); }, []);
  // PI / VA RECEIVABLE PER THE MASTER FILE, for the AR Due card: invoiced in
  // Striven but not yet funded by Lienstar / remitted by the distributors.
  const [piLien, setPiLien] = useState<PiLienstar | null>(null);
  const [vaRemit, setVaRemit] = useState<VaRemittances | null>(null);
  // Whether the latest attempt FAILED — distinct from still loading, so the card
  // says "Loading…" on a cold start rather than "unavailable".
  const [piLienErr, setPiLienErr] = useState(false);
  const [vaRemitErr, setVaRemitErr] = useState(false);
  // Fetched inside load() below, so they follow the board's 90-second live sync.
  const [arView, setArView] = useState<'all' | 'ledger' | 'pi' | 'va'>('all');
  const [pl, setPl] = useState<PlResult | null>(null);
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [trends, setTrends] = useState<TrendsResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [orders, setOrders] = useState<OrdersResult | null>(null);
  const [exc, setExc] = useState<ExceptionsResult | null>(null);
  const [comm, setComm] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);
  type Drill = { title: string; sub?: string; summary?: ReactNode; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] };
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
      // PI / VA RECEIVABLE PER THE MASTER FILE, refreshed WITH the board. It was
      // fetched once on mount, so a request that failed (e.g. landing during a
      // server restart) left AR Due reading "comparison unavailable" for the
      // life of the tab. Not awaited, like commission; a failed refresh keeps
      // the last good figures rather than blanking them.
      fetchPiLienstar().then((r) => { if (r?.ok) { setPiLien(r); setPiLienErr(false); } else setPiLienErr(true); }).catch(() => setPiLienErr(true));
      fetchVaRemittances().then((r) => { if (r?.ok) { setVaRemit(r); setVaRemitErr(false); } else setVaRemitErr(true); }).catch(() => setVaRemitErr(true));
      const [a, p, s, o, t, pay, ord, ex, apl, mf] = await Promise.all([
        fetchStrivenAR(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(),
        fetchStrivenOrders().catch(() => null), fetchStrivenExceptions().catch(() => null),
        // THE AP BOOK, for the same reason the Payables tab reads it: vendor
        // bills are tracked by hand in this sheet and only a handful ever reach
        // Striven, so Striven's four open bills are not the payable. AP is
        // read from this sheet ONLY (1 Oct 2026): unreachable means no AP
        // figure, never Striven's. Still never fails the rest of the board.
        fetchApLedger().catch(() => null),
        fetchMasterFileAp().catch(() => null),
      ]);
      setAr(a); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay);
      setOrders(ord); setExc(ex); setApLedger(apl); setMfAp(mf);
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
  // THE FISCAL YEAR FOLLOWS THE AS-OF DATE. Its picker is gone from the header:
  // the data covers one year, so the control could never switch to another, and
  // sitting beside Period it read as a second live scope while contributing
  // nothing. `fy` is still needed — Period's "Fiscal year" option scopes by it,
  // and the quarters card and the insights line label themselves with it — so it
  // is derived rather than picked. Moving As-of into a prior year re-scopes the
  // charts instead of blanking them, which is what the picker was for.
  const asOfYear = asOfStr.slice(0, 4);
  const fy = years.includes(asOfYear) ? asOfYear : (years[years.length - 1] ?? String(new Date().getFullYear()));
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

  /**
   * DO THE BALANCE CARDS FOLLOW THE PERIOD? No — they are a snapshot.
   *
   * A BALANCE is not a flow. "What are we owed" has one answer at any moment,
   * and slicing it by due month answers a different question — "what falls due
   * in September" — which is a collections question, not a position. The two
   * were being read as the same thing: the board showed $225,340 owed while the
   * AR page showed $307,765, and neither said which question it had answered.
   *
   * FLOWS STILL FOLLOW THE PERIOD, and should: revenue, cash received and the
   * monthly charts are all "in this month" by nature. Only the balance cards —
   * Open balances, Position summary, AR Expected, AP Due, and the commission
   * they net against — read the whole book.
   *
   * ONE FLAG so the decision is visible and reversible. Flip it to `true` and
   * every balance card goes back to following the Period control, captions and
   * titles included.
   */
  const BALANCES_FOLLOW_PERIOD = false;
  /** Period scoping AS IT APPLIES TO A BALANCE — the flag, and then the period. */
  const balScoped = BALANCES_FOLLOW_PERIOD && periodScoped;

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
    // Commission is netted against AR and AP on the Position summary, so it has
    // to be on their basis or the "net position" mixes a month against a book.
    const inScope = (l: Line) => !balScoped || (Boolean(l.date) && inFy(String(l.date).slice(0, 7)));
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
    const undated = balScoped
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
  const balanceScopeLabel = balScoped ? `due in ${periodLabel}` : 'as of today';
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
  // NOW THE MASTER FILE'S PAYMENTS (1 Oct 2026): the same rows that make Paid
  // to Date everywhere else, dated by their Payment Date. The AP ledger only if
  // the Master File cannot be read; Striven's bill payments are not used.
  const vendorCashOut: { date: string | null; amount: number }[] =
    mfAp?.ok && (mfAp.payments?.length ?? 0) > 0
      ? mfAp.payments!.map((p) => ({ date: p.date || null, amount: p.amount }))
      : (apLedger?.payments ?? []).map((p) => ({ date: p.date, amount: p.amount }));
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
    && (!BALANCES_FOLLOW_PERIOD || inPeriodDate(i.dueDate)));
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
  // THE BILL BOOK IS THE MASTER FILE'S (1 Oct 2026): the same bills the AP
  // Register lists, so every bill-level figure on this board - Oldest bill,
  // due soon, the dues card - agrees with it. The AP Ledgers sheet only when
  // the Master File cannot be read; never Striven.
  const mfBills = (mfAp?.ok ? mfAp.bills : null) ?? null;
  const apLedgerBills = mfBills ?? ((apLedger?.ok ? apLedger.bills : null) ?? null);
  const apBook = apLedgerBills
    ? apLedgerBills
      .filter((b) => b.kind !== 'cancelled' && Math.abs(b.open) > 0.005)
      .map((b) => ({ number: String(b.no), vendor: b.subLedger || '-', dueDate: b.due || null, open: b.open }))
    : [];   // no Striven fallback - AP is the sheet's only
  const apBookScoped = apBook.filter((b) => !BALANCES_FOLLOW_PERIOD || inPeriodDate(b.dueDate));
  const apOpenF = apBookScoped.reduce((s, b) => s + b.open, 0);
  // A credit note is money off the payable but nobody works it off a worklist,
  // so it counts toward the TOTAL and not toward the COUNT — the same split the
  // AP Register makes, which is why the two agree.
  const apBillCount = apBookScoped.filter((b) => b.open > 0).length;
  // THE AP TOTAL every card on this board shows: the Master File's vendor
  // balances (billed − paid, no offsetting), the same figure as Payables'
  // AP Open. Falls back to the ledger's bill total only if that tab cannot be
  // read, so the board is never blank. Bill-level views read `apBook` above,
  // which is the Master File's bills too.
  const mfOk = Boolean(mfAp?.ok);
  const mfOwed = (mfAp?.vendors ?? []).filter((v) => v.owed > 0);
  const apTotal = mfOk ? (mfAp!.apOpen ?? 0) : apOpenF;
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

  // ── THE COMPLETE RECEIVABLE (3 Oct 2026, on request) ───────────────────────
  // Three books, each used ONLY for the programme it is the authority on, so
  // nothing is counted twice:
  //   PI     invoiced in Striven − funded by Lienstar (Master File, Approved)
  //   VA     invoiced in Striven − remitted by the distributors (Master File)
  //   others the Striven ledger's open balance (TriCare, DOL, unassigned, …)
  // The ledger's own PI and VA balances are deliberately NOT added: those same
  // invoices are already inside the first two lines, judged against the money
  // that actually arrived rather than against Striven's payment records.
  const recvPi = piLien?.ok ? piLien.receivable ?? null : null;
  const recvVa = vaRemit?.ok ? vaRemit.receivable ?? null : null;
  const progOfInv = (i: { vertical?: string; payer?: string | null }) => i.vertical || programOfPayer(i.payer);
  const ledgerOther = arInv.filter((i) => i.open > 0 && !['PI', 'VA'].includes(progOfInv(i)));
  const ledgerOtherSum = ledgerOther.reduce((s, i) => s + i.open, 0);
  // ── ONE AR DUE FIGURE FOR THE WHOLE BOARD (5 Oct 2026, on request) ─────────
  // AR Due, AR Expected, Open Balances (subtitle and donut slice) and Collection
  // Rate's "Outstanding" all read THIS, so they can no longer disagree. It is
  // the complete receivable: PI per Lienstar + VA per remittances + every other
  // programme from the Striven ledger. (Supersedes 3 Oct's ledger-free AR
  // Expected, by decision: the other programmes are real receivables.)
  // Follows the Program filter: PI or VA alone shows that programme's line, and
  // `ledgerOther` is already cut to the filter by `arInv`.
  const expPi = prog === 'All' || prog === 'PI' ? recvPi : null;
  const expVa = prog === 'All' || prog === 'VA' ? recvVa : null;
  // From the shared helper, the same call the Receivables tab's AR Open makes.
  const arDueTotal = arDueParts(piLien, vaRemit, arInv, prog).total;
  const recvTotal = arDueTotal;
  const arExp = arDueTotal;
  const arExpDetail = (() => {
    const part = (rows: { received: number; outstanding: number }[] | undefined, partial: boolean) =>
      (rows ?? []).filter((r) => (r.received > 0.005) === partial).reduce((s, r) => s + r.outstanding, 0);
    const segs = [
      { name: 'PI · not funded', value: part(expPi?.rows, false), color: VERTICAL_COLORS.PI },
      { name: 'PI · part funded', value: part(expPi?.rows, true), color: '#6B8BD6' },
      { name: 'VA · nothing remitted', value: part(expVa?.rows, false), color: VERTICAL_COLORS.VA },
      { name: 'VA · part remitted', value: part(expVa?.rows, true), color: '#7CC79A' },
      // The rest of AR Due: programmes the Master File does not cover.
      { name: 'Other programmes · Striven', value: ledgerOtherSum, color: C.muted },
    ].filter((x) => x.value > 0.005);
    const invoiced = (expPi?.invoiced ?? 0) + (expVa?.invoiced ?? 0);
    const received = (expPi?.received ?? 0) + (expVa?.received ?? 0);
    const all = [...(expPi?.rows ?? []), ...(expVa?.rows ?? [])].sort((a, b) => b.outstanding - a.outstanding);
    return { segs, invoiced, received, top: all[0] ?? null, cases: all.length };
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
    // Same figure as the AR Expected card — the Master File receivable.
    { name: 'AR Expected', value: arExp, color: HUE.ar.to },
    { name: 'AP Due', value: apTotal, color: HUE.ap.to },
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
        { name: 'Due', value: b.current, color: C.positive },
        { name: 'Overdue 1–30d', value: b.d30, color: C.warning },
        { name: 'Overdue 31–60d', value: b.d60, color: '#EA580C' },
        { name: 'Overdue 60d+', value: b.d90, color: C.negative },
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
        { name: 'Due', value: k.current, color: C.positive },
        { name: 'Overdue 1–30d', value: k.d30, color: C.warning },
        { name: 'Overdue 31–60d', value: k.d60, color: '#EA580C' },
        { name: 'Overdue 60d+', value: k.d90, color: C.negative },
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
  // `payable` and `lines` are the same owed lines, so the tile's total is what
  // the list beneath it adds up to — and the list is what someone checks the
  // total against. This matches commDue.payable above, which is also unscoped
  // (balances do not follow the period: BALANCES_FOLLOW_PERIOD).
  //
  // NOT CUT TO THE PERIOD ANY MORE (3 Oct 2026, on request). The card answers
  // "what is due to be paid", and the sheet answers that by PAYOUT CYCLE, not by
  // when an order was booked. Cutting by order date showed October's $3,250 —
  // five lines, four of them 30 Sep orders keyed in on 1 Oct — while the sheet
  // had $79,212.69 owed in the 15 Oct run. Every owed line counts, whatever the
  // Period filter says; the sub names the payout run instead.
  const commRows = (() => {
    const roster = new Set(comm?.roster ?? []);
    return (comm?.striven?.byRep ?? []).map((r) => {
      const owed = (r.lines ?? []).filter((l) => l.state !== 'paid');
      return {
        rep: r.rep,
        payable: (r.lines ?? []).length
          ? Math.round(owed.reduce((a, l) => a + (l.comm ?? 0), 0) * 100) / 100
          : (r.payableTotal ?? 0),
        orders: r.orders ?? 0,
        units: r.units ?? 0,
        pi: r.pi ?? 0, va: r.va ?? 0, tricare: r.tricare ?? 0, dol: r.dol ?? 0,
        onRoster: roster.size ? roster.has(r.rep) : true,
        // The drill lists the SAME lines the figure was built from, so opening a
        // rep can never show orders from outside the period on screen.
        lines: owed.map((l) => ({
          ref: l.ref, patient: l.patient ?? '', item: l.item ?? '', prog: l.prog ?? '', comm: l.comm ?? 0,
        })),
      };
    }).filter((r) => r.payable > 0);
  })();
  // The payout run(s) the owed lines belong to, off the sheet's own cycle text
  // ("Paid ~10/15/2026" → "15 Oct 2026"), so the card says WHEN it is due.
  const commPayRuns = (() => {
    const runs = new Set<string>();
    for (const r of comm?.striven?.byRep ?? []) for (const l of r.lines ?? []) {
      if (l.state === 'paid') continue;
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(l.cycle ?? ''));
      if (m) runs.add(new Date(+m[3], +m[1] - 1, +m[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
    }
    return [...runs];
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
  const [labelVert, setLabelVert] = useState<'All' | 'PI' | 'VA' | 'TriCare' | 'DOL'>('All');
  const vertPick: string = prog !== 'All' ? prog : labelVert;
  const LABEL_VERTS = ['All', 'PI', 'VA', 'TriCare', 'DOL'] as const;
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
          : <span style={{ color: C.muted }}>-</span>,
        type: o.type,
        rep: o.rep || '-',
        status: o.status,
        // An em dash, not an empty cell: on the no-label drill every row would
        // otherwise be blank here and read as a rendering fault rather than as
        // the very fact the drill was opened to show.
        labels: (o.labels ?? []).length
          ? (o.labels ?? []).join(', ')
          : <span style={{ color: C.muted }}>-</span>,
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
  const soCount = so ? (prog === 'All' ? so.count : (so.piva[prog === 'Unassigned' ? 'Other' : prog]?.count ?? 0)) : 0;

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
  if (overdue.length) acItems.push({ n: String(overdue.length), l1: 'Overdue invoices (Striven)', l2: formatCurrency(overdueSum), view: 'receivables', ico: '!' });
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
  // click handler below already ignores anything that is not PI / VA / TriCare
  // / DOL, so the bar is inert by construction rather than by a second rule.
  const programBars = so ? ([
    { key: 'PI', name: 'PI', ...so.piva.PI, color: SERIES[0] },
    { key: 'VA', name: 'VA', ...so.piva.VA, color: SERIES[1] },
    { key: 'TriCare', name: 'Tri-Care', ...so.piva.TriCare, color: SERIES[2] },
    // Absent from a payload cached before DOL existed, hence the guard.
    ...((so.piva.DOL?.count ?? 0) > 0 ? [{ key: 'DOL', name: 'DOL', ...so.piva.DOL, color: VERTICAL_COLORS.DOL }] : []),
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


  // ---- click-through drills: every list/donut leads to its underlying rows ----
  // Every open invoice for one payer. Mirrors drillApBill.
  const drillArPayer = (payer: string) => setDrill({
    title: payer || 'Payer', sub: 'Open invoices for this payer',
    // Same PATIENT column the Due drills carry, for the same reason: a list of
    // invoice numbers and dates names no case, and this is the other place on
    // the board where one payer's invoices are read one by one.
    columns: [{ key: 'n', label: 'Invoice' }, { key: 'p', label: 'Patient' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
    rows: arInv.filter((i) => i.open > 0 && (i.payer || '-') === payer)
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
      .map((i) => ({ n: `#${i.number}`, p: i.patient || i.customer || '-', d: shortDate(i.dueDate), o: formatCurrency(i.open) })),
  });
  // drillApBucket ("AP Aging · 31–60") went with the donut that opened it.
  // drillApBill() went with the AP Due list it belonged to. Per-bill detail for
  // a vendor now lives on the Payables tab, which the AP Due card links to.
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

  const ready = ar && pl && payments && so && po && trends;
  // Kevin's board shows Units by device beside Financial Insights rather than
  // at the foot of the page. One flag, so the two placements cannot both render.
  // Last two COMPLETED months of CEI (the running month is never scored).
  const ceiDone = (cei?.months ?? []).filter((mo) => !mo.inProgress && mo.cei != null);
  const ceiLast = ceiDone[ceiDone.length - 1] ?? null;
  const ceiPrev = ceiDone[ceiDone.length - 2] ?? null;
  const kevinUnits = kevinLook && !hide('overview.devices') && devMixRows.length > 0;

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
        <label className="ov-filter"><span className="fl">Program</span>
          <select value={prog} onChange={(e) => setProg(e.target.value as 'All' | Program)}>
            <option value="All">All</option>
            <option value="PI">PI</option>
            <option value="VA">VA</option>
            <option value="TriCare">Tri-Care</option>
            <option value="DOL">DOL</option>
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
          {/* RECEIVABLES AND DUES THIS MONTH WAS HERE, and is gone on request
              (3 Oct 2026): the Overdue / Due today / Due within 7 days / Later
              this month split of receivables and vendor bills. The same balances
              are still on the AR Due and AP Due cards and on Receivables and
              Payables. */}

          {/* BUSINESS GROWTH (2 Oct 2026, on
              request). The company's own trajectory, month by month, added
              to this board on request (it already sits on the team dashboard).
              It reads the P&L for BOTH revenue and net profit, so its margin is
              the statement's own; the Revenue vs Expense card below is the
              STRIVEN book over the selected period, which is a different set of
              documents. Two cards, two books, each saying which it is.

              Hideable like every other panel here, so a profile can drop it
              without touching this file. */}
          {/* YET TO BE INVOICED IS OFF BOTH BOARDS (5 Oct 2026, on request).
              It sat beside Business growth on Kevin's board and beside
              Financial Insights on Crystal's; Business growth takes its row
              and Financial Insights the full width. The same orders are still
              listed on Receivables and in the PI Invoice Book. */}
          {!hide('overview.growth') && <BusinessGrowth />}

          <div className="exec-grid12">
            {/* COMMISSION, INTERACTIVE. Replaces the flat tile: same headline,
                but ranked by rep with a drill into programme split and the
                orders behind it. The tile above is gone — two copies of the
                same number would only invite them to disagree. */}
            {commRows.length > 0 && (
              // The heading follows the state. With the book settled there is
              // no rep row to click, and a sub inviting a click that does
              // nothing is how a card that is working reads as one that is not.
              <ChartCard className="g12-3" title={commRows.every((r) => r.payable <= 0) ? 'Commission' : 'Commission Due'}
                sub={commRows.every((r) => r.payable <= 0)
                  ? 'Nothing outstanding to any rep'
                  : `Owed per the commission sheet${commPayRuns.length ? ` · due in the ${commPayRuns.join(' / ')} payout` : ''} · click a rep for their split and orders`}>
                <CommissionBreakdown reps={commRows} onOpen={go('commission')} paidThrough={comm?.striven?.paidThrough} />
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
            {/* AR DUE + AP DUE moved up here, into the slots Open balances and
                Position summary held (2 Oct 2026, on request); those two moved
                down to where these were. */}
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
                <div className="section-sub">
                  {arView === 'all' ? 'Complete receivable · PI per Lienstar · VA per remittances · others per Striven'
                    : arView === 'pi' ? 'PI invoiced in Striven, not yet funded by Lienstar (Approved = funded)'
                      : arView === 'va' ? 'VA invoiced in Striven, not yet remitted (Master File)'
                        : `Striven open invoices · ${PROG_LABEL[prog]} · ${balanceScopeLabel}`}
                </div>
              </div></div>
              {/* FOUR VIEWS OF ONE QUESTION — what is owed to us. "All" is the
                  complete receivable; the other three are its parts' detail. */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                {([['all', 'All'], ['ledger', 'Striven ledger'], ['pi', 'PI · Lienstar'], ['va', 'VA · Remit']] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`ins-qtab${arView === k ? ' on' : ''}`} onClick={() => setArView(k)}>{label}</button>
                ))}
              </div>
              {arView === 'all' && (
                <div className="rank-list is-scroll">
                  {[
                    { k: 'pi' as const, ico: 'PI', name: 'PI · not funded by Lienstar', sub: recvPi ? `${recvPi.count} case${recvPi.count === 1 ? '' : 's'} · ${formatCurrency(recvPi.invoiced)} invoiced` : piLienErr ? 'Master File unavailable · retrying' : 'Loading the Master File…', v: recvPi?.outstanding ?? 0, tint: VERTICAL_COLORS.PI },
                    { k: 'va' as const, ico: 'VA', name: 'VA · not remitted', sub: recvVa ? `${recvVa.count} patient${recvVa.count === 1 ? '' : 's'} · ${formatCurrency(recvVa.invoiced)} invoiced` : vaRemitErr ? 'Master File unavailable · retrying' : 'Loading the Master File…', v: recvVa?.outstanding ?? 0, tint: VERTICAL_COLORS.VA },
                    { k: 'ledger' as const, ico: 'ST', name: 'Other programmes · Striven', sub: `${ledgerOther.length} open invoice${ledgerOther.length === 1 ? '' : 's'} · TriCare, DOL, unassigned`, v: ledgerOtherSum, tint: C.muted },
                  ].map((r) => (
                    <div key={r.k} className="rk-row" style={{ cursor: 'pointer' }} {...clickableProps(() => setArView(r.k))}>
                      <span className="rk-ico" style={{ background: `${r.tint}1A`, color: r.tint }}>{r.ico}</span>
                      <span className="rk-name" title={r.name}>
                        {r.name}
                        <span style={{ display: 'block', fontSize: 10.5, color: C.muted, fontWeight: 600 }}>{r.sub}</span>
                      </span>
                      <span className="rk-val">{formatCurrency(r.v)}</span>
                    </div>
                  ))}
                  <div className="muted-note" style={{ marginTop: 6 }}>
                    Striven's own PI and VA open balances are not added — those invoices are already counted above, against the money that actually arrived.
                    {(recvPi?.overFunded ?? 0) + (recvVa?.overRemitted ?? 0) > 0 && <> Received above invoiced (not netted): {formatCurrency((recvPi?.overFunded ?? 0) + (recvVa?.overRemitted ?? 0))}.</>}
                  </div>
                </div>
              )}
              {(arView === 'pi' || arView === 'va') && (
                <div className="rank-list is-scroll">
                  {(arView === 'pi' ? recvPi?.rows ?? [] : recvVa?.rows ?? []).map((r, i) => (
                    <div key={`${r.patient}-${i}`} className="rk-row"
                      title={`${r.patient} · invoiced ${formatCurrency(r.invoiced)} · received ${formatCurrency(r.received)}`}>
                      <span className="rk-ico" style={{ background: 'rgba(13,148,136,0.10)', color: '#0D9488' }}>{initials(r.patient || '-')}</span>
                      <span className="rk-name">
                        {trunc(r.patient || '-', 20)}
                        <span style={{ display: 'block', fontSize: 10.5, color: r.received > 0 ? C.warning : C.negative, fontWeight: 600 }}>
                          {r.reason}{r.received > 0 ? ` · ${formatCurrency(r.received)} in` : ''}
                        </span>
                      </span>
                      <span className="rk-val">{formatCurrency(r.outstanding)}</span>
                    </div>
                  ))}
                  {(arView === 'pi' ? !recvPi : !recvVa) && (
                    <div className="muted-note">
                      {(arView === 'pi' ? piLienErr : vaRemitErr)
                        ? 'Master File comparison unavailable - retrying automatically every 90 seconds.'
                        : 'Loading the Master File comparison… (the first load after a restart takes up to ~15 seconds)'}
                    </div>
                  )}
                  {(arView === 'pi' ? recvPi?.rows.length === 0 : recvVa?.rows.length === 0) && <div className="muted-note">Nothing outstanding.</div>}
                </div>
              )}
              {/* `is-scroll`: this list is not sliced, so it caps its own height
                  and scrolls rather than stretching the cards beside it. */}
              {arView === 'ledger' && (
              <div className="rank-list is-scroll">
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
              )}
              <div className="cfoot" style={{ marginTop: 'auto' }}>
                {arView === 'all' ? (<>
                  <div className="cf-i"><div className="l">Complete receivable</div><div className="v">{formatCurrency(recvTotal)}</div></div>
                </>) : arView === 'ledger' ? (<>
                  <div className="cf-i"><div className="l">Total due</div><div className="v">{formatCurrency(arOpenF)}</div></div>
                  <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Invoices</div><div className="v accent">{arInv.length}</div></div>
                </>) : (<>
                  <div className="cf-i"><div className="l">{arView === 'pi' ? 'Not funded' : 'Not remitted'}</div><div className="v">{formatCurrency((arView === 'pi' ? recvPi?.outstanding : recvVa?.outstanding) ?? 0)}</div></div>
                  <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">{arView === 'pi' ? 'Cases' : 'Patients'}</div><div className="v accent">{(arView === 'pi' ? recvPi?.count : recvVa?.count) ?? 0}</div></div>
                </>)}
              </div>
              <button className="card-link" onClick={go('receivables')}>Open receivables →</button>
            </div>

            {/* AP DUE — same bands as AR, so "what we are owed" and "what we
                owe" can be read against each other rather than in isolation. */}
            {(mfOk ? mfOwed.length > 0 : apBillCount > 0) && (
              <ChartCard className="g12-4" title="AP Due"
                sub={mfOk ? 'Owed by vendor · Master File · no offsetting' : `Open bills · ${balanceScopeLabel}${apLedgerBills ? ' · AP ledger' : ''}`}>
                {/* apBillCount, not ap.count: the value is the ledger's, and
                    pairing it with Striven's four made this card contradict
                    itself inside a single sentence. */}
                {mfOk ? (
                <MetricDetail
                  value={apTotal} format={formatCurrency}
                  sub={<>owed to {mfOwed.length} vendor{mfOwed.length === 1 ? '' : 's'}
                    {/* Due vs Overdue, by each open bill's due date. */}
                    {' · '}bills <b style={{ color: C.info }}>{formatCurrency(apDetail.rail[0].value)}</b> due,
                    {' '}<b style={{ color: C.negative }}>{formatCurrency(apDetail.overdue)}</b> overdue
                    {(mfAp!.billsRequired ?? 0) > 0 && <> · <b style={{ color: C.warning }}>{formatCurrency(mfAp!.billsRequired ?? 0)}</b> bills required (paid more than billed, not netted)</>}</>}
                  rail={mfOwed.map((v, i) => ({ name: v.vendor, value: v.owed, color: [HUE.ap.to, C.warning, '#EA580C', C.negative, C.info, C.brand][i % 6] }))}
                  facts={[
                    ...(mfOwed[0] ? [{
                      label: 'Top vendor',
                      value: `${Math.round((mfOwed[0].owed / Math.max(1, apTotal)) * 100)}%`,
                      note: trunc(mfOwed[0].vendor, 18), title: mfOwed[0].vendor,
                      warn: (mfOwed[0].owed / Math.max(1, apTotal)) > 0.5,
                    }] : []),
                    { label: 'Vendors', value: String(mfOwed.length), note: 'owed now' },
                    { label: 'Bills req.', value: formatCurrency(mfAp!.billsRequired ?? 0), note: 'overpaid vendors', warn: (mfAp!.billsRequired ?? 0) > 0 },
                  ]}
                />
                ) : (
                <MetricDetail
                  value={apOpenF} format={formatCurrency}
                  sub={<>across {apBillCount} unpaid bill{apBillCount === 1 ? '' : 's'}
                    {apDetail.overdue > 0 && <> · <b style={{ color: C.warning }}>{formatCurrency(apDetail.overdue)}</b> already overdue</>}</>}
                  rail={apDetail.rail}
                  facts={[
                    { label: 'Oldest', value: apDetail.oldest > 0 ? `${apDetail.oldest}d` : '-', note: 'past due', warn: apDetail.oldest > 30 },
                    ...(apDetail.top ? [{
                      label: 'Top vendor',
                      value: `${Math.round((apDetail.top.value / Math.max(1, apOpenF)) * 100)}%`,
                      note: trunc(apDetail.top.name, 18), title: apDetail.top.name,
                      warn: (apDetail.top.value / Math.max(1, apOpenF)) > 0.5,
                    }] : []),
                    { label: 'Vendors', value: String(apDetail.vendors), note: 'owed now' },
                  ]}
                />
                )}
              </ChartCard>
            )}

            {/* PI · STRIVEN VS LIENSTAR and VA · STRIVEN VS REMITTANCES ARE OFF
                THIS BOARD (5 Oct 2026, on request). They took a full-width row
                each under AR Due / AP Due. The comparisons themselves still
                feed AR Due and the AR Register; the cards are kept in
                PiLienstarCard.tsx / VaRemittanceCard.tsx, unmounted. */}

            {/* OPEN BALANCES sits where Units by programme was (2 Oct 2026, on
                request); Units by programme moved down beside Position summary.
                THE PERIOD IS IN THE TITLE, not only in the sub-line. A card
                headed "Open balances" under a header showing FY2026 reads as the
                whole year; it is September's, and the sub-line saying so was
                being missed. See periodLabel. */}
            {donutSlices.length > 0 && (
              <ChartCard className="g12-3" title={`Open balances${balScoped ? ` · ${periodLabel}` : ''}`}
                sub={`${formatCurrency(arDueTotal)} owed to us (AR Due) · ${formatCurrency(apTotal + commDue.payable)} owed out`}>
                <DonutList data={donutSlices} totalLabel="Total outstanding"
                  onSelect={(n) => { location.hash = n === 'AR Expected' ? 'receivables' : n === 'AP Due' ? 'payables' : 'commission'; }} />
              </ChartCard>
            )}
            {/* AR EXPECTED, IN DETAIL. The tile said "$35,076 · 11 unpaid",
                which is a number without a risk attached. This adds the three
                things that change what you do about it: how overdue it is, how
                much rides on one payer, and what is sitting in unapplied
                credits. */}
            {/* AR EXPECTED IS THE MASTER FILE'S RECEIVABLE NOW (3 Oct 2026, on
                request): PI invoiced and not funded by Lienstar, plus VA
                invoiced and not remitted — AR Due's PI and VA lines. The Striven
                ledger balance (and its ageing, payers and unapplied credits,
                which were all ledger facts) is no longer in this card. */}
            {(recvPi || recvVa) && (
              <ChartCard className="g12-4" title="AR Expected"
                sub={`Invoiced, not yet received · PI per Lienstar · VA per remittances · others per Striven · ${PROG_LABEL[prog]}`}>
                <div className="ard">
                  <div className="ard-top"><AnimatedNumber value={arExp} format={formatCurrency} duration={700} /></div>
                  <div className="ard-sub">
                    {expPi && <>{expPi.count} PI case{expPi.count === 1 ? '' : 's'} <b>{formatCurrency(expPi.outstanding)}</b></>}
                    {expPi && expVa && ' · '}
                    {expVa && <>{expVa.count} VA patient{expVa.count === 1 ? '' : 's'} <b>{formatCurrency(expVa.outstanding)}</b></>}
                    {!expPi && !expVa && <>The Master File covers PI and VA only; nothing to show for {PROG_LABEL[prog]}.</>}
                  </div>

                  {/* What it is made of: per programme, nothing received yet vs
                      partly received — the two call for different follow-up. */}
                  {arExpDetail.segs.length > 0 && (
                    <>
                      <div className="ard-rail">
                        {arExpDetail.segs.map((x, i) => (
                          <span key={x.name} className="seg" title={`${x.name}: ${formatCurrency(x.value)}`}
                            style={{ width: `${(x.value / Math.max(1, arExp)) * 100}%`, background: x.color, animationDelay: `${i * 0.07}s` }} />
                        ))}
                      </div>
                      <div className="ard-key">
                        {arExpDetail.segs.map((x) => (
                          <span key={x.name} className="k">
                            <span className="d" style={{ background: x.color }} />{x.name} <b>{formatCurrency(x.value)}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="ard-facts">
                    <div className="ard-f">
                      <div className="l">Invoiced</div>
                      <div className="v">{formatCurrency(arExpDetail.invoiced)}</div>
                      <div className="n">on these cases</div>
                    </div>
                    <div className="ard-f">
                      <div className="l">Received</div>
                      <div className="v">{arExpDetail.invoiced > 0 ? `${Math.round((arExpDetail.received / arExpDetail.invoiced) * 100)}%` : '-'}</div>
                      <div className="n">{formatCurrency(arExpDetail.received)} in so far</div>
                    </div>
                    {arExpDetail.top && (
                      <div className="ard-f" title={arExpDetail.top.patient}>
                        <div className="l">Largest</div>
                        <div className={`v${(arExpDetail.top.outstanding / Math.max(1, arExp)) > 0.3 ? ' warn' : ''}`}>
                          {Math.round((arExpDetail.top.outstanding / Math.max(1, arExp)) * 100)}%
                        </div>
                        <div className="n">{trunc(arExpDetail.top.patient, 18)}</div>
                      </div>
                    )}
                    {expVa && vaRemit?.remit?.lastPaid && (
                      <div className="ard-f">
                        <div className="l">Last remittance</div>
                        <div className="v">{shortDate(vaRemit.remit.lastPaid)}</div>
                        <div className="n">latest on the VA tab</div>
                      </div>
                    )}
                  </div>

                  <div className="ard-note">
                    Same figure as AR Due.
                    {ledgerOtherSum > 0 && <> {formatCurrency(ledgerOtherSum)} of it is programmes the Master File does not cover (TriCare, DOL, unassigned), from the Striven ledger.</>}
                    {' '}Click AR Due → PI · Lienstar or VA · Remit for the cases.
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
            {/* POSITION SUMMARY WAS HERE, and is gone on request (3 Oct 2026):
                the net of what is owed to us against commission + bills owed
                out. Its parts are still on AR Expected, AP Due and Commission
                Due. */}

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
                    { label: 'Margin', value: fRev > 0 ? `${Math.round(((fRev - fExp) / fRev) * 100)}%` : '-', note: formatCurrency(fRev - fExp) },
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
                    { label: 'Collected', value: collectedPct != null ? `${collectedPct}%` : '-', note: 'of invoiced', warn: collectedPct != null && collectedPct < 60 },
                    { label: 'Avg payment', value: payCountP ? formatCurrency(cashFY / payCountP) : '-', note: 'per payment' },
                    ...(bestCash ? [{ label: 'Best month', value: monthLabel(bestCash.month), note: formatCurrency(bestCash.value) }] : []),
                  ]}
                  note={collectedPct != null && collectedPct > 100
                    ? <>Over 100% because payments in this period settle invoices raised earlier - cash and revenue are not the same cohort.</>
                    : undefined}
                />
              </ChartCard>
            )}

          </div>

          <div className="exec-grid12">
            {/* Kevin's board: Cash Flow, Revenue vs Expense and Sales Orders by
                Program sit across one row with the CEI tile (a quarter each), on request. */}
            <ChartCard className={kevinLook ? "g12-3" : "g12-5"} title="Cash Flow Overview" sub={`Customer payments in vs vendor bill payments out · ${periodLabel}`}>
              {cashData.length > 1 && <LegendDots items={[{ name: 'Cash In', color: C.positive }, { name: 'Cash Out', color: C.negative }, { name: 'Net Cash', color: C.brand }]} />}
              <BarsLine data={cashData}
                bars={[{ key: 'cashIn', name: 'Cash In', color: C.positive }, { key: 'cashOut', name: 'Cash Out', color: C.negative }]}
                line={{ key: 'net', name: 'Net Cash', color: C.brand }} />
              <div className="cfoot">
                <div className="cf-i"><div className="l">Cash In</div><div className="v pos">{formatCurrency(cfIn)}</div></div>
                <div className="cf-i"><div className="l">Cash Out</div><div className="v neg">{formatCurrency(cfOut)}</div></div>
                <div className="cf-i"><div className="l">Net Cash</div><div className="v accent">{formatCurrency(cfIn - cfOut)}</div></div>
              </div>
            </ChartCard>

            <ChartCard className={kevinLook ? "g12-3" : !hide('overview.collectionRate') ? "g12-4" : "g12-7"} title="Revenue vs Expense" sub={`Invoiced revenue vs billed expenses · ${periodLabel}`}>
              {finData.length > 1 && <LegendDots items={[{ name: 'Revenue', color: C.positive }, { name: 'Expense', color: C.negative }, { name: 'Profit', color: C.brand }]} />}
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
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Outstanding (AR Due)</div><div className="v">{formatCurrency(arDueTotal)}</div></div>
              </div>
              <div className="cfoot" style={{ marginTop: 0 }}>
                <div className="cf-i"><div className="l">vs Last Month</div><div className={`v ${cashD ? (cashD.up ? 'pos' : 'neg') : ''}`}>{cashD ? `${cashD.up ? '▲' : '▼'} ${pctText(cashD.pct)}` : '-'}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">PI DSO</div><div className="v">{piDso != null ? `${piDso} days` : '-'}</div></div>
              </div>
            </ChartCard>
            )}

            {/* CEI · SALES ORDERS BY PROGRAM · PO SPEND, one row of three on
                Crystal's board (2 Oct 2026, on request). This zero-height
                full-width spacer forces the line break before CEI, so Cash Flow,
                Revenue vs Expense and Collection Rate keep the row above. Kevin's
                board keeps its own four-across row and does not get the break. */}
            {!kevinLook && <div className="g12-12" aria-hidden style={{ height: 0, margin: 0, padding: 0, border: 0 }} />}
            {/* CEI - the last COMPLETED month's Collection Effectiveness Index,
                beside Collection Rate (2 Oct 2026, on request). Collection Rate
                is this period's cash ÷ invoicing and runs past 100% early in a
                month; CEI only counts what was collectible. Full history is on
                Receivables › AR Overview. */}
            {!hide('overview.cei') && ceiLast && (
            <ChartCard className={kevinLook ? "g12-3" : "g12-4"} title="Collection Effectiveness" guide="Collection Effectiveness Index"
              sub={`CEI · ${new Date(`${ceiLast.month}-01T00:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' })} · last full month`}
              right={<button className="card-link" style={{ marginTop: 0 }} onClick={() => { location.hash = sectionHref('receivables', `ar-cei-${ceiLast.month}`); }}>By month →</button>}>
              <div className="card-body">
                <GaugeRing value={Math.min(100, Math.max(0, ceiLast.cei ?? 0))} centerValue={`${(ceiLast.cei ?? 0).toFixed(1)}%`} centerLabel={ceiLast.band ?? ''}
                  color={ceiLast.band === 'Excellent' ? C.positive : ceiLast.band === 'Good' ? C.brand : ceiLast.band === 'Fair' ? C.warning : C.negative} height={150} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Collected</div><div className="v pos">{formatCurrency(ceiLast.collected)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Collectible</div><div className="v">{formatCurrency(ceiLast.collectible)}</div></div>
              </div>
              <div className="cfoot" style={{ marginTop: 0 }}>
                <div className="cf-i"><div className="l">vs prior month</div>
                  <div className={`v ${ceiPrev?.cei != null ? ((ceiLast.cei ?? 0) >= ceiPrev.cei ? 'pos' : 'neg') : ''}`}>
                    {ceiPrev?.cei != null ? `${(ceiLast.cei ?? 0) >= ceiPrev.cei ? '▲' : '▼'} ${Math.abs((ceiLast.cei ?? 0) - ceiPrev.cei).toFixed(1)} pts` : '-'}
                  </div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Target</div><div className="v">90+</div></div>
              </div>
            </ChartCard>
            )}

            {/* TOP VENDORS (BY SPEND) WAS HERE, and is gone on request. It
                ranked the five largest vendors by committed PO spend and linked
                out to the Vendors tab.
                It was never the only place that answered the question: "PO Spend
                by Vendor (Top 5)" below covers the same ground from the same
                `po.byVendor` payload, and the Vendors tab carries the full list.
                With this removed, that card is no longer a duplicate of
                anything — see the note beside `overview.poSpendTop5` in
                viewProfile.ts, which hid it for exactly that reason. */}

            {/* The sub names the demo split rather than leaving a muted bar to
                explain itself — it is the one row on this card that is in the
                total but not in the business. */}
            <ChartCard className={kevinLook ? "g12-3" : "g12-4"} title="Sales Orders by Program"
              sub={`${so.count} orders · click a program to filter${(so.piva.DEMO?.count ?? 0) > 0 ? ` · includes ${so.piva.DEMO.count} DEMO / test` : ''}`}>
              <div className="card-body">
                <BarList data={programBars} money={false}
                  onSelect={(name) => setProg((p) => {
                    const key = name === 'Tri-Care' ? 'TriCare' : name;
                    return p === key ? 'All' : (key === 'PI' || key === 'VA' || key === 'TriCare' || key === 'DOL' ? key : p);
                  })} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">{prog === 'All' ? 'Total Orders' : `${PROG_LABEL[prog]} Orders`}</div><div className="v">{soCount.toLocaleString()}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Programs</div><div className="v accent">{programBars.length || '-'}</div></div>
              </div>
            </ChartCard>

            {/* The Exceptions preview card was removed from this board on request
                (2 Oct 2026). The Exceptions page itself is unchanged and still in
                the sidebar. */}
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

            <div className={`section chart-card ${kevinLook
              ? (hide('overview.exceptions') ? (kevinUnits ? 'g12-6' : 'g12-12') : 'g12-8')
              : 'g12-12'}`}>
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

            {/* Kevin's board: Units by device beside Financial Insights, on
                request, instead of at the foot of the board. */}
            {kevinUnits && (
            <ChartCard className="g12-6" title="Units by device">
              <UnitsByDevice
                rows={devMixRows}
                subtitle={`${devMixTotal.toLocaleString()} units across ${devMixRealRows} device${devMixRealRows === 1 ? '' : 's'} · ${PROG_LABEL[prog]}${devMixDemoUnits > 0 ? ` · plus ${devMixDemoUnits} demo unit${devMixDemoUnits === 1 ? '' : 's'} across ${demoOrders} DEMO order${demoOrders === 1 ? '' : 's'}, listed separately` : ''}`}
                onOpen={go('orders')}
              />
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
                      title="List these orders - they carry no Striven label, so no pipeline can place them past stage 1">
                      <b>{labelStats.untagged.toLocaleString()}</b> order{labelStats.untagged === 1 ? '' : 's'}
                      {' '}({formatCurrency(labelStats.untaggedValue)}) carr{labelStats.untagged === 1 ? 'ies' : 'y'} no label at all
                    </button>
                    {' - click to see them.'}
                  </>
                )}
              </div>
            </ChartCard>
          )}

          {/* UNITS BY DEVICE — kept at the FOOT of the board. It is a
              reference list rather than a headline: you come to it once you
              have a question about the mix, not on the way in. The cards above
              answer "how are we doing"; this answers "made of what". */}
          {!kevinUnits && !hide('overview.devices') && devMixRows.length > 0 && (
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

      {drill && <DrillModal title={drill.title} sub={drill.sub} summary={drill.summary}
        columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
