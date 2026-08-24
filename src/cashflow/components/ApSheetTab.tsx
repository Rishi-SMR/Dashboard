import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, ChartCard, RankBar, AgingBar, DrillModal, StatCards } from '../chartKit';
import { fetchApLedger, type ApLedger } from '../strivenApi';
import { ColumnFilter } from './ColumnFilter';
import { downloadXlsx, printToPdf, stamped } from '../export';
import { Portal } from './Portal';
import { SO_REF_STYLE } from '../soRef';

// ─────────────────────────────────────────────────────────────────────────────
// AP Register (Sheet): a manually-maintained accounts-payable register sourced
// from the "AP_Report_Invoices" spreadsheet (AP Report Base + AP Ledgers status).
// This is SEEDED from a sheet snapshot, not a live Striven feed, so it sits next
// to the live Payables tab rather than replacing it.
//
// HIPAA: the sheet's "Ship To" column holds patient names: deliberately EXCLUDED
// here. This tab shows vendor/financial data only (no PHI reaches the browser).
// ─────────────────────────────────────────────────────────────────────────────

type Bill = {
  no: string; vendor: string; date: string; due: string;
  /** What COUNTS toward the payable: signed on a credit note, ZERO on a
   *  cancelled bill. Every sum in this file reads this and needs no filter. */
  total: number;
  /** What the document says — printed in the Total column so a cancelled bill
   *  still shows $63.80 rather than a bare $0. */
  faceValue: number;
  kind: 'bill' | 'credit-note' | 'cancelled';
  status: string; aging: string; open: number;
  /** The sheet's Payment Terms and Due Days columns. Read by the server all
   *  along and dropped here, because nothing on screen had a use for them until
   *  the invoice card. They are the two facts a row cannot show and a reader
   *  most often wants: on what terms, and how far past them. */
  terms: string; dueDays: number;
  /** The term as net days, and who answered — the sheet's own cell or the
   *  vendor agreement filling a blank. Display only: no due date or ageing
   *  band is derived from it. */
  termsDays: number | null; termsSource: 'sheet' | 'agreed' | 'none';
};

// The 71-row hardcoded snapshot that used to live here is GONE. The register
// now reads the "AP Ledgers" tab of the AP workbook live (/api/ap-ledger), so
// it stays current instead of freezing at whenever someone last edited this
// file. Rows arrive grouped-ready by Sub-Ledger; see getApLedger().

const PAGE_SIZE = 10;
const OPEN_STATUSES = new Set(['Unpaid', 'Partially Paid']);
const PAID_STATUSES = new Set(['Paid', 'Paid without Shipping']);

const fmtDate = (s: string) => {
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Sheet aging label → shared AgingBar bucket key.
const AGING_KEY: Record<string, string> = {
  '0-30 Days': 'd1_30', '31-60 Days': 'd31_60', '61-90 Days': 'd61_90', '91-120 Days': 'd90plus',
};

// Status → pill tone class used across the dashboard.
//
// A CREDIT NOTE carries no payment status — the sheet leaves the cell blank —
// and the fall-through at the bottom of this function turned that blank into a
// red "Unpaid" chip. So CM136863 was shown as an unpaid $27 bill when it is a
// $27 credit. `kind` is checked first, before the status word is consulted.
function statusTag(status: string, kind: Bill['kind'] = 'bill'): ReactNode {
  if (kind === 'credit-note') return <span className="pill-tag tag-muted" style={{ fontWeight: 700 }}>↩ Credit note</span>;
  if (kind === 'cancelled') return <span className="pill-tag tag-muted">Cancelled · voided</span>;
  const s = status.toLowerCase();
  if (PAID_STATUSES.has(status)) return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ {status === 'Paid' ? 'Paid' : 'Paid (no ship)'}</span>;
  if (status === 'Partially Paid') return <span className="pill-tag tag-warn">Partial</span>;
  if (s.includes('cancel')) return <span className="pill-tag tag-muted">Cancelled</span>;
  return <span className="pill-tag tag-danger">Unpaid</span>;
}

/**
 * THE INVOICE NUMBER, MADE OPENABLE — and what "open" can honestly mean here.
 *
 * THERE IS NO INVOICE DOCUMENT TO SHOW, and that is a fact about the data, not a
 * shortcut. This register is the accountant's "AP Ledgers" sheet: twelve typed
 * columns, no attachment, no URL, no Striven id. Striven's own bills are a
 * different book entirely — eighteen of them, numbered 1..18, against this
 * sheet's 137 vendor invoice numbers (INV225908, DM-29162), and not one number
 * appears in both. So there is nothing to deep-link to and nothing to fetch.
 *
 * WHAT THE CARD SHOWS is everything the register knows about the row, which is
 * more than the row itself can: the payment terms and due-day count the sheet
 * carries but no table column prints, the payment status, the aging band, and
 * face value against what actually counts toward the payable — the distinction
 * that makes a cancelled bill read as $63.80 struck through and $0 owed.
 *
 * Styled with SO_REF_STYLE, the same declaration every sales-order reference
 * uses, so a clickable reference looks identical wherever it appears.
 */
function BillLink({ bill }: { bill: Bill }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" style={SO_REF_STYLE} title={`Open ${bill.no}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {bill.no}
      </button>
      {open && <BillCard bill={bill} onClose={() => setOpen(false)} />}
    </>
  );
}

function BillKV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted, fontWeight: 700, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

function BillCard({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  // Past the DUE date, not past the invoice date — and only while something is
  // still owed. A settled bill has no age worth printing.
  const late = bill.open > 0 && bill.due
    ? Math.floor((Date.now() - new Date(`${bill.due}T00:00:00Z`).getTime()) / 86_400_000)
    : null;
  return (
    <Portal>
      <div onClick={onClose} role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
        <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Vendor invoice ${bill.no}`}
          style={{ background: '#fff', borderRadius: 14, width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${C.brand}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{bill.no}</div>
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>Vendor invoice · {bill.vendor}</div>
            </div>
            <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginBottom: 16 }}>
              <BillKV label="Status">{statusTag(bill.status, bill.kind)}</BillKV>
              <BillKV label="Invoice date">{bill.date ? fmtDate(bill.date) : <span style={{ color: C.muted }}>—</span>}</BillKV>
              <BillKV label="Due date">{bill.due ? fmtDate(bill.due) : <span style={{ color: C.muted }}>—</span>}</BillKV>
              {/* The two the sheet carries and no table column prints. */}
              <BillKV label="Payment terms"><Terms days={bill.termsDays} source={bill.termsSource} /></BillKV>
              <BillKV label="Aging">{bill.aging || <span style={{ color: C.muted }}>—</span>}</BillKV>
              <BillKV label="Days past due">
                {late == null ? <span style={{ color: C.muted }}>settled</span>
                  : late > 0 ? <span style={{ color: C.negative }}>{late} days</span>
                    : <span style={{ color: C.positive }}>not yet due</span>}
              </BillKV>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
              {/* FACE VALUE AND COUNTED VALUE ARE DIFFERENT NUMBERS on exactly two
                  kinds of row, and the card says so rather than printing one and
                  letting the other be discovered by addition. */}
              <BillKV label="Invoice amount">{formatCurrency(bill.faceValue, true)}</BillKV>
              <BillKV label="Counts toward payable">
                {bill.kind === 'cancelled'
                  ? <span style={{ color: C.muted }}>$0 — cancelled</span>
                  : formatCurrency(bill.total, true)}
              </BillKV>
              <BillKV label="Open balance">
                {bill.open > 0 ? <span style={{ color: C.negative }}>{formatCurrency(bill.open, true)}</span>
                  : bill.open < 0 ? <span className="cell-pos">{formatCurrency(bill.open, true)}</span>
                    : <span style={{ color: C.muted }}>nothing owed</span>}
              </BillKV>
            </div>
            <div className="muted-note" style={{ marginTop: 16, lineHeight: 1.55 }}>
              From the AP Ledgers sheet, which is where this register gets its rows. It carries no scan or
              attachment, and these vendor invoice numbers have no matching record in Striven &mdash; so this is
              everything known about {bill.no}, not a link to the document itself.
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * A PAYMENT TERM, rendered once.
 *
 * "Net 30" where there is one, an em-dash where there is not — never a guess.
 * A term the vendor agreement supplied for a cell the sheet left blank is
 * marked with a degree ring and says so on hover, because a reader working the
 * register needs to know which figures came off the sheet they maintain and
 * which did not. Everything else prints plain.
 */
function Terms({ days, source }: { days: number | null; source: 'sheet' | 'agreed' | 'none' }) {
  if (days == null) return <span style={{ color: C.muted }}>&mdash;</span>;
  const label = days === 0 ? 'Due on receipt' : `Net ${days}`;
  if (source === 'agreed') {
    return (
      <span style={{ whiteSpace: 'nowrap' }}
        title="The sheet's Payment Terms cell is blank on this row; shown from the agreed vendor terms.">
        {label}<span style={{ color: C.warning, marginLeft: 3, fontWeight: 700 }}>&deg;</span>
      </span>
    );
  }
  return <span style={{ whiteSpace: 'nowrap' }}>{label}</span>;
}

type SortKey = 'sub' | 'date' | 'due' | 'total' | 'open';

/**
 * Natural (alphanumeric) compare for invoice numbers.
 *
 * The sheet uses a different scheme per supplier — `INV225908`, `DM-29170`,
 * `SMR-15`, bare `1788` — so a plain string sort files "1826" before "1491"
 * correctly by luck, but puts "SMR-9" after "SMR-15" and breaks on any
 * zero-padding difference. Splitting into text and number runs and comparing
 * piecewise sorts each scheme the way a person reads it, without needing to
 * know which scheme a given supplier uses.
 */
function naturalCompare(a: string, b: string): number {
  const split = (s: string) => String(s).match(/\d+|\D+/g) ?? [];
  const A = split(a); const B = split(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i]; const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x); const ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else { const d = x.localeCompare(y, undefined, { sensitivity: 'base' }); if (d) return d; }
  }
  return 0;
}
/**
 * THE REGISTER'S READING ORDER: sub-ledger A→Z, then invoice sequence ascending
 * inside each block.
 *
 * This is the DRILLS' copy. The two bill tables apply the same order but let
 * the name column flip direction, so theirs threads `sort.dir` through the
 * first comparison and cannot simply call this. The drills have no such
 * control, and a drill that reorders the same rows by amount makes you re-find
 * your place — the very thing grouping by supplier was meant to stop.
 *
 * Case-insensitive on the name:
 * the sheet mixes "WHOLESALE MEDICAL DEVICES LLC" with "ManaMed LLC", and a raw
 * compare would file every shouted name ahead of every normal one.
 */
const byLedgerThenSequence = (a: Bill, b: Bill): number =>
  a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' })
  || naturalCompare(a.no, b.no);

type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] };

/**
 * The ledger identity for one vendor block, as a chip.
 *
 * `billed − paid − outstanding` should be zero. It is not on TREND Delco, and
 * the reason is entirely mechanical: `billed` is NET of that block's credit
 * notes, while the sheet's Outstanding column is not, so the shortfall equals
 * the credit-note amount to the cent. Calling that "unreconciled" points at a
 * problem that does not exist — the sheet and the register agree, they just
 * treat credit notes differently. Only a gap that ISN'T the credit notes is
 * worth a warning.
 */
function reconcileTag(check: number, creditNoteAmount: number, creditNotes: number): ReactNode {
  if (Math.abs(check) < 0.01) return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ ties</span>;
  if (creditNoteAmount > 0 && Math.abs(check + creditNoteAmount) < 0.01) {
    return (
      <span className="pill-tag tag-muted"
        title={`Billed is net of ${creditNotes} credit note${creditNotes === 1 ? '' : 's'}; the sheet's Outstanding column is not. The block otherwise ties exactly.`}>
        ✓ ties · less {creditNotes} credit note{creditNotes === 1 ? '' : 's'} {formatCurrency(creditNoteAmount, true)}
      </span>
    );
  }
  return <span className="pill-tag tag-warn" title="billed − paid − outstanding">{formatCurrency(check, true)} unreconciled</span>;
}

/**
 * THE BILL REGISTER — one table, paid and unpaid together.
 *
 * It used to render twice, as two cards. Two registers meant a supplier's
 * history was split across them: to answer "what has Doctors Medical billed us
 * and where does it stand", you read one table, scrolled past a second, and
 * re-applied the same sub-ledger filter. Every bill for a vendor now sits in one
 * block, in invoice sequence, with the balance saying which are settled.
 *
 * The SEGMENT keeps the old worklist a click away: All / Unpaid / Paid, counted,
 * over one shared search, sort, page and export.
 */
function BillTable({ title, sub, bills, isUnpaid, creditOffset = 0, creditCount = 0 }: {
  title: string; sub: string; bills: Bill[];
  /** Splits the segment control and colours the Open column. Passed in rather
   *  than re-derived here, so the table and the tiles above it can never
   *  disagree about which bills are still owed. */
  isUnpaid: (b: Bill) => boolean;
  /** Credit notes reduce what is owed, but they are filed with the SETTLED rows
   *  — they are not unpaid bills. So this table's Open column adds to the GROSS
   *  balance while the Outstanding tile above shows the net. Passing the offset
   *  lets the footer close that gap on screen instead of leaving two figures
   *  $51.20 apart with nothing to connect them. */
  creditOffset?: number; creditCount?: number;
}) {
  const [query, setQuery] = useState('');
  // Opens on ALL, because that is what the merge is for. The two old tables are
  // still one click apart.
  const [seg, setSeg] = useState<'all' | 'unpaid' | 'paid'>('all');
  // GROUPED BY SUB-LEDGER BY DEFAULT. The register is worked one supplier at a
  // time, so a list ordered by balance scattered each vendor's bills across
  // every page. Sorting by name keeps them contiguous; the columns still sort
  // by amount or date when that is the question being asked.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'sub', dir: 1 });
  const [page, setPage] = useState(1);
  const [pickSub, setPickSub] = useState<Set<string>>(new Set());

  // Options come from THIS table's own bills, so the unpaid filter never offers
  // a sub-ledger that is fully settled (and vice versa). Counted by bill.
  const subOpts = useMemo(() => {
    const m = new Map<string, number>();
    // Scoped to the SEGMENT, so the Unpaid view never offers a supplier who is
    // fully settled — the same promise the two separate tables used to make.
    for (const b of bills.filter((x) => seg === 'all' || (seg === 'unpaid' ? isUnpaid(x) : !isUnpaid(x)))) {
      m.set(b.vendor, (m.get(b.vendor) ?? 0) + 1);
    }
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [bills, seg, isUnpaid]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bills.filter((b) =>
      (seg === 'all' || (seg === 'unpaid' ? isUnpaid(b) : !isUnpaid(b)))
      && (pickSub.size === 0 || pickSub.has(b.vendor))
      && (!q || b.no.toLowerCase().includes(q) || b.vendor.toLowerCase().includes(q)));
  }, [bills, query, pickSub, seg, isUnpaid]);
  // Counts for the segment chips, off the WHOLE register so they do not move as
  // the search narrows — a chip that renumbers itself is not a filter, it is a
  // second result count.
  const segCounts = useMemo(() => ({
    all: bills.length,
    unpaid: bills.filter(isUnpaid).length,
    paid: bills.filter((b) => !isUnpaid(b)).length,
  }), [bills, isUnpaid]);
  const sorted = useMemo(() => {
    const v = (b: Bill): number => (sort.key === 'total' ? b.total : sort.key === 'open' ? b.open
      : new Date((sort.key === 'due' ? b.due : b.date) + 'T00:00:00').getTime() || 0);
    // Sub-ledger sorts by NAME, case-insensitively — the sheet mixes casing
    // ("WHOLESALE MEDICAL DEVICES LLC" against "ManaMed LLC"), and a raw string
    // compare would file every shouted name ahead of every normal one.
    // Within a supplier, ASCENDING BY INVOICE NUMBER, so each block runs in the
    // sequence the bills were raised. Natural compare, because the numbering
    // scheme differs per supplier.
    if (sort.key === 'sub') {
      return [...filtered].sort((a, b) =>
        a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' }) * sort.dir
        || naturalCompare(a.no, b.no));
    }
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const fTotal = filtered.reduce((s, b) => s + b.total, 0);
  const fOpen = filtered.reduce((s, b) => s + b.open, 0);
  // A NAME defaults to A→Z; amounts and dates default to largest/newest first.
  // One shared default would make the sub-ledger column open at Z→A, which
  // reads as broken rather than as a choice.
  const setSortKey = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'sub' ? 1 : -1 }));
    setPage(1);
  };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // PDF prints THIS card only, not the whole tab.
  const printRef = useRef<HTMLDivElement>(null);

  /**
   * Excel of the rows AS FILTERED AND SORTED on screen — including the vendor
   * grouping — so the file can never disagree with the table above it.
   *
   * Amounts stay NUMERIC: formatCurrency would ship "$1,761" as text and break
   * every sum in the workbook. Excel does the formatting.
   */
  function exportExcel() {
    const money = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
    const scope = [
      title,
      filtered.length === bills.length ? `all ${bills.length}` : `filtered: ${filtered.length} of ${bills.length}`,
      pickSub.size ? `sub-ledgers: ${[...pickSub].join(', ')}` : 'all sub-ledgers',
    ].join(' · ');
    const rows: (string | number)[][] = [
      [scope],
      [],
      // TWO amount columns, because the screen shows a cancelled bill's face
      // value struck through while the totals exclude it. One column could only
      // carry one of those, and either choice would make the file disagree with
      // the page or fail to add up.
      ['Invoice', 'Sub-Ledger', 'Invoice date', 'Terms', 'Due date', 'Face value', 'Counts toward total', 'Open', 'Status'],
      ...sorted.map((b) => [
        b.no, b.vendor, b.date,
        // A ring marks a term the agreement supplied for a blank cell, exactly
        // as on screen, so the workbook and the table cannot read differently.
        b.termsDays == null ? '' : `Net ${b.termsDays}${b.termsSource === 'agreed' ? ' °' : ''}`,
        b.due, money(b.faceValue), money(b.total), money(b.open),
        b.kind === 'cancelled' ? 'Cancelled — excluded' : b.kind === 'credit-note' ? 'Credit note' : b.status,
      ]),
      [],
      // Blank under "Face value": summing face values would re-add the very
      // cancellations this register takes out. The totals row belongs under the
      // column that counts.
      ['Total', `${filtered.length} bills`, '', '', '', '', money(fTotal), money(fOpen), ''],
    ];
    downloadXlsx([{ name: seg === 'all' ? 'Bills' : seg === 'unpaid' ? 'Unpaid bills' : 'Paid bills', rows }],
      stamped(`smr-ap-${seg}-bills`, 'xlsx'));
  }

  return (
    <div className="section chart-card g12-12" ref={printRef}>
      <div className="section-head">
        <div>
          <h2 className="section-title">{title}</h2>
          <div className="section-sub">
            {sub} · <b>{filtered.length}</b> of {bills.length} bill{bills.length === 1 ? '' : 's'}
            {' '}· <b style={{ color: C.negative }}>{formatCurrency(filtered.reduce((s, b) => s + b.open, 0), true)}</b> outstanding
          </div>
          {/* THE OLD TWO TABLES, as a filter. Counted off the whole register so
              the numbers are a property of the book rather than of the search. */}
          <div className="smr-seg" style={{ marginTop: 8 }}>
            {([['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']] as const).map(([k, label]) => (
              <button key={k} className={seg === k ? 'active' : ''}
                onClick={() => { setSeg(k); setPage(1); setPickSub(new Set()); }}>
                {label} <span style={{ opacity: 0.65, fontWeight: 700 }}>{segCounts[k]}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Search, reset and the export buttons are controls, not content:
            `no-print` keeps them off the PDF. */}
        <div className="tbl-controls no-print">
          <input className="tbl-search" placeholder="Search invoice / sub-ledger" value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
          {/* A filter left on is easy to forget and makes the totals look wrong,
              so the way out is on screen whenever one is applied. */}
          {(pickSub.size > 0 || query) && (
            <button className="btn ghost" style={{ padding: '7px 11px' }}
              onClick={() => { setPickSub(new Set()); setQuery(''); setPage(1); }}>Reset</button>
          )}
          {/* Excel replaces the old CSV button: it carries the same rows but
              keeps amounts numeric, so the totals add up in the file. */}
          <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={exportExcel}
            title="Download these rows as an Excel workbook. Amounts stay numeric so they total in Excel.">
            ⤓ Excel
          </button>
          <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={() => printToPdf(printRef.current)}
            title="Open the print dialog: choose “Save as PDF” for a PDF of this table">
            ⎙ PDF
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice</th>
              {/* Filtering is the operation that makes sense on a sub-ledger:
                  the register is read one supplier at a time. */}
              {/* Only the LABEL sorts — the filter chip sits in the same cell and
                  must not toggle the sort when opened. */}
              <th style={{ whiteSpace: 'nowrap' }}>
                <span className="sortable" style={{ cursor: 'pointer' }} onClick={() => setSortKey('sub')}>
                  Sub-Ledger {sortInd('sub')}
                </span>
                <ColumnFilter label="Sub-ledger" options={subOpts} picked={pickSub}
                  onChange={(next) => { setPickSub(next); setPage(1); }} />
              </th>
              <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setSortKey('date')}>Invoice date {sortInd('date')}</th>
              {/* BETWEEN THE TWO DATES IT RELATES. Read left to right the row now
                  states the whole arrangement: raised on this date, on these
                  terms, due on that one. */}
              <th style={{ whiteSpace: 'nowrap' }}>Terms</th>
              <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setSortKey('due')}>Due date {sortInd('due')}</th>
              <th className="num sortable" onClick={() => setSortKey('total')}>Total {sortInd('total')}</th>
              {/* The paid table has no balance to show, so the column would be a
                  row of dashes. Dropped rather than rendered empty. */}
              {/* Always shown now. It is the column that tells a settled bill
                  from an owed one at a glance, which is the whole point of the
                  two registers being one. */}
              <th className="num sortable" onClick={() => setSortKey('open')}>Open {sortInd('open')}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {/* ALL sorted rows are rendered; the ones outside the current page
                are hidden on screen and revealed in print. Paging the PDF to 10
                rows would make a 68-bill register export as page 1 of 7, which
                is not a document anyone wants. */}
            {sorted.map((b, i) => (
              <tr key={b.no + b.date}
                className={i >= (pageSafe - 1) * PAGE_SIZE && i < pageSafe * PAGE_SIZE ? undefined : 'pg-off'}>
                {/* The row has no click of its own here, so the reference
                    carries the whole affordance. */}
                <td><BillLink bill={b} /></td>
                <td>{b.vendor}</td>
                <td>{fmtDate(b.date)}</td>
                <td><Terms days={b.termsDays} source={b.termsSource} /></td>
                <td>{fmtDate(b.due)}</td>
                {/* A credit note prints as a negative and is tinted, so the row
                    reads as money coming OFF the account rather than another
                    bill that happens to be small. A cancelled bill prints its
                    FACE value struck through: the document existed, the amount
                    does not count, and both facts are visible at once. */}
                <td className={b.kind === 'credit-note' ? 'num cell-pos' : 'num'}
                  style={b.kind === 'cancelled' ? { textDecoration: 'line-through', color: C.muted } : undefined}
                  title={b.kind === 'cancelled' ? 'Cancelled — excluded from every total on this page' : undefined}>
                  {formatCurrency(b.faceValue, true)}
                </td>
                {/* A settled bill shows an em-dash, not $0.00: nothing is owed,
                    and a column of zeroes reads as an amount rather than as the
                    absence of one. */}
                <td className={b.open > 0 ? 'num cell-neg' : 'num'}>
                  {b.open > 0 ? formatCurrency(b.open, true) : <span style={{ color: C.muted }}>—</span>}
                </td>
                <td>{statusTag(b.status, b.kind)}</td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No bills match.</td></tr>}
            {filtered.length > 0 && (
              <tr className="total-row">
                <td>TOTAL</td>
                <td>{filtered.length} bill{filtered.length === 1 ? '' : 's'}</td>
                <td></td><td></td><td></td>
                <td className="num">{formatCurrency(fTotal, true)}</td>
                <td className="num">{formatCurrency(fOpen, true)}</td>
                <td></td>
              </tr>
            )}
            {/* Only on the FULL, unfiltered list: a credit note offsets the
                whole balance, not whichever subset of bills is on screen, so
                netting it against a filtered total would be arithmetic nobody
                could check. */}
            {creditOffset > 0 && filtered.length === bills.length && (
              <>
                <tr className="total-row">
                  <td colSpan={2} style={{ fontWeight: 600, color: C.muted }}>
                    less {creditCount} credit note{creditCount === 1 ? '' : 's'}
                  </td>
                  <td></td><td></td><td></td><td></td>
                  <td className="num cell-pos">−{formatCurrency(creditOffset, true)}</td>
                  <td></td>
                </tr>
                <tr className="total-row">
                  <td>NET OUTSTANDING</td>
                  <td></td><td></td><td></td><td></td><td></td>
                  <td className="num">{formatCurrency(fOpen - creditOffset, true)}</td>
                  <td></td>
                </tr>
              </>
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
  );
}

export function ApSheetTab() {
  // Search / sort / paging live INSIDE each BillTable now, so the two
  // registers page independently of one another.
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [drill, setDrill] = useState<Drill | null>(null);

  // ── LIVE FEED ──────────────────────────────────────────────────────────────
  // Reads the AP Ledgers sheet. `BILLS` stays the name every derivation below
  // already uses, so swapping the source touched none of them — the only change
  // is that it is now component state rather than a constant.
  //
  // `subLedger` is surfaced as `vendor` because that is what the sheet's
  // Sub-Ledger column holds and what every table and chart here already reads.
  const [ledger, setLedger] = useState<ApLedger | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    fetchApLedger()
      .then((d) => { setLedger(d); if (d && d.ok === false) setLoadErr(d.note ?? 'AP Ledgers sheet unavailable.'); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Could not reach the AP Ledgers sheet.'));
  }, []);
  const BILLS: Bill[] = useMemo(
    () => (ledger?.bills ?? []).map((b) => ({
      no: b.no, vendor: b.subLedger, date: b.date, due: b.due,
      total: b.total, faceValue: b.faceValue ?? b.total, kind: b.kind ?? 'bill',
      status: b.status, aging: b.aging, open: b.open,
      terms: b.terms ?? '', dueDays: b.dueDays ?? 0,
      termsDays: b.termsDays ?? null, termsSource: b.termsSource ?? 'none',
    })),
    [ledger],
  );

  // ── THE TWO REGISTERS ──────────────────────────────────────────────────────
  // UNPAID is defined by what is still OWED, not by the status word alone:
  // "Partially Paid" and "Paid without Shipping" both leave a balance behind and
  // belong on the worklist. Everything else is settled.
  //
  // Exhaustive and disjoint by construction — every bill lands in exactly one,
  // so the two tables always add back to the register.
  //
  // A CREDIT NOTE and a CANCELLED BILL are neither: neither owes anything and
  // neither was paid. Both are filed with the settled rows, because the
  // worklist is "what still has to be paid" and neither of them is. Stated as a
  // `kind` test rather than left to fall out of the status word, which is how
  // the credit notes landed there before — wearing an "Unpaid" chip in the PAID
  // table, which was simply wrong.
  const isUnpaid = (b: Bill) => b.kind === 'bill'
    && (b.status === 'Unpaid'
      || ((b.status === 'Partially Paid' || b.status === 'Paid without Shipping') && b.open > 0));
  // `unpaidBills` / `paidBills` are gone with the two tables they fed. The
  // register takes the whole of BILLS and splits it with `isUnpaid` inside its
  // own segment control, so the predicate stays the single definition of "still
  // owed" without a pair of pre-sliced arrays going stale beside it.

  // Headline aggregates: all derived from the one BILLS array so every tile ties.
  //
  // PAID IS THE DEBIT COLUMN, not the count of bills stamped "Paid". The sheet's
  // Debit rows are money actually paid to the supplier; the status word is a
  // per-bill label that can lag it. On four of six vendors the two agree exactly
  // (billed − payments = outstanding); on Doctors Medical they differ by $1,725
  // of payments not applied to any bill, and that gap is worth seeing rather
  // than smoothing away by using whichever basis looks tidier.
  //
  // `paidByStatus` is kept beside it so the variance can be named.
  const agg = useMemo(() => {
    const billed = BILLS.reduce((s, b) => s + b.total, 0);
    const paidByStatus = BILLS.filter((b) => PAID_STATUSES.has(b.status)).reduce((s, b) => s + b.total, 0);
    const paidCount = BILLS.filter((b) => PAID_STATUSES.has(b.status)).length;
    // COUNT the bills that owe something; SUM every balance including the
    // negative ones. A credit note is not an "open bill" — nobody works it off a
    // worklist — but it is money off the total, so it belongs in the sum and not
    // in the count. Filtering to `open > 0` before summing, which is what this
    // did, silently dropped the credits back out of the figure.
    const openBills = BILLS.filter((b) => b.open > 0);
    const outstanding = BILLS.reduce((s, b) => s + b.open, 0);
    const paid = ledger?.totals?.paidRecorded ?? paidByStatus;
    const rate = paid + outstanding > 0 ? (paid / (paid + outstanding)) * 100 : 0;
    return { billed, paid, paidByStatus, paidCount, outstanding, openCount: openBills.length, rate };
  }, [BILLS, ledger]);

  // Per-vendor billed / paid / outstanding, in the register's reading order.
  // `check` is the ledger identity for that block: billed − paid − outstanding,
  // which is zero wherever the sheet is internally consistent.
  const vendorRows = useMemo(() => (ledger?.subLedgers ?? [])
    .map((g) => ({
      vendor: g.subLedger,
      termsDays: g.termsDays ?? null,
      termsSource: g.termsSource ?? 'none',
      bills: g.bills,
      billed: g.billed,
      paid: g.paidRecorded ?? 0,
      payments: g.paymentRows ?? 0,
      open: g.open,
      creditNoteAmount: g.creditNoteAmount ?? 0,
      creditNotes: g.creditNotes ?? 0,
      // Rounded before comparing: three figures each carrying float error can
      // leave a "gap" of 1e-13, which would light up every row as a mismatch.
      check: Math.round((g.billed - (g.paidRecorded ?? 0) - g.open) * 100) / 100,
    }))
    .map((v) => ({
      ...v,
      // ── BILLS REQUIRED ─────────────────────────────────────────────────────
      // Money we have PAID that no invoice on the sheet accounts for.
      //
      // The identity is billed − paid = outstanding. When the Debit column runs
      // ahead of the Credit column the difference is not a rounding problem and
      // it is not an overpayment: it is a payment we made against an invoice the
      // register has never been given. EvoHealth is the clearest case — $51,475
      // paid against $22,625 of bills — and the $28,850 between them is simply
      // invoices we are missing.
      //
      // Naming it turns a reconciliation complaint into a WORKLIST: this is the
      // exact figure of paperwork to chase from each supplier, and once those
      // invoices are entered the row ties on its own.
      //
      // DERIVED FROM `check`, not from the server's `paidGap`, so this column
      // and the RECONCILES tag beside it can never tell different stories — they
      // are two readings of one number. (They agree today on all six vendors;
      // deriving both here is what keeps that true.)
      billsRequired: v.check < -0.005 ? Math.round(-v.check * 100) / 100 : 0,
    }))
    .sort((a, b) => b.billed - a.billed), [ledger]);

  /** Total paperwork outstanding — the figure to chase, across every supplier. */
  const billsRequiredTotal = useMemo(
    () => Math.round(vendorRows.reduce((s, v) => s + v.billsRequired, 0) * 100) / 100,
    [vendorRows],
  );

  // Everything the register takes OUT of its own total, named — so the page can
  // say why it is smaller than the sheet's invoice column instead of leaving
  // that to be discovered by whoever adds the rows up by hand.
  const adjustments = useMemo(() => {
    const cn = BILLS.filter((b) => b.kind === 'credit-note');
    const cx = BILLS.filter((b) => b.kind === 'cancelled');
    const parts: string[] = [];
    if (cn.length) parts.push(`${cn.length} credit note${cn.length === 1 ? '' : 's'} (${formatCurrency(cn.reduce((s, b) => s + Math.abs(b.total), 0), true)})`);
    if (cx.length) parts.push(`${cx.length} cancelled (${formatCurrency(cx.reduce((s, b) => s + b.faceValue, 0), true)})`);
    return { creditNotes: cn.length, cancelled: cx.length, note: parts.join(' · ') };
  }, [BILLS]);

  // Spend by vendor (all bills) and outstanding watchlist (open only).
  const spend = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of BILLS) m.set(b.vendor, (m.get(b.vendor) || 0) + b.total);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [BILLS]);
  const watch = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of BILLS) if (b.open > 0) m.set(b.vendor, (m.get(b.vendor) || 0) + b.open);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [BILLS]);

  // Aging of open balances, mapped onto the shared 5-bucket ramp.
  const aging = useMemo(() => {
    const amt: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const cnt: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of BILLS) {
      if (b.open <= 0) continue;
      const k = AGING_KEY[b.aging] ?? 'current';
      amt[k] += b.open; cnt[k] += 1;
    }
    return { amt, cnt };
  }, [BILLS]);


  // Status mix for the small cards.
  const statusCards = useMemo(() => {
    // 'Credit note' is a row on this card because the percentages are taken
    // against BILLS.length. Credit notes carry a blank status, so before they
    // were named here they fell out of the `order` list entirely and the card
    // silently added up to 125 of 127.
    const order = ['Paid', 'Paid without Shipping', 'Unpaid', 'Partially Paid', 'Cancelled', 'Credit note'];
    const m = new Map<string, number>();
    for (const b of BILLS) {
      const k = b.kind === 'credit-note' ? 'Credit note' : b.status;
      m.set(k, (m.get(k) || 0) + 1);
    }
    const tone = (s: string): 'ok' | 'warn' | 'none' | 'info' =>
      PAID_STATUSES.has(s) ? 'ok' : s === 'Partially Paid' ? 'warn'
        : s.toLowerCase().includes('cancel') || s === 'Credit note' ? 'none' : 'info';
    return order.filter((s) => m.has(s)).map((s) => ({ name: s === 'Paid without Shipping' ? 'Paid (no ship)' : s, value: m.get(s) || 0, tone: tone(s) }));
  }, [BILLS]);


  // Drills.
  //
  // Every amount below is an INVOICE-LEVEL figure, so all of them print CENTS
  // (`formatCurrency(n, true)`). 118 of the 127 bills carry a fractional part,
  // and rounding each row to whole dollars drifted the register by $10.61 —
  // enough that a vendor's rows visibly failed to add up to their own total.
  // The headline KPI strip stays in whole dollars: that is the board-wide
  // convention for glanceable figures, and the drill behind each tile is where
  // the exact number now lives.
  const vendorDrill = (name: string) => setDrill({
    title: name,
    // One supplier, so the term is a property of the whole drill: repeating it
    // down every row would say the same thing as many times as they have bills.
    sub: (() => {
      const n = BILLS.filter((b) => b.vendor === name).length;
      const d = BILLS.find((b) => b.vendor === name && b.termsDays != null)?.termsDays ?? null;
      return `${n} bills on record · ${d == null ? 'no payment terms stated' : d === 0 ? 'Due on receipt' : `Net ${d}`}`;
    })(),
    columns: [{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Date' }, { key: 't', label: 'Total', num: true }, { key: 's', label: 'Status' }],
    // One vendor, so this is invoice sequence ascending — same order the
    // supplier's block runs in on the register below.
    rows: BILLS.filter((b) => b.vendor === name).sort(byLedgerThenSequence)
      .map((b) => ({
        n: <BillLink bill={b} />,
        d: fmtDate(b.date),
        // Face value, so a cancelled row still shows the document's amount —
        // the strike-through and the tag say it does not count.
        t: b.kind === 'cancelled'
          ? <s style={{ color: C.muted }}>{formatCurrency(b.faceValue, true)}</s>
          : formatCurrency(b.total, true),
        s: statusTag(b.status, b.kind),
      })),
  });
  const explainOutstanding = () => setDrill({
    title: 'Outstanding', sub: `${agg.openCount} open bills · ${formatCurrency(agg.outstanding, true)}`,
    // Spelled out and in caps. The drill's CSS uppercases headers anyway, but
    // the labels are written that way here so the words survive anywhere the
    // stylesheet does not reach — the PDF print sheet and the Excel export.
    // INVOICE DATE sits beside DUE DATE. With only the due date on screen there
    // was no way to tell a bill that is late from one raised on long terms —
    // both read as a date in the past — and the register's own table carries
    // both, so the drill was the odd one out.
    columns: [
      { key: 'n', label: 'INVOICE NUMBER' }, { key: 'v', label: 'VENDOR NAME' },
      { key: 'd', label: 'INVOICE DATE' }, { key: 'tm', label: 'TERMS' }, { key: 'due', label: 'DUE DATE' },
      { key: 'o', label: 'OPEN BALANCES', num: true },
    ],
    // Vendor A→Z, then invoice sequence — the register's own order, so the
    // drill reads as a continuation of the tables rather than a reshuffle of
    // them. It used to lead with the largest balance, which scattered each
    // supplier's bills down the list.
    rows: BILLS.filter((b) => b.open > 0).sort(byLedgerThenSequence)
      // An em-dash where the sheet carries no date, not a blank cell: HiDow's
      // 83563 has neither an invoice date nor a due date, and an empty cell
      // reads as a rendering fault rather than as a gap in the source.
      .map((b): Record<string, ReactNode> => ({
        // Openable here too — this drill is where the outstanding rows are
        // actually worked, so it is the likeliest place to want the terms and
        // the days-past-due the row cannot print.
        n: <BillLink bill={b} />,
        v: b.vendor,
        d: b.date ? fmtDate(b.date) : <span style={{ color: C.muted }}>—</span>,
        tm: <Terms days={b.termsDays} source={b.termsSource} />,
        due: b.due ? fmtDate(b.due) : <span style={{ color: C.muted }}>—</span>,
        o: formatCurrency(b.open, true),
      }))
      // The credit notes, then the net — so the rows above add to the figure on
      // the tile rather than to $51.20 more than it.
      .concat((ledger?.totals?.creditNotes ?? 0) > 0 ? [
        {
          n: <span style={{ color: C.muted }}>less {ledger!.totals!.creditNotes} credit note{ledger!.totals!.creditNotes === 1 ? '' : 's'}</span>,
          v: '', d: '', tm: '', due: '', o: <span className="cell-pos">−{formatCurrency(ledger!.totals!.creditNoteAmount, true)}</span>,
        },
        {
          n: <strong>NET OUTSTANDING</strong>, v: '', d: '', tm: '', due: '',
          o: <strong>{formatCurrency(agg.outstanding, true)}</strong>,
        },
      ] : []),
  });
  /**
   * What was paid, per vendor, and whether it reconciles.
   *
   * Three columns that should satisfy `billed − paid = outstanding` on every
   * row. Where they do not, the row says so instead of the drill quietly
   * printing three numbers that do not relate.
   */
  const explainPaid = () => setDrill({
    title: 'Paid to Date',
    sub: `${ledger?.totals?.paymentRows ?? 0} payments in the sheet's Debit column · ${formatCurrency(agg.paid, true)}`,
    columns: [
      { key: 'v', label: 'SUB-LEDGER' }, { key: 'p', label: 'PAID', num: true },
      { key: 'n', label: 'PAYMENTS' }, { key: 'b', label: 'BILLED', num: true },
      { key: 'o', label: 'OUTSTANDING', num: true }, { key: 'c', label: 'BILLED − PAID − OUTSTANDING' },
    ],
    rows: [
      ...vendorRows.map((v) => ({
        v: v.vendor, p: formatCurrency(v.paid, true), n: String(v.payments),
        b: formatCurrency(v.billed, true), o: formatCurrency(v.open, true),
        c: reconcileTag(v.check, v.creditNoteAmount, v.creditNotes),
      })),
      {
        v: <strong>TOTAL</strong>,
        p: <strong>{formatCurrency(vendorRows.reduce((s, v) => s + v.paid, 0), true)}</strong>,
        n: <strong>{vendorRows.reduce((s, v) => s + v.payments, 0)}</strong>,
        b: <strong>{formatCurrency(vendorRows.reduce((s, v) => s + v.billed, 0), true)}</strong>,
        o: <strong>{formatCurrency(vendorRows.reduce((s, v) => s + v.open, 0), true)}</strong>,
        c: <strong>{formatCurrency(vendorRows.reduce((s, v) => s + v.check, 0), true)}</strong>,
      },
    ],
  });
  const explainBilled = () => setDrill({
    title: 'Total AP Billed', sub: `${BILLS.length} bills · ${formatCurrency(agg.billed, true)}`,
    columns: [{ key: 'v', label: 'Vendor' }, { key: 't', label: 'Billed', num: true }],
    rows: spend.map((s) => ({ v: s.name, t: formatCurrency(s.value, true) })),
  });

  return (
    // `ap-register` scopes this tab's own typography. `exec-deck` is shared by a
    // dozen tabs, so styling through it would restyle the whole portal.
    <div className="exec-deck ap-register" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>AP Register</h1>
          <div className="page-sub">
            Live from the <b>AP Ledgers</b> sheet · {BILLS.length} bills across {ledger?.subLedgers?.length ?? 0} sub-ledgers · no patient data
            {ledger?.fetchedAt && <> · read {new Date(ledger.fetchedAt).toLocaleTimeString()}</>}
          </div>
        </div>
      </div>

      {/* The sheet is unreachable or unconfigured — say so rather than render an
          empty register that looks like "no bills". */}
      {loadErr && <div className="error" style={{ marginBottom: 12 }}>{loadErr}</div>}
      {!ledger && !loadErr && <div className="page-sub" style={{ padding: 16 }}>Reading the AP Ledgers sheet…</div>}

      <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        {/* NET of credit notes and cancellations — said on the tile, because a
            total that is quietly smaller than the sheet's own invoice column
            invites the question this answers. */}
        <KpiR ico="doc" tint="#0A369F" label="Total AP Billed" value={agg.billed} format={formatCurrency}
          deltaText={`${BILLS.length} invoices`}
          foot={adjustments.note ? `net of ${adjustments.note}` : 'invoice register'}
          onClick={explainBilled} />
        {/* The DEBIT column — money actually paid — not the face value of bills
            stamped "Paid". Clickable, because the two bases differ by $1,776.20
            and that is a question the tile should answer rather than raise. */}
        <KpiR ico="wallet" tint="#16A34A" label="Paid to Date" value={agg.paid} format={formatCurrency}
          deltaText={`${ledger?.totals?.paymentRows ?? 0} payments recorded`}
          foot="from the sheet's Debit column" onClick={explainPaid} />
        {/* NET of credit notes — said on the tile, since the Unpaid Bills table
            below adds to the gross balance and the two would otherwise sit
            $51.20 apart with nothing to connect them. */}
        <KpiR ico="cash" tint="#DC2626" label="Outstanding" value={agg.outstanding} format={formatCurrency}
          deltaText={`${agg.openCount} open bills`}
          foot={(ledger?.totals?.creditNotes ?? 0) > 0
            ? `unpaid + partial, less ${formatCurrency(ledger!.totals!.creditNoteAmount, true)} credit notes`
            : 'unpaid + partial'}
          onClick={explainOutstanding} />
        <KpiR ico="clip" tint="#D97706" label="Open Bills" value={agg.openCount}
          deltaText="awaiting payment" foot="from the register" onClick={explainOutstanding} />
        <KpiR ico="pie" tint="#7C3AED" label="Payment Rate" value={agg.rate} format={(n) => `${n.toFixed(1)}%`}
          deltaText="paid ÷ (paid + open)" foot="of registered $" />
      </div>

      <div className="exec-grid12">
        <ChartCard className="g12-7" title="Spend by Vendor" sub="Total billed per vendor · click a bar to drill">
          <RankBar data={spend} money colorAt={() => C.brand} onSelect={vendorDrill} />
        </ChartCard>

        <ChartCard className="g12-5" title="AP Aging" sub="Open balance by days past due"
          right={
            <div className="smr-seg" style={{ margin: 0 }}>
              <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
              <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
            </div>
          }>
          <AgingBar aging={agingMode === 'amount' ? aging.amt : aging.cnt} money={agingMode === 'amount'} />
        </ChartCard>

        <ChartCard className="g12-7" title="Outstanding by Vendor" sub="Who we owe · open balances only · click to drill">
          <RankBar data={watch} money colorAt={() => C.negative} onSelect={vendorDrill} />
        </ChartCard>

        <ChartCard className="g12-5" title="Payment Status" sub={`${BILLS.length} bills by status`}>
          <StatCards data={statusCards} total={BILLS.length} />
        </ChartCard>

        {/* TWO REGISTERS, not one filtered table. "What still has to be paid"
            and "what is settled" are different jobs — one is a worklist, the
            other a record — and a dropdown made you re-pick the split every
            time. Each table carries its own search, sort, paging and CSV.

            UNPAID = status Unpaid, plus Partially Paid and Paid without
            Shipping that still carry an open balance. Everything else is
            settled. The two are exhaustive: 68 + 59 = 127, and every dollar of
            outstanding lands in the unpaid table. */}
        {/* SUB-LEDGER SUMMARY — the ledger identity, one row per supplier.
            Sits above the two bill registers because it is the reconciliation
            those registers roll up to: billed against what was actually paid,
            with the remainder that should equal the outstanding column.
            Payments are per-VENDOR in this sheet, not per-bill, so they cannot
            be shown as a column inside the bill tables below — this is their
            place. */}
        <div className="section chart-card g12-12">
          <div className="section-head">
            <div>
              <h2 className="section-title">SUB-LEDGER SUMMARY</h2>
              <div className="section-sub">
                What each supplier was billed, what has been paid to them, and what is left ·
                {' '}<b>{ledger?.totals?.paymentRows ?? 0}</b> payments from the sheet's Debit column
              </div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SUB-LEDGER</th>
                  {/* A property of the SUPPLIER, so it sits with their name
                      rather than being read off one of their bills. */}
                  <th>TERMS</th>
                  <th className="num">BILLS</th>
                  <th className="num">BILLED</th>
                  <th className="num">PAID</th>
                  <th className="num">PAYMENTS</th>
                  <th className="num">OUTSTANDING</th>
                  {/* Paid with no invoice behind it — the paperwork to chase.
                      See `billsRequired`. */}
                  <th className="num" title="Payments with no invoice on the sheet to account for them. Obtain these bills and the row reconciles.">BILLS REQUIRED</th>
                  <th>RECONCILES</th>
                </tr>
              </thead>
              <tbody>
                {vendorRows.map((v) => (
                  <tr key={v.vendor}>
                    <td><strong>{v.vendor}</strong></td>
                    <td><Terms days={v.termsDays} source={v.termsSource} /></td>
                    <td className="num">{v.bills}</td>
                    <td className="num">{formatCurrency(v.billed, true)}</td>
                    <td className="num cell-pos">{formatCurrency(v.paid, true)}</td>
                    <td className="num">{v.payments}</td>
                    <td className={v.open > 0.005 ? 'num cell-neg' : 'num'}>
                      {v.open > 0.005 ? formatCurrency(v.open, true) : '-'}
                    </td>
                    <td className="num" style={v.billsRequired > 0 ? { color: C.warning, fontWeight: 700 } : undefined}>
                      {v.billsRequired > 0 ? formatCurrency(v.billsRequired, true) : '-'}
                    </td>
                    <td>{reconcileTag(v.check, v.creditNoteAmount, v.creditNotes)}</td>
                  </tr>
                ))}
                {vendorRows.length > 0 && (
                  <tr className="total-row">
                    <td>TOTAL</td>
                    <td />
                    <td className="num">{vendorRows.reduce((s, v) => s + v.bills, 0)}</td>
                    <td className="num">{formatCurrency(vendorRows.reduce((s, v) => s + v.billed, 0), true)}</td>
                    <td className="num">{formatCurrency(vendorRows.reduce((s, v) => s + v.paid, 0), true)}</td>
                    <td className="num">{vendorRows.reduce((s, v) => s + v.payments, 0)}</td>
                    <td className="num">{formatCurrency(vendorRows.reduce((s, v) => s + v.open, 0), true)}</td>
                    <td className="num" style={billsRequiredTotal > 0 ? { color: C.warning, fontWeight: 800 } : undefined}>
                      {billsRequiredTotal > 0 ? formatCurrency(billsRequiredTotal, true) : '-'}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Named, not hidden: the register is a reconciliation, and a row that
              genuinely does not tie is the most useful thing on this page.
              A credit-note difference is EXPLAINED, so it is described rather
              than listed as an exception — lumping the two together is how a
              real $1,725 problem gets read as more of the same bookkeeping
              noise. */}
          {(() => {
            const explained = vendorRows.filter((v) => v.creditNoteAmount > 0 && Math.abs(v.check + v.creditNoteAmount) < 0.01);
            const unexplained = vendorRows.filter((v) => Math.abs(v.check) >= 0.01 && !explained.includes(v));
            if (!explained.length && !unexplained.length) return null;
            return (
              <div className="muted-note" style={{ marginTop: 10 }}>
                A row ties when <b>billed − paid = outstanding</b>.
                {explained.length > 0 && (
                  <> {explained.map((v) => v.vendor).join(', ')} sits {explained.map((v) => formatCurrency(Math.abs(v.check), true)).join(', ')} short
                    {' '}<b>because of its credit note{explained[0].creditNotes === 1 ? '' : 's'}</b>: Billed here is net of them,
                    while the sheet's Outstanding column is not. That block otherwise reconciles exactly.</>
                )}
                {unexplained.length > 0 && (() => {
                  // TWO DIFFERENT FAULTS, and they were being reported as one
                  // sentence. A NEGATIVE check means we paid more than the
                  // invoices on file account for — the paperwork is missing, and
                  // the fix is to obtain those bills. A POSITIVE one means the
                  // opposite: a bill's balance was never reduced for a payment
                  // already made, which is a correction to the sheet. Telling
                  // someone to "chase invoices" for the second is wrong work.
                  const missingBills = unexplained.filter((v) => v.billsRequired > 0);
                  const unapplied = unexplained.filter((v) => v.billsRequired === 0);
                  return (
                    <>
                      {missingBills.length > 0 && (
                        <> <b>Bills required</b> — we have paid{' '}
                          <b style={{ color: C.warning }}>{formatCurrency(billsRequiredTotal, true)}</b> that no invoice on this
                          sheet accounts for: {missingBills.map((v) => `${v.vendor} ${formatCurrency(v.billsRequired, true)}`).join(', ')}.
                          {' '}These are not overpayments — they are invoices we do not yet hold. Obtain them from the supplier,
                          enter them in the sheet, and each block ties on its own.</>
                      )}
                      {unapplied.length > 0 && (
                        <> {unapplied.map((v) => `${v.vendor} ${formatCurrency(v.check, true)}`).join(', ')} — a bill's balance
                          has not been reduced for a payment already made; that is a correction to the sheet, not a missing invoice.</>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })()}
        </div>

        {/* ONE REGISTER. It was two cards — "Unpaid Bills" then "Paid Bills" —
            which split every supplier's history in half: answering "what has
            Doctors Medical billed us and where does it stand" meant reading one
            table, scrolling past a second, and re-applying the same sub-ledger
            filter. The segment inside keeps both worklists one click away. */}
        <BillTable
          title="Bill Register"
          sub={adjustments.note
            ? `Every bill, paid and unpaid · includes ${adjustments.note}, excluded from the total`
            : 'Every bill, paid and unpaid'}
          bills={BILLS}
          isUnpaid={isUnpaid}
          creditOffset={ledger?.totals?.creditNoteAmount ?? 0}
          creditCount={ledger?.totals?.creditNotes ?? 0}
        />
      </div>

      {/* Kept at the FOOT of the tab: a caveat about the SOURCE, not
          something to read before the register itself. The sheet keeps its
          "Total Outstanding" cell by hand; the Outstanding column is what the
          rows actually add up to, so every figure uses the column and this
          names the gap rather than hiding it. */}
      {/* SILENT WHEN EVERYTHING TIES.
          The workbook's top "Total Outstanding" cell is no longer read, so there
          is no longer a permanent notice about a stale hand-typed figure sitting
          under a register whose every block reconciles. What remains speaks up
          only when a vendor block genuinely disagrees with its own subtotal row
          — a banner that is always on is a banner nobody reads. */}
      {(ledger?.totals?.blockMismatches?.length ?? 0) > 0 && (
        <div className="qb-flash warn" style={{ marginBottom: 12 }}>
          ⚠️ {ledger!.totals!.blockMismatches.length} vendor
          block{ledger!.totals!.blockMismatches.length === 1 ? ' does' : 's do'} not tie
          to {ledger!.totals!.blockMismatches.length === 1 ? 'its' : 'their'} own <b>Total Outstanding</b> row:{' '}
          {ledger!.totals!.blockMismatches.map((m) => `${m.subLedger} (rows ${formatCurrency(m.rows, true)} vs sheet ${formatCurrency(m.sheet, true)})`).join('; ')}.
          Every figure here uses the rows.
          {(ledger?.droppedHeaderRows ?? 0) > 0 && <> {ledger!.droppedHeaderRows} repeated header rows inside the data were skipped.</>}
        </div>
      )}

      {drill && <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
