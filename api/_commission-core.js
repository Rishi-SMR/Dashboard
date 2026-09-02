// Commission engine — pure functions, no network and no I/O, so the rules that
// decide money and visibility can be unit-tested directly (see
// _commission-core.test.js). _striven.js supplies the data; this file decides
// what it is worth and who is allowed to see it.
import {
  COMMISSION_RATES, FALLBACK_VERTICAL_RATES, ORDER_LABEL_RULES,
  REP_DIRECTORY, REP_COMMISSION_SCHEMES, identitiesOf,
} from './_commission-config.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ── Rates ────────────────────────────────────────────────────────────────────
/**
 * Rate for one device. Longest matching COMMISSION_RATES key wins, so a
 * specific "genesis lumbar" entry beats a generic "genesis" one. Falls back to
 * the vertical's legacy rate and reports that via `source` so the caller can
 * surface the gap rather than pay a guessed number silently.
 * @returns {{rate:number, source:'device'|'fallback'}}
 */
/**
 * The commission SCHEDULE this rep is engaged on, or null for the house card.
 *
 * Looked up by canonical roster name, so it follows commRep()'s fold: an order
 * booked to any spelling of the rep is priced on their terms, and one booked to
 * anybody else is not.
 */
export function schemeFor(rep, cfg = {}) {
  const schemes = cfg.schemes || REP_COMMISSION_SCHEMES;
  const r = norm(rep);
  if (!r) return null;
  const hit = Object.keys(schemes || {}).find((k) => norm(k) === r);
  return hit ? schemes[hit] : null;
}

export function rateForDevice(device, vertical, cfg = {}) {
  const rates = cfg.rates || COMMISSION_RATES;
  const fallback = cfg.fallback || FALLBACK_VERTICAL_RATES;
  const d = norm(device);
  let best = null;
  if (d) {
    for (const key of Object.keys(rates)) {
      const k = norm(key);
      if (k && d.includes(k) && (best === null || k.length > best.length)) best = k;
    }
  }
  if (best !== null) {
    const hit = Object.keys(rates).find((k) => norm(k) === best);
    return { rate: Number(rates[hit]) || 0, source: 'device' };
  }
  return { rate: Number(fallback[vertical]) || 0, source: 'fallback' };
}

/**
 * PERSONAL INJURY, PAID AS A SHARE OF WHAT IS ACTUALLY COLLECTED.
 *
 * A PI case is not billed and settled once: money arrives in two payments and
 * the rep earns a share of each, NET of what the business had to pay out first.
 * From the schedule, with the worked example that defines it:
 *
 *   Billed                                            $13,990.00
 *   Advance      15% of billed                          2,098.50
 *   COGS                                                1,600.00
 *   Advance net  (2,098.50 - 1,600.00) x 20%   =           99.70
 *   Settlement   50% of billed                          6,995.00
 *   Repayment    2 x the advance                        4,197.00
 *   Settlement net (6,995.00 - 4,197.00) x 20% =          559.60
 *   Total case commission                       =         659.30
 *
 * WHY BOTH LEGS ARE RETURNED SEPARATELY. They fall due at different times — the
 * advance when the funder pays, the settlement when the case closes — so a
 * caller that knows which payments have landed can pay the right half. A caller
 * that does not gets the whole-case figure and can report it as pending.
 *
 * COGS IS REQUIRED AND IS NOT GUESSED. Without it the advance leg is unknowable
 * (it is the only term it depends on), so this returns `advance: null` and names
 * the missing input instead of quietly paying a number that is too high. The
 * settlement leg does not depend on COGS and is still returned, because it is a
 * real figure and withholding it would understate the case just as badly.
 *
 * A NEGATIVE LEG IS FLOORED AT ZERO, not carried: a device that cost more than
 * the advance brought in is a loss to the business, and it is not deducted from
 * the rep's other cases.
 */
export function piCommission({ billed, cogs = null }, pi) {
  const B = Number(billed) || 0;
  const share = Number(pi?.share) || 0;
  const advance = round2(B * (Number(pi?.advancePct) || 0));
  const settlement = round2(B * (Number(pi?.settlementPct) || 0));
  const repayment = round2(advance * (Number(pi?.repaymentMultiple) || 0));

  const settlementLeg = round2(Math.max(0, settlement - repayment) * share);
  const hasCogs = cogs != null && Number.isFinite(Number(cogs));
  const advanceLeg = hasCogs ? round2(Math.max(0, advance - Number(cogs)) * share) : null;

  return {
    advance, settlement, repayment,
    advanceLeg, settlementLeg,
    total: round2((advanceLeg ?? 0) + settlementLeg),
    /** What the figure above is missing, so a caller can say so rather than imply completeness. */
    needs: hasCogs ? [] : ['cogs'],
  };
}

// ── Order labels ─────────────────────────────────────────────────────────────
/**
 * Classify an order's status text.
 *   'hold'    → excluded from commission entirely
 *   'waiting' → counted in the total but pending, not payable
 *   'payable' → fillable / reimbursed, payable and due
 * `hold` is tested first: an excluded order must never be reported as payable.
 * @returns {'hold'|'waiting'|'payable'}
 */
/** Cancelled / voided / denied orders. Same vocabulary getSO uses to build the
 *  order book, so one definition governs revenue and commission alike. */
export const isCancelledStatus = (s) => /cancel|void|lost|denied|rejected/i.test(String(s ?? ''));

/**
 * @param {string|string[]} status The order's status text AND/OR its Striven
 *   labels. An array is joined, so a caller can pass both and have every rule
 *   tested against every piece of evidence.
 */
export function classifyOrderLabel(status, rules = ORDER_LABEL_RULES) {
  // THE RULES ARE NAMED FOR LABELS AND WERE ONLY EVER GIVEN A STATUS.
  //
  // ORDER_LABEL_RULES matches /hold/ and /waiting.*reimburse/, but the only
  // thing ever passed in was the Striven order STATUS — which reads
  // "In Progress", "Completed" or "Canceled" and nothing else. 50 orders in the
  // book carry the HOLD label; not one has a status that matches it. So both
  // rules were dead: every non-cancelled, non-$0 order classified as payable,
  // heldOrders reported 0 across the board, and waitingTotal was $0 for every
  // rep in every month.
  //
  // Accepting a list is what lets the caller pass the labels as well. Joined
  // with a separator no rule can span, so two labels cannot combine into a
  // phrase neither of them says.
  const s = (Array.isArray(status) ? status : [status])
    .map((v) => String(v ?? '').trim()).filter(Boolean).join(' | ');
  if (!s.trim()) return 'payable';
  for (const re of (rules.hold || [])) if (re.test(s)) return 'hold';
  for (const re of (rules.waiting || [])) if (re.test(s)) return 'waiting';
  return 'payable';
}

// ── Per-order commission ─────────────────────────────────────────────────────
/**
 * commission = Σ (units × per-device rate) across the order's devices.
 * A `hold` order contributes $0 and produces no commission lines at all.
 * @param {{status?:string, labels?:string[], program?:string, items?:{item:string, qty:number}[]}} order
 * @returns {{state:string, units:number, commission:number, lines:Array, rateGaps:string[]}}
 */
export function commissionForOrder(order, cfg = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const vertical = order?.program || 'Other';

  // A cancelled order never happened commercially — no devices, no value, no
  // commission. Checked before everything else so no later rule can revive it.
  if (isCancelledStatus(order?.status)) {
    return { state: 'cancelled', units: 0, commission: 0, lines: [], rateGaps: [] };
  }

  // Status AND labels. The labels are where HOLD and "Waiting for
  // Reimbursement" actually live; the status only says whether the order is
  // open. Cancellation above stays on the STATUS alone, deliberately: a
  // 'CANCELLED' label on a live order is a mislabel, and letting it void an
  // order's commission would make a tag in Striven silently unpay someone.
  const state = classifyOrderLabel([order?.status, ...(order?.labels || [])], cfg.labelRules);

  // Nothing was billed, so nothing is earned. A $0 order is excluded outright
  // rather than paying a device rate against revenue that never existed. This
  // is checked before the held case so a held $0 order is still worth nothing.
  if (Number(order?.value ?? 0) <= 0) {
    // A held order that is also $0 stays reported as held: hold is the more
    // useful label operationally, and the amount is zero either way.
    return { state: state === 'hold' ? 'hold' : 'zero-value', units: 0, commission: 0, lines: [], rateGaps: [] };
  }

  // A `hold` order deliberately FALLS THROUGH and is costed like any other.
  //
  // It used to return $0 with no lines. That kept it out of payable correctly,
  // but it also erased the amount, so a rep whose orders were all held (the
  // Genesys backorder: Ali's whole month) saw nothing at all rather than a
  // pending figure. The business needs both: excluded from the cheque, visible
  // as Waiting. splitByState is what routes it, so the money is computed here
  // and withheld there.

  // ── A REP ON THEIR OWN TERMS ───────────────────────────────────────────────
  // The house rate card prices a device the same whoever sold it. A rep with a
  // schedule of their own is priced from theirs instead — different money per
  // device, and for Personal Injury a different MODEL entirely.
  const scheme = schemeFor(order?.rep, cfg);

  if (scheme?.pi && vertical === 'PI') {
    const units = items.reduce((n, it) => n + (Number(it?.qty) || 0), 0);
    const r = piCommission({ billed: Number(order?.value) || 0, cogs: order?.cogs ?? null }, scheme.pi);
    return {
      // PAID OUT OF MONEY THAT HAS ARRIVED, so an order on its own can never
      // make it payable: it is reported as WAITING until the reimbursements
      // land, which is exactly what that state already means here. A hold still
      // wins — an order not dispensed has not earned anything to wait for.
      state: state === 'hold' ? 'hold' : 'waiting',
      units,
      commission: r.total,
      lines: [{
        device: 'Net collected reimbursement',
        units,
        rate: scheme.pi.share,
        comm: r.total,
        rateSource: 'percent',
        state,
        // The legs, so a caller can pay the advance when the funder pays and the
        // settlement when the case closes, instead of treating the case as one
        // lump that is either due or not.
        pi: r,
      }],
      rateGaps: [],
      // Named, not silently zero: the advance leg cannot be computed without the
      // cost of the device, and this is how the UI can say so.
      needs: r.needs,
    };
  }

  const lines = [];
  const rateGaps = [];
  let units = 0, commission = 0;
  for (const it of items) {
    const qty = Number(it?.qty) || 0;
    if (qty <= 0) continue;
    const device = String(it?.item ?? '');
    // THEIR CARD, NOT THE HOUSE ONE. A device absent from a rep's own card falls
    // through to the vertical fallback and is reported in `rateGaps` — the same
    // "the rate card is outstanding" path the house card uses — rather than
    // borrowing a house price the rep is not engaged on.
    const { rate, source } = rateForDevice(device, vertical, scheme?.rates ? { ...cfg, rates: scheme.rates } : cfg);
    const comm = round2(qty * rate);
    units += qty;
    commission = round2(commission + comm);
    lines.push({ device, units: qty, rate, comm, rateSource: source, state });
    if (source === 'fallback' && device) rateGaps.push(device);
  }
  return { state, units, commission, lines, rateGaps, needs: [] };
}

/**
 * Roll per-order results into payable / waiting buckets for one rep.
 *
 * `payableTotal` is the cheque: what the rep is actually paid on the 15th for
 * dispensed orders. `waitingTotal` is earned-but-not-yet-payable, and it holds
 * BOTH label states that block payment:
 *
 *   waiting  reimbursement not yet received
 *   hold     order taken but not dispensed (e.g. the Genesys backorder)
 *
 * Held orders are therefore excluded from payable but reported as Waiting,
 * which is the split the business asked for: "her payable due would look
 * different than her commission due". `heldTotal` is broken out separately so
 * the UI can say WHY something is waiting without re-deriving it.
 */
export function splitByState(orders) {
  let payableTotal = 0, waitingTotal = 0, heldTotal = 0;
  let heldOrders = 0, zeroValueOrders = 0, cancelledOrders = 0;
  for (const o of orders) {
    if (o.state === 'cancelled') { cancelledOrders++; continue; }
    if (o.state === 'zero-value') { zeroValueOrders++; continue; }
    if (o.state === 'hold') {
      heldOrders++;
      heldTotal = round2(heldTotal + (o.commission || 0));
      waitingTotal = round2(waitingTotal + (o.commission || 0));
      continue;
    }
    if (o.state === 'waiting') waitingTotal = round2(waitingTotal + o.commission);
    else payableTotal = round2(payableTotal + o.commission);
  }
  return {
    payableTotal, waitingTotal, heldTotal,
    total: round2(payableTotal + waitingTotal),
    heldOrders, zeroValueOrders, cancelledOrders,
  };
}

// ── The sheet against the workbook it was transcribed from ───────────────────
/**
 * Correct ONE rep-month's reconciliation-sheet lines against the SOURCE
 * workbook rows for that same rep and month.
 *
 * WHY THIS EXISTS. The reconciliation sheet is not a source: it is a
 * transcription of Crystal's commission workbooks with a Striven match column
 * bolted on, and a transcription can be wrong. Cassie's July 2026 cycle is the
 * case that found it — five L1833 brace lines carried the $425 combo rate
 * instead of the $80 the workbook bills them at, and a sixth line (a $425
 * combo) was dropped altogether. Net effect $1,300 too much, on a figure the
 * page presents as signed off. Nothing on the page could have shown that,
 * because the sheet was the only thing being read.
 *
 * THE WORKBOOK WINS ON MONEY AND DEVICE. It is the document the business
 * actually pays from; the sheet's own value is its match evidence, which the
 * workbook does not carry. So this takes the amount and the device name from
 * the workbook and leaves everything else on the line — the Striven reference,
 * the order date, the vertical, the payout cycle, the match tier — untouched.
 *
 * MATCHED IN TWO PASSES, patient-and-amount before patient-alone. A patient can
 * legitimately hold several lines in one cycle (a combo AND a brace), so
 * pairing on the patient alone would let a $425 combo consume the $80 brace row
 * and report a "correction" that is really a mis-pairing. Exact pairs are taken
 * out of the pool first; only what is left over can be a genuine disagreement.
 *
 * A SHEET LINE THE WORKBOOK DOES NOT HAVE IS KEPT, NOT DELETED, and returned in
 * `orphaned` so it is counted rather than silently dropped. Removing it would
 * be this function deciding a rep is owed less on the strength of a name that
 * failed to match — the one error here that takes money away, and the one that
 * nobody would see. Reporting it puts the question in front of a person.
 *
 * @param {Array<{patient:string, item:string, comm:number}>} lines
 *   Sheet lines for one rep-month. MUTATED IN PLACE: the caller holds these
 *   objects and wants the corrected values on them.
 * @param {Array<{patient:string, item:string, comm:number}>} wbRows
 *   The workbook's rows for the same rep-month, valued rows only.
 * @param {{keyOf?:(x:object)=>string}} [opts]
 *   How to read the name a row is paired on, for BOTH sides. It defaults to the
 *   patient, and the reconciliation reader overrides it, because the two sides
 *   do not spell a name from the same place: a sheet line shows the STRIVEN
 *   spelling of an auto-matched patient ("D. Garcia"), while the workbook has
 *   only what the sheet's own Patient column says ("D. Gonzales"). Pairing on
 *   the displayed name made 19 correctly-transcribed rows look missing and
 *   re-added them, which ADDED $9,286 to three reps who had nothing wrong.
 * @returns {{corrected:Array, added:Array, orphaned:Array, delta:number}}
 *   `added` are workbook rows with no sheet line at all — the caller builds
 *   real lines from them, because only it knows how to resolve a Striven
 *   reference. `delta` is the money this changes, corrections plus additions.
 */
export function reconcileToWorkbook(lines, wbRows, opts = {}) {
  const keyOf = opts.keyOf || ((x) => x.patient);
  const pool = (lines || []).map((line) => ({ line, taken: false }));
  const rows = (wbRows || []).map((row) => ({ row, paired: false }));
  const key = (x) => norm(keyOf(x));

  // Pass 1 — patient AND amount agree. Nothing to correct, and taking these out
  // first is what stops pass 2 pairing a patient's second line with their first.
  for (const r of rows) {
    const hit = pool.find((s) => !s.taken
      && key(s.line) === key(r.row)
      && round2(s.line.comm) === round2(r.row.comm));
    if (hit) { hit.taken = true; r.paired = true; }
  }

  // Pass 2 — the patient agrees and the amount does not. The workbook wins.
  const corrected = [];
  for (const r of rows) {
    if (r.paired) continue;
    const hit = pool.find((s) => !s.taken && key(s.line) === key(r.row));
    if (!hit) continue;
    hit.taken = true; r.paired = true;
    corrected.push({
      patient: hit.line.patient,
      was: round2(hit.line.comm), now: round2(r.row.comm),
      wasItem: hit.line.item || '', item: r.row.item || '',
    });
    hit.line.comm = round2(r.row.comm);
    if (r.row.item) hit.line.item = r.row.item;
  }

  const added = rows.filter((r) => !r.paired).map((r) => r.row);
  const orphaned = pool.filter((s) => !s.taken).map((s) => s.line);
  const delta = round2(
    corrected.reduce((t, c) => t + (c.now - c.was), 0)
    + added.reduce((t, a) => t + (Number(a.comm) || 0), 0),
  );
  return { corrected, added, orphaned, delta };
}

// The sheet verification gate (isRepVerified / MIN_MATCH_RATE) was removed with
// the sheet feed itself: with Striven as the only source there is no second set
// of figures to reconcile against, so nothing to mark verified or unverified.

// ── Identity ─────────────────────────────────────────────────────────────────
const normEmail = (s) => String(s ?? '').trim().toLowerCase();
/** email → { email, repName, role }. Unknown accounts get the least privilege. */
export function resolveIdentity(email, directory = REP_DIRECTORY) {
  const e = normEmail(email);
  const row = (directory || []).find((r) => normEmail(r.email) === e);
  if (!row) return { email: e, repName: null, role: 'rep' };
  return {
    email: e,
    repName: row.repName ?? null,
    role: row.role === 'admin' ? 'admin' : 'rep',
  };
}

// ── Server-side redaction ────────────────────────────────────────────────────
// The per-field money registries (REP_MONEY / STRIVEN_MONEY / RECONCILE_MONEY)
// and the blankMoney() helper are gone with the row-blanking they served. A
// peer row is dropped whole now, so there is no row left to null fields on —
// and no registry to keep in step with every field somebody adds later.
/**
 * Is this row the viewer's OWN?
 *
 * A SET, not an equality: a viewer can hold more than one roster row (see
 * REP_IDENTITY_GROUPS), and comparing a single name would redact half of her own
 * book from her as if it were a colleague's. For every rep in no group this is
 * the same one-name test it always was.
 */
const isOwn = (viewer, repName) => Boolean(viewer?.repName) && identitiesOf(viewer.repName).has(norm(repName));

/**
 * Redact one payload for one viewer. Runs on the SERVER before serialization —
 * another rep's dollars must never reach the browser, hidden by CSS or not.
 *
 * Rep role  → their OWN row, and nothing about anybody else.
 * Admin     → untouched.
 *
 * A peer row used to survive here, stripped to operational counts: name, order
 * count, unit count, per-programme counts. That was the "volume is shared, pay
 * is not" model the leaderboard was built on. A rep is now restricted to their
 * own data, so peer rows are DROPPED rather than blanked — a row reduced to a
 * name and a count still tells a rep who else is on the book and how much they
 * booked, which is precisely what is being withheld.
 *
 * `keepOwn` is the one rule, applied to every collection of rep rows in the
 * payload. Miss one and that view leaks the whole roster.
 */
export function redactCommissionPayload(payload, viewer) {
  if (!payload || viewer?.role === 'admin') return payload;
  const out = { ...payload };
  const keepOwn = (rows) => (rows || []).filter((r) => isOwn(viewer, r.rep));

  // Sheet rows: own only. A viewer with no repName (a login absent from the
  // directory) matches nothing and gets an empty list — least privilege, and
  // the same fail-closed behaviour the rest of the payload has.
  const ownSheet = (payload.reps || []).find((r) => isOwn(viewer, r.rep)) || null;
  out.reps = keepOwn(payload.reps);
  // The "View as" roster is an ADMIN control. To a rep it is a list of their
  // colleagues' names — the same disclosure every other rule here removes.
  out.roster = [];

  // Company-wide dollar totals would leak the other reps in aggregate, so a rep
  // sees their OWN totals here; admins keep the true company figures.
  out.grandTotal = ownSheet ? ownSheet.total : null;
  out.byProgram = ownSheet
    ? { TriCare: ownSheet.tricare ?? 0, PI: ownSheet.pi ?? 0, VA: ownSheet.va ?? 0 }
    : { TriCare: null, PI: null, VA: null };
  // payableTotal / waitingTotal / heldOrders were NOT scoped here, so a rep
  // received the COMPANY's figures under names that read like their own — the
  // whole book's $216,815.64 sitting beside their own $29,250. grandTotal was
  // scoped and these were not, which is exactly how the gap went unnoticed.
  const ownPay = (payload.striven?.byRep || []).find((r) => isOwn(viewer, r.rep)) || null;
  out.payableTotal = ownPay ? (ownPay.payableTotal ?? 0) : null;
  // Paid is a rep's OWN money too, and a company-wide figure here would leak the
  // team's payroll under a label that reads like their own — the same omission
  // the note above describes, one field newer.
  out.paidTotal = ownPay ? (ownPay.paidTotal ?? 0) : null;
  out.waitingTotal = ownPay ? (ownPay.waitingTotal ?? 0) : null;
  out.heldOrders = ownPay ? (ownPay.heldOrders ?? 0) : null;
  out.scopedToRep = viewer?.repName ?? null;

  // Pay-period tabs carry the same per-rep dollars.
  if (Array.isArray(payload.periods)) {
    out.periods = payload.periods.map((p) => ({
      ...p,
      total: null,
      reps: keepOwn(p.reps),
    }));
  }

  // Striven-computed view.
  if (payload.striven) {
    const ownStriven = (payload.striven.byRep || []).find((r) => isOwn(viewer, r.rep)) || null;
    out.striven = {
      ...payload.striven,
      grandTotal: ownStriven ? ownStriven.total : null,
      // Same omission as above, one level down.
      payableTotal: ownStriven ? (ownStriven.payableTotal ?? 0) : null,
      paidTotal: ownStriven ? (ownStriven.paidTotal ?? 0) : null,
      waitingTotal: ownStriven ? (ownStriven.waitingTotal ?? 0) : null,
      heldOrders: ownStriven ? (ownStriven.heldOrders ?? 0) : null,
      // offRoster NAMES other people ("Kevin Parker", "Rishi Arora") and carries
      // their value. It is a reconciliation aid for an admin and a colleague
      // list to a rep, so it goes entirely.
      offRoster: null,
      // `recon` goes for the same reason, and it USED TO SURVIVE HERE. It was
      // company aggregates only (the sheet-wide auto/review/unmatched split), so
      // it read as harmless and every explicit rule above stepped around it —
      // but it is still the whole book's money on a rep's payload, and its
      // `corrections` block now names other reps and what each of their figures
      // moved by. Nothing in the UI reads it; it is an admin reconciliation aid
      // and belongs only to an admin.
      recon: null,
      byProgram: ownStriven
        ? { TriCare: ownStriven.tricare ?? 0, VA: ownStriven.va ?? 0, PI: ownStriven.pi ?? 0 }
        : { TriCare: null, VA: null, PI: null },
      byRep: keepOwn(payload.striven.byRep),
      // A month's headline figures are scoped the same way the all-months ones
      // are: the caller's OWN numbers for that month, not the company's. Nulling
      // them outright would hide a rep's own pay the moment they picked a month.
      months: (payload.striven.months || []).map((m) => {
        const ownM = (m.reps || []).find((r) => isOwn(viewer, r.rep)) || null;
        return {
          ...m,
          total: ownM ? ownM.total : null,
          TriCare: ownM ? ownM.tricare ?? 0 : null,
          VA: ownM ? ownM.va ?? 0 : null,
          PI: ownM ? ownM.pi ?? 0 : null,
          value: ownM ? ownM.value : null,
          payableTotal: ownM ? ownM.payableTotal : null,
          paidTotal: ownM ? (ownM.paidTotal ?? 0) : null,
          waitingTotal: ownM ? ownM.waitingTotal : null,
          reps: keepOwn(m.reps),
        };
      }),
    };
  }

  // Reconcile view.
  if (payload.reconcile) {
    out.reconcile = {
      ...payload.reconcile,
      totals: { sheet: null, striven: null, diff: null },
      reps: keepOwn(payload.reconcile.reps),
    };
  }

  return out;
}
