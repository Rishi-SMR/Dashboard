import { useMemo, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, ChartCard, AgingBar, MonthBars, DrillModal } from '../chartKit';
import { fetchArRegister, type ArRegister, type ArRegisterInvoice } from '../strivenApi';
import { ColumnFilter } from './ColumnFilter';
import { downloadXlsx, printToPdf, stamped } from '../export';

// Programme colours, matching the vertical dots the rep tables use, so a
// vertical means the same thing at a glance wherever it appears.
const VERT_C: Record<string, string> = { PI: '#0A369F', VA: '#16A34A', TriCare: '#0D9488', DOL: '#7C3AED', DEMO: '#D97706' };

// ─────────────────────────────────────────────────────────────────────────────
// AR REGISTER — the invoice book, as its own page.
//
// Striven supplies the BOOK (which invoices exist, what is still open); the
// accountant's Sales_Activity_Report sheet supplies the DETAIL (invoice date,
// patient, PO memo, GL account). Driven off Striven deliberately: an invoice the
// sheet has not caught up with then shows as a row missing its detail — the
// `sheet ✗` badge — rather than silently shrinking the total. Invoice #116 is
// that row today.
//
// This tab's OUTSTANDING figure ties exactly to the AR Open tile on the AR / AP
// tab. Both net unapplied customer credits through one shared server-side rule
// (netOpenByInvoice). If the two ever disagree on screen, that is the first
// thing to look at — reading raw balances instead put $50,109.94 across 17
// invoices next to the tab's $35,075.99 across 11.
//
// PHI: every row names a patient. The name is reduced to initial + surname
// server-side before serialization; the full name never reaches this component.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 14;
type SortKey = 'no' | 'date' | 'due' | 'total' | 'expected' | 'open';
type Segment = 'all' | 'open' | 'paid' | 'zero-value';

/**
 * AR EXPECTED replaces the Payer column.
 *
 * The RULE lives on the server (arExpectedFor in _commission-config.js) and
 * arrives per row as `arExpected` — it is a money figure the business plans
 * against, so it is derived in one place rather than recomputed here where a
 * second copy of the rate could drift from the first.
 *
 * `expectedOf` exists only for the fallback: a browser holding a response
 * fetched before the server carried the field — an open tab across a deploy —
 * has `undefined`, and a bare `i.arExpected` would total the column to NaN and
 * render "$NaN" under every filter. Falling back to BILLED degrades to the
 * pre-feature reading rather than to a zero that looks like an answer.
 */
const expectedOf = (i: ArRegisterInvoice) =>
  (typeof i.arExpected === 'number' && Number.isFinite(i.arExpected) ? i.arExpected : num(i.total));
/** True where the PI lien rule cut the figure, so the row can say so. */
const isDiscounted = (i: ArRegisterInvoice) => i.arBasis === 'pi-15';

/**
 * ACTUAL COLLECTABLE — what an OPEN invoice is realistically worth.
 *
 * `arExpected` is the programme rule applied to the whole invoice; this applies
 * it to the part still outstanding. On a PI lien the two differ the moment
 * anything is part-paid, and the chase list cares about the remainder, not the
 * face value.
 *
 * PRO-RATED off `arExpected` rather than multiplying by 0.15 here. The rate
 * lives on the server (arExpectedFor) and a second copy in this file is exactly
 * the drift the AR EXPECTED comment above warns about — this way a change to
 * the lien rate, or a new programme with its own rule, flows through untouched.
 *
 * Zero on a settled invoice: nothing outstanding is nothing to collect.
 */
const collectableOf = (i: ArRegisterInvoice) => {
  const total = num(i.total);
  const open = num(i.open);
  if (open <= 0.005 || total <= 0.005) return 0;
  return expectedOf(i) * (open / total);
};

const fmtDate = (s: string) => {
  if (!s) return '-';
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const monthLabel = (m: string) => {
  const d = new Date(m + '-01T00:00:00');
  return Number.isNaN(d.getTime()) ? m : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};
const trunc = (v: string, n = 26) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);

/**
 * How a settled invoice was settled, read DEFENSIVELY.
 *
 * `cashPaid` / `creditApplied` are recent additions to the payload. A browser
 * holding a response fetched before the server carried them — an open tab across
 * a deploy is the everyday case — has `undefined` in both, and the naive read
 * turned every sum into NaN: the breakdown rendered "0 invoices / $0.00" under a
 * total of $250,883.33, which is worse than useless because it looks like an
 * answer.
 *
 * Missing credit reads as NO credit and cash falls back to `paid`, so an old
 * payload degrades to a correct-but-undetailed split that still adds up to the
 * total, rather than to zeros. `num()` also absorbs a null or a string amount,
 * either of which would poison the same sums.
 */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const PART = {
  creditApplied: (i: ArRegisterInvoice) => num(i.creditApplied),
  cashPaid: (i: ArRegisterInvoice) =>
    (typeof i.cashPaid === 'number' && Number.isFinite(i.cashPaid) ? i.cashPaid : num(i.paid) - num(i.creditApplied)),
  total: (i: ArRegisterInvoice) => num(i.total),
};

/** Status → the words shown to a reader. ONE map, used by both the pill below
 *  and the Status column filter, so a chip can never offer a label the table
 *  does not print. */
const STATUS_LABEL: Record<string, string> = {
  open: 'Open', paid: 'Paid', credited: 'Credit applied', 'zero-value': 'Zero value',
};
const statusLabel = (i: ArRegisterInvoice) => STATUS_LABEL[i.status] ?? i.status;

/**
 * Status → pill. `kind` decides before the amount does, because neither a
 * zero-value invoice nor one settled by an unapplied credit can be told apart
 * from an ordinary paid row by its balance alone.
 */
function statusTag(i: ArRegisterInvoice): ReactNode {
  if (i.status === 'zero-value') return <span className="pill-tag tag-muted">Zero value</span>;
  if (i.status === 'open') return <span className="pill-tag tag-danger">Open</span>;
  // Settled by a customer credit rather than by a payment against this invoice.
  // Six rows, and the reason the raw balances and the AR tile differ by
  // $15,033.95 until the credits are netted — worth naming rather than folding
  // into "Paid".
  if (i.status === 'credited') return <span className="pill-tag tag-warn">Credit applied</span>;
  return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>;
}

export function ArSheetTab() {
  const [reg, setReg] = useState<ArRegister | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [pickPayer, setPickPayer] = useState<Set<string>>(new Set());
  const [pickVert, setPickVert] = useState<Set<string>>(new Set());
  const [pickStatus, setPickStatus] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'no', dir: -1 });
  const [page, setPage] = useState(1);
  const [drill, setDrill] = useState<null | {
    title: string; sub: string;
    columns: { key: string; label: string; num?: boolean }[];
    rows: Record<string, ReactNode>[];
  }>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchArRegister()
      .then((r) => { setReg(r); if (r && r.ok === false) setLoadErr(r.note ?? 'AR register unavailable.'); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Could not reach the AR register.'));
  }, []);

  const INV: ArRegisterInvoice[] = useMemo(() => reg?.invoices ?? [], [reg]);
  const t = reg?.totals;

  // Payer options come from the rows themselves, so the filter can never offer
  // a payer with nothing behind it. Unassigned is a real bucket here — most
  // patient invoices carry no payer until the order is classified.
  // Same rule as the payer filter below: options come from the rows, so a
  // programme with nothing behind it is never offered. Unassigned is real —
  // two invoices resolve to no programme at all.
  const vertOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(i.vertical || 'Unassigned', (m.get(i.vertical || 'Unassigned') ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);
  // Same rule as the other two: options come from the ROWS, so a status with
  // nothing behind it is never offered.
  const statusOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(statusLabel(i), (m.get(statusLabel(i)) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);
  const payerOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(i.payer || 'Unassigned', (m.get(i.payer || 'Unassigned') ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INV.filter((i) => {
      // 'paid' means SETTLED, so it has to include the credit-settled rows —
      // otherwise the segments do not add back to the register.
      if (segment === 'paid' && !(i.status === 'paid' || i.status === 'credited')) return false;
      if (segment === 'open' && i.status !== 'open') return false;
      if (segment === 'zero-value' && i.status !== 'zero-value') return false;
      if (pickPayer.size && !pickPayer.has(i.payer || 'Unassigned')) return false;
      if (pickVert.size && !pickVert.has(i.vertical || 'Unassigned')) return false;
      if (pickStatus.size && !pickStatus.has(statusLabel(i))) return false;
      return !q || i.no.includes(q) || i.patient.toLowerCase().includes(q)
        || i.payer.toLowerCase().includes(q) || i.memo.toLowerCase().includes(q)
        || String(i.vertical || '').toLowerCase().includes(q);
    });
  }, [INV, query, segment, pickPayer, pickVert, pickStatus]);

  const sorted = useMemo(() => {
    const v = (i: ArRegisterInvoice) => (sort.key === 'no' ? Number(i.no) || 0
      : sort.key === 'total' ? i.total : sort.key === 'open' ? i.open
        : sort.key === 'expected' ? expectedOf(i)
          : new Date((sort.key === 'due' ? i.dueDate : i.date) + 'T00:00:00').getTime() || 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const fBilled = filtered.reduce((s, i) => s + i.total, 0);
  const fOpen = filtered.reduce((s, i) => s + i.open, 0);
  // Summed over the SAME rows the table renders, so the total answers for what
  // is on screen under whatever filter is applied — not for the whole register.
  const fExpected = filtered.reduce((s, i) => s + expectedOf(i), 0);

  const setKey = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
    setPage(1);
  };
  const ind = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  /** Excel of the rows AS FILTERED AND SORTED on screen. Amounts stay NUMERIC —
   *  formatCurrency would ship "$1,998.00" as text and break every sum. */
  function exportExcel() {
    const money = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
    const scope = [
      'AR Register',
      filtered.length === INV.length ? `all ${INV.length}` : `filtered: ${filtered.length} of ${INV.length}`,
      segment === 'all' ? 'all statuses' : segment === 'zero-value' ? 'zero value only' : `${segment} only`,
      pickPayer.size ? `payers: ${[...pickPayer].join(', ')}` : 'all payers',
      pickVert.size ? `verticals: ${[...pickVert].join(', ')}` : 'all verticals',
      pickStatus.size ? `status: ${[...pickStatus].join(', ')}` : 'all statuses',
    ].join(' · ');
    const rows: (string | number)[][] = [
      [scope],
      [],
      // Payer stays in the FILE even though it left the screen. A spreadsheet is
      // read away from the portal, where the payer cannot be looked up any other
      // way, and this sheet already carries columns the table does not (memo,
      // settled, sheet presence) — it is a superset, not a mirror.
      // 'AR expected basis' names the rule per row so a reader can tell a
      // discounted figure from a full one without recomputing it.
      ['Invoice number', 'Invoice date', 'Due date', 'Patient', 'Vertical', 'Payer', 'Patient PO / memo',
        'Billed', 'AR expected', 'AR expected basis', 'Settled', 'Outstanding', 'Status', 'In accountant sheet'],
      ...sorted.map((i) => [i.no, i.date, i.dueDate, i.patient, i.vertical || '', i.payer, i.memo,
        money(i.total), money(expectedOf(i)),
        isDiscounted(i) ? 'PI lien — 15% of billed' : 'Full billed amount',
        money(i.paid), money(i.open),
        i.status === 'credited' ? 'Paid (credit applied)' : i.status === 'zero-value' ? 'Zero value'
          : i.status === 'open' ? 'Open' : 'Paid',
        i.inSheet ? 'yes' : 'NO — Striven only']),
      [],
      // Padded to the header above: Billed is column 8 and AR expected 9, so the
      // two blanks after it hold the basis column's place before Settled.
      ['Total', '', '', `${filtered.length} invoices`, '', '', '',
        money(fBilled), money(fExpected), '', money(fBilled - fOpen), money(fOpen), '', ''],
    ];
    downloadXlsx([{ name: 'AR register', rows }], stamped('smr-ar-register', 'xlsx'));
  }

  // The category key MUST be `month` — the shared axis formatter reads that name,
  // and passing anything else renders a chart with no labels on its x-axis at
  // all, which is exactly what this was doing.
  //
  // EMPTY MONTHS ARE TRIMMED FROM THE ENDS ONLY. The register scaffolds every
  // month of the year, so the chart opened with Jan, Feb and Mar as three blank
  // columns and will grow a blank tail through to December — a third of the
  // axis spent on months nothing has happened in yet.
  //
  // Interior gaps are KEPT. A month with no billing between two months that had
  // some is a real fact about the book, and closing the gap would draw April
  // adjacent to June and quietly redraw the trend. Only the leading and
  // trailing runs go, because those are the calendar scaffold rather than
  // anything the business did.
  const monthAll = (reg?.byMonth ?? []).map((m) => ({ month: m.month, billed: m.billed, n: m.invoices }));
  const monthSeries = (() => {
    // BILLED VALUE is the test, not invoice count, because value is what this
    // chart draws. January is the case that decides it: it holds one invoice
    // billed at $0, so counting invoices would keep January — and with January
    // kept, February and March become interior gaps and survive too, leaving
    // the three blank columns exactly as they were. A month that plots nothing
    // is empty as far as a value chart is concerned.
    const has = (m: { billed: number }) => m.billed > 0;
    const first = monthAll.findIndex(has);
    if (first < 0) return monthAll;                   // nothing anywhere: leave it alone
    let last = monthAll.length - 1;
    while (last > first && !has(monthAll[last])) last -= 1;
    return monthAll.slice(first, last + 1);
  })();
  // What the trim removed. Counted so the subtitle can OWN the omission: a
  // hidden month that still holds an invoice puts that invoice beyond reach of
  // a chart whose whole affordance is "click a month for its invoices", and the
  // reader should learn that from the card rather than from the totals not
  // adding up.
  const monthHidden = monthAll.length - monthSeries.length;
  const monthHiddenInvoices = monthAll
    .filter((m) => !monthSeries.includes(m))
    .reduce((s, m) => s + m.n, 0);

  /**
   * The AR EXPECTED card's three figures.
   *
   * Read off the server's totals, with `billed` as the fallback for both of the
   * others: a payload from before the rule shipped carries neither, and
   * defaulting them to 0 would draw a card claiming the business expects to
   * collect nothing. Expected-equals-billed is the honest reading of "no rule
   * was applied".
   */
  // Headline for the ACTUAL COLLECTABLE tile: what the open book is really
  // worth, and how many of those invoices the lien rule discounts.
  const collectable = useMemo(() => {
    const open = INV.filter((i) => num(i.open) > 0.005);
    return {
      total: open.reduce((s, i) => s + collectableOf(i), 0),
      face: open.reduce((s, i) => s + num(i.open), 0),
      count: open.length,
      discounted: open.filter(isDiscounted).length,
    };
  }, [INV]);

  const arExp = (() => {
    const billed = num(t?.billed);
    const expected = typeof t?.arExpected === 'number' ? t.arExpected : billed;
    const discount = typeof t?.arDiscount === 'number' ? t.arDiscount : Math.max(0, billed - expected);

    // BY VERTICAL, because the blended 85.5% is not a rule anyone applies — it
    // is an accident of this month's mix. The rule is per programme: PI settles
    // out of a lien at 15% of face value, everything else is expected in full.
    // One headline hid that; the split states it.
    //
    // Cut from the invoice rows rather than from a server total, so it uses the
    // same `arExpected` the drill below lists and cannot disagree with it.
    const vm = new Map<string, { vertical: string; n: number; billed: number; expected: number }>();
    for (const i of INV) {
      const key = i.vertical || 'Unassigned';
      const e = vm.get(key) ?? { vertical: key, n: 0, billed: 0, expected: 0 };
      e.n += 1; e.billed += num(i.total); e.expected += expectedOf(i);
      vm.set(key, e);
    }
    const byVert = [...vm.values()]
      .filter((v) => v.billed > 0 || v.n > 0)
      .map((v) => ({ ...v, pct: v.billed > 0 ? (v.expected / v.billed) * 100 : 100 }))
      // Discounted programmes first — they are the reason the card exists — then
      // by size, so PI leads and VA follows it rather than burying it.
      .sort((a, b) => (a.pct - b.pct) || (b.billed - a.billed));

    return {
      billed,
      expected,
      discount,
      discounted: num(t?.arDiscounted),
      pct: billed > 0 ? Math.max(0, Math.min(100, (expected / billed) * 100)) : 0,
      byVert,
    };
  })();

  /**
   * ACTUAL COLLECTABLE, by programme and then invoice by invoice.
   *
   * The question this answers is "which vertical do I still have to collect
   * from, and how much is really there". OUTSTANDING alone overstates it badly:
   * PI's $31,075.99 of open face value is a lien worth $4,661.40, so a chase
   * list ordered by face value would put nearly all its effort on the smallest
   * real recovery.
   */
  const explainCollectable = () => {
    const open = INV.filter((i) => num(i.open) > 0.005);
    const m = new Map<string, ArRegisterInvoice[]>();
    for (const i of open) {
      const k = i.vertical || 'Unassigned';
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    const groups = [...m.entries()]
      .map(([vertical, rows]) => ({ vertical, rows }))
      .sort((a, b) => b.rows.reduce((s, i) => s + collectableOf(i), 0) - a.rows.reduce((s, i) => s + collectableOf(i), 0));
    const S = (rows: ArRegisterInvoice[], f: (i: ArRegisterInvoice) => number) => rows.reduce((s, i) => s + f(i), 0);
    setDrill({
      title: 'Actual collectable',
      sub: `${open.length} open invoice${open.length === 1 ? '' : 's'} · ${formatCurrency(S(open, (i) => num(i.open)), true)} outstanding at face · ${formatCurrency(S(open, collectableOf), true)} realistically collectable`,
      columns: [
        { key: 'k', label: 'VERTICAL' }, { key: 'n', label: 'OPEN INVOICES' },
        { key: 'face', label: 'OUTSTANDING (FACE)', num: true },
        { key: 'coll', label: 'ACTUAL COLLECTABLE', num: true },
        { key: 'rate', label: 'BASIS' },
      ],
      rows: [
        ...groups.map((g) => ({
          k: <span style={{ fontWeight: 800, color: VERT_C[g.vertical] ?? C.ink }}>{g.vertical}</span>,
          n: String(g.rows.length),
          face: formatCurrency(S(g.rows, (i) => num(i.open)), true),
          coll: <span className="cell-pos" style={{ fontWeight: 800 }}>{formatCurrency(S(g.rows, collectableOf), true)}</span>,
          rate: g.rows.every(isDiscounted)
            ? <span className="pill-tag tag-warn">lien · 15% of face</span>
            : g.rows.some(isDiscounted)
              ? <span className="pill-tag tag-warn">mixed</span>
              : <span className="pill-tag tag-ok">expected in full</span>,
        })),
        {
          k: <strong>TOTAL</strong>,
          n: <strong>{open.length}</strong>,
          face: <strong>{formatCurrency(S(open, (i) => num(i.open)), true)}</strong>,
          coll: <strong>{formatCurrency(S(open, collectableOf), true)}</strong>,
          rate: '',
        },
        // The worklist itself, hardest money first — ordered by what is really
        // recoverable, not by face value.
        { k: <span style={{ color: C.muted, fontSize: 12 }}>Every open invoice, by what is really recoverable</span>, n: '', face: '', coll: '', rate: '' },
        ...open.slice().sort((a, b) => collectableOf(b) - collectableOf(a)).map((i) => ({
          k: (
            <span style={{ paddingLeft: 10 }}>
              #{i.no} · {i.patient || '-'}
              <span style={{ color: VERT_C[i.vertical ?? ''] ?? C.muted, fontWeight: 700 }}> · {i.vertical || 'Unassigned'}</span>
            </span>
          ),
          n: <span style={{ color: C.muted }}>{i.dueDate ? `due ${fmtDate(i.dueDate)}` : 'no due date'}</span>,
          face: formatCurrency(num(i.open), true),
          coll: <span className="cell-pos">{formatCurrency(collectableOf(i), true)}</span>,
          rate: isDiscounted(i)
            ? <span style={{ fontSize: 11, color: C.muted }}>15% of face</span>
            : <span style={{ fontSize: 11, color: C.muted }}>full</span>,
        })),
      ],
    });
  };

  /** The invoices the lien rule actually bit, from the card's footer link. */
  const explainExpected = () => {
    // Identified by the RULE rather than by re-testing the vertical here: the
    // server stamps `arBasis`, and a second copy of "which invoices are PI"
    // living in the UI is how the two drift.
    const rows = INV.filter((i) => expectedOf(i) < num(i.total) - 0.005)
      .sort((a, b) => (num(b.total) - expectedOf(b)) - (num(a.total) - expectedOf(a)));
    if (!rows.length) return;
    const billed = rows.reduce((s, i) => s + num(i.total), 0);
    const exp = rows.reduce((s, i) => s + expectedOf(i), 0);
    setDrill({
      title: 'AR expected · PI lien discount',
      sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} · billed ${formatCurrency(billed, true)} · expected ${formatCurrency(exp, true)} · discount ${formatCurrency(billed - exp, true)}`,
      columns: [
        { key: 'no', label: 'INVOICE NUMBER' }, { key: 'd', label: 'INVOICE DATE' },
        { key: 'p', label: 'PATIENT' }, { key: 'b', label: 'BILLED', num: true },
        { key: 'e', label: 'EXPECTED', num: true }, { key: 'x', label: 'DISCOUNT', num: true },
      ],
      rows: rows.map((i) => ({
        no: <strong>#{i.no}</strong>, d: fmtDate(i.date), p: i.patient || '-',
        b: formatCurrency(num(i.total), true),
        e: formatCurrency(expectedOf(i), true),
        x: <span style={{ color: C.negative }}>−{formatCurrency(num(i.total) - expectedOf(i), true)}</span>,
      })),
    });
  };

  /** One month's invoices, from clicking its bar. */
  const explainMonth = (month: string) => {
    if (!month) return;
    const rows = INV.filter((i) => (i.date || '').slice(0, 7) === month)
      .sort((a, b) => Number(b.no) - Number(a.no));
    if (!rows.length) return;
    setDrill({
      title: monthLabel(month),
      sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} raised · ${formatCurrency(rows.reduce((s, i) => s + i.total, 0), true)}`,
      columns: [
        { key: 'no', label: 'INVOICE NUMBER' }, { key: 'd', label: 'INVOICE DATE' },
        { key: 'p', label: 'PATIENT' }, { key: 'a', label: 'BILLED', num: true },
        { key: 'o', label: 'OUTSTANDING', num: true }, { key: 's', label: 'STATUS' },
      ],
      rows: rows.map((i) => ({
        no: <strong>#{i.no}</strong>, d: fmtDate(i.date), p: i.patient || '-',
        a: formatCurrency(i.total, true),
        o: i.open > 0.005 ? formatCurrency(i.open, true) : '—',
        s: statusTag(i),
      })),
    });
  };

  /**
   * Total Billed → the invoice book below it.
   *
   * Clears every filter first, because the tile is a count of ALL invoices and
   * the table it scrolls to may be showing a subset. The scroll is deferred a
   * frame so it measures the table AFTER the reset has re-rendered it — resetting
   * a filter usually makes the table taller, and scrolling first lands short.
   *
   * `scroll-flash` is a brief outline on arrival: on a tall page the jump is
   * otherwise ambiguous about which card you were sent to.
   */
  const showBook = () => {
    setQuery(''); setSegment('all'); setPickPayer(new Set()); setPickVert(new Set()); setPage(1);
    requestAnimationFrame(() => {
      const el = printRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('scroll-flash');
      void el.offsetWidth;             // restart the animation if it is still running
      el.classList.add('scroll-flash');
      window.setTimeout(() => el.classList.remove('scroll-flash'), 1400);
    });
  };

  /**
   * COLLECTED, BROKEN DOWN BY WHERE THE MONEY CAME FROM.
   *
   * Two ways an invoice stops being outstanding, and they are not the same
   * money: cash banked against the invoice itself, or an unapplied credit
   * sitting on the customer's account being applied to it. Every column here is
   * summed off the SAME rows the register renders — `cashPaid`, `creditApplied`
   * and `open` add back to `total` on every row — so the drill cannot drift from
   * the tile that opened it. The TOTAL line is computed from the two rows above
   * it rather than read from `totals`, which is what makes the tie a fact rather
   * than a claim.
   */
  /**
   * The invoices behind the CASH column, from the Collected drill.
   *
   * The six credit-settled invoices were already itemised there — a credit is
   * unusual and wants evidence — while the 148 cash ones were a single figure
   * you had to take on trust. This is the same courtesy for the larger half.
   *
   * `label` and `back` are passed in so the one function serves both cash rows:
   * the pure-cash 148 and the part-cash 6 reach it with their own heading, and
   * the return link lands back on the summary rather than closing the modal.
   */
  const explainCash = (rows: ArRegisterInvoice[], label: string) => {
    const cash = rows.reduce((s, i) => s + PART.cashPaid(i), 0);
    setDrill({
      title: 'Cash collected',
      sub: `${label} · ${rows.length} invoice${rows.length === 1 ? '' : 's'} · ${formatCurrency(cash, true)} banked`,
      columns: [
        { key: 'b', label: '' },
        { key: 'no', label: 'INVOICE' }, { key: 'd', label: 'PAID / DATED' },
        { key: 'p', label: 'PATIENT' }, { key: 'vert', label: 'VERTICAL' },
        { key: 't', label: 'BILLED', num: true }, { key: 'c', label: 'CASH BANKED', num: true },
      ],
      rows: [
        // A way BACK. The modal's ✕ closes outright, which from a second level
        // loses the summary the reader drilled from.
        {
          b: <button className="card-link" style={{ margin: 0 }} onClick={explainCollected}>← Collected</button>,
          no: '', d: '', p: '', vert: '', t: '', c: '',
        },
        ...rows.slice().sort((a, b) => PART.cashPaid(b) - PART.cashPaid(a)).map((i) => ({
          b: '',
          no: <strong>#{i.no}</strong>,
          d: fmtDate(i.date),
          p: i.patient || '-',
          // THE PROGRAMME, not the payer. This column carried `payer` under a
          // PAYER heading — "Veterans Affairs", "Unassigned" — and simply
          // relabelling it would have printed a payer's name under a vertical's
          // heading. The invoice row carries a real `vertical`, so the column
          // now reads that. Tinted with the shared programme colours, so VA
          // means the same at a glance here as on every other tab.
          vert: i.vertical
            ? <span style={{ fontWeight: 700, color: VERT_C[i.vertical] ?? C.ink }}>{i.vertical}</span>
            : <span style={{ color: C.muted }}>Unassigned</span>,
          t: formatCurrency(num(i.total), true),
          c: <span className="cell-pos">{formatCurrency(PART.cashPaid(i), true)}</span>,
        })),
        {
          b: '', no: <strong>TOTAL</strong>, d: '', p: '', vert: '',
          t: <strong>{formatCurrency(rows.reduce((s, i) => s + num(i.total), 0), true)}</strong>,
          c: <strong>{formatCurrency(cash, true)}</strong>,
        },
      ],
    });
  };

  const explainCollected = () => {
    const settled = INV.filter((i) => i.status === 'paid' || i.status === 'credited');
    const S = (rows: ArRegisterInvoice[], k: 'cashPaid' | 'creditApplied' | 'total') =>
      rows.reduce((s, i) => s + PART[k](i), 0);
    const pure = settled.filter((i) => PART.creditApplied(i) <= 0.005);
    const mixed = settled.filter((i) => PART.creditApplied(i) > 0.005);
    // Grouped off the SAME `settled` set the rows above use, so the two blocks
    // cannot describe different populations. Largest first; an invoice with no
    // programme is its own bucket rather than being dropped, since dropping it
    // would make the block quietly sum to less than the total above it.
    const byVert = (() => {
      const m = new Map<string, ArRegisterInvoice[]>();
      for (const i of settled) {
        const k = i.vertical || 'Unassigned';
        m.set(k, [...(m.get(k) ?? []), i]);
      }
      return [...m.entries()]
        .map(([vertical, rows]) => ({ vertical, rows }))
        .sort((a, b) => S(b.rows, 'total') - S(a.rows, 'total'));
    })();
    const money = (n: number) => (n > 0.005 ? formatCurrency(n, true) : '—');
    const line = (label: ReactNode, rows: ArRegisterInvoice[]) => ({
      k: label,
      n: String(rows.length),
      billed: formatCurrency(S(rows, 'total'), true),
      cash: money(S(rows, 'cashPaid')),
      cr: money(S(rows, 'creditApplied')),
      tot: formatCurrency(S(rows, 'total'), true),
    });
    return setDrill({
      title: 'Collected',
      sub: `${settled.length} settled invoices · cash + credit = the collected total`,
      columns: [
        { key: 'k', label: 'HOW IT WAS SETTLED' }, { key: 'n', label: 'INVOICES' },
        // BILLED leads the money, so the row reads left to right as "this much
        // was invoiced, and here is how it came in".
        { key: 'billed', label: 'BILLED', num: true },
        { key: 'cash', label: 'CASH', num: true }, { key: 'cr', label: 'CREDIT', num: true },
        // COLLECTED, not TOTAL. On a settled invoice cash + credit equals the
        // billed amount exactly — verified across all 154 — so this column
        // carries the same figure as BILLED. It is kept as the CHECK that makes
        // the pair worth reading: the day a row marked settled still has a
        // residual, Billed will exceed Collected and the gap will be on screen
        // instead of hiding inside one merged column.
        { key: 'tot', label: 'COLLECTED', num: true },
      ],
      rows: [
        // The CASH figure opens the invoices behind it. The credit column is
        // already itemised further down, so only cash needed a way through.
        line(
          <button className="card-link" style={{ margin: 0 }}
            onClick={() => explainCash(pure, 'Paid in cash, no credit involved')}>
            Paid in cash, no credit involved →
          </button>,
          pure,
        ),
        line(
          <button className="card-link" style={{ margin: 0 }}
            onClick={() => explainCash(mixed, 'Part cash, remainder cleared by a customer credit')}>
            Part cash, remainder cleared by a customer credit →
          </button>,
          mixed,
        ),
        {
          k: <strong>TOTAL COLLECTED</strong>,
          n: <strong>{settled.length}</strong>,
          billed: <strong>{formatCurrency(S(settled, 'total'), true)}</strong>,
          cash: (
            <button className="card-link" style={{ margin: 0, fontWeight: 800 }}
              onClick={() => explainCash(settled, 'Every settled invoice')}>
              {formatCurrency(S(settled, 'cashPaid'), true)}
            </button>
          ),
          cr: <strong>{formatCurrency(S(settled, 'creditApplied'), true)}</strong>,
          tot: <strong>{formatCurrency(S(settled, 'total'), true)}</strong>,
        },
        // ── THE SAME MONEY, CUT BY PROGRAMME ────────────────────────────────
        // The two rows above answer "how was it settled"; these answer "what was
        // it for". Both add to the same 154 invoices and the same $255,004.26,
        // so the block is a second view of one total rather than a new figure —
        // which is why it sits under TOTAL COLLECTED and not beside it.
        ...(byVert.length > 1
          ? [
            { k: <span style={{ color: C.muted, fontSize: 12 }}>By vertical</span>, n: '', billed: '', cash: '', cr: '', tot: '' },
            ...byVert.map((v) => ({
              // Clickable through to the same cash drill, scoped to this
              // programme — the row a reader is most likely to want next.
              k: (
                <button className="card-link" style={{ margin: 0, paddingLeft: 10 }}
                  onClick={() => explainCash(v.rows, `${v.vertical} · settled`)}>
                  <span style={{ fontWeight: 800, color: VERT_C[v.vertical] ?? C.ink }}>{v.vertical}</span> →
                </button>
              ),
              n: String(v.rows.length),
              billed: formatCurrency(S(v.rows, 'total'), true),
              cash: money(S(v.rows, 'cashPaid')),
              cr: money(S(v.rows, 'creditApplied')),
              tot: formatCurrency(S(v.rows, 'total'), true),
            })),
          ]
          : []),
        // The mixed rows one by one, so the credit column is auditable rather
        // than a figure you have to take on trust.
        ...(mixed.length
          ? [{ k: <span style={{ color: C.muted, fontSize: 12 }}>The {mixed.length} invoices a credit was applied to</span>, n: '', billed: '', cash: '', cr: '', tot: '' }]
          : []),
        ...mixed.sort((a, b) => PART.creditApplied(b) - PART.creditApplied(a)).map((i) => ({
          k: <span style={{ paddingLeft: 10 }}>#{i.no} · {i.patient || '-'}</span>,
          n: '',
          billed: formatCurrency(i.total, true),
          cash: money(PART.cashPaid(i)),
          cr: money(PART.creditApplied(i)),
          tot: formatCurrency(i.total, true),
        })),
      ],
    });
  };

  return (
    // `ar-register` scopes this tab's own typography, the way `ap-register`
    // does — `exec-deck` is shared by a dozen tabs.
    <div className="exec-deck ar-register" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>AR Register</h1>
          <div className="page-sub">
            Every invoice raised · <b>{t?.invoices ?? 0}</b> invoices · book from Striven, detail from the <b>Sales Activity</b> sheet
            {reg?.fetchedAt && <> · read {new Date(reg.fetchedAt).toLocaleTimeString()}</>}
          </div>
        </div>
      </div>

      {loadErr && <div className="error" style={{ marginBottom: 12 }}>{loadErr}</div>}
      {!reg && !loadErr && <div className="page-sub" style={{ padding: 16 }}>Reading the invoice book…</div>}

      {reg?.ok && t && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
            {/* Straight to the invoice book. The tile counts EVERY invoice, so
                it clears the filters on the way down — landing on a table
                showing 12 rows under a headline of 164 would read as a
                contradiction rather than as a filter someone left on. */}
            <KpiR ico="doc" tint="#0A369F" label="Total Billed" value={t.billed} format={formatCurrency}
              deltaText={`${t.invoices} invoices`} foot="every invoice raised · click to open the book"
              onClick={showBook} />
            {/* Clickable: the split between cash banked and credit applied is
                the question this tile invites, and $17,687 of it is not what it
                looks like on the face of the card. */}
            <KpiR ico="wallet" tint="#16A34A" label="Collected" value={t.collected} format={formatCurrency}
              deltaText={`${t.collectedInvoices} settled`}
              // Same guard as the drill: an older payload has neither figure,
              // and `$- cash · $- credit` under a real total reads as breakage.
              foot={num(t.creditCollected) > 0
                ? `${formatCurrency(num(t.cashCollected))} cash · ${formatCurrency(num(t.creditCollected))} credit`
                : `${t.collectedInvoices} paid in full`}
              onClick={explainCollected} />
            <KpiR ico="cash" tint="#DC2626" label="Outstanding" value={t.outstanding} format={formatCurrency}
              deltaText={`${t.openInvoices} open invoices`} foot="net of customer credits" />
            <KpiR ico="clip" tint="#D97706" label="Open Invoices" value={t.openInvoices}
              deltaText="awaiting payment" foot="from the invoice book" />
            {/* ACTUAL COLLECTABLE sits beside OUTSTANDING deliberately: it is
                the same money, valued at what it is really worth. Outstanding is
                face value, and on a PI lien face value is ~6.7x the recovery —
                $31,075.99 of open PI is $4,661.40 of expected cash. A chase list
                built on the tile to its left would spend its effort backwards. */}
            <KpiR ico="cash" tint="#0D9488" label="Actual Collectable" value={collectable.total} format={formatCurrency}
              deltaText={`of ${formatCurrency(t.outstanding)} outstanding`}
              foot={collectable.discounted > 0
                ? `${collectable.discounted} PI lien${collectable.discounted === 1 ? '' : 's'} at 15% · click for the split`
                : 'every open invoice expected in full'}
              onClick={explainCollectable} />
            <KpiR ico="pie" tint="#7C3AED" label="Collection Rate" value={t.collectionRate}
              format={(n) => `${n.toFixed(1)}%`} deltaText="collected ÷ billed" foot="of everything invoiced" />
          </div>

          <div className="exec-grid12">
            {/* 4 / 3 / 5 rather than the old 5 / 7. AR EXPECTED is three figures
                and a bar, so it needs the least room of the three; the two
                charts keep the rest. */}
            <ChartCard className="g12-4" title="AR AGING" sub="Open receivables by days past due">
              <AgingBar aging={reg.aging} />
            </ChartCard>

            {/* WHAT THE BOOK SHOULD ACTUALLY COLLECT, against what it billed.
                The figure existed only as a phrase in the Invoice Book subtitle
                below, where the reader had to hold two totals in their head to
                see the gap. Here the gap IS the card. */}
            <ChartCard className="g12-4" title="AR EXPECTED" sub="PI settles at 15% of billed · every other programme in full">
              <div className="ar-exp">
                <div className="ar-exp-head">
                  <div>
                    <div className="ar-exp-v">{formatCurrency(arExp.expected, true)}</div>
                    <div className="ar-exp-l">of {formatCurrency(arExp.billed, true)} billed</div>
                  </div>
                  {/* The blended rate, labelled as blended. It is the OUTCOME of
                      the mix below, not a rule — saying so stops it being read
                      as a rate the business applies. */}
                  <div className="ar-exp-pct" title="Expected ÷ billed across every programme — an outcome of the mix, not a rate">
                    <b>{arExp.pct.toFixed(1)}%</b><span>blended</span>
                  </div>
                </div>
                <div className="ar-exp-bar" title={`${arExp.pct.toFixed(1)}% of billed is expected back`}>
                  <span style={{ width: `${arExp.pct}%` }} />
                </div>

                {/* THE RULE, PROGRAMME BY PROGRAMME. This is the card: one
                    blended figure said nothing about why $42k is missing. */}
                <div className="ar-exp-tbl">
                  <div className="ar-exp-tr is-head">
                    <span>Programme</span><span>Billed</span><span>Expected</span>
                  </div>
                  {arExp.byVert.map((v) => {
                    const cut = v.pct < 99.95;
                    return (
                      <div key={v.vertical} className={`ar-exp-tr${cut ? ' is-cut' : ''}`}
                        title={`${v.n} invoice${v.n === 1 ? '' : 's'} · ${cut ? `expected at ${v.pct.toFixed(0)}% of billed` : 'expected in full'}`}>
                        <span>
                          {v.vertical}
                          <i>{cut ? `${v.pct.toFixed(0)}%` : 'full'}</i>
                        </span>
                        <span>{formatCurrency(v.billed, true)}</span>
                        <span>{formatCurrency(v.expected, true)}</span>
                      </div>
                    );
                  })}
                  <div className="ar-exp-tr is-total">
                    <span>Total</span>
                    <span>{formatCurrency(arExp.billed, true)}</span>
                    <span>{formatCurrency(arExp.expected, true)}</span>
                  </div>
                </div>

                {arExp.discounted > 0 ? (
                  <button className="card-link ar-exp-foot" onClick={explainExpected}>
                    {arExp.discounted} PI invoice{arExp.discounted === 1 ? '' : 's'} discounted
                    {' '}−{formatCurrency(arExp.discount, true)} →
                  </button>
                ) : (
                  <div className="ar-exp-foot">No programme discount applies — every invoice is expected in full.</div>
                )}
              </div>
            </ChartCard>

            <ChartCard className="g12-4" title="BILLED BY MONTH"
              sub={`Invoice value raised each month · ${t.invoices} invoices · click a month for its invoices${
                monthHidden > 0
                  ? ` · ${monthHidden} month${monthHidden === 1 ? '' : 's'} with nothing billed hidden${
                    monthHiddenInvoices > 0
                      ? ` (holding ${monthHiddenInvoices} invoice${monthHiddenInvoices === 1 ? '' : 's'} at $0)`
                      : ''}`
                  : ''
              }`}>
              <MonthBars data={monthSeries} bars={[{ key: 'billed', name: 'Billed', color: C.brand }]}
                onSelect={explainMonth} />
            </ChartCard>

            <div className="section chart-card g12-12" ref={printRef}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">INVOICE BOOK</h2>
                  <div className="section-sub">
                    <b>{t.invoices}</b> invoices · billed <b>{formatCurrency(t.billed, true)}</b> ·
                    {' '}AR expected <b>{formatCurrency(t.arExpected ?? t.billed, true)}</b>
                    {/* Names the difference rather than leaving two totals side
                        by side for the reader to reconcile. Only shown when the
                        rule actually bit something. */}
                    {(t.arDiscounted ?? 0) > 0 && (
                      <span title={`${t.arDiscounted} PI invoice${t.arDiscounted === 1 ? '' : 's'} carried at 15% of billed`}>
                        {' '}(−{formatCurrency(t.arDiscount ?? 0, true)} PI lien)
                      </span>
                    )}
                    {' '}· outstanding <b style={{ color: C.negative }}>{formatCurrency(t.outstanding, true)}</b>
                  </div>
                </div>
                {/* Controls, not content: `no-print` keeps them off the PDF. */}
                <div className="tbl-controls no-print">
                  <input className="tbl-search" placeholder="Search invoice / patient / payer / PO"
                    value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  {/* The payer FILTER outlives the payer column. Dropping it with
                      the column would have quietly removed the only way to pin a
                      single law firm — the one thing payer is good for here,
                      since a PI invoice's payer is the firm and there are dozens.
                      It carries a visible label because, unlike a column header,
                      a bare funnel chip in a toolbar says nothing about what it
                      filters. */}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11.5, fontWeight: 700, color: C.muted, letterSpacing: '.04em' }}>
                    PAYER
                    <ColumnFilter label="Payer" options={payerOpts} picked={pickPayer}
                      onChange={(next) => { setPickPayer(next); setPage(1); }} />
                  </span>
                  {/* A filter left on is easy to forget and makes the totals look
                      wrong, so the way out is on screen whenever one applies. */}
                  {(query || segment !== 'all' || pickPayer.size > 0 || pickVert.size > 0 || pickStatus.size > 0) && (
                    <button className="btn ghost" style={{ padding: '7px 11px' }}
                      onClick={() => { setQuery(''); setSegment('all'); setPickPayer(new Set()); setPickVert(new Set()); setPickStatus(new Set()); setPage(1); }}>Reset</button>
                  )}
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={exportExcel}
                    title="Download these rows as an Excel workbook. Amounts stay numeric so they total in Excel.">⤓ Excel</button>
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={() => printToPdf(printRef.current)}
                    title="Open the print dialog: choose “Save as PDF” for a PDF of this table">⎙ PDF</button>
                </div>
              </div>

              {/* Open / Settled / Zero value are exhaustive and disjoint, so the
                  three counts always add back to the register. */}
              <div className="smr-seg no-print" style={{ marginBottom: 10 }}>
                {([['all', `All ${t.invoices}`], ['open', `Open ${t.openInvoices}`],
                  ['paid', `Settled ${t.collectedInvoices}`], ['zero-value', `Zero value ${t.zeroValue}`]] as [Segment, string][])
                  .map(([k, label]) => (
                    <button key={k} className={segment === k ? 'active' : ''}
                      onClick={() => { setSegment(k); setPage(1); }}>{label}</button>
                  ))}
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('no')}>INVOICE NUMBER {ind('no')}</th>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('date')}>INVOICE DATE {ind('date')}</th>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('due')}>DUE DATE {ind('due')}</th>
                      <th>PATIENT</th>
                      <th style={{ whiteSpace: 'nowrap' }}>
                        VERTICAL
                        <ColumnFilter label="Vertical" options={vertOpts} picked={pickVert}
                          onChange={(next) => { setPickVert(next); setPage(1); }} />
                      </th>
                      <th className="num sortable" onClick={() => setKey('total')}>BILLED {ind('total')}</th>
                      {/* Replaces PAYER. Sits immediately after BILLED because
                          the pair is only meaningful read together — the gap
                          between them IS the PI lien discount. */}
                      <th className="num sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('expected')}
                        title="What is expected to be received. PI settles out of a lien at 15% of billed; every other programme is expected in full.">
                        AR EXPECTED {ind('expected')}
                      </th>
                      <th className="num sortable" onClick={() => setKey('open')}>OUTSTANDING {ind('open')}</th>
                      <th style={{ whiteSpace: 'nowrap' }}>
                        STATUS
                        <ColumnFilter label="Status" options={statusOpts} picked={pickStatus}
                          onChange={(next) => { setPickStatus(next); setPage(1); }} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* ALL sorted rows render; off-page ones are hidden on screen
                        and revealed in print, so the PDF is the whole register
                        rather than page 1 of 12. */}
                    {sorted.map((i, n) => (
                      <tr key={i.no}
                        className={n >= (pageSafe - 1) * PAGE_SIZE && n < pageSafe * PAGE_SIZE ? undefined : 'pg-off'}>
                        <td>
                          <strong>#{i.no}</strong>
                          {/* Striven has it, the accountant's sheet does not.
                              Shown rather than hidden: making this visible is the
                              whole reason the book comes from Striven. */}
                          {!i.inSheet && (
                            <span className="pill-tag tag-warn" style={{ marginLeft: 6 }}
                              title="In Striven but not in the accountant's sheet">sheet ✗</span>
                          )}
                        </td>
                        <td>{fmtDate(i.date)}</td>
                        <td>{fmtDate(i.dueDate)}</td>
                        <td>{i.patient || '-'}</td>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: i.vertical ? 700 : 400, color: i.vertical ? (VERT_C[i.vertical] || C.sub) : C.muted }}>
                          {i.vertical || '-'}
                        </td>
                        <td className="num">{formatCurrency(i.total, true)}</td>
                        {/* A discounted row is MARKED, not just smaller. Without
                            the badge the only signal that a figure is 15% of
                            billed rather than equal to it is doing the division
                            in your head, and a reader scanning the column would
                            take a quietly reduced number at face value. */}
                        <td className="num" title={isDiscounted(i)
                          ? `PI lien: 15% of ${formatCurrency(i.total, true)} billed`
                          : 'Expected in full — no programme discount applies'}>
                          {formatCurrency(expectedOf(i), true)}
                          {isDiscounted(i) && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: C.muted }}>PI 15%</span>
                          )}
                        </td>
                        <td className={i.open > 0.005 ? 'num cell-neg' : 'num'}>
                          {i.open > 0.005 ? formatCurrency(i.open, true) : '-'}
                        </td>
                        <td>{statusTag(i)}</td>
                      </tr>
                    ))}
                    {sorted.length === 0 && <tr><td colSpan={9} style={{ color: C.muted }}>No invoices match.</td></tr>}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td>{filtered.length} invoice{filtered.length === 1 ? '' : 's'}</td>
                        {/* Four empties: due date, patient, vertical — and the
                            payer column is gone, so this is one SHORTER than it
                            was. Miscount it and the money lands under the wrong
                            heading, which is the failure this row invites. */}
                        <td /><td /><td />
                        <td className="num">{formatCurrency(fBilled, true)}</td>
                        <td className="num">{formatCurrency(fExpected, true)}</td>
                        <td className="num">{formatCurrency(fOpen, true)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {pages > 1 && (
                <div className="pgn no-print">
                  <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
                  <div className="pgn-pages">
                    <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                    {Array.from({ length: pages }, (_, i) => i + 1).slice(0, 8).map((p) => (
                      <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                    ))}
                    <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Where the register and the accountant's sheet disagree. At the FOOT
              of the tab: a caveat about the SOURCE, not something to read before
              the register itself — and stated rather than reconciled, since the
              difference is data entry, not a rule this code could apply. */}
          {(t.missingFromSheet > 0 || t.variances > 0 || t.apRowsExcluded > 0) && (
            <div className="qb-flash warn" style={{ marginTop: 12 }}>
              ⚠️ Against the accountant's sheet ({t.sheetRows} rows read):
              {t.missingFromSheet > 0 && <> <b>{t.missingFromSheet}</b> invoice{t.missingFromSheet === 1 ? '' : 's'} in Striven but not in the sheet ({formatCurrency(t.missingAmount, true)}), badged <b>sheet ✗</b> above.</>}
              {t.variances > 0 && <> <b>{t.variances}</b> amount{t.variances === 1 ? '' : 's'} disagree by {formatCurrency(t.varianceAmount, true)}.</>}
              {t.apRowsExcluded > 0 && <> <b>{t.apRowsExcluded}</b> rows on that sheet offset <i>Accounts Payable</i>, not receivable ({formatCurrency(Math.abs(t.apAmountExcluded), true)}) — excluded, since counting them would understate AR by exactly that.</>}
              {t.unappliedCredits > 0 && <> Outstanding is net of <b>{formatCurrency(t.unappliedCredits, true)}</b> in unapplied customer credits, the same basis the AR / AP tab reports on.</>}
            </div>
          )}
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows}
          onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
