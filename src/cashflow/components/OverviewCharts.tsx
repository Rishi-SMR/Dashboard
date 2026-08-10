import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenAP, fetchStrivenPL, fetchStrivenSO, fetchStrivenPO,
  fetchStrivenTrends, fetchStrivenPayments, fetchStrivenBillPayments,
  fetchStrivenOrders, fetchStrivenExceptions, fetchCommission,
  type ArResult, type ApResult, type PlResult, type SoResult, type PoResult,
  type TrendsResult, type PaymentsResult, type BillPaymentsResult,
  type OrdersResult, type ExceptionsResult, type CommissionResult,
} from '../strivenApi';
import { formatCurrency, clickableProps, isCancelledStatus, isCompletedStatus } from '../format';
import { C, SERIES, CAT6, VERTICAL_COLORS, compactMoney, monthLabel, programOfPayer, type Program } from '../chartTheme';
import { ChartCard, BarsLine, LegendDots, BarList, DonutList, GaugeRing, DrillModal, useSyncAgo, pctText, HUE, AnimatedNumber } from '../chartKit';
import { shortDeviceName } from './DeviceChips';
import { UnitsByDevice } from './UnitsByDevice';
import { CommissionBreakdown } from './CommissionBreakdown';
import { MetricDetail } from './MetricDetail';

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
      const [a, b, p, s, o, t, pay, bp, ord, ex] = await Promise.all([
        fetchStrivenAR(), fetchStrivenAP(), fetchStrivenPL(), fetchStrivenSO(), fetchStrivenPO(),
        fetchStrivenTrends(), fetchStrivenPayments(), fetchStrivenBillPayments().catch(() => null),
        fetchStrivenOrders().catch(() => null), fetchStrivenExceptions().catch(() => null),
      ]);
      // Commission is its own derivation and can be slow, so it loads beside the
      // rest and simply leaves its tile blank if Striven is unavailable.
      fetchCommission().then(setComm).catch(() => setComm(null));
      setAr(a); setAp(b); setPl(p); setSo(s); setPo(o); setTrends(t); setPayments(pay);
      setBillpay(bp); setOrders(ord); setExc(ex);
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

  // COMMISSION DUE, scoped to the PRODUCING REPS — the same population the
  // Commission tab shows when this tile is clicked.
  //
  // It read `striven.payableTotal`, which is the whole roster: it counted
  // Cassie, Kinley Shepherd and House Account, none of whom appear on the
  // Commission tab any more. The tile said $218,116 and the page it opened said
  // $209,815 — an $8,301 gap between a figure and the breakdown behind it.
  //
  // `roster` is the server's producer list, empty for a non-admin; this board
  // is admin-only, but the fallback keeps it honest if that ever changes.
  const commDue = (() => {
    const s = comm?.striven;
    if (!s) return { payable: comm?.payableTotal ?? 0, waiting: 0, offRoster: 0 };
    const roster = new Set(comm?.roster ?? []);
    const rows = roster.size ? (s.byRep ?? []).filter((r) => roster.has(r.rep)) : null;
    if (!rows) return { payable: s.payableTotal ?? 0, waiting: s.waitingTotal ?? 0, offRoster: 0 };
    const sum = (k: 'payableTotal' | 'waitingTotal') =>
      Math.round(rows.reduce((a, r) => a + (r[k] ?? 0), 0) * 100) / 100;
    // What the roster filter LEAVES OUT. Non-producing reps are off the Reps
    // dashboard by request, but their commission is still owed — reporting the
    // tile without it would quietly understate the liability.
    const offRoster = Math.round(((s.byRep ?? [])
      .filter((r) => !roster.has(r.rep))
      .reduce((a, r) => a + (r.payableTotal ?? 0), 0)) * 100) / 100;
    return { payable: sum('payableTotal'), waiting: sum('waitingTotal'), offRoster };
  })();

  // ---- FY + Program + As-of scope (the header filters actually re-slice the data) ----
  const [fyPick, setFyPick] = useState<string | null>(null);
  // PERIOD DEFAULTS TO THE FISCAL YEAR.
  //
  // It used to default to the As-of MONTH, on the reasoning that an owner reads
  // "how are we doing right now". In practice that opened the board on a month
  // with no invoices yet — early August showed Revenue $0, Cash Received $0 and
  // two empty charts, while the snapshot cards beside them showed real money.
  // The zeroes were correct and read as breakage. A year-to-date figure is
  // always populated, so the board opens saying something; the month view is
  // one click away in the Period filter.
  // 'month'  the as-of month · 'fy' the fiscal year · 'pick' one named month
  // · 'custom' a from→to range.
  //
  // RANGES ARE MONTH-PRECISION, not day. Every period-scoped figure on this
  // board comes from a monthly series (trends, payments), so a day-level range
  // could not be honoured — it would silently round to whole months while
  // showing exact dates. Month inputs say what the data can actually answer.
  const [scope, setScope] = useState<'month' | 'fy' | 'pick' | 'custom'>('fy');
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
  const inFy = (m: string) => {
    if (scope === 'month') return m === asOfYm;
    if (scope === 'pick') return m === pickMonth;
    // An open end means "from here on" / "up to here" rather than nothing.
    if (scope === 'custom') return (!fromYm || m >= fromYm) && (!toYm || m <= toYm);
    return m.startsWith(fy) && m <= asOfYm;
  };

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
  const cashOutBy: Record<string, number> = {};
  for (const r of billpay?.recent ?? []) {
    const m = String(r.date ?? '').slice(0, 7);
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
  const arInv = (ar?.invoices ?? []).filter((i) => i.open > 0 && (prog === 'All' || programOfPayer(i.payer) === prog));
  const arOpenF = arInv.reduce((s, i) => s + i.open, 0);
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
    for (const b of ap?.bills ?? []) {
      if (!(b.open > 0)) continue;
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
      const name = shortDeviceName(d.device) || d.device;
      const k = name.toLowerCase();
      const e = m.get(k);
      if (!e) { m.set(k, { ...d, device: name }); continue; }
      e.units += d.units; e.orders += d.orders;
      e.heldUnits += d.heldUnits; e.heldOrders += d.heldOrders;
    }
    return [...m.values()].filter((d) => d.units > 0);
  })();
  const devMixTotal = devMixRows.reduce((s, d) => s + d.units, 0);
  // DEMO orders sit outside every unit figure on this board. gen-reports.mjs
  // drops them when it builds report_patient_items, so they carry no device
  // lines — order-analytics reports them as 0 units, which is an absence rather
  // than a measurement. They still count in the order book and its value, so
  // the two cards that report UNITS have to say they are missing.
  const demoOrders = so?.piva?.DEMO?.count ?? 0;
  const demoValue = so?.piva?.DEMO?.value ?? 0;

  // Doughnut slices for the money tiles. Each keeps the hue its own KPI card
  // uses, so a colour means the same thing in both places. A zero balance is
  // dropped rather than drawn — a 0% slice is a legend entry pretending to be
  // data, and it makes the ring look broken.
  const donutSlices = [
    { name: 'AR Expected', value: arOpenF, color: HUE.ar.to },
    { name: 'AP Due', value: ap?.totalOpen ?? 0, color: HUE.ap.to },
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
    const bills = (ap?.bills ?? []).filter((b) => (b.open ?? 0) > 0);
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
  const commRows = (() => {
    const roster = new Set(comm?.roster ?? []);
    return (comm?.striven?.byRep ?? []).map((r) => ({
      rep: r.rep,
      payable: r.payableTotal ?? 0,
      orders: r.orders ?? 0,
      units: r.units ?? 0,
      pi: r.pi ?? 0, va: r.va ?? 0, tricare: r.tricare ?? 0,
      onRoster: roster.size ? roster.has(r.rep) : true,
      lines: (r.lines ?? []).map((l) => ({
        ref: l.ref, patient: l.patient ?? '', item: l.item ?? '', prog: l.prog ?? '', comm: l.comm ?? 0,
      })),
    })).filter((r) => r.payable > 0);
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
  const labelStats = (() => {
    const src = (so?.recent ?? [])
      .filter((o) => !isCancelledStatus(o.status))
      .filter((o) => (vertPick === 'All' ? true : o.type === vertPick))
      .filter((o) => (labelScope === 'done' ? isCompletedStatus(o.status) : true));
    const m = new Map<string, { label: string; n: number; value: number; done: number; byVert: Map<string, number> }>();
    let untagged = 0;
    for (const o of src) {
      const ls = o.labels ?? [];
      if (!ls.length) { untagged += 1; continue; }
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
      verts: LABEL_VERTS.filter((v) => v === 'All' || live.has(v)),
      rows: [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    };
  })();
  // Drill: every order carrying the clicked label, in Striven's own wording.
  const drillLabel = (label: string) => {
    const list = (so?.recent ?? [])
      .filter((o) => !isCancelledStatus(o.status))
      .filter((o) => (vertPick === 'All' ? true : o.type === vertPick))
      .filter((o) => (labelScope === 'done' ? isCompletedStatus(o.status) : true))
      .filter((o) => (o.labels ?? []).includes(label))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    setDrill({
      title: label,
      sub: `${list.length} order${list.length === 1 ? '' : 's'} · ${formatCurrency(list.reduce((s, o) => s + (o.value || 0), 0))}`,
      columns: [
        { key: 'ref', label: 'Order #' }, { key: 'patient', label: 'Patient' },
        { key: 'type', label: 'Programme' },
        { key: 'rep', label: 'Sales Rep' }, { key: 'status', label: 'Status' },
        { key: 'labels', label: 'All labels' }, { key: 'value', label: 'Value', num: true },
      ],
      rows: list.map((o) => ({
        ref: <strong>{o.ref}</strong>,
        // First INITIAL + surname, as everywhere else this data appears. Placed
        // beside the order number because that is how staff recognise a row —
        // "SO-451" alone identifies nothing to a reader.
        patient: o.patient
          ? <strong>{o.patient}</strong>
          : <span style={{ color: C.muted }}>—</span>,
        type: o.type,
        rep: o.rep || '-',
        status: o.status,
        labels: (o.labels ?? []).join(', '),
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
  const billsDue = (ap?.bills ?? []).filter((b) => b.open > 0 && b.dueDate && new Date(b.dueDate).getTime() <= soon);
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
  const programBars = so ? ([
    { key: 'PI', name: 'PI', ...so.piva.PI, color: SERIES[0] },
    { key: 'VA', name: 'VA', ...so.piva.VA, color: SERIES[1] },
    { key: 'TriCare', name: 'Tri-Care', ...so.piva.TriCare, color: SERIES[2] },
    ...(so.piva.Other.count > 0 ? [{ key: 'Other', name: 'Other', ...so.piva.Other, color: SERIES[3] }] : []),
  ].filter((d) => d.count > 0).map((d) => ({
    name: d.name, value: d.count, color: d.color, meta: `${d.count} orders`,
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
    <div className="exec-deck ov-board" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 14 }}>
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
        <label className="ov-filter"><span className="fl">Fiscal Year</span>
          <select value={fy} onChange={(e) => setFyPick(e.target.value)} disabled={scope !== 'fy'}>
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
              <ChartCard className="g12-3" title="Commission Due" sub="Click a rep for their programme split and top orders">
                <CommissionBreakdown reps={commRows} onOpen={go('commission')} />
              </ChartCard>
            )}
            {donutSlices.length > 0 && (
              <ChartCard className="g12-3" title="Open balances"
                sub={`${formatCurrency(arOpenF)} owed to us · ${formatCurrency(ap.totalOpen + commDue.payable)} owed out`}>
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
              <ChartCard className="g12-3" title="Position summary" sub="Open balances, netted · as of today">
                <div className="pos">
                  <div className="pos-cap">Net position</div>
                  <div className={`pos-net ${arOpenF - (ap.totalOpen + commDue.payable) < 0 ? 'neg' : 'pos'}`}>
                    <AnimatedNumber value={arOpenF - (ap.totalOpen + commDue.payable)} format={formatCurrency} duration={700} />
                  </div>
                  <div className="pos-sub">
                    {arOpenF >= ap.totalOpen + commDue.payable
                      ? 'More is owed to us than we owe out.'
                      : `We owe ${((ap.totalOpen + commDue.payable) / Math.max(1, arOpenF)).toFixed(1)}× what we are owed.`}
                  </div>

                  {/* Both bars share ONE scale — the larger side is full width —
                      so the two lengths are directly comparable. Scaling each to
                      its own width would make them look equal. */}
                  <div className="pos-side">
                    <div className="pos-lab"><span className="t">Owed to us</span><span className="v">{formatCurrency(arOpenF)}</span></div>
                    <div className="pos-track">
                      <span className="seg" style={{ width: `${(arOpenF / Math.max(arOpenF, ap.totalOpen + commDue.payable, 1)) * 100}%`, background: C.positive }} />
                    </div>
                    <div className="pos-key"><span className="k"><span className="d" style={{ background: C.positive }} />AR from {arInv.length} unpaid invoice{arInv.length === 1 ? '' : 's'}</span></div>
                  </div>

                  <div className="pos-side">
                    <div className="pos-lab"><span className="t">We owe out</span><span className="v">{formatCurrency(ap.totalOpen + commDue.payable)}</span></div>
                    <div className="pos-track">
                      <span className="seg" style={{ width: `${(commDue.payable / Math.max(arOpenF, ap.totalOpen + commDue.payable, 1)) * 100}%`, background: HUE.po.to }} />
                      <span className="seg" style={{ width: `${(ap.totalOpen / Math.max(arOpenF, ap.totalOpen + commDue.payable, 1)) * 100}%`, background: HUE.ap.to, animationDelay: '.08s' }} />
                    </div>
                    <div className="pos-key">
                      <span className="k"><span className="d" style={{ background: HUE.po.to }} />Commission <b>{formatCurrency(commDue.payable)}</b></span>
                      <span className="k"><span className="d" style={{ background: HUE.ap.to }} />Bills <b>{formatCurrency(ap.totalOpen)}</b></span>
                    </div>
                  </div>

                  <div className="pos-note">
                    Balances, not cash: commission falls due as orders settle, and AR arrives on its own schedule
                    {piDso != null ? ` — PI is collecting in about ${piDso} days` : ''}.
                  </div>
                </div>
              </ChartCard>
            )}

            {/* DEMO IS NOT IN THIS RING, and saying so matters: it covers
                PI/VA/TriCare only, so "672 units" reads as the whole book unless
                the exclusion is stated. The units source (report_patient_items)
                drops demo orders at ingest, which is why they cannot simply be a
                fourth slice — they carry no device lines at all, not zero. */}
            {unitSlices.length > 0 && (
              <ChartCard className="g12-3" title="Units by programme"
                sub={`${devMixTotal.toLocaleString()} units on the order book${demoOrders > 0 ? ` · ${demoOrders} DEMO orders excluded` : ''}`}>
                <DonutList data={unitSlices} money={false} totalLabel="Total units" onSelect={go('orders')} />
                {demoOrders > 0 && (
                  <div className="lbl-note">
                    <b>{demoOrders} DEMO order{demoOrders === 1 ? '' : 's'}</b> ({formatCurrency(demoValue)}) are excluded — they carry no device lines
                    in the units source and earn no commission, so their units cannot be counted here.
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
                sub={`Open receivables · ${PROG_LABEL[prog]}${asOfPick ? ` · as of ${shortDate(asOfStr)}` : ''}`}>
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
                <div className="section-sub">Open receivables · {PROG_LABEL[prog]}{asOfPick ? ` · as of ${shortDate(asOfStr)}` : ''}</div>
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
            {(ap?.count ?? 0) > 0 && (
              <ChartCard className="g12-4" title="AP Due"
                sub={`Open bills · snapshot${asOfPick ? ` · as of ${shortDate(asOfStr)}` : ''}`}>
                <MetricDetail
                  value={ap.totalOpen} format={formatCurrency}
                  sub={<>across {ap.count} unpaid bill{ap.count === 1 ? '' : 's'}
                    {apDetail.overdue > 0 && <> · <b style={{ color: C.warning }}>{formatCurrency(apDetail.overdue)}</b> already overdue</>}</>}
                  rail={apDetail.rail}
                  facts={[
                    { label: 'Oldest', value: apDetail.oldest > 0 ? `${apDetail.oldest}d` : '—', note: 'past due', warn: apDetail.oldest > 30 },
                    ...(apDetail.top ? [{
                      label: 'Top vendor',
                      value: `${Math.round((apDetail.top.value / Math.max(1, ap.totalOpen)) * 100)}%`,
                      note: trunc(apDetail.top.name, 18), title: apDetail.top.name,
                      warn: (apDetail.top.value / Math.max(1, ap.totalOpen)) > 0.5,
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

            <ChartCard className={hide('overview.topVendors') ? "g12-6" : "g12-4"} title="Sales Orders by Program" sub={`${so.count} orders · click a program to filter`}>
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
                {labelStats.untagged > 0 && <> <b>{labelStats.untagged.toLocaleString()}</b> order{labelStats.untagged === 1 ? '' : 's'} carr{labelStats.untagged === 1 ? 'ies' : 'y'} no label at all.</>}
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
                subtitle={`${devMixTotal.toLocaleString()} units across ${devMixRows.length} device${devMixRows.length === 1 ? '' : 's'} · ${PROG_LABEL[prog]}${demoOrders > 0 ? ` · ${demoOrders} DEMO orders excluded` : ''}`}
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
