import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchPiLienstar, type ArResult, type PiBookInvoice, type PiLienstar } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { DrillModal } from '../chartKit';
import { SoLink } from './SoLink';
import { soIdFromRef } from '../soRef';
import { GuideMark, currentAnchor } from '../guideTrail';

/**
 * THE PI BOOK — four tranches of a lien case, on the AR REGISTER.
 *
 * Lifted out of ReceivablesTab, which owned it until the Invoice Book grew a
 * vertical picker. It belongs beside the invoices it describes: the register
 * already splits the book by vertical, and "PI" there means exactly the cases
 * these four sections divide up. On the AR / AP page it sat under a KPI strip
 * and five charts that are about the whole book, and a reader filtering to PI
 * in the register had to leave the page to find out what PI actually is.
 *
 * SELF-CONTAINED ON PURPOSE. It takes the `/api/ar` payload and owns everything
 * else — its own tab state, its own guide-anchor handling, its own "View all"
 * modal. The host renders <PiBook ar={ar} /> and nothing more, so the next
 * screen that wants it does not have to lift a memo and four helpers with it.
 */

const trunc = (v: string, n = 24) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);

// it is asserted on the server (see _pi-book.test.js) rather than hoped for.
//
// A ROW CAN BE IN TWO SECTIONS; THE MONEY IS IN ONE. A case whose advance is in
// is in (1) for the 15% and (4) for the 85%, which is what it is: two tranches
// of one case, at different stages, and collapsing it into a single row would
// have to hide one of them.
//
// ONE TABLE, FOUR TABS. They were four stacked panels first, and that buried the
// it is asserted on the server (see _pi-book.test.js) rather than hoped for.
//
// A ROW CAN BE IN TWO SECTIONS; THE MONEY IS IN ONE. A case whose advance is in
// is in (1) for the 15% and (4) for the 85%, which is what it is: two tranches
// of one case, at different stages, and collapsing it into a single row would
// have to hide one of them.
//
// ONE TABLE, FOUR TABS. They were four stacked panels first, and that buried the
// only comparison the split exists to make: section 1 and section 4 sat two
// thousand pixels apart, so how the case value actually divides could not be
// seen without scrolling and remembering. The strip puts the four figures on one
// line, and the table below answers "which cases?" for whichever is pressed —
// which also means the four rows sets must share ONE shape, hence `PiRow`.
// ─────────────────────────────────────────────────────────────────────────────

/** The four accents, in the order the sections run. Green is money in, amber is
 *  being chased, red is not even asked for, slate is not owed yet — the same
 *  severity ladder the pills use, so a colour means one thing on this page. */
type PiTone = 'ok' | 'warn' | 'danger' | 'info';

/**
 * ONE ROW SHAPE FOR ALL FOUR SECTIONS.
 *
 * Three of the four are invoices and the fourth is an order that has none, so
 * they arrive in two different shapes from two different places. Normalising
 * them here is what lets a SINGLE table render any section: the table takes
 * `PiRow[]` and knows nothing about which section it is showing, so the four
 * cannot drift into four subtly different tables.
 *
 * `amount` IS THE SECTION'S OWN TRANCHE — advance received, advance owed, what
 * invoicing would raise, or the balance to come. The column header names which,
 * because the figure means something different in each and an unlabelled money
 * column would be four different numbers under one word.
 */
type PiRow = {
  key: string;
  /** STRING OR NUMBER, because the two sources disagree and SoLink takes either:
   *  the PI book ships the id as a string, while section 3's orders are keyed by
   *  reference and parsed to a number by `soIdFromRef`. Coercing one to match
   *  the other here would only move the cast, not remove it. */
  soId: string | number | null; ref: string; rep: string;
  /** Null where no invoice has been raised — section 3, and only section 3. */
  invoiceNo: string | null;
  patient: string; payer: string;
  caseValue: number; amount: number;
  joined: boolean; overRate: boolean;
  /** The order's value in Striven today, and what it was invoiced at — for the
   *  case-value-difference remark. Absent on section 3's uninvoiced orders. */
  valueNow?: number | null; invoiced?: number;
  /** Why this invoice is not the plain 15% advance — a short tag and the exact
   *  reason, worked out from the order, its other invoices and Lienstar. */
  remark?: { tag: string; text: string } | null;
  status: ReactNode;
};

/** What the tab strip and the table need to know about one section. */
type PiSectionDef = {
  n: 1 | 2 | 3 | 4;
  tone: PiTone;
  /** The tab's label, the table's money-column header, and the prose under the
   *  strip. Three different lengths for three different jobs. */
  tab: string; amountLabel: string; title: string; sub: ReactNode;
  unit: string;
  /** This section's headword in the User Guide — the ⓘ beside its title goes
   *  there. Each section gets its OWN term rather than all four pointing at
   *  "Fifteen percent advance": the reader pressing ⓘ on section 3 is asking
   *  what "not invoiced" means, not what the lien rate is. */
  guide: string;
  amount: number; count: number; caseValue: number;
  rows: PiRow[];
};

/**
 * THE BADGES A PI ROW CAN CARRY, and both are about the JOIN, not the money.
 *
 * A reader looking at a case value wants to know whether it is the order or a
 * stand-in, because that decides whether the 85% beside it means anything. Two
 * rows can carry the same figures for opposite reasons, and the badge is the
 * only thing that tells them apart.
 */
function PiRowFlags({ r }: { r: PiRow }) {
  // CASE VALUE DIFFERENCE. Striven's order is worth something else today than
  // the cached value this row was worked from (an order edited after the
  // invoice). Shown as a remark with the difference, and the "more than 15%"
  // tag is only kept if the invoice is over 15% of TODAY's value too — SO-49's
  // #199 is 14.3% of its current $15,187, not "over 15%" of a stale $8,492.
  const now = r.valueNow ?? null;
  const diff = now != null ? Math.round((now - r.caseValue) * 100) / 100 : 0;
  const valueChanged = r.joined && now != null && Math.abs(diff) >= 1;
  return (
    <>
      {!r.joined && (
        <span className="pill-tag tag-muted" style={{ marginLeft: 6 }}
          title="No sales order joins to this invoice, so the case value is the invoice itself. There is no 15% split and nothing riding behind it.">
          no order
        </span>
      )}
      {/* NAMES THE SOURCE, not just the arithmetic. "over 15%" read as a rule
          this page had applied and found wanting — as though the portal had
          decided the invoice was wrong. It has decided nothing: STRIVEN raised
          the invoice at more than 15% of the order behind it, and the badge is
          reporting what is in the system of record so somebody can go and look
          at it there. `white-space: nowrap` because the phrase is four words in
          a cell that already sets nowrap on the invoice number beside it, and a
          badge that wrapped mid-sentence would read as two tags. */}
      {valueChanged && (
        <span className="pill-tag tag-info" style={{ marginLeft: 6, whiteSpace: 'nowrap' }}
          title={`The sales order is ${formatCurrency(now!)} in Striven today; this row's figures use ${formatCurrency(r.caseValue)} from an older copy of the order. Invoiced ${formatCurrency(r.invoiced ?? 0)} = ${now ? (((r.invoiced ?? 0) / now) * 100).toFixed(1) : '-'}% of the current value.`}>
          Case value {diff > 0 ? '+' : '−'}{formatCurrency(Math.abs(diff))} · now {formatCurrency(now!)}
        </span>
      )}
      {r.remark?.tag && (
        <span className="pill-tag tag-warn" style={{ marginLeft: 6, whiteSpace: 'nowrap' }} title={r.remark.text}>
          {r.remark.tag}
        </span>
      )}
      {r.remark?.text && <div className="pi-remark">{r.remark.text}</div>}
    </>
  );
}

/**
 * THE TAB STRIP: four sections, side by side, each one a button.
 *
 * IT IS A SUMMARY AND A CONTROL AT ONCE, which is the point. Four stacked panels
 * put two thousand pixels between section 1 and section 4, so the one comparison
 * the split exists to make — how the case value divides between banked, owed,
 * unbilled and not-yet-due — could not be made without scrolling. Side by side,
 * the four figures are read in one glance and the table below answers "which
 * cases?" for whichever one you press.
 *
 * EVERY TAB KEEPS ITS OWN ACCENT WHEN INACTIVE, at low strength. Greying the
 * three you are not on would throw away the severity ladder exactly when it is
 * most useful — the strip is meant to be read as four figures, not as one
 * selected figure and three dormant controls.
 */
function PiTabs({ sections, active, onPick }: {
  sections: PiSectionDef[]; active: number; onPick: (n: PiSectionDef['n']) => void;
}) {
  return (
    <div className="pi-tabs" role="tablist" aria-label="Personal Injury book sections">
      {sections.map((s) => (
        <button key={s.n} type="button" role="tab"
          id={`pi-tab-${s.n}`} aria-controls="pi-book-table" aria-selected={active === s.n}
          className={`pi-tab is-${s.tone}${active === s.n ? ' active' : ''}`}
          onClick={() => onPick(s.n)}>
          <span className="pi-tab-top">
            <span className="pi-tab-n" aria-hidden>{s.n}</span>
            <span className="pi-tab-l">{s.tab}</span>
          </span>
          <strong className="pi-tab-v">{formatCurrency(s.amount)}</strong>
          <span className="pi-tab-f">{s.count} {s.unit}{s.count === 1 ? '' : 's'} · {formatCurrency(s.caseValue)} case value</span>
        </button>
      ))}
    </div>
  );
}

/**
 * THE ONE TABLE. It renders whichever section is selected and knows nothing else
 * about them.
 *
 * THE INVOICE COLUMN STAYS FOR SECTION 3, reading "not raised" rather than
 * vanishing. In four separate tables that column could simply be absent, because
 * each table was its own thing; in one table the columns must not move under the
 * reader when they change tab — a header that shifts sideways between sections
 * makes the four impossible to compare, which is the whole reason they were
 * merged. And "not raised" is the actual answer for those rows: it is the
 * subject of the section, not a gap in the data.
 */
function PiTable({ section }: { section: PiSectionDef }) {
  return (
    <table className="data-table compact" id="pi-book-table"
      role="tabpanel" aria-labelledby={`pi-tab-${section.n}`}>
      <thead>
        <tr>
          <th>Order</th><th>Invoice</th><th>Patient</th><th>Payer</th><th>Rep</th>
          <th className="num">Case value</th><th className="num">{section.amountLabel}</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        {section.rows.map((r) => (
          // TINTED ONLY ON SECTION 3, as it always was. That section is an action
          // list — every row is an invoice somebody has to raise — and the tint
          // is what says so at a glance. Tinting all four would make the tint
          // mean "this is a PI row", which is not worth a colour.
          <tr key={r.key} className={section.n === 3 ? 'is-pending-row' : undefined}>
            {/* The order leads in every section, so the four read as one book cut
                four ways rather than as four tables that happen to be adjacent. */}
            <td>{r.ref ? <SoLink soId={r.soId} label={r.ref} /> : <span style={{ color: C.muted }}>-</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {r.invoiceNo
                ? <>#{r.invoiceNo}<PiRowFlags r={r} /></>
                : <span style={{ color: C.muted }}>not raised</span>}
            </td>
            <td className="clip">{r.patient || '-'}</td>
            <td className="clip" title={r.payer || undefined}>{trunc(r.payer || '-', 22)}</td>
            <td>{r.rep || '-'}</td>
            <td className="num">{formatCurrency(r.caseValue)}</td>
            <td className="num">{formatCurrency(r.amount)}</td>
            <td>{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PiBook({ ar }: { ar: ArResult | null }) {
  /**
   * WHAT LIENSTAR ACTUALLY FUNDED, per the Master File (5 Oct 2026). Striven's
   * ledger is all this book read before, and Lienstar's advance is often never
   * recorded against the invoice there — SO-173's #112 read "Advance also due"
   * though Lienstar had funded its full 15%. An Approved case whose To be Funded
   * covers the advance is treated as received. Refreshed with the board; a
   * failed fetch simply leaves the ledger reading in place.
   */
  const [lien, setLien] = useState<PiLienstar | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetchPiLienstar().then((r) => { if (alive && r?.ok) setLien(r); }).catch(() => {});
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  /** Lienstar funded this invoice's 15% advance in full (Approved case). */
  const lienFunded = (r: PiBookInvoice) => {
    const L = r.soId ? lien?.lienBySo?.[String(r.soId)] : undefined;
    return Boolean(L && /^approved$/i.test(L.status) && L.toBeFunded > 0 && L.toBeFunded >= r.advance - 0.5);
  };
  const lienTip = (r: PiBookInvoice, extra: string) => {
    const L = r.soId ? lien?.lienBySo?.[String(r.soId)] : undefined;
    return `Lienstar funded the 15% advance: ${formatCurrency(L?.toBeFunded ?? 0)}${L?.paidOn ? ` on ${L.paidOn}` : ''}${L?.batch ? ` (batch ${L.batch})` : ''}, per the Master File's PI Lienstar Funding tab. Striven's ledger has not recorded it against this invoice. ${extra}`;
  };
  const advanceInTag = (r: PiBookInvoice) => (r.overRate
    ? <span className="pill-tag tag-ok" title={lienTip(r, 'The invoice bills the full case value, so the remaining 85% arrives at settlement.')}>Advance received · fully invoiced</span>
    : <span className="pill-tag tag-ok" title={lienTip(r, '')}>Advance received (Lienstar)</span>);
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
  /**
   * THE OTHER THREE TRANCHES — see the block comment above the component.
   *
   * Split server-side (piBookOf), because section 1 is built from invoices this
   * endpoint's own register deliberately drops: an advance that has been
   * collected leaves no balance, and `invoices` carries only what is owed.
   *
   * OPTIONAL ON PURPOSE. An open tab across a deploy holds a payload with no
   * `piBook`, and the four sections then degrade to the one the page has always
   * had rather than rendering "$NaN" under three empty tables.
   */
  const piBook = ar?.piBook ?? null;

  /**
   * THE FOUR SECTIONS, BUILT ONCE — figures, prose and rows together.
   *
   * They are assembled in one place because the tab strip and the table have to
   * agree about every one of them: the strip shows a section's total, the table
   * shows the rows that total was summed from, and deriving those separately is
   * how a strip comes to disagree with the table under it.
   *
   * A SECTION WITH NO ROWS IS DROPPED, not shown empty. Each is a real state a
   * case can be in, and an empty one is a state nothing is currently in — a tab
   * that opens on "no rows" is a dead end, and four tabs where one never
   * answers teaches a reader to distrust the other three.
   */
  const piSections = useMemo<PiSectionDef[]>(() => {
    // ── WHY AN INVOICE IS NOT THE PLAIN 15% ADVANCE ──────────────────────────
    // Every PI invoice should be 15% of its case. Where one is not, the row
    // says exactly why instead of a generic "more than 15%" badge: the full
    // case value billed, a share other than 15%, a case value changed after
    // invoicing, other invoices on the same order — and what Lienstar did.
    const invBySo = new Map<string, { number: string; invoiced: number }[]>();
    const seenInv = new Set<number>();
    for (const r of [...(piBook?.received.invoices ?? []), ...(piBook?.awaiting.invoices ?? []), ...(piBook?.balance.invoices ?? [])]) {
      if (!r.soId || seenInv.has(r.id)) continue;
      seenInv.add(r.id);
      invBySo.set(String(r.soId), [...(invBySo.get(String(r.soId)) ?? []), { number: r.number, invoiced: r.invoiced }]);
    }
    const money = (n: number) => formatCurrency(Math.round(n * 100) / 100);
    const remarkOf = (r: PiBookInvoice): PiRow['remark'] => {
      if (!r.joined || !r.soId) return null;
      const base = r.valueNow && Math.abs(r.valueNow - r.caseValue) >= 1 ? r.valueNow : r.caseValue;
      const changed = base !== r.caseValue;
      const fifteen = Math.round(base * 15) / 100;
      const pctOf = base ? (r.invoiced / base) * 100 : 0;
      const isFull = Math.abs(r.invoiced - base) < 1;
      const isOver = r.invoiced > fifteen + 0.01;
      if (!isOver && !changed) return null;              // a plain 15% advance: nothing to explain
      const L = lien?.lienBySo?.[String(r.soId)];
      const lienTxt = !L ? 'Not on the Lienstar tab, so no 15% advance was funded by Lienstar.'
        : /^approved$/i.test(L.status)
          ? `Lienstar funded the 15% (${money(L.toBeFunded)})${L.paidOn ? ` on ${L.paidOn}` : ', not paid yet'}.`
          : `Lienstar: ${L.status}, nothing funded.`;
      const sibs = (invBySo.get(String(r.soId)) ?? []).filter((x) => x.number !== r.number);
      const orderBilled = Math.round(((invBySo.get(String(r.soId)) ?? []).reduce((t, x) => t + x.invoiced, 0)) * 100) / 100;
      const sibTxt = sibs.length
        ? ` ${r.ref} also has ${sibs.map((x) => `#${x.number} (${money(x.invoiced)})`).join(', ')}: ${money(orderBilled)} billed on this case in total${orderBilled > base + 1 ? `, ${money(orderBilled - base)} more than the case value` : ''}.`
        : '';
      if (changed && !isOver) {
        const gap = L && /^approved$/i.test(L.status) ? Math.round((L.toBeFunded - r.invoiced) * 100) / 100 : 0;
        return {
          tag: '',
          text: `Case value changed after invoicing: ${money(r.caseValue)} → ${money(base)}. Invoiced ${money(r.invoiced)} = ${pctOf.toFixed(1)}% of the current value.`
            + (Math.abs(gap) >= 1 ? ` Lienstar's 15% is ${money(L!.toBeFunded)}, so the invoice is ${money(Math.abs(gap))} ${gap > 0 ? 'below' : 'above'} it.` : '')
            + sibTxt,
        };
      }
      if (isFull) {
        return {
          tag: 'Billed full case value',
          text: `Invoiced the full case value (${money(base)}) instead of the 15% advance (${money(fifteen)}). ${lienTxt}${sibTxt}`,
        };
      }
      return {
        tag: `Billed ${Math.round(pctOf)}% of case`,
        text: `Invoiced ${money(r.invoiced)} = ${pctOf.toFixed(1)}% of the ${money(base)} case; the 15% advance is ${money(fifteen)}. ${lienTxt}${sibTxt}`,
      };
    };
    const fromInvoice = (r: PiBookInvoice, amount: number, status: ReactNode): PiRow => ({
      key: `i${r.id}`, soId: r.soId, ref: r.ref, rep: r.rep,
      invoiceNo: r.number, patient: r.patient, payer: r.payer,
      caseValue: r.caseValue, amount, joined: r.joined, overRate: r.overRate, status,
      valueNow: r.valueNow ?? null, invoiced: r.invoiced, remark: remarkOf(r),
    });
    const out: PiSectionDef[] = [];
    // ── LIENSTAR-FUNDED ADVANCES ARE RECEIVED (26 Oct 2026, on request) ────────
    // An advance Lienstar has funded per the Master File (Approved, To be Funded
    // covers it) is received, even while Striven's ledger still shows the
    // invoice open because the funding was never applied to it there. Those
    // rows move from section 2 to section 1 — G. Posey's SO-676 (#553) sat
    // under "Advance owed" with an "Advance received (Lienstar)" pill, which
    // contradicted itself. So section 2 can now be BELOW the PI part of AR
    // Open, by exactly the Lienstar money Striven has not recorded.
    const awaitingAll = piBook?.awaiting.invoices ?? [];
    const lienIn = awaitingAll.filter((r) => lienFunded(r));
    const stillOwed = awaitingAll.filter((r) => !lienFunded(r));
    const sum = (rs: PiBookInvoice[], f: (r: PiBookInvoice) => number) => Math.round(rs.reduce((s, r) => s + f(r), 0) * 100) / 100;
    const receivedIds = new Set((piBook?.received.invoices ?? []).map((r) => r.id));
    const lienNew = lienIn.filter((r) => !receivedIds.has(r.id));
    const recCount = (piBook?.received.count ?? 0) + lienNew.length;
    if (piBook && recCount > 0) out.push({
      n: 1, tone: 'ok', tab: 'Advance received', amountLabel: 'Advance received', unit: 'case', guide: 'Fifteen percent advance',
      title: 'PI advance received (the 15%)',
      sub: <>The 15% lien advance has been collected on these cases — in Striven, or funded by Lienstar per the
        Master File's PI Lienstar Funding tab. There is nothing left to chase on it. The 85% behind them is still to
        come, and is section 4.
        {lienIn.length > 0 && <> {lienIn.length} of these ({formatCurrency(sum(lienIn, (r) => r.advanceOpen))}) are
          Lienstar-funded but not yet recorded against the invoice in Striven, so Striven's AR still shows them open.</>}</>,
      amount: Math.round((piBook.received.amount + sum(lienIn, (r) => r.advanceOpen)) * 100) / 100,
      count: recCount,
      caseValue: Math.round((piBook.received.caseValue + sum(lienNew, (r) => r.caseValue)) * 100) / 100,
      rows: [
        ...piBook.received.invoices.map((r) => fromInvoice(r, r.advanceReceived + (lienFunded(r) ? r.advanceOpen : 0), r.advanceOpen > 0.005 && !lienFunded(r)
          // A part-paid advance is in this section AND in section 2, for its own
          // halves. Saying so on the row is what stops a reader finding the same
          // invoice under two tabs and assuming the page has double-counted it.
          ? <span className="pill-tag tag-warn" title="Part of the advance has arrived. The rest is in section 2.">Part received</span>
          : <span className="pill-tag tag-ok">✓ Advance in</span>)),
        ...lienNew.map((r) => fromInvoice(r, r.advanceOpen, advanceInTag(r))),
      ],
    });
    if (piBook && stillOwed.length > 0) out.push({
      n: 2, tone: 'warn', tab: 'Advance owed', amountLabel: 'Advance outstanding', unit: 'case', guide: 'AR Open',
      title: 'PI advance invoiced, not yet received',
      sub: <>The 15% advance is on an invoice that has not been paid, by Striven's ledger or by Lienstar. This is the
        PI receivable — the only one of the four that is money the business can chase today.</>,
      amount: sum(stillOwed, (r) => r.advanceOpen), count: stillOwed.length, caseValue: sum(stillOwed, (r) => r.caseValue),
      // ── "FULLY INVOICED", NOT "AWAITING PAYMENT" ────────────────────────────
      // The status column answers what has been INVOICED, and the section's own
      // title already answers what has been received ("invoiced, not yet
      // received"). Saying "Awaiting payment" here restated the title in red on
      // every row and left the invoicing question — is anything still to be
      // raised on this case? — unanswered.
      //
      // On a PI case the 15% advance IS the whole invoice: the balance bills
      // when the case settles out of the award and is section 4, not something
      // outstanding to raise. So a case with its advance invoiced is fully
      // invoiced, and that is a finished state rather than a fault — hence the
      // neutral blue over the old danger red. The money owed is still stated,
      // in the Advance outstanding column beside it.
      //
      // "Part received" stays as it was: it is a fact about MONEY that has
      // arrived, it sends the reader to section 1 for the other half, and it
      // would be lost if every row read the same.
      rows: stillOwed.map((r) => fromInvoice(r, r.advanceOpen, r.advanceReceived > 0.005
        ? <span className="pill-tag tag-warn" title="Part of the advance has arrived. What landed is in section 1.">Part received</span>
        : <span className="pill-tag tag-info" title="The 15% advance is invoiced in full — on a PI case that is the whole invoice, since the balance bills when the case settles. Nothing further is to be raised; the advance is simply unpaid.">Fully Invoiced</span>)),
    });
    if (piPending.length > 0) out.push({
      n: 3, tone: 'danger', tab: 'Not invoiced', amountLabel: 'Would invoice', unit: 'order', guide: 'Not invoiced',
      title: 'PI orders yet to be invoiced',
      sub: <>These sales orders carry no invoice at all. Not counted in AR Open above - nothing is receivable until it
        is raised, so every row here is an invoice somebody has to go and raise.
        {ar?.pending && ar.pending.count > piPending.length && (
          <> A further {ar.pending.count - piPending.length} uninvoiced orders sit on other programmes and are not shown here.</>
        )}</>,
      amount: ar?.pending?.pi.expected ?? 0, count: piPending.length, caseValue: ar?.pending?.pi.caseValue ?? 0,
      rows: piPending.map((o) => ({
        key: `p${o.soId}`, soId: soIdFromRef(o.ref), ref: o.ref, rep: o.rep,
        invoiceNo: null, patient: o.patient || '', payer: o.payer,
        caseValue: o.caseValue, amount: o.expected, joined: true, overRate: false,
        status: <span className="pill-tag tag-danger">Not invoiced</span>,
      })),
    });
    if (piBook && piBook.balance.count > 0) out.push({
      n: 4, tone: 'info', tab: 'Case balance (85%)', amountLabel: 'Balance to come', unit: 'case', guide: 'Case value',
      title: 'PI case balance still to come (the 85%)',
      sub: <>The part of each invoiced case beyond the 15% advance. It bills when the case settles out of the patient's
        award, so it is <b>not</b> a receivable and sits outside AR Open above — but it is the largest figure on the PI
        book, and the one an AR total cannot see. Cases with no sales order behind them are not here: the invoice is the
        whole bill and nothing follows it.</>,
      amount: piBook.balance.amount, count: piBook.balance.count, caseValue: piBook.balance.caseValue,
      rows: piBook.balance.invoices.map((r) => fromInvoice(r, r.remainder, r.advanceOpen > 0.005 && lienFunded(r) ? advanceInTag(r) : r.advanceOpen > 0.005
        ? <span className="pill-tag tag-danger" title="The 15% advance has not arrived either - this case has returned nothing at all so far.">Advance also due</span>
        : <span className="pill-tag tag-muted" title="The 15% advance has been received. This is the remainder, which settles out of the award.">Awaiting settlement</span>)),
    });
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piBook, piPending, ar, lien]);

  /**
   * WHICH SECTION IS OPEN. Held as the NUMBER, not an index, so it survives a
   * refresh that changes which sections have rows — an index would silently
   * point at a different section the moment one emptied.
   */
  const [piTab, setPiTab] = useState<PiSectionDef['n']>(1);
  /**
   * THE GUIDE CAN OPEN ONE OF THE FOUR — `#receivables~not-invoiced~pi-3`.
   *
   * THIS IS THE ONE THING THE SHELL'S LANDING CODE CANNOT DO FOR ITSELF. It
   * finds a `data-guide-anchor` and scrolls to it, which is enough for a chart
   * card but not for a section behind a tab: sections 1, 2 and 4 are not in the
   * DOM at all while section 3 is open, so there is nothing to find and the
   * reader is delivered to the right panel showing the wrong section. Only this
   * component can press its own tab, so it does, and the shell then lands on the
   * `pi-book` anchor as usual.
   *
   * MOUNT AND HASHCHANGE, because the tab stays mounted between visits — a
   * second link from the guide changes only the hash.
   */
  useEffect(() => {
    const pick = () => {
      const m = /^pi-([1-4])$/.exec(currentAnchor() ?? '');
      if (m) setPiTab(Number(m[1]) as PiSectionDef['n']);
    };
    pick();
    window.addEventListener('hashchange', pick);
    return () => window.removeEventListener('hashchange', pick);
  }, []);
  /** Falls back to the first section that exists, so the panel can never open on
   *  a tab that is not there. Derived rather than corrected in an effect: an
   *  effect would render one empty frame before it fixed itself. */
  const piActive = piSections.find((s) => s.n === piTab) ?? piSections[0] ?? null;

  const [drill, setDrill] = useState<null | {
    title: string; sub?: string;
    columns: { key: string; label: string; num?: boolean }[];
    rows: Record<string, ReactNode>[];
  }>(null);

  /** "View all" for whichever section is open: the same rows, in a window that
   *  is not sharing the page with the register's own table. */
  const explainPiSection = (sec: PiSectionDef) => setDrill({
    title: sec.title,
    sub: `${sec.count} PI ${sec.unit}${sec.count === 1 ? '' : 's'} · ${formatCurrency(sec.amount)} · ${formatCurrency(sec.caseValue)} of case value behind them`,
    columns: [
      { key: 'ref', label: 'Order' }, { key: 'inv', label: 'Invoice' },
      { key: 'patient', label: 'Patient' }, { key: 'payer', label: 'Payer' },
      { key: 'rep', label: 'Rep' },
      { key: 'caseValue', label: 'Case value', num: true },
      { key: 'amount', label: sec.amountLabel, num: true },
    ],
    rows: sec.rows.map((r) => ({
      ref: <strong>{r.ref || '-'}</strong>,
      inv: r.invoiceNo ? `#${r.invoiceNo}` : 'not raised',
      patient: r.patient || '-',
      payer: trunc(r.payer || '-', 28),
      rep: r.rep || '-',
      caseValue: formatCurrency(r.caseValue),
      amount: formatCurrency(r.amount),
    })),
  });

  if (!piActive) return null;

  return (
    <>
      <div className="pi-book" data-guide-anchor="pi-book">
        <div className="pi-book-head">
          <h2 className="pi-book-title">Personal Injury · the book in four parts<GuideMark term="PI" /></h2>
          <div className="pi-book-sub">
            A lien case is billed in two tranches, so it is never simply open or paid.
            These four sections are where every PI case sits: the 15% advance banked,
            the 15% raised and still owed, the orders that carry no invoice at all, and
            the 85% that only bills when the case settles.
            {piBook && (
              <> Across the {piBook.totals.count} invoiced case{piBook.totals.count === 1 ? '' : 's'},
                sections 1, 2 and 4 split {formatCurrency(piBook.totals.caseValue)} of case value between them.</>
            )}
            {' '}Only section 2 is a receivable. It is the PI part of AR Open on the AR / AP page, less advances Lienstar has funded that Striven has not yet recorded.
          </div>
        </div>

        <PiTabs sections={piSections} active={piActive.n} onPick={setPiTab} />

        <div className={`pi-book-panel is-${piActive.tone}`}>
          <div className="pi-panel-head">
            <div>
              <h3 className="pi-panel-title">
                <span className="pi-sec-n" aria-hidden>{piActive.n}</span>
                {piActive.title}
                <GuideMark term={piActive.guide} label={piActive.title} />
              </h3>
              <div className="ar-pending-sub">{piActive.sub}</div>
            </div>
            <button className="btn ghost" onClick={() => explainPiSection(piActive)}>View all</button>
          </div>
          <div className="table-wrap scroll-y" style={{ marginTop: 12 }}>
            <PiTable section={piActive} />
          </div>
        </div>
      </div>

      {drill && <DrillModal {...drill} onClose={() => setDrill(null)} />}
    </>
  );
}
