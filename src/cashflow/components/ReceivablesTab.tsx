import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  fetchStrivenAR, fetchStrivenPayments, fetchStrivenCustomers,
  type ArResult, type ArInvoice, type ArPendingOrder, type Payment, type PaymentsResult, type CustomersResult,
} from '../strivenApi';
import { formatCurrency, pageList, clickableProps } from '../format';
import { StatusPill } from './StatusPill';
import { C, AGING, AGING_LABELS, programOfPayer, type Program } from '../chartTheme';
import { ChartCard, AgingBar, TrendArea, DrillModal, GaugeRing, KpiR, useSyncAgo, pctText } from '../chartKit';
import { SoLink } from './SoLink';
import { soIdFromRef } from '../soRef';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
const trunc = (v: string, n = 24) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '•';

// Honest MoM on complete months only (never the partial current month).
const nowYm = new Date().toISOString().slice(0, 7);
const momDelta = (series: { month: string; value: number }[]): { pct: number; up: boolean } | null => {
  const done = series.filter((p) => p.month < nowYm && (p.value ?? 0) > 0);
  if (done.length < 2) return null;
  const cur = done[done.length - 1].value, prev = done[done.length - 2].value;
  if (!prev) return null;
  return { pct: Math.round(((cur - prev) / prev) * 100), up: cur >= prev };
};

const daysPast = (dueDate: string | null, refMs = Date.now()): number => {
  if (!dueDate) return 0;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.floor((refMs - due) / 86_400_000);
};
// Bucket labels match AGING_LABELS so bars/filters line up with Striven's aging.
const bucketOf = (dueDate: string | null, refMs = Date.now()): string => {
  const d = daysPast(dueDate, refMs);
  if (d <= 0) return 'Current';
  if (d <= 30) return '1–30';
  if (d <= 60) return '31–60';
  if (d <= 90) return '61–90';
  return '90+';
};

const INS_TONES: Record<string, { bg: string; fg: string }> = {
  pos: { bg: 'rgba(22,163,74,0.12)', fg: '#16A34A' },
  neg: { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626' },
  brand: { bg: 'rgba(10,54,159,0.10)', fg: '#0A369F' },
  warn: { bg: 'rgba(217,119,6,0.12)', fg: '#D97706' },
};

type SortKey = 'due' | 'value' | 'total' | 'open' | 'days';
const PAGE_SIZE = 8;

/**
 * CASH ACTUALLY RECEIVED AGAINST THE INVOICE — `total - ledgerOpen`, never
 * `total - open`.
 *
 * `ledgerOpen` is Striven's own balance for the invoice ITSELF, which is what
 * answers "has this been collected". `open` is the reported receivable, and on
 * PI it is CAPPED at 15% of the order — so where the cap bites it is smaller
 * than the ledger balance and `total - open` would overstate what came in.
 *
 * (It used to be the other way round: `open` carried the whole case and this
 * subtraction went NEGATIVE on every PI row. Different failure, same fix.)
 *
 * `?? i.open` keeps a payload predating `ledgerOpen` working: off PI the two are
 * equal, so the fallback is a no-op there.
 */
const receivedOf = (i: ArInvoice) => (i.total || 0) - (i.ledgerOpen ?? i.open ?? 0);
/**
 * THE FULL AMOUNT BEHIND THE ROW — the order the invoice was raised against.
 *
 * READ FROM `caseValue`, NOT DERIVED. This used to be `received + open`, which
 * was exact while `open` carried the CASE balance: the received advance plus the
 * outstanding remainder is the order, and it tied out on all 85 open invoices.
 *
 * That identity died with the basis change. `open` is now the unpaid part of the
 * 15% advance, so `received + open` is about a sixth of the order on a PI row —
 * it would have kept printing a confident, wrong number in the Case Value
 * column. The server ships `caseValue` for exactly this, so the column reads the
 * order value instead of inferring one.
 *
 * Falls back to the old identity off PI, where it still holds: `caseValue` is
 * null there because the invoice IS the whole bill.
 */
const valueOf = (i: ArInvoice) =>
  (typeof i.caseValue === 'number' && i.caseValue > 0 ? i.caseValue : receivedOf(i) + (i.open || 0));

export function ReceivablesTab() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [customers, setCustomers] = useState<CustomersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);

  // Dynamic controls.
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [payRange, setPayRange] = useState<'year' | '6mo'>('year');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 });
  const [page, setPage] = useState(1);
  const [bucketFilter, setBucketFilter] = useState<string>('All');
  const [progFilter, setProgFilter] = useState<'All' | Program>('All');
  const [query, setQuery] = useState('');
  const [asOfPick, setAsOfPick] = useState<string | null>(null); // YYYY-MM-DD
  const tableRef = useRef<HTMLDivElement | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const asOfStr = asOfPick && asOfPick <= todayStr ? asOfPick : todayStr;
  const refMs = new Date(`${asOfStr}T23:59:59`).getTime();

  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [a, pay, cust] = await Promise.all([
        fetchStrivenAR(), fetchStrivenPayments(), fetchStrivenCustomers(),
      ]);
      setAr(a); setPayments(pay); setCustomers(cust);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load Receivables data.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const invoices = ar?.invoices ?? [];
  const cashSeries = (payments?.byMonth ?? []).map((m) => ({ month: m.month, value: m.amount }));
  const cashD = momDelta(cashSeries);

  // DSO restricted to PI (client SOW): VA/TriCare pay on fixed cycles so DSO is
  // meaningless there. Aging method: amount-weighted average age of open PI
  // receivables (revenue isn't program-split, so a sales-based PI DSO can't be
  // scoped honestly).
  const piOpenInv = invoices.filter((i) => (i.open || 0) > 0 && programOfPayer(i.payer || i.customer) === 'PI');
  const piOpenSum = piOpenInv.reduce((s, i) => s + (i.open || 0), 0);
  const dso = piOpenSum > 0
    ? Math.round(piOpenInv.reduce((s, i) => {
        const age = i.dueDate ? Math.max(0, Math.floor((refMs - new Date(i.dueDate).getTime()) / 86_400_000)) : 0;
        return s + (i.open || 0) * age;
      }, 0) / piOpenSum)
    : null;

  // Collection effectiveness = collected ÷ (collected + still open). Real, explainable.
  const collected = payments?.total ?? 0;
  const healthPct = collected + (ar?.totalOpen ?? 0) > 0 ? Math.round((collected / (collected + (ar?.totalOpen ?? 0))) * 100) : 0;
  const healthBand = healthPct >= 90 ? 'Excellent' : healthPct >= 75 ? 'Good' : healthPct >= 60 ? 'Fair' : 'Low';
  const healthColor = healthPct >= 75 ? C.positive : healthPct >= 60 ? '#D97706' : C.negative;

  // Aging by count (invoices per bucket) for the toggle.
  const BUCKET_KEY: Record<string, string> = { Current: 'current', '1–30': 'd1_30', '31–60': 'd31_60', '61–90': 'd61_90', '90+': 'd90plus' };
  const agingCount = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const i of invoices) m[BUCKET_KEY[bucketOf(i.dueDate, refMs)]] += 1;
    return m;
  }, [invoices, refMs]);
  // Amount aging bucketed client-side so the as-of date applies.
  const agingEff = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const i of invoices) m[BUCKET_KEY[bucketOf(i.dueDate, refMs)]] += i.open;
    return m;
  }, [invoices, refMs]);

  const overdueRows = AGING_LABELS.filter((b) => b.key !== 'current')
    .map((b, i) => ({ label: `${b.label} days`, value: agingEff[b.key] || 0, color: AGING[i + 1] }));
  const totalOverdue = overdueRows.reduce((s, r) => s + r.value, 0);

  // Top payers by open balance.
  const topPayers = useMemo(() => {
    const agg = new Map<string, number>();
    for (const i of invoices) {
      if (i.open <= 0) continue;
      const who = i.payer || i.customer || 'Unassigned';
      agg.set(who, (agg.get(who) || 0) + i.open);
    }
    return [...agg].map(([name, open]) => ({ name, open })).sort((a, b) => b.open - a.open).slice(0, 5);
  }, [invoices]);

  // Insights: all computed from live data above.
  const biggestBucket = overdueRows.slice().sort((a, b) => b.value - a.value)[0];
  const insights: { tone: keyof typeof INS_TONES; ico: string; text: ReactNode }[] = [];
  if (cashD) insights.push({ tone: cashD.up ? 'pos' : 'neg', ico: cashD.up ? '▲' : '▼', text: <>Collections {cashD.up ? 'increased' : 'dropped'} <b>{pctText(cashD.pct)}</b> vs last month</> });
  if (biggestBucket && biggestBucket.value > 0) insights.push({ tone: 'warn', ico: '!', text: <><b>{biggestBucket.label}</b> overdue is the largest bucket ({formatCurrency(biggestBucket.value)})</> });
  if (dso != null) insights.push({ tone: 'brand', ico: '◷', text: <>PI DSO is <b>{dso} days</b> (avg age of open PI receivables)</> });
  if ((ar?.unappliedCredits ?? 0) > 0.005) insights.push({ tone: 'warn', ico: '$', text: <><b>{formatCurrency(ar!.unappliedCredits!)}</b> paid but unapplied: netted out of AR</> });
  if (topPayers[0]) insights.push({ tone: 'pos', ico: '◆', text: <>Top balance: <b>{trunc(topPayers[0].name, 20)}</b> ({formatCurrency(topPayers[0].open)})</> });

  // Open-invoices table: filter → sort → paginate.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invoices.filter((i) =>
      (bucketFilter === 'All' || bucketOf(i.dueDate, refMs) === bucketFilter) &&
      (progFilter === 'All' || programOfPayer(i.payer || i.customer) === progFilter) &&
      (!q || String(i.number).toLowerCase().includes(q) || (i.payer || '').toLowerCase().includes(q)));
  }, [invoices, bucketFilter, progFilter, query, refMs]);

  /**
   * PI ORDERS THAT HAVE NEVER BEEN BILLED, sitting in the invoice register.
   *
   * They belong here rather than only in the panel above because this table IS
   * the question "what is outstanding on this book", and an order nobody has
   * invoiced is the most outstanding thing on it — it just has no invoice
   * number to be found under. Flagged, so it can never be mistaken for a real
   * invoice row.
   *
   * DROPPED BY THE AGEING FILTER, DELIBERATELY. An unbilled order has no due
   * date, so it is in no ageing bucket; showing it under "31–60 days" would be
   * inventing an age it does not have. It survives All, and the programme and
   * search filters it can actually answer.
   */
  const pendingRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (bucketFilter !== 'All') return [];
    if (progFilter !== 'All' && progFilter !== 'PI') return [];
    return (ar?.pending?.orders ?? [])
      .filter((o) => o.vertical === 'PI')
      .filter((o) => !q || o.ref.toLowerCase().includes(q) || (o.payer || '').toLowerCase().includes(q));
  }, [ar, bucketFilter, progFilter, query]);

  /** One list, two kinds of row. The union is what lets a single sort and a
   *  single paginator run over both without either kind pretending to be the
   *  other. */
  type Row =
    | { kind: 'invoice'; key: string; inv: ArInvoice }
    | { kind: 'pending'; key: string; ord: ArPendingOrder };
  const sorted = useMemo(() => {
    const rows: Row[] = [
      ...filtered.map((inv) => ({ kind: 'invoice' as const, key: `i${inv.id}`, inv })),
      ...pendingRows.map((ord) => ({ kind: 'pending' as const, key: `p${ord.soId}`, ord })),
    ];
    // A pending row answers only two of the sort keys honestly — what the order
    // is worth, and (as zero) what has been invoiced against it. On Received,
    // Open and Days Past Due it has no figure at all, and 0 sorts it to one end
    // rather than claiming a value. That is the truthful placement: it has none.
    const v = (r: Row): number => {
      if (r.kind === 'pending') {
        return sort.key === 'value' ? r.ord.caseValue : 0;
      }
      const i = r.inv;
      return sort.key === 'value' ? valueOf(i)
        : sort.key === 'total' ? i.total : sort.key === 'open' ? i.open
          : sort.key === 'days' ? daysPast(i.dueDate, refMs) : (i.dueDate ? new Date(i.dueDate).getTime() : 0);
    };
    return rows.sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, pendingRows, sort, refMs]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  /** What the flagged rows would add to AR if they were raised. Reported beside
   *  the totals, never inside them — see the footer. */
  const pendingExpected = pendingRows.reduce((s, o) => s + o.expected, 0);
  const pendingCase = pendingRows.reduce((s, o) => s + o.caseValue, 0);

  /**
   * THE PANEL'S OWN LIST: every uninvoiced PI order, PI ONLY.
   *
   * It carried all 298 orders across every programme while the invoice table
   * below it carried 72 PI ones, so the tab stated two different sizes for the
   * same problem within one screen of each other. This is the PI book, which is
   * the one the 15% advance rule applies to and the one the rest of this tab is
   * scoped to.
   *
   * NOT `pendingRows`. That list is narrowed by the invoice table's own bucket,
   * programme and search controls; this panel is a standing summary and must
   * not move when someone types in the table's search box.
   */
  const piPending = useMemo(
    () => (ar?.pending?.orders ?? []).filter((o) => o.vertical === 'PI'),
    [ar],
  );
  const fTotal = filtered.reduce((s, i) => s + (i.total || 0), 0);
  const fOpen = filtered.reduce((s, i) => s + (i.open || 0), 0);
  // Both live at module scope now, because the sort comparator above needs them
  // and runs before this point. See receivedOf / valueOf.
  const fReceived = filtered.reduce((s, i) => s + receivedOf(i), 0);
  /**
   * WHAT THESE INVOICES ARE WORTH, which is not what they have been invoiced.
   *
   * RECEIVED PLUS OUTSTANDING, and that is the whole definition. It needs no
   * order value, no extra field and no deploy: both terms are already on every
   * row. Checked against the live book on all 85 open invoices - `received +
   * open` equals the sales order behind the invoice on every single one, and
   * $38,146 + $307,765 = $345,910 exactly.
   *
   * IT IS DEFINED AS THE SUM OF ITS OWN PARTS ON PURPOSE. The bar below splits
   * this figure into those two terms, so defining the whole as their total is
   * what guarantees the bar always closes at 100% - there is no third source to
   * drift against.
   */
  const fValue = fReceived + fOpen;
  /** Invoiced but not yet collected - the ledger's own open balance. `fOpen` is
   *  the CASE basis and is a larger, different thing. */
  const fLedgerOpen = filtered.reduce((s, i) => s + (i.ledgerOpen ?? i.open ?? 0), 0);
  /** Value that has never been billed: on PI the 85% that only invoices on
   *  settlement. Floored at zero so a rounding wobble cannot print "-$0". */
  const fUnbilled = Math.max(0, fValue - fTotal);
  const share = (n: number) => (fValue > 0 ? Math.round((n / fValue) * 100) : 0);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  const payRows = payments?.recent ?? [];
  const payShown = payRows.slice(0, 8);
  /** What is ON SCREEN and what "View All" holds — the two figures the footer's
   *  all-time total needs to be read against. Summed from the same arrays the
   *  tables render, so the note cannot drift from the rows above it. */
  const payShownSum = payShown.reduce((s, p) => s + (p.amount || 0), 0);
  const payRecentSum = payRows.reduce((s, p) => s + (p.amount || 0), 0);
  const payData = (payments?.byMonth ?? []).slice(payRange === '6mo' ? -6 : -12).map((m) => ({ month: m.month, amount: m.amount }));

  // Drills (tap-to-explain KPIs + aging bars + payments view-all).
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const explainAr = () => setDrill({
    title: 'AR Open', sub: 'Sum of every open invoice’s remaining balance, split by days past due',
    ...kv([...AGING_LABELS.map((b) => ({ k: `${b.label}`, v: formatCurrency(ar?.aging[b.key] || 0) })), { k: 'Total', v: formatCurrency(ar?.totalOpen || 0) }]),
  });
  const explainCash = () => setDrill({
    title: 'Cash Received', sub: 'Customer payments recorded in Striven: money actually in the door',
    ...kv([{ k: 'Payments recorded', v: String(payments?.count ?? 0) }, { k: 'Total received', v: formatCurrency(collected) }]),
  });
  /** Every unbilled PI order, largest first — the full list behind the red card.
   *  PI-scoped like the card itself: a "View all" that widened to programmes the
   *  card does not show would answer a question nobody asked it. */
  const explainPending = () => setDrill({
    title: 'PI orders yet to be invoiced',
    sub: `${piPending.length} PI sales orders with no invoice · ${formatCurrency(ar?.pending?.pi.expected ?? 0)} of advance would enter AR once raised`,
    columns: [
      { key: 'ref', label: 'Order' }, { key: 'patient', label: 'Patient' },
      { key: 'payer', label: 'Payer' }, { key: 'rep', label: 'Rep' },
      { key: 'caseValue', label: 'Order value', num: true },
      { key: 'expected', label: 'Would invoice', num: true },
    ],
    rows: piPending.map((o) => ({
      ref: <strong>{o.ref}</strong>,
      patient: o.patient || '-',
      payer: trunc(o.payer || '-', 28),
      rep: o.rep || '-',
      caseValue: formatCurrency(o.caseValue),
      expected: formatCurrency(o.expected),
    })),
  });
  const explainDso = () => setDrill({
    title: 'PI Days Sales Outstanding', sub: 'PI only (client rule) · avg age of open PI receivables, amount-weighted',
    ...kv([{ k: 'Open PI AR', v: formatCurrency(piOpenSum) }, { k: 'PI invoices open', v: String(piOpenInv.length) }, { k: 'PI DSO', v: dso != null ? `${dso} days` : '-' }]),
  });
  const drillBucket = (label: string) => setDrill({
    title: `Open Invoices · ${label}`, sub: `${invoices.filter((i) => bucketOf(i.dueDate, refMs) === label).length} invoices in this bucket`,
    columns: [{ key: 'n', label: 'Invoice #' }, { key: 'p', label: 'Payer' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
    rows: invoices.filter((i) => bucketOf(i.dueDate, refMs) === label).sort((a, b) => b.open - a.open)
      .map((i) => ({ n: `#${i.number}`, p: i.payer || '-', d: fmtDate(i.dueDate), o: formatCurrency(i.open) })),
  });
  /** SETTLED IS NOT THE SAME AS UNKNOWN. A payer with nothing left open gets the
   *  word, not `$0` and not a dash: it is the answer most worth seeing on a
   *  payments list, and a bare zero reads as a figure that failed to load. */
  const outstandingCell = (p: Payment) => {
    if (p.outstanding == null) return <span style={{ color: C.muted }}>-</span>;
    if (p.outstanding <= 0.005) return <span style={{ color: C.positive, fontWeight: 600 }}>settled</span>;
    return <span className="cell-neg">{formatCurrency(p.outstanding)}</span>;
  };
  const viewAllPayments = () => setDrill({
    title: 'Recent Payments', sub: `${payRows.length} latest customer payments · patient and what they still owe`,
    columns: [
      { key: 'r', label: 'Payment Ref' },
      { key: 'p', label: 'Patient' },
      { key: 'd', label: 'Date' },
      { key: 'a', label: 'Amount', num: true },
      // The payer's WHOLE remaining balance, not this payment's — the two are
      // different questions and the header has to say which one this answers.
      { key: 'o', label: 'Still Outstanding', num: true },
      { key: 's', label: 'Status' },
    ],
    rows: payRows.map((p) => ({
      r: p.ref,
      p: p.patient || p.customer || '-',
      d: fmtDate(p.date),
      a: formatCurrency(p.amount),
      o: outstandingCell(p),
      s: <StatusPill status={p.status} />,
    })),
  });


  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Receivables</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven{agoText ? ` · updated ${agoText}` : ''}
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark }}>🔒 PHI masked</span>
          </div>
        </div>
        <div className="ov-headright">
          <label className="ov-filter"><span className="fl">As of</span>
            <input type="date" value={asOfStr} max={todayStr} onChange={(e) => setAsOfPick(e.target.value || null)} />
          </label>
          {asOfPick && <button className="card-link" style={{ marginTop: 0 }} onClick={() => setAsOfPick(null)}>Today</button>}
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ar && payments && customers && (
        <>
          <div className="kpi-r-strip">
            <KpiR ico="doc" tint="#0A369F" label="AR Open" value={ar.totalOpen} format={formatCurrency}
              deltaText={`${ar.count} open invoices`} foot="excludes voided invoices" onClick={explainAr} />
            <KpiR ico="clip" tint="#16A34A" label="Open Invoices" value={ar.count}
              deltaText="awaiting payment" foot="matches Striven A/R aging" />
            <KpiR ico="cash" tint="#059669" label="Cash Received" value={payments.total} format={formatCurrency}
              delta={cashD} foot={`${payments.count} payments`} onClick={explainCash} />
            <KpiR ico="users" tint="#7C3AED" label="Accounts" value={customers.count}
              deltaText={`${customers.customers.filter((c) => /active/i.test(c.status)).length} active`} foot="on record" />
            <KpiR ico="clock" tint="#D97706" label="PI Days Sales Outstanding" value={dso ?? 0}
              format={(n) => `${Math.round(n)} days`} deltaText="PI only · fixed-cycle payers excluded" foot="avg age of open PI receivables" onClick={explainDso} />
          </div>

          {/* ── YET TO BE INVOICED ─────────────────────────────────────────
              Orders Striven has never billed. Deliberately ABOVE the aging
              chart and outside every AR total: with PI carried at the 15%
              advance the receivable is small, and read alone it says the
              business is owed almost nothing. It is not — this is the money
              that has not been asked for yet, and on PI it outweighs the whole
              open book. Red because it is an action, not a statistic. */}
          {piPending.length > 0 && (
            <div className="ar-pending">
              <div className="ar-pending-head">
                <span className="ar-pending-dot" aria-hidden />
                <div>
                  <h2 className="ar-pending-title">PI orders yet to be invoiced</h2>
                  <div className="ar-pending-sub">
                    {piPending.length} PI sales order{piPending.length === 1 ? '' : 's'} in Striven carry no invoice.
                    Not counted in AR Open above — nothing is receivable until it is raised.
                    {ar.pending && ar.pending.count > piPending.length && (
                      <> A further {ar.pending.count - piPending.length} uninvoiced orders sit on other programmes and are not shown here.</>
                    )}
                  </div>
                </div>
                <button className="btn ghost" onClick={explainPending}>View all</button>
              </div>
              {/* THREE FIGURES, ALL PI. The middle tile used to be a "PI orders"
                  count sitting inside an all-programme panel — the one place the
                  PI number was visible. Now the panel IS PI, so that tile would
                  have restated the heading, and the count moves here where the
                  other two describe the same 72 orders. */}
              <div className="ar-pending-figs">
                <div className="ar-pending-fig">
                  <span className="l">Would add to AR</span>
                  <strong className="v is-red">{formatCurrency(ar.pending?.pi.expected ?? 0)}</strong>
                  <span className="f">the 15% advance, once raised</span>
                </div>
                <div className="ar-pending-fig">
                  <span className="l">Orders</span>
                  <strong className="v">{piPending.length}</strong>
                  <span className="f">PI only · flagged in the register below</span>
                </div>
                <div className="ar-pending-fig">
                  <span className="l">Case value behind it</span>
                  <strong className="v">{formatCurrency(ar.pending?.pi.caseValue ?? 0)}</strong>
                  <span className="f">the lien, not a receivable</span>
                </div>
              </div>
              <div className="table-wrap scroll-y" style={{ marginTop: 12 }}>
                <table className="data-table compact">
                  <thead>
                    {/* PATIENT, WHERE PROGRAMME USED TO BE. Every row is PI now,
                        so a Programme column would print the same word 72 times
                        and earn none of its width. Patient is what the invoice
                        register beside it shows, and it is how anyone actually
                        identifies one of these orders. */}
                    <tr>
                      <th>Order</th><th>Patient</th><th>Payer</th><th>Rep</th>
                      <th className="num">Order value</th><th className="num">Would invoice</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {piPending.map((o) => (
                      <tr key={o.soId} className="is-pending-row">
                        <td><SoLink soId={soIdFromRef(o.ref)} label={o.ref} /></td>
                        <td className="clip">{o.patient || '-'}</td>
                        <td className="clip" title={o.payer || undefined}>{trunc(o.payer || '-', 22)}</td>
                        <td>{o.rep || '-'}</td>
                        <td className="num">{formatCurrency(o.caseValue)}</td>
                        <td className="num">{formatCurrency(o.expected)}</td>
                        <td><span className="pill-tag tag-danger">Not invoiced</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="AR Aging" sub="Open receivables by days past due · click a bar"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
                  <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
                </div>
              }>
              <AgingBar aging={agingMode === 'amount' ? agingEff : agingCount} money={agingMode === 'amount'} onSelect={drillBucket} />
            </ChartCard>

            <ChartCard className="g12-4" title="Cash Received by Month" sub="Customer payments collected"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={payRange === 'year' ? 'active' : ''} onClick={() => setPayRange('year')}>12 mo</button>
                  <button className={payRange === '6mo' ? 'active' : ''} onClick={() => setPayRange('6mo')}>6 mo</button>
                </div>
              }>
              <TrendArea data={payData} idPrefix="rc-pay" series={[{ key: 'amount', name: 'Received', color: C.brand }]} />
            </ChartCard>

            <ChartCard className="g12-3" title="A/R Health Score" sub="Collected ÷ (collected + open AR)">
              <div className="card-body">
                <GaugeRing arc="semi" value={healthPct} centerValue={String(healthPct)} centerLabel={healthBand} color={healthColor} height={150} />
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Target</div><div className="v">90+</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Collected</div><div className="v pos">{formatCurrency(collected)}</div></div>
              </div>
            </ChartCard>

            <div className="section chart-card g12-4">
              <div className="section-head"><div><h2 className="section-title">Overdue Summary</h2><div className="section-sub">Past-due receivables by bucket</div></div></div>
              <div className="card-body" style={{ justifyContent: 'flex-start' }}>
                <div className="rank-list">
                  {overdueRows.map((r) => (
                    <div key={r.label} className="rk-row" style={{ cursor: 'pointer' }} {...clickableProps(() => drillBucket(r.label.replace(' days', '')))}>
                      <span className="donut-dot" style={{ background: r.color }} />
                      <span className="rk-name">{r.label}</span>
                      <span className="rk-val">{formatCurrency(r.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Overdue</div><div className="v neg">{formatCurrency(totalOverdue)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Current (not due)</div><div className="v pos">{formatCurrency(agingEff.current || 0)}</div></div>
              </div>
            </div>

            <div className="section chart-card g12-4">
              <div className="section-head"><div><h2 className="section-title">Top Customers (by Balance)</h2><div className="section-sub">Payer · largest open balances</div></div></div>
              <div className="rank-list">
                {topPayers.map((c) => (
                  <div key={c.name} className="rk-row" style={{ cursor: 'pointer' }}
                    {...clickableProps(() => { setQuery(c.name); setBucketFilter('All'); setProgFilter('All'); setPage(1); tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); })}>
                    <span className="rk-ico">{initials(c.name)}</span>
                    <span className="rk-name" title={c.name}>{trunc(c.name, 26)}</span>
                    <span className="rk-val">{formatCurrency(c.open)}</span>
                  </div>
                ))}
                {topPayers.length === 0 && <div className="muted-note">No open balances.</div>}
              </div>
              <button className="card-link" style={{ marginTop: 'auto', paddingTop: 10 }}
                onClick={() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>View all customers →</button>
            </div>

            <div className="section chart-card g12-4 g12-w">
              <div className="section-head"><div><h2 className="section-title">Insights</h2><div className="section-sub">Computed from live data</div></div></div>
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

            {/* FULL WIDTH, and `tbl-single` with it. At 7-of-12 the nine
                columns overflowed the card and Open Balance / Days Past Due sat
                off the right edge behind a scrollbar nobody looks for. A
                nine-column register is a full-width object. */}
            <div className="section chart-card g12-12 tbl-single" ref={tableRef}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">Open Invoices</h2>
                  <div className="section-sub">
                    Unpaid invoices with a remaining balance: matches Striven's A/R aging
                    {pendingRows.length > 0 && <> · <span style={{ color: C.negative, fontWeight: 700 }}>{pendingRows.length} PI orders</span> with no invoice are flagged in red and excluded from the total</>}
                    {(ar.unappliedCredits ?? 0) > 0.005 && <> · <span style={{ color: '#047857', fontWeight: 700 }}>{formatCurrency(ar.unappliedCredits!)}</span> unapplied netted out</>}
                  </div>
                </div>
                <div className="tbl-controls">
                  <input className="tbl-search" placeholder="Search payer / invoice #" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  <select className="tbl-select" value={bucketFilter} onChange={(e) => { setBucketFilter(e.target.value); setPage(1); }}>
                    {['All', 'Current', '1–30', '31–60', '61–90', '90+'].map((b) => <option key={b} value={b}>{b === 'All' ? 'All buckets' : b}</option>)}
                  </select>
                  <select className="tbl-select" value={progFilter} onChange={(e) => { setProgFilter(e.target.value as 'All' | Program); setPage(1); }}>
                    <option value="All">All programs</option>
                    <option value="PI">PI</option>
                    <option value="VA">VA</option>
                    <option value="TriCare">Tri-Care</option>
                    <option value="Unassigned">Unassigned</option>
                  </select>
                </div>
              </div>
              {progFilter !== 'All' && PROG_NOTE[progFilter] && (
                <div className="info-banner" style={{ marginBottom: 12 }}>
                  <span className="info-banner-icon">ℹ</span>
                  <span>{PROG_NOTE[progFilter]}</span>
                </div>
              )}
              {/* ── WHAT IS THE BOOK WORTH, AND HOW MUCH OF IT IS STILL OUT ──
                  The footer adds up the columns; it cannot say how they RELATE.
                  A reader seeing $98,020 invoiced above $307,765 outstanding has
                  no way to tell whether that is a collections disaster or the
                  ordinary shape of a lien book - the missing term is the value
                  the invoices were only ever a deposit against.

                  ONE BAR, TWO SEGMENTS, because received and outstanding are the
                  whole of the value and nothing else belongs in it. The invoiced
                  split is stated underneath in words rather than given marks of
                  its own: it cuts the same money a second way, and a bar whose
                  segments come from two different partitions is unreadable.

                  SCOPED TO THE FILTERS, off `filtered` exactly as the footer is,
                  so narrowing to PI restates every figure rather than leaving a
                  whole-book headline over a filtered table. */}
              {filtered.length > 0 && (
                <div className="ar-value">
                  <div className="ar-value-head">
                    <span className="l">Total value of these {filtered.length} invoice{filtered.length === 1 ? '' : 's'}</span>
                    <b className="v">{formatCurrency(fValue)}</b>
                  </div>
                  <div className="ar-value-bar" role="img"
                    aria-label={`${share(fReceived)}% received, ${share(fOpen)}% still outstanding`}>
                    <span style={{ width: `${share(fReceived)}%`, background: C.positive }} />
                    <span style={{ width: `${100 - share(fReceived)}%`, background: C.negative }} />
                  </div>
                  <div className="ar-value-key">
                    <span><i style={{ background: C.positive }} />Received
                      <b>{formatCurrency(fReceived)}</b>
                      <em>{share(fReceived)}%</em></span>
                    <span><i style={{ background: C.negative }} />Still outstanding
                      <b>{formatCurrency(fOpen)}</b>
                      <em>{share(fOpen)}%</em></span>
                  </div>
                  <div className="ar-value-note">
                    <b>{formatCurrency(fTotal)}</b> of that has been invoiced so far
                    {fLedgerOpen > 0.005 && <> &mdash; <b>{formatCurrency(fReceived)}</b> collected and <b>{formatCurrency(fLedgerOpen)}</b> billed but still unpaid</>}.
                    {fUnbilled > 0.005 && <> The other <b>{formatCurrency(fUnbilled)}</b> has not been invoiced at all: it is case balance that only bills on settlement.</>}
                  </div>
                </div>
              )}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice #</th>
                      {/* PATIENT, which the payload has carried all along and
                          this table never asked for. It is the identifier anyone
                          here recognises a row by, and on PI it is the ONLY one:
                          the payer column is empty on 79 of the 85 open invoices
                          because `order_chain` - the only place a law firm is
                          named - is rebuilt on a cycle and does not yet hold the
                          newest invoices, which are exactly the ones on top. */}
                      <th>Patient</th>
                      <th>Payer</th>
                      <th className="sortable" onClick={() => setSortKey('due')}>Due Date {sortInd('due')}</th>
                      {/* THE WHOLE AMOUNT, LEFT OF WHAT WAS BILLED OF IT, so the
                          row reads left to right as the story it is: this much is
                          owed on the case, this much has been invoiced of it,
                          this much came in, this much is still out. Derived from
                          the row's own two figures — see valueOf — so unlike the
                          Case Value column it replaces, it is never a dash. */}
                      <th className="num sortable" onClick={() => setSortKey('value')}>Total Amount {sortInd('value')}</th>
                      <th className="num sortable" onClick={() => setSortKey('total')}>Invoiced {sortInd('total')}</th>
                      <th className="num">Received</th>
                      {/* NO CASE VALUE COLUMN. It would have been the per-row
                          explanation of why Open exceeds Invoiced, but the value
                          it needs is not on the deployed payload, so the column
                          printed a dash on every line - a column of nothing is
                          worse than none. The summary above answers the same
                          question for the whole book, off `received + open`,
                          which needs no extra field. */}
                      <th className="num sortable" onClick={() => setSortKey('open')}>Open Balance {sortInd('open')}</th>
                      <th className="num sortable" onClick={() => setSortKey('days')}>Days Past Due {sortInd('days')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => {
                      // ── A FLAGGED ORDER, NOT AN INVOICE ──────────────────
                      // Every money column here is deliberately empty except
                      // the two it can answer: what the order is worth, and
                      // what has been invoiced against it — which is nothing,
                      // and printing that zero is the entire point of the row.
                      // Open Balance stays a dash rather than $0: zero would
                      // read as "settled", and this is the opposite of settled.
                      if (row.kind === 'pending') {
                        const o = row.ord;
                        return (
                          <tr key={row.key} className="is-pending-row">
                            <td>
                              <SoLink soId={soIdFromRef(o.ref)} label={o.ref} />
                              <span className="pill-tag tag-danger" style={{ marginLeft: 8, fontSize: 10.5 }}>not invoiced</span>
                            </td>
                            <td className="clip">{o.patient || '-'}</td>
                            <td className="clip" title={o.payer || undefined}>{o.payer || '-'}</td>
                            <td><span style={{ color: C.muted }}>—</span></td>
                            <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.caseValue)}</td>
                            <td className="num cell-neg">{formatCurrency(0)}</td>
                            <td className="num"><span style={{ color: C.muted }}>—</span></td>
                            <td className="num" title={`${formatCurrency(o.expected)} would enter AR once this is invoiced`}>
                              <span style={{ color: C.muted }}>—</span>
                            </td>
                            <td className="num"><span style={{ color: C.muted }}>—</span></td>
                          </tr>
                        );
                      }
                      const inv = row.inv;
                      const recv = receivedOf(inv);
                      const d = daysPast(inv.dueDate, refMs);
                      // THE INVOICE IS CLEAR, which on PI is not the same as the
                      // case being settled: collecting the advance closes the
                      // invoice and leaves the lien wide open. The pill says
                      // which of the two happened rather than borrowing
                      // "part-paid" for a row that is nothing of the kind.
                      const invoiceClear = recv > 0.005 && (inv.ledgerOpen ?? inv.open) <= 0.005;
                      return (
                        <tr key={row.key}>
                          <td>
                            <strong>#{inv.number}</strong>
                            {invoiceClear
                              ? <span className="pill-tag tag-ok" style={{ marginLeft: 8, fontSize: 10.5 }}>{inv.vertical === 'PI' ? 'advance paid' : 'paid'}</span>
                              : recv > 0.005 && <span className="pill-tag tag-ok" style={{ marginLeft: 8, fontSize: 10.5 }}>part-paid</span>}
                          </td>
                          <td className="clip">{inv.patient || inv.customer || '-'}</td>
                          <td className="clip" title={inv.payer || undefined}>{inv.payer || '-'}</td>
                          <td>{fmtDate(inv.dueDate)}</td>
                          <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(valueOf(inv))}</td>
                          <td className="num">{formatCurrency(inv.total)}</td>
                          <td className="num cell-pos">{recv > 0.005 ? formatCurrency(recv) : '-'}</td>
                          <td className="num cell-neg">{formatCurrency(inv.open)}</td>
                          <td className="num cell-neg">{d > 0 ? d : '-'}</td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr><td colSpan={9} style={{ color: C.muted }}>No invoices match.</td></tr>
                    )}
                    {/* THE FLAGGED ROWS ARE NOT IN THE TOTAL BELOW, and this row
                        is where that is said. Their money has not been billed,
                        so folding it into a receivable total would overstate
                        the book by exactly the amount nobody has invoiced —
                        the error this whole change exists to expose. Stated as
                        its own line so the reader sees the two figures apart
                        and can add them if that is the question they have. */}
                    {pendingRows.length > 0 && (
                      <tr className="subtotal-row is-pending-row">
                        <td colSpan={4}>
                          NOT INVOICED — {pendingRows.length} PI order{pendingRows.length === 1 ? '' : 's'}
                          <span style={{ fontWeight: 400, color: C.muted }}> · excluded from the total below</span>
                        </td>
                        <td className="num">{formatCurrency(pendingCase)}</td>
                        <td className="num">{formatCurrency(0)}</td>
                        <td className="num"><span style={{ color: C.muted }}>—</span></td>
                        <td className="num" title="What these orders would add to AR once raised">
                          {formatCurrency(pendingExpected)} <span style={{ fontWeight: 400, color: C.muted }}>if raised</span>
                        </td>
                        <td />
                      </tr>
                    )}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td colSpan={4}>TOTAL{pendingRows.length > 0 ? ' INVOICED' : ''}</td>
                        <td className="num">{formatCurrency(fValue)}</td>
                        <td className="num">{formatCurrency(fTotal)}</td>
                        {/* Summed off the same per-row figure the column prints,
                            so the footer cannot disagree with what is above it.
                            This was `fTotal - fOpen` and printed -$209,745. */}
                        <td className="num">{formatCurrency(fReceived)}</td>
                        <td className="num">{formatCurrency(fOpen)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pgn">
                <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
                <div className="pgn-pages">
                  <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                  {pageList(pageSafe, pages).map((p, i) => (
                    p === '…'
                      ? <button key={`e${i}`} disabled>…</button>
                      : <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                  ))}
                  <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
                </div>
              </div>
            </div>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Recent Payments</h2><div className="section-sub">Latest customer payments received</div></div>
                <button className="card-link" style={{ marginTop: 0 }} onClick={viewAllPayments}>View All →</button>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payment Ref</th>
                      <th>Patient</th>
                      <th>Date</th>
                      <th className="num">Amount</th>
                      <th className="num">Outstanding</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payShown.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.ref || '-'}</strong></td>
                        <td className="clip">{p.patient || p.customer || '-'}</td>
                        <td>{fmtDate(p.date)}</td>
                        <td className="num cell-pos">{formatCurrency(p.amount)}</td>
                        <td className="num">{outstandingCell(p)}</td>
                        <td><StatusPill status={p.status} /></td>
                      </tr>
                    ))}
                    {payShown.length === 0 && (
                      <tr><td colSpan={6} style={{ color: C.muted }}>No recent payments.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="cfoot">
                <div className="cf-i"><div className="l">Total Received</div><div className="v pos">{formatCurrency(collected)}</div></div>
                <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Payments</div><div className="v">{(payments.count).toLocaleString()}</div></div>
              </div>
              {/* WHAT THE FOOTER MEANS AGAINST WHAT THE TABLE SHOWS.
                  $292,857 sitting under eight rows totalling a fraction of it
                  invites exactly one reading — that the rows should add up to
                  the figure — and they never will: the table is a recent slice
                  and the footer is the whole book. Three numbers, so the
                  relationship is stated instead of inferred.

                  THE MIDDLE ONE IS NOT REDUNDANT. "View All" opens 30, not the
                  198 the footer counts, and a reader who clicks it expecting to
                  reconcile to $292,857 finds neither this table's total nor the
                  footer's. Naming the 30 up front is what stops that trip. */}
              {payRows.length > 0 && (
                <div className="pay-gist">
                  <b>{formatCurrency(collected)}</b> received across {payments.count.toLocaleString()} payments all-time.
                  {' '}The {payShown.length} above are the most recent, totalling <b>{formatCurrency(payShownSum)}</b>
                  {payRows.length > payShown.length && (
                    <> &mdash; <button type="button" className="pay-gist-link" onClick={viewAllPayments}>View All</button>
                      {' '}opens the latest {payRows.length} (<b>{formatCurrency(payRecentSum)}</b>)</>
                  )}.
                </div>
              )}
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

// Per-segment plain-language explanation shown when a program tab is selected,
// so Kevin never has to ask "what is this?" (esp. the PI residual).
const PROG_NOTE: Record<string, string> = {
  PI: 'PI invoices stay open until settlement. The 15% advance is applied and the remainder stays open: often for a long time. An outstanding PI balance is normal here, not a collection problem.',
  VA: 'VA pays on fixed cycles (Integrated on the 5th & 15th, HIDAL by the 5th) and settles one-for-one, so VA invoices close cleanly. An open VA balance usually just means the cycle hasn’t run yet.',
  TriCare: 'Tri-Care is paid by the TriCare program on a fixed cycle. Open balances clear when that cycle runs.',
  Unassigned: 'Invoices whose payer isn’t classified to a program yet. Set the payer on the order in Striven to route them.',
};
