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
 * THE ADVANCE IS IN.
 *
 * A settled invoice is one with nothing outstanding — paid, or cleared by a
 * customer credit — and on a PI lien the money that settles it IS the advance.
 * So this is the ledger's own answer to "has the 15% been received", read off
 * figures already on the row rather than inferred from anywhere else.
 *
 * WHAT IT CANNOT SEE is a part-payment: an invoice where the advance landed but
 * something is still owed reads as not-received here, because `open` alone
 * cannot say which tranche the shortfall belongs to. Every PI invoice in the
 * book today is wholly paid or wholly open, so nothing is misread right now —
 * but the first part-payment will be, and the answer then is the pipeline's
 * stage, not more arithmetic on this row.
 */
const advanceIn = (i: ArRegisterInvoice) => i.status === 'paid' || i.status === 'credited';

/**
 * WHAT A PI CASE WAS ACTUALLY BILLED.
 *
 * NOT the invoice. Striven bills the 15% lien advance and books THAT as the
 * invoice total, so the invoice figure is the advance and the sales order behind
 * it carries the real one — `orderTotal`, resolved server-side from the SO→
 * invoice chain and the patient-items report. #241 invoices $899.25 against
 * SO-207's $5,995.00.
 *
 * FALLS BACK TO THE INVOICE where the server found no larger order. That is not
 * a failure mode, it is the other true case: five PI rows were invoiced gross,
 * and the accountant's sheet carries them at exactly Striven's own figure.
 * Grossing those up would multiply a correct number by 6.67.
 */
const piGrossOf = (i: ArRegisterInvoice) =>
  (typeof i.orderTotal === 'number' && Number.isFinite(i.orderTotal) ? i.orderTotal : num(i.total));

/** The lien advance rate. Named because two rules now turn on it. */
const PI_ADVANCE_RATE = 0.15;

/**
 * AN ADVANCE BIGGER THAN THE LIEN RATE ALLOWS.
 *
 * On PI the invoice should be 15% of the order behind it. Where it is more,
 * one of two things is true and neither is visible from the row alone:
 *
 *   · THE INVOICE IS THE GROSS. Striven booked the whole bill rather than the
 *     advance, so `orderTotal` is null, the total falls back to the invoice and
 *     the ratio reads 100%. Five rows, and the accountant's sheet agrees with
 *     every one of them.
 *   · THE ORDER IS THE WRONG ONE. Where a patient has more than one order the
 *     customer-reference join cannot say which invoice belongs to which, and it
 *     takes the first. #170 reads 40% against an order that is almost certainly
 *     #72's.
 *
 * The first is correct data, the second is a bad join, and a reader cannot tell
 * them apart — which is exactly why the row is marked rather than quietly
 * averaged into a programme total. A tolerance of a cent absorbs rounding; this
 * is not meant to catch a rate struck a fraction off.
 */
const advanceOverRate = (i: ArRegisterInvoice) => {
  const gross = piGrossOf(i);
  if (gross <= 0.005) return false;
  return num(i.total) > r2(gross * PI_ADVANCE_RATE) + 0.01;
};

/** The invoice as a share of the order behind it. Null where there is no total
 *  to take a share OF. */
const advancePctOf = (i: ArRegisterInvoice) => {
  const gross = piGrossOf(i);
  return gross > 0.005 ? (num(i.total) / gross) * 100 : null;
};

/**
 * WHAT SHARE OF THE CASE THIS INVOICE IS.
 *
 * On a lien it should read 15% on every row, which is exactly what makes the
 * ones that do not worth printing: the number IS the flag, so the anomaly is
 * legible without a legend and without comparing two columns in your head.
 *
 * IT REPLACES A BARE "!". The mark said a row was wrong; this says by how much,
 * which is the difference between "look at this" and "look at this, it is the
 * whole bill" — 100% and 40% are different problems with different fixes.
 *
 * Whole percent: a lien struck at 15% either was or was not, and a decimal here
 * would invite reading rounding noise as a finding. The tooltip carries the
 * exact figures for anyone who needs them.
 */
function AdvancePct({ i }: { i: ArRegisterInvoice }) {
  const pct = advancePctOf(i);
  if (pct == null) return null;
  const over = advanceOverRate(i);
  return (
    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: over ? C.warning : C.muted }}
      title={over
        ? `${formatCurrency(num(i.total), true)} is ${pct.toFixed(1)}% of the ${formatCurrency(piGrossOf(i), true)} total, not 15%. Either this invoice is the whole bill rather than the advance, or it has been matched to the wrong sales order.`
        : `${formatCurrency(num(i.total), true)} of the ${formatCurrency(piGrossOf(i), true)} total — the lien advance`}>
      {pct.toFixed(0)}%
    </span>
  );
}

/**
 * THE PI BALANCE: WHAT THE CASE STILL OWES.
 *
 * NOT the ledger's `open`, which is what the INVOICE owes at face value — and
 * the invoice is only the advance. This is the lien's own arithmetic, and it
 * turns on one question: has the advance arrived?
 *
 *   advance received  →  total − advance. The 15% is in; the rest of the case
 *                        is what has yet to return.
 *   advance NOT in    →  the WHOLE total. Nothing has come back at all, so
 *                        deducting an advance that was never paid would
 *                        understate the exposure by exactly the amount still
 *                        being chased.
 *
 * NEVER ZERO on a real invoice, which is why the status column beside it cannot
 * be derived from this figure — it reads `advanceIn` directly instead.
 *
 * IT INHERITS advanceIn's BLIND SPOT, in the direction that overstates: a
 * part-paid invoice is not "settled", so it takes the whole-total branch even
 * where the advance has arrived. Nothing in the book is part-paid today. The
 * fix when one appears is the pipeline's stage, not deeper arithmetic here.
 */
const piBalanceOf = (i: ArRegisterInvoice) => {
  const gross = piGrossOf(i);
  const invoiced = num(i.total);
  // THE WHOLE BILL WAS INVOICED — nothing is coming after it.
  //
  // These are the rows marked at 100%: no lien tranche was struck, so there is
  // no second payment to wait for and the case owes nothing beyond the invoice
  // itself. Whether that invoice has been PAID is the status column's question,
  // not this one — this column reports what is still to come, and for these
  // rows the answer is nothing.
  //
  // Checked before the advance branch, because it outranks it: an unpaid
  // 100% row would otherwise take the "nothing has arrived, so the whole total
  // is out" path and report a second tranche that does not exist.
  if (Math.abs(gross - invoiced) <= 0.005) return 0;
  return advanceIn(i) ? r2(gross - invoiced) : gross;
};

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
/**
 * WHAT THIS INVOICE STILL OWES. The one figure the dashboard reports.
 *
 * Outstanding, Actual Collectable and AR Receivable are three tiles asking the
 * same question, and they were answering it three ways. They all read this now,
 * so the dashboard cannot show a reader two totals for one book.
 *
 *   PI       `piBalanceOf` — the case less whatever advance has arrived. The
 *            ledger cannot answer for PI: its invoice is only the 15% advance,
 *            so an invoice with `open = 0` is a settled ADVANCE, not a settled
 *            case, and the remaining 85% is still to come.
 *   the rest the ledger's open balance. Billed and paid in one go, so what is
 *            owed is simply what has not been paid.
 */
const owedOf = (i: ArRegisterInvoice) =>
  (vertOf(i) === 'PI' ? piBalanceOf(i) : num(i.open));

/** Kept as the name the collectable card and its drill were written against. */
const collectableOf = (i: ArRegisterInvoice) => owedOf(i);

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

/** Two decimals, the way the server rounds every total it sends. Kept so the
 *  per-vertical headline is the same arithmetic as the register-wide one and
 *  not a float tail away from it. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The residue bucket: an invoice the server could join to no programme. */
const UNASSIGNED = 'Unassigned';
/** The programme a row belongs to, with that residue named rather than blank. */
const vertOf = (i: ArRegisterInvoice) => i.vertical || UNASSIGNED;
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
/**
 * THE PI BOOK'S STATUS. PAID MEANS FULLY SETTLED — nothing less.
 *
 * On a lien the advance arriving is not the case being paid; it is the first of
 * two tranches, and the invoice still has its balance to return. Calling that
 * "Paid" told a reader the case was closed while 85% of it was outstanding, and
 * on a chase list that is the one thing a status must never get wrong.
 *
 * So there are three states, not two, and the middle one is where the whole
 * book currently sits:
 *
 *   Paid        the balance is settled — the case has returned in full
 *   Partially Paid (Advance)
 *               the 15% arrived, the balance has not. The green figure beside
 *               it says the same thing; this says it in words
 *   Open        nothing has come back at all — not even the advance, so the
 *               WHOLE total is outstanding and the invoice is open in the
 *               ordinary sense the rest of the register uses the word
 *
 * NOTHING CAN REACH 'Paid' ON TODAY'S DATA, and that is worth being plain
 * about rather than hiding behind a condition that never fires. `piBalanceOf`
 * is invoiced − advance once the advance is in, which is structurally 85% of
 * the invoice and never zero: the portal holds no signal for the settlement
 * arriving. The test is written against the balance because that IS the right
 * rule; it starts returning Paid the moment something can tell us a case
 * settled — the pipeline's 'Waiting for settlement' stage clearing, or a
 * ledger that records the second tranche.
 *
 * ZERO-VALUE IS ITS OWN ANSWER. An invoice that billed nothing has no advance
 * and no balance; filing it under either Paid or Open would claim something
 * about money that was never owed.
 */
function piStatusText(i: ArRegisterInvoice): string {
  if (i.status === 'zero-value') return 'Zero value';
  // NOTHING RECEIVED IS OPEN, WHATEVER THE BALANCE SAYS. Not a cent has arrived
  // — not even the advance — so the whole case is outstanding, and "open" is what
  // the rest of the register calls that.
  //
  // Tested FIRST because a 100%-invoiced row carries a zero balance the moment
  // it is raised (there is no second tranche to wait for), and reading Paid off
  // that alone would call an untouched invoice settled.
  if (!advanceIn(i)) return 'Open';
  // Received, and nothing further to come: the case is closed. Reachable only
  // where the whole bill was invoiced; a 15% advance always leaves a balance.
  if (piBalanceOf(i) <= 0.005) return 'Paid';
  return 'Partially Paid (Advance)';
}

/** ONE definition of the three states, so the pill, the filter chip and the
 *  workbook cannot drift apart on what a row is called. */
function piStatusTag(i: ArRegisterInvoice): ReactNode {
  const label = piStatusText(i);
  if (label === 'Zero value') return <span className="pill-tag tag-muted">Zero value</span>;
  if (label === 'Paid') return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>;
  // GREEN paid · AMBER partially paid · RED open, per the agreed key. The pill
  // grounds already carry those three, so the colour and the words say the same
  // thing and neither has to be read against a legend elsewhere.
  return label === 'Partially Paid (Advance)'
    ? <span className="pill-tag tag-warn" title="The 15% advance has been received. The balance is still outstanding, so the case is not settled.">Partially Paid (Advance)</span>
    : <span className="pill-tag tag-danger" title="Nothing has been received on this invoice — not even the advance — so the whole total is outstanding.">Open</span>;
}

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
  /**
   * WHICH VERTICAL'S BOOK IS ON SCREEN. 'all' is the whole register.
   *
   * A TAB, NOT A FILTER, and the difference is what the headline says. The
   * VERTICAL column filter this replaces narrowed the ROWS and left the totals
   * above them describing the register — so picking PI drew a table of 154
   * under a headline of 196 invoices and $312,919.90 billed, and the reader
   * had no way to tell which of the two numbers was about what they could see.
   * Everything scopes to this now: the totals line, the status counts, the
   * table, and both exports.
   */
  const [vert, setVert] = useState<string>('all');
  const [pickStatus, setPickStatus] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'no', dir: -1 });
  const [page, setPage] = useState(1);
  const [drill, setDrill] = useState<null | {
    title: string; sub: string;
    columns: { key: string; label: string; num?: boolean }[];
    rows: Record<string, ReactNode>[];
    /** Optional column totals, pinned to the foot of the dialog. */
    total?: Record<string, ReactNode>;
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
  const vertTabs = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(vertOf(i), (m.get(vertOf(i)) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      // Biggest book first, but Unassigned pinned last whatever its size: it is
      // the residue, not a programme, and it should not sit between two that are.
      .sort((a, b) => Number(a.value === UNASSIGNED) - Number(b.value === UNASSIGNED)
        || b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);

  /**
   * PI'S BOOK SPEAKS PI'S LANGUAGE.
   *
   * The same three columns carrying the same three figures — the words the lien
   * business actually uses for them. A PI invoice is not "billed and
   * outstanding": it is INVOICED, the funder ADVANCES 15% of that against the
   * lien, and what is left is the BALANCE still outstanding on the case.
   *
   * ONLY ON THE PI TAB, and that is the whole reason this is keyed to the tab
   * rather than done once in the header. On 'All verticals' the same column
   * holds VA and TriCare rows, where there is no advance and no lien and every
   * invoice is expected in full — "ADVANCE 15%" over that column would be false
   * about three quarters of the register.
   */
  const isPi = vert === 'PI';
  /**
   * IS THIS ROW PI — as against `isPi`, which is "is the PI TAB open".
   *
   * The two are the same thing only on the PI tab. Everywhere a row is DRAWN,
   * this is the one that matters: on "All verticals" a PI invoice is still a PI
   * invoice, and gating its status, its percentage and its highlight on the tab
   * meant the same row read one way on one tab and another way on another. The
   * money columns were fixed for this already; the annotations around them were
   * not.
   *
   * `isPi` still governs what is TAB-level and genuinely so: the column
   * headings, the running words in the totals line, and which columns the
   * workbook carries.
   */
  const rowIsPi = (i: ArRegisterInvoice) => vertOf(i) === 'PI';
  // TOTAL and INVOICED read the same on every tab now: the first column is what
  // the case was billed, the second what Striven invoiced against it. Only the
  // last still varies, because on PI it is the case balance rather than the
  // invoice's.
  const COL = { billed: 'TOTAL', expected: 'INVOICED', open: isPi ? 'BALANCE OUTSTANDING' : 'OUTSTANDING' };
  /** The same three words in running text, for the totals line. */
  const WORD = {
    billed: 'total',
    expected: isPi ? 'invoiced (advance)' : 'invoiced',
    open: isPi ? 'balance outstanding' : 'outstanding',
  };

  /**
   * THE THREE MONEY COLUMNS, as one definition each.
   *
   * The PI book reports the CASE, not the invoice: the order's value, the 15%
   * advance Striven invoiced against it, and what is still to come. Every other
   * programme bills and expects the same figure, so nothing moves there.
   *
   * Defined once because five things have to agree — the cell, the sort, the
   * headline, the TOTAL row and the workbook — and a sixth reading of "billed"
   * introduced later is how a column comes to disagree with its own total.
   */
  // KEYED ON THE ROW'S PROGRAMME, not on the open tab. Gated on `isPi` these
  // reverted to the invoice basis the moment you left the PI tab, so "All
  // verticals" reported PI at its advance and the header disagreed with every
  // other card on the page.
  const billedOf = (i: ArRegisterInvoice) => (vertOf(i) === 'PI' ? piGrossOf(i) : num(i.total));
  const expOf = (i: ArRegisterInvoice) => (vertOf(i) === 'PI' ? num(i.total) : expectedOf(i));

  /**
   * WHAT THE LAST MONEY COLUMN REPORTS, for one row.
   *
   * Defined once because four things have to agree about it — the cell, the
   * sort, the TOTAL row and the workbook — and a fifth reading of "outstanding"
   * added later is how a column comes to disagree with its own total.
   */
  const openOf = owedOf;

  /** The book on screen: every invoice in the picked vertical, BEFORE search,
   *  status or payer narrows it any further. */
  const inVert = useMemo(
    () => (vert === 'all' ? INV : INV.filter((i) => vertOf(i) === vert)),
    [INV, vert],
  );

  /**
   * THE HEADLINE FOR THE BOOK ON SCREEN, and the status counts under it.
   *
   * Summed from the rows rather than read off `reg.totals`, because those are
   * register-wide and there is no per-vertical set to ask the server for. That
   * is not a second source of truth: the server builds its totals from the same
   * per-row figures this table renders (see the `totals` note in strivenApi.ts),
   * so 'all' still agrees with it to the cent — and the verticals now add back
   * to 'all' by construction rather than by coincidence.
   *
   * The three status counts belong here for the same reason. Open / Settled /
   * Zero value have to partition the BOOK above them; left on the register's
   * figures they would have gone on claiming 196 under a book of 38.
   */
  const book = useMemo(() => {
    // OPEN-STATUS ROWS ONLY for the outstanding figure, which is how the server
    // sums its own (`outstanding = sum(openRows, 'open')`). Every settled row
    // carries open = 0 so the two agree today; matching the DEFINITION rather
    // than relying on that is what keeps them agreeing.
    const openRows = inVert.filter((i) => i.status === 'open');
    const billed = r2(inVert.reduce((s, i) => s + billedOf(i), 0));
    const arExpected = r2(inVert.reduce((s, i) => s + expOf(i), 0));
    return {
      invoices: inVert.length,
      billed,
      arExpected,
      arDiscount: Math.max(0, r2(billed - arExpected)),
      arDiscounted: inVert.filter(isDiscounted).length,
      // THE HEADLINE IS THE SUM OF THE COLUMN UNDER IT. On the PI tab that
      // column is the lien balance, not the ledger's open figure, and totalling
      // the one while printing the other is the exact mismatch the per-vertical
      // totals were introduced to close.
      // openOf ALREADY asks what programme each ROW is, so one sum serves every
      // tab. The ternary here undid that: off the PI tab it fell back to the
      // ledger's open balance, and "All verticals" reported $85,754.19 while the
      // tiles above it reported $307,764.55 for the same book.
      outstanding: r2(inVert.reduce((s, i) => s + openOf(i), 0)),
      openInvoices: openRows.length,
      // SETTLED is paid OR credit-applied — the same union the segment filter
      // uses. Counting only 'paid' would leave the three tabs short of the book.
      collectedInvoices: inVert.filter((i) => i.status === 'paid' || i.status === 'credited').length,
      zeroValue: inVert.filter((i) => i.status === 'zero-value').length,
    };
  }, [inVert, isPi]);
  // Same rule as the other two: options come from the ROWS, so a status with
  // nothing behind it is never offered.
  /** What the STATUS column actually prints for a row, on whichever tab is
   *  open. The filter below and the workbook both go through this, so a chip can
   *  never offer a label the table does not print — the rule STATUS_LABEL was
   *  written for, now that the PI book prints a different vocabulary. */
  const statusTextOf = (i: ArRegisterInvoice) => (rowIsPi(i) ? piStatusText(i) : statusLabel(i));
  const statusOpts = useMemo(() => {
    const m = new Map<string, number>();
    // Off the rows IN VIEW, not the whole register: on the PI tab a chip built
    // from every invoice would offer statuses no PI row can have, and count them
    // against verticals this table is not showing.
    for (const i of inVert) m.set(statusTextOf(i), (m.get(statusTextOf(i)) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inVert, isPi]);
  const payerOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(i.payer || 'Unassigned', (m.get(i.payer || 'Unassigned') ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inVert.filter((i) => {
      // 'paid' means SETTLED, so it has to include the credit-settled rows —
      // otherwise the segments do not add back to the register.
      if (segment === 'paid' && !(i.status === 'paid' || i.status === 'credited')) return false;
      if (segment === 'open' && i.status !== 'open') return false;
      if (segment === 'zero-value' && i.status !== 'zero-value') return false;
      if (pickPayer.size && !pickPayer.has(i.payer || UNASSIGNED)) return false;
      if (pickStatus.size && !pickStatus.has(statusTextOf(i))) return false;
      return !q || i.no.includes(q) || i.patient.toLowerCase().includes(q)
        || i.payer.toLowerCase().includes(q) || i.memo.toLowerCase().includes(q)
        || String(i.vertical || '').toLowerCase().includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inVert, query, segment, pickPayer, pickStatus, isPi]);

  const sorted = useMemo(() => {
    const v = (i: ArRegisterInvoice) => (sort.key === 'no' ? Number(i.no) || 0
      : sort.key === 'total' ? billedOf(i) : sort.key === 'open' ? openOf(i)
        : sort.key === 'expected' ? expOf(i)
          : new Date((sort.key === 'due' ? i.dueDate : i.date) + 'T00:00:00').getTime() || 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort, isPi]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const fBilled = filtered.reduce((s, i) => s + billedOf(i), 0);
  const fOpen = filtered.reduce((s, i) => s + openOf(i), 0);
  const fPaid = filtered.reduce((s, i) => s + num(i.paid), 0);
  // Summed over the SAME rows the table renders, so the total answers for what
  // is on screen under whatever filter is applied — not for the whole register.
  const fExpected = filtered.reduce((s, i) => s + expOf(i), 0);

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
      // FIRST, because it is the book this file is OF. Counted against the
      // vertical rather than the register below it, so "all 154" means the
      // whole PI book and not 154 of 196.
      vert === 'all' ? 'all verticals' : `vertical: ${vert}`,
      filtered.length === inVert.length ? `all ${inVert.length}` : `filtered: ${filtered.length} of ${inVert.length}`,
      segment === 'all' ? 'all statuses' : segment === 'zero-value' ? 'zero value only' : `${segment} only`,
      pickPayer.size ? `payers: ${[...pickPayer].join(', ')}` : 'all payers',
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
      // The three money headings follow the SCREEN they were exported from. A
      // workbook of the PI book headed "Billed / AR expected" is read away from
      // the portal by someone who asked for invoiced and advance, with nothing on
      // the sheet tying the two vocabularies together. The scope line above
      // already names the vertical, so the words cannot be ambiguous.
      ['Invoice number', 'Invoice date', 'Due date', 'Patient', 'Vertical', 'Payer', 'Patient PO / memo',
        'Total', 'Invoiced', 'AR expected basis',
        'Settled', isPi ? 'Balance outstanding' : 'Outstanding', 'Status', 'In accountant sheet',
        // Colour does not survive an export, so what the green SAYS ships as a
        // column of its own rather than being lost on the way to the file.
        ...(isPi ? ['Advance received'] : [])],
      ...sorted.map((i) => [i.no, i.date, i.dueDate, i.patient, i.vertical || '', i.payer, i.memo,
        money(billedOf(i)), money(expOf(i)),
        isDiscounted(i) ? 'PI lien — 15% of billed' : 'Full billed amount',
        money(i.paid), money(openOf(i)),
        // The PI book collapses four states to two on screen; the workbook says
        // the same two, or it is a different report of the same rows.
        rowIsPi(i)
          ? piStatusText(i)
          : i.status === 'credited' ? 'Paid (credit applied)' : i.status === 'zero-value' ? 'Zero value'
            : i.status === 'open' ? 'Open' : 'Paid',
        i.inSheet ? 'yes' : 'NO — Striven only',
        ...(isPi ? [rowIsPi(i) && advanceIn(i) ? 'yes' : 'no'] : [])]),
      [],
      // Padded to the header above: Billed is column 8 and AR expected 9, so the
      // two blanks after it hold the basis column's place before Settled.
      ['Total', '', '', `${filtered.length} invoices`, '', '', '',
        money(fBilled), money(fExpected), '', money(fPaid), money(fOpen), '', '',
        ...(isPi ? [''] : [])],
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
  /**
   * EVERYTHING BILLED, on the same basis the book below reports.
   *
   * NOT the server's `t.billed`, which sums what Striven INVOICED — and on PI
   * that is the 15% lien advance, not what the case was billed. The tile read
   * $364,936.60 while the invoice book it opens read $612,826.95, a $247,890.35
   * gap on one screen between a tile and the table it links to.
   */
  const totalBilled = r2(INV.reduce((s2, i) => s2 + billedOf(i), 0));

  const collectable = useMemo(() => {
    // OWED, not `open`. A PI invoice whose advance has been paid has open = 0 and
    // 85% of the case still to come; filtering on the ledger dropped exactly the
    // rows this tile exists to chase.
    const open = INV.filter((i) => owedOf(i) > 0.005);
    return {
      total: open.reduce((s, i) => s + collectableOf(i), 0),
      face: open.reduce((s, i) => s + num(i.open), 0),
      count: open.length,
    };
  }, [INV]);

  /**
   * COLLECTED AND THE RATE, on the same basis as the two tiles beside them.
   *
   * Stated as billed LESS what is still owed, not summed from the ledger's
   * `paid`. The server's `t.collected` counts cash against INVOICES, and on PI
   * the invoice is the 15% advance — so it reported $279,182.41 sitting between
   * a Total Billed of $612,826.95 and an Outstanding of $307,764.55, three
   * adjacent tiles that did not add up.
   *
   * Derived rather than summed for the same reason the drills derive theirs:
   * three figures that subtract to each other cannot drift apart.
   */
  const totalCollected = r2(totalBilled - collectable.total);
  const collectionRate = totalBilled > 0 ? r2((totalCollected / totalBilled) * 100) : 0;

  /**
   * THE CARD'S TWO FIGURES, PER ROW — keyed on the ROW's programme, not on the
   * open tab, because this card describes the whole register at once.
   *
   * On PI, BILLED is the sales order and RECEIVABLE is what is STILL TO COME on
   * it — the case less whatever advance has already been received, which is the
   * same `piBalanceOf` the book, both drills and this card's own footer report.
   * The footer used to quote a figure the column above it did not; they are now
   * the same number.
   *
   * RECEIVABLE IS WHAT IS STILL OWED — one meaning, across the whole card. It
   * took two forms only because the programmes are collected differently:
   *
   *   PI       the case less whatever advance has arrived — `piBalanceOf`, the
   *            same figure the book, both drills and this card's footer report.
   *            A settled PI invoice is not the end of the case, so the ledger's
   *            `open` cannot answer for it.
   *   the rest the OPEN invoices. Every other programme bills and is paid in one
   *            go, so what is receivable is simply what has not been paid.
   *
   * IT USED TO REPORT WHAT WAS EXPECTED ON THE WHOLE BOOK, settled invoices
   * included, which is a different question and not the one the heading asks:
   * VA read $277,822.81 receivable against $46,500.00 genuinely outstanding.
   *
   * BILLED IS UNTOUCHED for everything but PI. It is what was billed, and that
   * does not change with how much of it has come back.
   */
  const cardBilled = (i: ArRegisterInvoice) => (vertOf(i) === 'PI' ? piGrossOf(i) : num(i.total));
  const cardExpected = owedOf;

  const arExp = (() => {
    // BY VERTICAL, because a single blended figure is not a rule anyone applies
    // — it is an accident of this month's mix. The split states what each
    // programme is actually owed.
    //
    // Cut from the invoice rows rather than from a server total, so the card
    // uses the same arithmetic the drills below list and cannot disagree with
    // them.
    const vm = new Map<string, { vertical: string; n: number; billed: number; expected: number }>();
    for (const i of INV) {
      const key = i.vertical || 'Unassigned';
      const e = vm.get(key) ?? { vertical: key, n: 0, billed: 0, expected: 0 };
      e.n += 1; e.billed += cardBilled(i); e.expected += cardExpected(i);
      vm.set(key, e);
    }
    const byVert = [...vm.values()]
      // ONLY WHAT IS STILL OWED. A programme that has been collected in full has
      // no receivable, and a row of zeroes on a card headed AR RECEIVABLE is a
      // line the reader has to check and discard. DEMO is collected in full
      // today and drops off; it returns by itself the moment an invoice of its
      // opens.
      .filter((v) => v.expected > 0.005)
      .map((v) => ({ ...v, pct: v.billed > 0 ? (v.expected / v.billed) * 100 : 100 }))
      // Least recoverable first — the programmes with the most still outstanding
      // relative to what they billed are the reason the card exists — then by
      // size, so the big books lead within a tier.
      .sort((a, b) => (a.pct - b.pct) || (b.billed - a.billed));

    // THE TOTAL IS OF THE ROWS ABOVE IT, not of the register. Once a programme
    // can be filtered out, summing the whole book here would print a total the
    // visible rows do not add up to — the "four rows under a total of eleven"
    // this file has been bitten by before. BILLED moves with it for the same
    // reason: it is the billed figure of the programmes shown, and the card
    // says so by sitting directly under them.
    const billed = r2(byVert.reduce((s2, v) => s2 + v.billed, 0));
    const expected = r2(byVert.reduce((s2, v) => s2 + v.expected, 0));
    const discount = Math.max(0, r2(billed - expected));

    return {
      billed,
      expected,
      discount,
      // THE PI BOOK'S SIZE, which is what the footer beneath says — "N PI
      // invoices · $X yet to be received".
      discounted: INV.filter((i) => vertOf(i) === 'PI').length,
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
  /**
   * WHAT THE 85 ARE, from the Open Invoices tile.
   *
   * The tile counts every invoice with money still on it, and that is two very
   * different situations the count alone cannot separate: an invoice nobody has
   * paid a cent on, and a PI case whose advance arrived months ago and whose
   * balance is still out. GROUPED BY THAT, not by programme — the Actual
   * Collectable drill beside it already splits by vertical, and a second copy of
   * the same table would only make the reader check which one they opened.
   */
  const explainOwing = () => {
    const owing = INV.filter((i) => owedOf(i) > 0.005);
    if (!owing.length) return;
    const isPiRow = (i: ArRegisterInvoice) => vertOf(i) === 'PI';
    const S = (rows: ArRegisterInvoice[]) => r2(rows.reduce((s2, i) => s2 + owedOf(i), 0));
    const nonPi = owing.filter((i) => !isPiRow(i));
    const byVert = [...new Set(nonPi.map(vertOf))]
      .map((v) => ({
        label: `${v} · open`,
        note: 'billed and paid in one go, so the balance is what is unpaid',
        rows: nonPi.filter((i) => vertOf(i) === v),
      }))
      .sort((a, b) => S(b.rows) - S(a.rows));
    const groups = [
      {
        label: 'PI · nothing received',
        note: 'not even the advance, so the WHOLE total is outstanding',
        rows: owing.filter((i) => isPiRow(i) && !advanceIn(i)),
      },
      {
        label: 'PI · advance received, balance owing',
        note: 'the 15% is in; the case has yet to settle',
        rows: owing.filter((i) => isPiRow(i) && advanceIn(i)),
      },
      ...byVert,
    ].filter((g) => g.rows.length > 0);

    setDrill({
      title: 'Invoices still owing',
      sub: `${owing.length} invoice${owing.length === 1 ? '' : 's'} · ${formatCurrency(S(owing), true)} outstanding`,
      columns: [
        { key: 'k', label: 'GROUP' }, { key: 'n', label: 'INVOICES', num: true },
        { key: 'amt', label: 'OUTSTANDING', num: true }, { key: 'why', label: '' },
      ],
      rows: [
        ...groups.map((g) => ({
          k: <span style={{ fontWeight: 800 }}>{g.label}</span>,
          n: String(g.rows.length),
          amt: <span style={{ color: C.negative, fontWeight: 800 }}>{formatCurrency(S(g.rows), true)}</span>,
          why: <span style={{ fontSize: 11.5, color: C.muted }}>{g.note}</span>,
        })),
        {
          rowClass: 'total-row',
          k: <strong>TOTAL</strong>,
          n: <strong>{owing.length}</strong>,
          amt: <strong>{formatCurrency(S(owing), true)}</strong>,
          why: '',
        },
        // The worklist itself. Largest first — this is a chase list, and the
        // order it opens in is the order somebody will work it in.
        { k: <span style={{ color: C.muted, fontSize: 12 }}>Every invoice still owing, largest first</span>, n: '', amt: '', why: '' },
        ...owing.slice().sort((a, b) => owedOf(b) - owedOf(a)).map((i) => ({
          k: (
            <span style={{ paddingLeft: 10 }}>
              #{i.no} · {i.patient || '-'}
              <span style={{ color: VERT_C[i.vertical ?? ''] ?? C.muted, fontWeight: 700 }}> · {i.vertical || 'Unassigned'}</span>
            </span>
          ),
          n: <span style={{ color: C.muted }}>{i.dueDate ? `due ${fmtDate(i.dueDate)}` : 'no due date'}</span>,
          amt: <span style={{ color: C.negative }}>{formatCurrency(owedOf(i), true)}</span>,
          why: vertOf(i) === 'PI' ? piStatusTag(i) : statusTag(i),
        })),
      ] as Record<string, ReactNode>[],
      total: {
        k: `${owing.length} invoices`,
        amt: <span style={{ color: C.negative }}>{formatCurrency(S(owing), true)}</span>,
      },
    });
  };

  const explainCollectable = () => {
    const open = INV.filter((i) => owedOf(i) > 0.005);
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
      sub: `${open.length} invoice${open.length === 1 ? '' : 's'} still owing · ${formatCurrency(S(open, collectableOf), true)} outstanding`,
      columns: [
        { key: 'k', label: 'VERTICAL' }, { key: 'n', label: 'OPEN INVOICES' },
        // ONE MONEY COLUMN. "Outstanding at face" beside "actual collectable"
        // was a contrast between a face value and a discounted one; both are the
        // same figure now, and printing it twice invites the reader to hunt for
        // a difference that is not there.
        { key: 'coll', label: 'OUTSTANDING', num: true },
      ],
      rows: [
        ...groups.map((g) => ({
          k: <span style={{ fontWeight: 800, color: VERT_C[g.vertical] ?? C.ink }}>{g.vertical}</span>,
          n: String(g.rows.length),
          coll: <span className="cell-pos" style={{ fontWeight: 800 }}>{formatCurrency(S(g.rows, collectableOf), true)}</span>,
        })),
        {
          k: <strong>TOTAL</strong>,
          n: <strong>{open.length}</strong>,
          coll: <strong>{formatCurrency(S(open, collectableOf), true)}</strong>,
        },
        // The worklist itself, hardest money first — ordered by what is really
        // recoverable, not by face value.
        { k: <span style={{ color: C.muted, fontSize: 12 }}>Every invoice still owing, largest first</span>, n: '', coll: '' },
        ...open.slice().sort((a, b) => collectableOf(b) - collectableOf(a)).map((i) => ({
          k: (
            <span style={{ paddingLeft: 10 }}>
              #{i.no} · {i.patient || '-'}
              <span style={{ color: VERT_C[i.vertical ?? ''] ?? C.muted, fontWeight: 700 }}> · {i.vertical || 'Unassigned'}</span>
            </span>
          ),
          n: <span style={{ color: C.muted }}>{i.dueDate ? `due ${fmtDate(i.dueDate)}` : 'no due date'}</span>,
          coll: <span className="cell-pos">{formatCurrency(collectableOf(i), true)}</span>,
        })),
      ],
    });
  };

  /**
   * WHAT PI STILL OWES, over every one of its invoices.
   *
   * Held here rather than computed twice because the card footer and the drill
   * it opens have to agree: a footer quoting one total that opens a table
   * summing to another is the reader's first reason to distrust both.
   *
   * Per row this is `piBalanceOf` — the same arithmetic as the PI book's
   * BALANCE OUTSTANDING column and the programme drill's, so no two screens can
   * disagree about a single invoice either.
   */
  const piYetToCome = useMemo(() => {
    const rows = INV.filter((i) => vertOf(i) === 'PI');
    return {
      rows,
      // TOTAL and ADVANCE on the order basis — the same two figures the book and
      // the programme drill print for these rows.
      billed: r2(rows.reduce((s2, i) => s2 + piGrossOf(i), 0)),
      advance: r2(rows.reduce((s2, i) => s2 + num(i.total), 0)),
      yetToCome: r2(rows.reduce((s2, i) => s2 + piBalanceOf(i), 0)),
    };
  }, [INV]);

  /** The PI book as a chase list, from the card's footer link. */
  const explainExpected = () => {
    // Ranked by what is still owed, which is also what the last column says —
    // ordering on one figure while printing another would put the biggest
    // number somewhere down the list.
    const rows = [...piYetToCome.rows].sort((a, b) => piBalanceOf(b) - piBalanceOf(a));
    if (!rows.length) return;
    setDrill({
      title: 'AR receivable · Amount yet to be received from PI',
      sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} · total ${formatCurrency(piYetToCome.billed, true)} · invoiced (advance) ${formatCurrency(piYetToCome.advance, true)} · yet to be received ${formatCurrency(piYetToCome.yetToCome, true)}`,
      columns: [
        { key: 'no', label: 'INVOICE NUMBER' }, { key: 'd', label: 'INVOICE DATE' },
        { key: 'p', label: 'PATIENT' }, { key: 'b', label: 'TOTAL', num: true },
        { key: 'e', label: 'INVOICED', num: true }, { key: 'x', label: 'YET TO BE RECEIVED', num: true },
      ],
      rows: rows.map((i) => ({
        rowClass: advanceOverRate(i) ? 'row-overrate' : undefined,
        no: <strong>#{i.no}</strong>, d: fmtDate(i.date), p: i.patient || '-',
        b: formatCurrency(piGrossOf(i), true),
        e: <>
          {advanceIn(i)
            ? <span className="amt-received">{formatCurrency(num(i.total), true)}</span>
            : formatCurrency(num(i.total), true)}
          <AdvancePct i={i} />
        </>,
        // NO LEADING MINUS. It was a deduction from billed; it is money owed, and
        // a negative sign on a receivable reads as a credit. Heavy where nothing
        // has arrived at all — those are the rows a chase list exists to surface.
        x: <span style={{ color: C.negative, fontWeight: advanceIn(i) ? 600 : 800 }}
          title={advanceIn(i)
            ? `${formatCurrency(piGrossOf(i), true)} total less the ${formatCurrency(num(i.total), true)} advance already received`
            : `The whole ${formatCurrency(piGrossOf(i), true)} total — the advance has not been received, so nothing is deducted`}>
          {formatCurrency(piBalanceOf(i), true)}
        </span>,
      })),
    });
  };

  /**
   * ONE PROGRAMME'S INVOICES, from clicking its row on the AR RECEIVABLE card.
   *
   * The card states what each programme is still owed, and the obvious next
   * question is which invoices are behind the number. This is that list.
   *
   * IT SPEAKS EACH PROGRAMME'S OWN LANGUAGE. On PI the columns are the lien's —
   * the order's total, the 15% advance Striven invoiced against it (pilled once
   * it has landed, with its share of the total beside it) and what is still to
   * come — and the status is the three-state one. Everywhere else there is no
   * advance and no lien, so the neutral wording and the register's own status
   * are the only true ones.
   *
   * BOTH ROUTES GO THROUGH THE SHARED HELPERS — piGrossOf, piBalanceOf,
   * advanceIn, piStatusTag — rather than repeating their arithmetic locally.
   * A local copy is how this drill came to miss the rule that zeroes the
   * balance when the whole bill was invoiced, and drifted from the book that
   * had it.
   */
  const explainVertical = (vertical: string) => {
    const rows = INV.filter((i) => vertOf(i) === vertical).sort((a, b) => Number(b.no) - Number(a.no));
    if (!rows.length) return;
    const pi = vertical === 'PI';
    const grossOf = (i: ArRegisterInvoice) => (pi ? piGrossOf(i) : num(i.total));
    const owedOf = (i: ArRegisterInvoice) => (pi ? piBalanceOf(i) : num(i.open));
    /**
     * THE MIDDLE COLUMN IS WHAT HAS COME IN — total less what is still to come.
     *
     * That identity already held on PI, where the invoice IS the advance:
     * $5,995.00 total − $5,095.75 still to come = the $899.25 invoiced. It did
     * not hold anywhere else, because the column carried AR EXPECTED — what the
     * programme is expected to yield on the whole book, settled or not — so VA
     * read $277,822.81 billed, $277,822.81 expected and $46,500.00 outstanding,
     * three figures with no arithmetic between them.
     *
     * Stated as the subtraction rather than summed from `paid`, so the three
     * columns reconcile by construction and cannot drift apart on a row where
     * the ledger's parts do not quite add up.
     */
    const inOf = (i: ArRegisterInvoice) => r2(grossOf(i) - owedOf(i));
    const gross = r2(rows.reduce((s2, i) => s2 + grossOf(i), 0));
    const billed = r2(rows.reduce((s2, i) => s2 + num(i.total), 0));
    const owed = r2(rows.reduce((s2, i) => s2 + owedOf(i), 0));
    const exp = r2(gross - owed);
    setDrill({
      title: `${vertical} · AR receivable`,
      sub: [
        `${rows.length} invoice${rows.length === 1 ? '' : 's'}`,
        ...(pi ? [`total ${formatCurrency(gross, true)}`] : []),
        `${pi ? 'invoiced (advance)' : 'billed'} ${formatCurrency(billed, true)}`,
        ...(pi ? [] : [`received ${formatCurrency(exp, true)}`]),
        `${pi ? 'yet to be received' : 'outstanding'} ${formatCurrency(owed, true)}`,
      ].join(' · '),
      columns: [
        { key: 'no', label: 'INVOICE NUMBER' }, { key: 'd', label: 'INVOICE DATE' },
        { key: 'p', label: 'PATIENT' },
        // TOTAL sits LEFT of INVOICED because it is the prior, larger fact: the
        // order, of which the invoice is the 15% advance.
        ...(pi ? [{ key: 't', label: 'TOTAL', num: true }] : []),
        { key: 'b', label: pi ? 'INVOICED' : 'BILLED', num: true },
        // RECEIVED, not EXPECTED. The figure is now total less what is still to
        // come, which is money already in — and a column headed "expected"
        // printing what has already arrived is the plainest kind of wrong.
        ...(pi ? [] : [{ key: 'e', label: 'RECEIVED', num: true }]),
        { key: 'o', label: pi ? 'YET TO BE RECEIVED' : 'OUTSTANDING', num: true },
        { key: 's', label: 'STATUS' },
      ],
      rows: rows.map((i) => ({
        rowClass: pi && advanceOverRate(i) ? 'row-overrate' : undefined,
        no: <strong>#{i.no}</strong>, d: fmtDate(i.date), p: i.patient || '-',
        ...(pi ? {
          t: <span title={i.orderTotal != null
            ? `The sales order behind this invoice is ${formatCurrency(i.orderTotal, true)}; the invoice is the 15% advance against it`
            : 'No larger order found — this invoice is the whole bill'}>
            {formatCurrency(grossOf(i), true)}
          </span>,
        } : {}),
        b: pi
          ? <>
            {advanceIn(i)
              ? <span className="amt-received">{formatCurrency(num(i.total), true)}</span>
              : formatCurrency(num(i.total), true)}
            <AdvancePct i={i} />
          </>
          : formatCurrency(num(i.total), true),
        ...(pi ? {} : { e: formatCurrency(inOf(i), true) }),
        o: owedOf(i) > 0.005
          ? <span style={{ color: C.negative, fontWeight: pi && !advanceIn(i) ? 800 : 600 }}>
            {formatCurrency(owedOf(i), true)}
          </span>
          : '—',
        s: pi ? piStatusTag(i) : statusTag(i),
      })),
      // The SAME sums the subtitle quotes — one reckoning, printed at both ends
      // of the dialog so it is in view whichever end you are reading from.
      total: {
        p: `${rows.length} invoice${rows.length === 1 ? '' : 's'}`,
        ...(pi ? { t: formatCurrency(gross, true) } : {}),
        b: formatCurrency(billed, true),
        ...(pi ? {} : { e: formatCurrency(exp, true) }),
        o: <span style={{ color: C.negative }}>{formatCurrency(owed, true)}</span>,
      },
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
    setQuery(''); setSegment('all'); setVert('all'); setPickPayer(new Set()); setPage(1);
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
            <KpiR ico="doc" tint="#0A369F" label="Total Billed" value={totalBilled} format={formatCurrency}
              deltaText={`${INV.length} invoices`} foot="PI at case value, the rest as invoiced · click to open the book"
              onClick={showBook} />
            {/* Clickable: the split between cash banked and credit applied is
                the question this tile invites, and $17,687 of it is not what it
                looks like on the face of the card. */}
            {/* BILLED LESS WHAT IS STILL OWED, so the three money tiles on this
                row subtract to each other. `t.collected` counts cash against
                INVOICES, and a PI invoice is the 15% advance — it read
                $279,182.41 between a billed of $612,826.95 and an outstanding of
                $307,764.55. The cash/credit split below is still the ledger's and
                still true; it just no longer accounts for the whole figure. */}
            <KpiR ico="wallet" tint="#16A34A" label="Collected" value={totalCollected} format={formatCurrency}
              deltaText={`${t.collectedInvoices} settled`}
              // Same guard as the drill: an older payload has neither figure,
              // and `$- cash · $- credit` under a real total reads as breakage.
              foot={num(t.creditCollected) > 0
                ? `${formatCurrency(num(t.cashCollected))} cash · ${formatCurrency(num(t.creditCollected))} credit`
                : `${t.collectedInvoices} paid in full`}
              onClick={explainCollected} />
            {/* OFF `collectable`, not the server's `t.outstanding`. The server
                totals the LEDGER, which cannot see that a PI invoice with its
                advance paid still has 85% of the case to come — it reported
                $82,754.19 against $304,764.55 genuinely owed. */}
            <KpiR ico="cash" tint="#DC2626" label="Outstanding" value={collectable.total} format={formatCurrency}
              deltaText={`${collectable.count} invoices still owing`} foot="PI at case value, the rest net of credits" />
            {/* EVERY INVOICE WITH MONEY STILL ON IT, which is more than the ones
                the ledger calls open. `t.openInvoices` counts status = open, so it
                missed every PI invoice whose advance has been received and whose
                case still owes the balance — 49 of them, each with a live figure
                in the Outstanding tile beside this one. A count that excludes
                rows the total includes cannot be reconciled against it.
                `collectable.count` is the same set that total is summed over. */}
            <KpiR ico="clip" tint="#D97706" label="Open Invoices" value={collectable.count}
              deltaText="still owing" foot="open, plus advance-in with a balance · click for the split"
              onClick={explainOwing} />
            {/* THE SAME FIGURE AS OUTSTANDING, deliberately. No lien discount is
                applied anywhere any more, so the two tiles are one number said
                twice; this one is kept because the drill behind it is the
                per-vertical chase list, which nothing else on this page offers. */}
            <KpiR ico="cash" tint="#0D9488" label="Actual Collectable" value={collectable.total} format={formatCurrency}
              deltaText={`of ${formatCurrency(collectable.total)} outstanding`}
              foot="every open invoice at its full balance · click for the split"
              onClick={explainCollectable} />
            {/* Off the two tiles beside it rather than the server's own rate,
                which divided invoice-basis collected by invoice-basis billed and
                so answered a different question from the row it sits in. */}
            <KpiR ico="pie" tint="#7C3AED" label="Collection Rate" value={collectionRate}
              format={(n) => `${n.toFixed(1)}%`} deltaText="collected ÷ billed" foot="of everything billed to the case" />
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
            <ChartCard className="g12-4" title="AR RECEIVABLE" sub="What is still owed — PI after the advance, every other programme its open invoices">
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
                    <span>Programme</span><span>Billed</span><span>Receivable</span>
                  </div>
                  {/* EVERY PROGRAMME OPENS ITS OWN INVOICES. A real <button>
                      rather than a div with an onClick, so the row is tabbable,
                      announced as a control and fires on Enter and Space without
                      any of that being hand-rolled. The grid layout is unchanged
                      — button.ar-exp-tr in the stylesheet only undoes the UA's
                      own button styling. */}
                  {arExp.byVert.map((v) => {
                    const cut = v.pct < 99.95;
                    return (
                      <button type="button" key={v.vertical} className={`ar-exp-tr${cut ? ' is-cut' : ''}`}
                        onClick={() => explainVertical(v.vertical)}
                        title={`${v.n} invoice${v.n === 1 ? '' : 's'} · ${cut ? `expected at ${v.pct.toFixed(0)}% of billed` : 'expected in full'} — click for the list`}>
                        <span>
                          {v.vertical}
                          <i>{cut ? `${v.pct.toFixed(0)}%` : 'full'}</i>
                        </span>
                        <span>{formatCurrency(v.billed, true)}</span>
                        <span>{formatCurrency(v.expected, true)}</span>
                      </button>
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
                    {/* Quotes the SAME total the drill sums to. */}
                    {arExp.discounted} PI invoice{arExp.discounted === 1 ? '' : 's'} ·
                    {' '}{formatCurrency(piYetToCome.yetToCome, true)} yet to be received →
                  </button>
                ) : (
                  <div className="ar-exp-foot">Nothing is outstanding on PI.</div>
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
                  {/* NAMED FOR THE BOOK ON SCREEN. "INVOICE BOOK" over a table
                      of 38 VA invoices reads as the whole register with rows
                      missing; the programme in the heading is what says it is
                      not. */}
                  <h2 className="section-title">{vert === 'all' ? 'INVOICE BOOK' : `${vert.toUpperCase()} INVOICE BOOK`}</h2>
                  <div className="section-sub">
                    <b>{book.invoices}</b> invoices · {WORD.billed} <b>{formatCurrency(book.billed, true)}</b> ·
                    {' '}{WORD.expected} <b>{formatCurrency(book.arExpected, true)}</b>
                    {/* Names the difference rather than leaving two totals side
                        by side for the reader to reconcile. Only shown when the
                        rule actually bit something. */}
                    {book.arDiscounted > 0 && (
                      <span title={`${book.arDiscounted} PI invoice${book.arDiscounted === 1 ? '' : 's'} carried at 15% of billed`}>
                        {' '}(−{formatCurrency(book.arDiscount, true)} PI lien)
                      </span>
                    )}
                    {' '}· {WORD.open} <b style={{ color: C.negative }}>{formatCurrency(book.outstanding, true)}</b>
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
                  {(query || segment !== 'all' || vert !== 'all' || pickPayer.size > 0 || pickStatus.size > 0) && (
                    <button className="btn ghost" style={{ padding: '7px 11px' }}
                      onClick={() => { setQuery(''); setSegment('all'); setVert('all'); setPickPayer(new Set()); setPickStatus(new Set()); setPage(1); }}>Reset</button>
                  )}
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={exportExcel}
                    title="Download these rows as an Excel workbook. Amounts stay numeric so they total in Excel.">⤓ Excel</button>
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={() => printToPdf(printRef.current)}
                    title="Open the print dialog: choose “Save as PDF” for a PDF of this table">⎙ PDF</button>
                </div>
              </div>

              {/* ── ONE BOOK PER PROGRAMME ────────────────────────────────────
                  The outer split, drawn above the status one because it is the
                  coarser of the two: this picks WHICH BOOK, the strip below it
                  partitions that book. Only rendered where there is more than
                  one programme to choose between — a single-vertical register
                  would be offering a choice of one.

                  The status segment resets with it. Landing on VA still filtered
                  to "Zero value" from the PI book shows an empty table under a
                  headline of 38, which reads as a broken page rather than as a
                  filter left on. */}
              {vertTabs.length > 1 && (
                <div className="smr-seg no-print" style={{ marginBottom: 8 }}>
                  {/* "All VERTICALS", not "All": two strips stacked, each with an
                      All at its left edge, otherwise leaves the reader working
                      out which of the two 'All's they are looking at. */}
                  {([['all', `All verticals ${INV.length}`], ...vertTabs.map((v) => [v.value, `${v.value} ${v.count}`] as [string, string])])
                    .map(([k, label]) => (
                      <button key={k} className={vert === k ? 'active' : ''}
                        title={k === 'all' ? 'Every invoice in the register' : `Only the ${k} book — totals, counts and exports all scope to it`}
                        onClick={() => { setVert(k); setSegment('all'); setPage(1); }}>{label}</button>
                    ))}
                </div>
              )}

              {/* Open / Settled / Zero value are exhaustive and disjoint, so the
                  three counts always add back to the book above them — the
                  register when the tab is All, one programme otherwise. */}
              <div className="smr-seg no-print" style={{ marginBottom: 10 }}>
                {([['all', `All ${book.invoices}`], ['open', `Open ${book.openInvoices}`],
                  ['paid', `Settled ${book.collectedInvoices}`], ['zero-value', `Zero value ${book.zeroValue}`]] as [Segment, string][])
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
                      {/* No filter chip: the tab strip above IS this column's
                          filter now, and a second control for the same field
                          could only disagree with it. */}
                      <th style={{ whiteSpace: 'nowrap' }}>VERTICAL</th>
                      <th className="num sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('total')}>{COL.billed} {ind('total')}</th>
                      {/* Replaces PAYER. Sits immediately after BILLED because
                          the pair is only meaningful read together — the gap
                          between them IS the PI lien discount. */}
                      <th className="num sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('expected')}
                        title={isPi
                          ? 'The advance: 15% of the invoiced amount, paid against the lien. Shown green once it has been received.'
                          : 'What is expected to be received. PI settles out of a lien at 15% of billed; every other programme is expected in full.'}>
                        {COL.expected} {ind('expected')}
                      </th>
                      <th className="num sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('open')}
                        title={isPi
                          ? 'What is still owed on the invoice at face value — the balance the case has yet to settle.'
                          : undefined}>{COL.open} {ind('open')}</th>
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
                        className={[
                          n >= (pageSafe - 1) * PAGE_SIZE && n < pageSafe * PAGE_SIZE ? '' : 'pg-off',
                          // MARKED, NOT CORRECTED. See advanceOverRate.
                          rowIsPi(i) && advanceOverRate(i) ? 'row-overrate' : '',
                        ].filter(Boolean).join(' ') || undefined}>
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
                        {/* On PI this is the ORDER, not the invoice — see
                            piGrossOf. The tooltip says which of the two a row
                            is showing, because a figure six times the invoice
                            beside it needs to account for itself. */}
                        <td className="num" title={rowIsPi(i)
                          ? (i.orderTotal != null
                            ? `The sales order behind this invoice is ${formatCurrency(i.orderTotal, true)}; the ${formatCurrency(num(i.total), true)} invoice is the 15% advance against it`
                            : 'No larger order found — this invoice is the whole bill')
                          : undefined}>{formatCurrency(billedOf(i), true)}</td>
                        {/* A discounted row is MARKED, not just smaller. Without
                            the badge the only signal that a figure is 15% of
                            billed rather than equal to it is doing the division
                            in your head, and a reader scanning the column would
                            take a quietly reduced number at face value. */}
                        {/* GREEN MEANS THE ADVANCE IS IN — the same .cell-pos /
                            .cell-neg pairing the outstanding column already uses,
                            so one column reads as money in and the other as money
                            owed without needing a legend. PI ONLY: elsewhere this
                            column is AR EXPECTED, where green would be claiming a
                            receipt the heading never promised.
                            The title says it in words too — colour alone is not a
                            label, and it is the one cue a colour-blind reader or a
                            printed page does not get. */}
                        <td className="num" title={[
                          isDiscounted(i)
                            ? `PI lien: 15% of ${formatCurrency(i.total, true)} billed`
                            : 'Expected in full — no programme discount applies',
                          rowIsPi(i) ? (advanceIn(i) ? 'Advance received' : 'Advance not yet received') : '',
                        ].filter(Boolean).join(' · ')}>
                          {/* THE PILL CARRIES THE MEANING NOW, so it goes on the
                              FIGURE rather than the cell: a green cell tints
                              whatever else sits in it, and this one also holds
                              the lien badge on the mixed tab. */}
                          {rowIsPi(i) && advanceIn(i)
                            ? <span className="amt-received">{formatCurrency(expOf(i), true)}</span>
                            : formatCurrency(expOf(i), true)}
                          {/* THE PERCENTAGE REPLACES THE OLD "PI 15%" BADGE on every
                              tab. The badge marked which rows in a mixed column had
                              been cut by the lien, which the percentage does too —
                              and it does it truthfully: the badge said 15% on the
                              six rows that are 40% and 100%. */}
                          {rowIsPi(i) && <AdvancePct i={i} />}
                        </td>
                        {/* RED IS FOR THE ROWS WITH NOTHING IN YET. Every PI row
                            now carries a balance, so colouring all of them would
                            spend the alarm on the whole column and leave the five
                            invoices where not a cent has arrived looking like the
                            seventeen where the advance already has. Red and heavy
                            is reserved for those; the rest are the ordinary
                            remainder of a case that is running to plan. */}
                        <td className={rowIsPi(i)
                          ? (advanceIn(i) ? 'num' : 'num cell-neg')
                          : (openOf(i) > 0.005 ? 'num cell-neg' : 'num')}
                          style={rowIsPi(i) && !advanceIn(i) ? { fontWeight: 800 } : undefined}
                          title={rowIsPi(i)
                            ? (advanceIn(i)
                              ? `${formatCurrency(billedOf(i), true)} total less the ${formatCurrency(num(i.total), true)} advance already received`
                              : `The whole ${formatCurrency(billedOf(i), true)} total — the ${formatCurrency(num(i.total), true)} advance has not been received, so nothing is deducted`)
                            : undefined}>
                          {openOf(i) > 0.005 ? formatCurrency(openOf(i), true) : '-'}
                        </td>
                        <td>{rowIsPi(i) ? piStatusTag(i) : statusTag(i)}</td>
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
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} total={drill.total}
          onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
