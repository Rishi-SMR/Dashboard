import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchStrivenAP, fetchStrivenVendors, fetchStrivenPO, fetchStrivenBillPayments, fetchApLedger,
  type ApResult, type VendorsResult, type PoResult, type BillPaymentsResult, type ApLedger,
} from '../strivenApi';
import { formatCurrency, formatPhone, pageList } from '../format';
import { StatusPill } from './StatusPill';
import { C, AGING_LABELS } from '../chartTheme';
import { ChartCard, RankBar, AgingBar, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const VENDOR_CAP = 50;
const PAGE_SIZE = 8;

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

const daysPast = (dueDate: string | null, refMs = Date.now()): number => {
  if (!dueDate) return 0;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.floor((refMs - due) / 86_400_000);
};

// Bill status straight from the due date: overdue / due today / due in Xd.
function DuePill({ dueDate, refMs }: { dueDate: string | null; refMs?: number }) {
  const d = daysPast(dueDate, refMs);
  if (!dueDate) return <span className="pill-tag tag-muted">No due date</span>;
  if (d > 0) return <span className="pill-tag tag-danger">Overdue</span>;
  if (d === 0) return <span className="pill-tag tag-warn">Due Today</span>;
  return <span className="pill-tag tag-info">Due in {-d}d</span>;
}

// isPaid / PaidBadge went with the Striven source for Bills Paid. They existed
// to say whether a Striven bill-payment record had been voided; an AP ledger
// debit row carries no status at all — it is a payment that happened — so there
// is nothing left for them to label. StatusPill is still used by the vendor
// table below.

type SortKey = 'due' | 'total' | 'open' | 'days';

export function PayablesTab() {
  const [ap, setAp] = useState<ApResult | null>(null);
  const [vendors, setVendors] = useState<VendorsResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [bp, setBp] = useState<BillPaymentsResult | null>(null);
  // The AP ledger sheet, for BILLS PAID. Striven records one bill payment; the
  // sheet's Debit column records fifty. See the card below.
  const [apl, setApl] = useState<ApLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  // Dynamic controls.
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [dueF, setDueF] = useState<'All' | 'overdue' | 'today' | 'upcoming'>('All');
  const [asOfPick, setAsOfPick] = useState<string | null>(null); // YYYY-MM-DD
  const todayStr = new Date().toISOString().slice(0, 10);
  const asOfStr = asOfPick && asOfPick <= todayStr ? asOfPick : todayStr;
  const refMs = new Date(`${asOfStr}T23:59:59`).getTime();

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [a, v, o, p, l] = await Promise.all([
        fetchStrivenAP(), fetchStrivenVendors(), fetchStrivenPO(), fetchStrivenBillPayments(),
        // Never lets the page fail: the ledger is one sheet away and the rest of
        // Payables does not depend on it.
        fetchApLedger().catch(() => null),
      ]);
      setAp(a); setVendors(v); setPo(o); setBp(p); setApl(l);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load Payables data.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  // ── THE AP BOOK IS THE LEDGER SHEET, NOT STRIVEN ────────────────────────────
  //
  // This page was reading TWO BOOKS AT ONCE and presenting them as one. AP Open,
  // # Open Bills, the aging chart and the open-bills table came from Striven;
  // Bills Paid came from the AP ledger sheet. Side by side on one strip that is
  // not a discrepancy, it is nonsense — the three figures cannot be combined:
  //
  //   ledger billed  $106,481.06
  //   ledger paid  −  $76,026.06
  //   =               $30,455.00   ← the ledger's own outstanding, to the cent
  //   AP Open card    $11,422.17   ← Striven, off by $19,032.83
  //
  // The sheet is the real book. Striven carries FOUR open bills; the ledger
  // carries 133 bills, 46 of them open, and all 51 payments. Vendor bills are
  // tracked by hand in that sheet and only a handful ever reach Striven, which
  // is the same reason Bills Paid already moved — Striven had one payment of
  // $840 against a six-figure book.
  //
  // STRIVEN IS NOT DISCARDED. Its figure is carried as `strivenOpen` and shown
  // on the card and in the drill, exactly as the commission page keeps
  // `strivenPayable` beside the sheet's number: a reader who remembers $11,422
  // must be able to find it and see why it differs.
  //
  // Falls back to Striven whole if the sheet is unreachable — one book at a
  // time either way, never a blend of the two.
  // OPEN BILLS ONLY — a credit note is not a bill anybody works off a worklist,
  // so it does not belong in a list called "Open Bills". It IS money off the
  // payable, though, so it stays in the AP Open headline, in the drill's
  // arithmetic and in the note under the table. The same split the AP Register
  // makes: counted out of the list, netted into the total.
  const ledgerOpenBills = useMemo(() => (apl?.bills ?? [])
    .filter((b) => b.open > 0.005)
    .map((b) => ({
      id: b.no, number: b.no, vendor: b.subLedger,
      dueDate: b.due || null, total: b.faceValue, open: b.open,
      currency: 'USD',
    })), [apl]);
  const useLedger = Boolean(apl?.ok && (apl.bills?.length ?? 0) > 0);
  const bills = useLedger ? ledgerOpenBills : (ap?.bills ?? []);
  const apOpen = useLedger ? (apl!.totals?.open ?? 0) : (ap?.totalOpen ?? 0);
  const apOpenBills = useLedger ? (apl!.totals?.openBills ?? 0) : (ap?.count ?? 0);
  const strivenOpen = ap?.totalOpen ?? 0;
  const strivenBills = ap?.count ?? 0;
  // The credit notes the list above deliberately excludes. `apOpen` is net of
  // them, the bill rows are not, and the gap is exactly this — so every place
  // the two figures appear together says so rather than leaving $51.20
  // unaccounted for.
  const creditNoteCount = useLedger ? (apl!.totals?.creditNotes ?? 0) : 0;
  const creditNoteAmount = useLedger ? (apl!.totals?.creditNoteAmount ?? 0) : 0;
  // What the bill rows themselves add up to, before the credit notes come off.
  // Rounded inline rather than through `r2`, which is declared further down and
  // would be in its temporal dead zone when this memo runs during render.
  const billsOnlyOpen = useMemo(
    () => Math.round(bills.reduce((s, b) => s + b.open, 0) * 100) / 100, [bills]);

  // ── BILLS PAID COMES FROM THE AP LEDGER SHEET ───────────────────────────────
  //
  // The card read Striven's bill-payment records, which hold exactly ONE
  // payment — BP-1, $840 to HiDow — so a page about payables reported $840
  // settled against a $104,948 book. The sheet's DEBIT column is where the
  // payments actually live: 50 rows, $74,265.17, across all six vendors.
  //
  // Striven's own record is kept as `striven` below and shown as a footnote,
  // not dropped. It is not wrong — it is one payment somebody entered there —
  // and a page that silently swapped its source would leave whoever remembers
  // the $840 unable to find it.
  const paidRows = useMemo(() => {
    const rows = apl?.payments ?? [];
    return rows.map((p, i) => ({ key: `${p.subLedger}-${p.date}-${i}`, vendor: p.subLedger, date: p.date, amount: p.amount }));
  }, [apl]);
  const paidTotal = apl?.totals?.paidRecorded ?? 0;
  // `paidImplied` is billed − outstanding: what the BILLS say was settled, as
  // against what the debit rows record. Equal today across every vendor, and
  // worth stating rather than assuming — the two are independent columns.
  const paidTies = apl?.totals != null
    && Math.abs((apl.totals.paidRecorded ?? 0) - (apl.totals.paidImplied ?? 0)) < 0.005;
  // WHAT THE CARD SHOWS, as against what the drill shows. Six vendors read at a
  // glance; fifty payments do not — and the card is a third of a row tall, so
  // the choice is which of the two it can actually answer. It takes "who was
  // paid, how much", and the payment-by-payment list moves behind the click.
  const paidVendors = useMemo(() => (apl?.subLedgers ?? [])
    .filter((g) => g.paymentRows > 0)
    .map((g) => ({ vendor: g.subLedger, rows: g.paymentRows, amount: g.paidRecorded }))
    .sort((a, b) => b.amount - a.amount), [apl]);

  // Aging by bill count for the toggle.
  const bucketK = (d: number) => (d <= 0 ? 'current' : d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90plus');
  const agingCount = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of bills) m[bucketK(daysPast(b.dueDate, refMs))] += 1;
    return m;
  }, [bills, refMs]);
  // Amount aging bucketed client-side so the as-of date applies.
  const agingEff = useMemo(() => {
    const m: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of bills) m[bucketK(daysPast(b.dueDate, refMs))] += b.open;
    return m;
  }, [bills, refMs]);

  // Top vendors by PO spend: brand-blue ranked bars, click to drill into POs.
  const vendorData = useMemo(
    () => [...(po?.byVendor ?? [])]
      .filter((v) => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 7)
      .map((v) => ({ name: v.vendor || '-', value: v.total })),
    [po],
  );
  function openVendorDrill(name: string) {
    const rows = (po?.recent ?? [])
      .filter((r) => (r.vendor || '-') === name)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((r) => ({ ref: r.ref || '-', date: fmtDate(r.date), amt: formatCurrency(r.total) }));
    setDrill({
      title: name, sub: `${rows.length} purchase order${rows.length === 1 ? '' : 's'} on record`,
      columns: [{ key: 'ref', label: 'PO ref' }, { key: 'date', label: 'Date' }, { key: 'amt', label: 'Amount', num: true }],
      rows,
    });
  }

  // Open-bills table: search → sort → paginate.
  const dueGroup = (b: typeof bills[number]) => { const d = daysPast(b.dueDate, refMs); return !b.dueDate ? 'upcoming' : d > 0 ? 'overdue' : d === 0 ? 'today' : 'upcoming'; };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bills.filter((b) =>
      (dueF === 'All' || dueGroup(b) === dueF) &&
      (!q || String(b.number).toLowerCase().includes(q) || (b.vendor || '').toLowerCase().includes(q)));
  }, [bills, query, dueF, refMs]);
  const sorted = useMemo(() => {
    const v = (b: typeof bills[number]): number => sort.key === 'total' ? b.total : sort.key === 'open' ? b.open
      : sort.key === 'days' ? daysPast(b.dueDate, refMs) : (b.dueDate ? new Date(b.dueDate).getTime() : 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort, refMs]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const fTotal = filtered.reduce((s, b) => s + (b.total || 0), 0);
  const fOpen = filtered.reduce((s, b) => s + (b.open || 0), 0);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // Export the filtered bills as CSV (client-side, nothing leaves the browser).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Bill #', 'Vendor', 'Due date', 'Total', 'Open', 'Days past due'].map(esc).join(','),
      ...sorted.map((b) => [b.number, b.vendor || '', b.dueDate?.slice(0, 10) || '', b.total, b.open, Math.max(0, daysPast(b.dueDate, refMs))].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'open-bills.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // Click an aging bar → the bills inside that bucket.
  const drillApBucket = (label: string) => {
    const inBucket = (b: typeof bills[number]) => {
      const d = daysPast(b.dueDate, refMs);
      const bl = d <= 0 ? 'Current' : d <= 30 ? '1–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+';
      return bl === label;
    };
    setDrill({
      title: `AP Aging · ${label}`, sub: label === 'Current' ? 'Bills not yet due' : `Bills ${label} days past due`,
      columns: [{ key: 'n', label: 'Bill #' }, { key: 'v', label: 'Vendor' }, { key: 'd', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
      rows: bills.filter((b) => b.open > 0 && inBucket(b)).sort((a, b) => b.open - a.open)
        .map((b) => ({ n: `#${b.number}`, v: b.vendor || '-', d: fmtDate(b.dueDate), o: formatCurrency(b.open) })),
    });
  };

  // ── Tap-to-explain drills ───────────────────────────────────────────────────
  // These exist to show HOW A HEADLINE IS MADE, so the column has to add up to
  // the total printed under it. Both are therefore in CENTS: at whole dollars
  // the PO breakdown listed $5,923 and $2,616 for figures of $5,922.81 and
  // $2,615.97, and a reader adding the column landed a dollar off the total
  // with no way to tell rounding from an error.
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // Off `agingEff`, which is bucketed client-side from the same rows the chart
  // and the table use, so the drill cannot disagree with either. It used to read
  // `ap.aging` — Striven's own buckets — which is a different book AND ignores
  // the "As of" date the rest of the page respects.
  const explainAp = () => setDrill({
    title: 'AP Open',
    sub: `Unpaid balance across every open vendor bill, split by days past due · ${useLedger ? 'AP ledger sheet' : 'Striven'} · as of ${asOfStr}`,
    ...kv([
      ...AGING_LABELS.map((b) => ({ k: b.label, v: formatCurrency(agingEff[b.key] || 0, true) })),
      // The buckets add to the BILLS, and AP Open is net of credit notes — so
      // the subtotal and the deduction are both shown. Printing the aged bands
      // straight above a headline $51.20 below their sum is the kind of gap a
      // reader has to take on trust, and should not have to.
      { k: `Open bills · ${bills.length}`, v: formatCurrency(billsOnlyOpen, true) },
      ...(creditNoteCount > 0
        ? [{ k: `Less ${creditNoteCount} credit note${creditNoteCount === 1 ? '' : 's'}`, v: formatCurrency(-creditNoteAmount, true) }]
        : []),
      { k: 'AP Open', v: formatCurrency(apOpen, true) },
      // The other book, named as such and BELOW the total so it cannot read as
      // part of it. Whoever remembers $11,422 finds it here with the reason.
      ...(useLedger ? [
        { k: `— Striven records ${strivenBills} open bill${strivenBills === 1 ? '' : 's'}`, v: formatCurrency(strivenOpen, true) },
        { k: '— difference: bills tracked only in the sheet', v: formatCurrency(r2(apOpen - strivenOpen), true) },
      ] : []),
    ]),
  });
  const explainPo = () => {
    // AGGREGATED HERE FROM `recent`, the unaggregated list of every active PO,
    // and deliberately NOT from `po.byVendor`.
    //
    // byVendor is capped at 12 vendors server-side and this drill then took the
    // top 5 of that, so it listed $110,178.78 under a printed Active total of
    // $111,089.28 — WMD ($840.50) and Wholesale Medical Devices ($70.00) simply
    // absent, and a $910.50 gap with nothing on screen to account for it. There
    // are only seven vendors in the book, so the cap was buying nothing and
    // costing the one property this dialog exists to have.
    //
    // Aggregating the full list makes the column sum to the total by
    // construction, whatever either cap does later.
    const m = new Map<string, number>();
    for (const p of (po?.recent ?? [])) {
      const v = p.vendor || 'Unknown';
      m.set(v, r2((m.get(v) ?? 0) + (p.total || 0)));
    }
    const vend = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const listed = r2(vend.reduce((s, [, t]) => s + t, 0));
    const total = po?.totalValue ?? 0;
    // Belt and braces. `recent` and `totalValue` are built from the same rows,
    // so this is $0.00 — and if it ever is not, the dialog says so rather than
    // printing a column that quietly disagrees with its own total.
    const gap = r2(total - listed);
    setDrill({
      title: 'PO Total',
      sub: `Value of ACTIVE purchase orders · ${po?.count ?? 0} POs across ${vend.length} vendor${vend.length === 1 ? '' : 's'} · cancelled, voided and demo POs are excluded and listed below the total for reference`,
      ...kv([
        ...vend.map(([v, t]) => ({ k: v, v: formatCurrency(t, true) })),
        ...(Math.abs(gap) >= 0.005 ? [{ k: 'Unallocated — vendors not itemised', v: formatCurrency(gap, true) }] : []),
        { k: 'Active total', v: formatCurrency(total, true) },
        // BELOW the total and named as excluded, not above it in the same
        // column. "Cancelled (excluded)" used to sit between the vendors and
        // the total, where it reads as another line being added in — summing
        // the column as printed gave $198,310, a number that means nothing.
        ...(po?.cancelledValue ? [{ k: `Excluded · cancelled or voided (${po.cancelledCount} POs)`, v: formatCurrency(po.cancelledValue, true) }] : []),
        ...(po?.demoValue ? [{ k: `Excluded · demo POs (${po.demoCount} POs)`, v: formatCurrency(po.demoValue, true) }] : []),
        ...(po?.pendingValue ? [{ k: `Excluded · not yet classified (${po.pendingCount} POs)`, v: formatCurrency(po.pendingValue, true) }] : []),
      ]),
    });
  };
  // THE PAYMENT-BY-PAYMENT LIST, which is the card's whole detail view now.
  //
  // The card used to hold this table inline, in a band the height of a chart —
  // about one and a half rows of fifty, under a scrollbar. A list that long has
  // to be somewhere you can read it, and a summary card is not that place.
  //
  // Newest first: a payment ledger is read from the most recent payment
  // backwards, and the sheet's own order is by vendor block, which answers a
  // question the vendor summary on the card already answers better.
  const explainPaid = () => setDrill({
    title: 'Bill Payment Details',
    sub: `Every payment in the AP ledger's Debit column · ${paidRows.length} payment${paidRows.length === 1 ? '' : 's'} across ${paidVendors.length} vendor${paidVendors.length === 1 ? '' : 's'} · ${formatCurrency(paidTotal)}${
      paidTies
        ? ' · ledger ties: the debits match what the bills imply was settled'
        : ` · ledger differs: ${formatCurrency(apl?.totals?.paidImplied ?? 0)} implied by the bills`
    }${(bp?.count ?? 0) > 0 ? ` · Striven separately records ${bp?.count} bill payment${(bp?.count ?? 0) === 1 ? '' : 's'} totalling ${formatCurrency(bp?.total ?? 0)}, included above rather than additional to it` : ''}`,
    columns: [{ key: 'v', label: 'Vendor' }, { key: 'd', label: 'Paid on' }, { key: 'a', label: 'Amount', num: true }],
    rows: [...paidRows]
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((p) => ({ v: p.vendor || '-', d: fmtDate(p.date), a: formatCurrency(p.amount) })),
  });

  const vendorRows = (vendors?.vendors ?? []).slice(0, VENDOR_CAP);
  const moreVendors = Math.max(0, (vendors?.vendors.length ?? 0) - vendorRows.length);
  const ready = !!ap;

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Payables</h1>
          <div className="page-sub">
            <span className="live-dot" /> {useLedger ? 'AP ledger' : 'Striven'} · {ready ? `${apOpenBills} open bills` : 'loading…'}{agoText ? ` · updated ${agoText}` : ''}
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
      {loading && !ap && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {/* Both cards read the AP LEDGER now, the same book Bills Paid uses,
                so billed − paid = open holds across the strip. The foot names
                the source rather than leaving two books to be told apart by
                whoever notices the arithmetic does not work. */}
            <KpiR ico="doc" tint="#0A369F" label="AP Open" value={apOpen} format={formatCurrency}
              deltaText={`${apOpenBills} open bills`}
              foot={useLedger ? 'AP ledger · net of credit notes' : 'Striven · ledger unavailable'}
              onClick={explainAp} />
            <KpiR ico="clip" tint="#16A34A" label="# Open Bills" value={apOpenBills}
              deltaText="awaiting payment"
              foot={useLedger ? `Striven records ${strivenBills}` : 'Striven AP aging'} />
            <KpiR ico="box" tint="#7C3AED" label="PO Total" value={po?.totalValue ?? 0} format={formatCurrency}
              deltaText={`${po?.count ?? 0} active POs`} foot={po?.cancelledCount ? `${po.cancelledCount} cancelled excluded` : 'active only'} onClick={explainPo} />
            {/* Same source as the card below. Leaving this on Striven's $840
                would have put two different "Bills Paid" figures on one screen,
                a tile and a card apart. */}
            <KpiR ico="wallet" tint="#D97706" label="Bills Paid" value={paidTotal} format={formatCurrency}
              deltaText={`${paidRows.length} payment${paidRows.length === 1 ? '' : 's'}`}
              foot="AP ledger · Debit column" onClick={explainPaid} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-4" title="Top Vendors by PO Spend" sub={`Active POs only${po?.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''} · click a bar`}>
              <RankBar data={vendorData} money colorAt={() => C.brand} onSelect={openVendorDrill} />
            </ChartCard>

            <ChartCard className="g12-4" title="AP Aging" sub="Open payables by days past due"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
                  <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
                </div>
              }>
              <AgingBar aging={agingMode === 'amount' ? agingEff : agingCount} money={agingMode === 'amount'} onSelect={drillApBucket} />
            </ChartCard>

            {/* Bills Paid sits here, so the row runs committed spend → what is
                overdue → what has actually been settled. Moved up from beneath
                the open-bills table, where it read as an appendix rather than
                the other half of the payables picture.

                `paid-card` is what makes it SIZE like the two charts beside it:
                everything under the head goes in one `paid-body` band fixed to
                the same 240px their `.chart-box` owns.

                IT SHOWS VENDORS, NOT PAYMENTS, and that is the point. This card
                held the fifty-row payment table inline, and a third of a row is
                about one and a half rows tall — so the table was unreadable AND
                the row was the wrong shape. Six vendors answer "who was paid,
                how much" inside the band with room to spare; the payment-level
                list is a click away, where there is height to read it. */}
            <div className="section chart-card g12-4 paid-card clickable"
              role="button" tabIndex={0}
              onClick={explainPaid}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); explainPaid(); } }}
              aria-label={`Bills Paid — open bill payment details, ${paidRows.length} payments`}>
              <div className="section-head">
                {/* NO SUBTITLE. It said where the figures come from and how the
                    card is grouped — both of which the card itself now shows:
                    the banner speaks for the ledger, the rows are plainly by
                    vendor, and the provenance sentence is in the dialog. Two
                    lines of caption to restate that was the least useful thing
                    in a band where every row of it costs a vendor. */}
                <div><h2 className="section-title">Bills Paid</h2></div>
                {/* The affordance is spelled out. A card that opens a dialog and
                    only hints at it with a hover lift is a card most people
                    never click. */}
                <span className="paid-more">Details →</span>
              </div>
              <div className="paid-body">
                {paidRows.length > 0 && (
                  <div className="paid-banner">
                    <span className="paid-banner-check">{paidTies ? '✓' : '•'}</span>
                    {/* Ties the two independent columns together, or names the gap.
                        The sheet records payments in Debit and outstanding in its
                        own column; billed − outstanding should equal the debits,
                        and saying so is what makes the figure checkable.

                        SHORT ON PURPOSE. The counts moved to the footer, where
                        they read as figures rather than prose, and the full
                        sentence is in the dialog's subtitle. What is left is one
                        line — which is what lets all six vendors below fit the
                        band without a scrollbar. */}
                    <span>
                      <strong>{paidTies ? 'Ledger ties.' : 'Ledger differs.'}</strong>{' '}
                      {paidTies
                        ? 'Debits match the bills.'
                        : `${formatCurrency(paidTotal)} vs ${formatCurrency(apl?.totals?.paidImplied ?? 0)} implied.`}
                    </span>
                  </div>
                )}
                <ul className="paid-vendors">
                  {paidVendors.map((v) => (
                    <li key={v.vendor}>
                      {/* Truncated with the full name on the title: these run to
                          "Doctors Medical, LLC / A&O Medical, LLC" and wrapping
                          one costs a whole other vendor's row. */}
                      <span className="pv-name" title={v.vendor}>{v.vendor || '-'}</span>
                      <span className="pv-n">{v.rows} pmt{v.rows === 1 ? '' : 's'}</span>
                      <span className="pv-amt">{formatCurrency(v.amount)}</span>
                    </li>
                  ))}
                  {paidVendors.length === 0 && (
                    <li className="pv-empty">{apl ? 'No payments recorded in the ledger.' : 'AP ledger unavailable.'}</li>
                  )}
                </ul>
                <div className="cfoot">
                  <div className="cf-i"><div className="l">Total Paid</div><div className="v pos">{formatCurrency(paidTotal)}</div></div>
                  <div className="cf-i" style={{ textAlign: 'center' }}><div className="l">Payments</div><div className="v">{paidRows.length.toLocaleString()}</div></div>
                  <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Vendors</div><div className="v">{paidVendors.length}</div></div>
                </div>
              </div>
            </div>

            <div className="section chart-card g12-6">
              <div className="section-head">
                <div><h2 className="section-title">Open Bills</h2><div className="section-sub">Unpaid vendor bills with a remaining balance</div></div>
                <div className="tbl-controls">
                  <input className="tbl-search" placeholder="Search bills / vendor" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  <select className="tbl-select" value={dueF} onChange={(e) => { setDueF(e.target.value as typeof dueF); setPage(1); }}>
                    <option value="All">All bills</option>
                    <option value="overdue">Overdue</option>
                    <option value="today">Due today</option>
                    <option value="upcoming">Upcoming</option>
                  </select>
                  <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered bills" onClick={exportCsv}>⤓ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Bill #</th>
                      <th>Vendor</th>
                      <th className="sortable" onClick={() => setSortKey('due')}>Due Date {sortInd('due')}</th>
                      <th className="num sortable" onClick={() => setSortKey('total')}>Total {sortInd('total')}</th>
                      <th className="num sortable" onClick={() => setSortKey('open')}>Open {sortInd('open')}</th>
                      <th className="num sortable" onClick={() => setSortKey('days')}>Days Past Due {sortInd('days')}</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((b) => {
                      const d = daysPast(b.dueDate, refMs);
                      return (
                        <tr key={b.id}>
                          <td><strong>#{b.number}</strong></td>
                          <td>{b.vendor || '-'}</td>
                          <td>{fmtDate(b.dueDate)}</td>
                          <td className="num">{formatCurrency(b.total)}</td>
                          <td className="num cell-neg">{formatCurrency(b.open)}</td>
                          <td className="num cell-neg">{d > 0 ? d : '-'}</td>
                          <td><DuePill dueDate={b.dueDate} refMs={refMs} /></td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr><td colSpan={7} style={{ color: C.muted }}>No bills match.</td></tr>
                    )}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td>{filtered.length} bill{filtered.length === 1 ? '' : 's'}</td>
                        <td></td>
                        <td className="num">{formatCurrency(fTotal)}</td>
                        <td className="num">{formatCurrency(fOpen)}</td>
                        <td></td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pgn">
                <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
                {/* WHY THE COLUMN AND THE HEADLINE DIFFER, stated on the page
                    rather than left to be discovered. The credit notes are off
                    this list because they are not bills to be paid, but they
                    are still money off what is owed, so AP Open is $51.20 lower
                    than the rows here add to. Unexplained, that gap reads as an
                    error in one of the two figures. */}
                {creditNoteCount > 0 && (
                  <span className="pgn-info" style={{ marginLeft: 'auto', paddingLeft: 12 }}>
                    Excludes {creditNoteCount} credit note{creditNoteCount === 1 ? '' : 's'} ({formatCurrency(creditNoteAmount)}) —
                    netted into AP Open, which reads {formatCurrency(apOpen)} against {formatCurrency(billsOnlyOpen)} of bills.
                  </span>
                )}
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

            {/* Vendors takes the full row now that Bills Paid has moved up. */}
            <div className="section chart-card g12-6">
              <div className="section-head"><div><h2 className="section-title">Vendors</h2><div className="section-sub">{vendors?.count ?? 0} suppliers on record · scroll for more</div></div></div>
              <div className="table-wrap" style={{ maxHeight: 430, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Terms</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorRows.map((v) => (
                      <tr key={v.id}>
                        <td><strong>{v.name || '-'}</strong></td>
                        <td><StatusPill status={v.status} /></td>
                        <td>{v.terms || '-'}</td>
                        <td>{formatPhone(v.phone)}</td>
                      </tr>
                    ))}
                    {vendorRows.length === 0 && (
                      <tr><td colSpan={4} style={{ color: C.muted }}>No vendors on record.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {moreVendors > 0 && <div className="muted-note">Showing first {VENDOR_CAP} of {vendors?.vendors.length ?? 0} vendors.</div>}
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
