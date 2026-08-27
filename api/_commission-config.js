// Commission configuration — every client-editable knob for the commission
// engine lives here. Each value can be overridden at runtime from the Supabase
// `app_config` table (see getCommissionConfig in _striven.js), so rates and rep
// assignments change without a redeploy.
//
// See README "Commission configuration" for the operator-facing description.

// ── Per-device commission rates ──────────────────────────────────────────────
// commission = units × rate, per device, summed across the devices on an order.
// Keys are matched case-insensitively as substrings of the Striven line-item
// name; the LONGEST matching key wins, so a specific "genesis lumbar" entry
// beats a generic "genesis" one.
//
// PLACEHOLDER TABLE. Only the Genesis Lumbar rate below is client-confirmed.
// The full device rate list is still to be supplied; until it lands, a device
// with no entry here falls back to FALLBACK_VERTICAL_RATES and is reported in
// the response's `rateGaps` array, so an unpriced device is visible rather than
// silently commissioned at the wrong number.
// Derived from the DEVICE → COMMISSION columns of both commission workbooks
// (55 distinct device strings, ZERO ambiguity — every device maps to exactly one
// amount). Multi-device rows in the sheet confirm these are per-UNIT rates:
//   "Genesys Lumbar, Universal"            $1,300  = 2 × 650
//   "Genesys Lumbar, Shoulder, Universal"  $1,950  = 3 × 650
//   "2 SOFTPULSE KNEES"                      $850  = 2 × 425
// Keys match case-insensitively as substrings of the Striven line-item name, so
// "PI Genesys Lumbar" → 'genesys' → $650. The sheet spells it "Genesys" (y), not
// "Genesis" — both are covered.
export const COMMISSION_RATES = {
  // ── confirmed, flat per unit ──
  'genesys': 650,                 // Genesys Lumbar/Knee/Universal/Shoulder/Foot-Ankle
  'genesis': 650,                 // alternate spelling
  'sofpulse': 425,                // SofPulse / SOFPULSE
  'softpulse': 425,               // SOFTPULSE (and the sheet's typo variants)
  'onlux': 425,                   // ONLUX Lumbar / Knee
  // ── HCPCS-coded rows (used where Striven carries the billing code) ──
  'e0731/e0730': 425,             // stim + garment combo
  'e0730-1/e0731-1': 425,
  'e0730': 350,                   // garment only
  'l0650': 120,
  'l1833': 80,
  'l3670': 0,                     // not commissioned
  'cmc': 0,                       // not commissioned
};

// Legacy per-vertical rates, used ONLY when a device is absent from
// COMMISSION_RATES. These are the pre-refactor numbers and are estimates: they
// keep the portal showing a plausible figure instead of $0 while the real rate
// card is outstanding. Every line priced this way is marked rateSource:
// 'fallback' and counted in `rateGaps`.
// NOTE ON PI: the sheet shows Personal Injury is NOT a flat per-device rate.
// Its rows carry irregular amounts — $129.70, $227.92, $253.62, $461.37,
// $610.07, $920.90, $960.61, $1,070.72, $1,232.98 — and bundled rows contradict
// a unit model outright ("3xManaRay 3xGenesys 1xKnee" = $960.61, where three
// Genesys alone would be $1,950). PI reads as a percentage of collections, which
// this portal has no input for. Until that rule is supplied, PI devices have no
// entry above and fall through to the vertical fallback below.
export const FALLBACK_VERTICAL_RATES = { VA: 425, TriCare: 369.78, PI: 0, DOL: 0 };

// ── AR EXPECTED ──────────────────────────────────────────────────────────────
// What the business expects to RECEIVE on an invoice, as against what it billed.
//
//   PI      15% of billed. A PI order is billed at the full device price but is
//           a LIEN: the claim settles out of the patient's award and only a
//           fraction of the face value ever comes back, so a PI invoice carried
//           at its full value overstates the receivable nearly sevenfold.
//   other   billed. Not a guess and not a placeholder: an invoice with no rule
//           of its own is expected in full, and treating one as expecting
//           nothing would quietly write off real billed work — the failure
//           that is hardest to notice, because the total merely looks smaller.
//
// DELIBERATELY PI-ONLY FOR NOW. Two further rules are known but not applied,
// and are left OUT rather than half-built, because config that exists and is
// not used reads as a rule that IS in force:
//   VA       billed less a 15% deduction towards POD
//   TriCare  per unit, off the invoice's own line items — Striven already
//            prices them (4 Stim $425, garment $75, back brace $150), so the
//            figure should be read from the invoice rather than from a rate
//            table here that would drift from it
// Both are a small change to arExpectedFor() when the business confirms them.
export const PI_AR_RATE = 0.15;

/**
 * One invoice's expected receipt.
 *
 * @param {{vertical?:string, billed:number}} p
 * @returns {{amount:number, basis:string}}
 *
 * `basis` names the rule that produced the number, so the UI can say WHY a row
 * reads what it does rather than presenting every figure as equally derived.
 *
 * The rate is taken from the PROGRAMME, never from the payer text: the payer on
 * a PI invoice is the individual law firm and there are dozens of them, while
 * the vertical is the one field that says which rule applies.
 */
export function arExpectedFor({ vertical, billed }) {
  const amount = Number(billed) || 0;
  const isPi = String(vertical ?? '') === 'PI';
  return {
    amount: Math.round(amount * (isPi ? PI_AR_RATE : 1) * 100) / 100,
    basis: isPi ? 'pi-15' : 'billed',
  };
}

/**
 * The reconciliation sheet's Vertical column → the three programme names the
 * rest of the portal is keyed by.
 *
 * The sheet is typed by hand and spells it loosely — "VA Order", "va",
 * "Tri-Care", "Personal Injury" — so a raw string comparison misses most of it.
 * Extracted here because TWO readers now fold it (the paid/owed split and the
 * rep × vertical commission rollup), and a second copy would drift the moment
 * one of them learns a new spelling.
 *
 * Returns '' for anything unrecognised, so an unfoldable line is visibly
 * unassigned rather than quietly banked into one of the three.
 */
export function verticalOfCommissionLine(prog) {
  const s = String(prog ?? '');
  if (/tri.?care/i.test(s)) return 'TriCare';
  if (/\bva\b|veteran/i.test(s)) return 'VA';
  if (/\bpi\b|personal injury/i.test(s)) return 'PI';
  return '';
}

// ── Order label rules ────────────────────────────────────────────────────────
// Matched against the Striven order status text. `hold` is checked first and
// wins, because an excluded order must never be counted as payable.
//   hold    → excluded from the commission calculation entirely ($0, no line)
//   waiting → included in the total but reported as PENDING, not payable
// Anything unmatched is payable/due, which preserves the previous behaviour.
export const ORDER_LABEL_RULES = {
  hold: [/\bon[\s_-]?hold\b/i, /\bhold\b/i],
  waiting: [
    /waiting\s+(for\s+)?reimburse/i,
    /awaiting\s+reimburse/i,
    /pending\s+reimburse/i,
    /reimbursement\s+pending/i,
  ],
};

// ── PI pipeline stages ───────────────────────────────────────────────────────
// Named to match the tags your team already uses on Striven sales orders, so the
// portal and Striven speak the same language.
//
// Striven's API does not expose those tags — its OpenAPI spec has no tag field on
// SalesOrder, and `Labels` exists only on TaskDetail. The stage therefore comes
// from, in order of preference:
//   1. a Striven CUSTOM FIELD named STRIVEN_STAGE_FIELD, if one is set up
//   2. the portal's own stage store, set by hand
// Add that custom field in Striven and mirror the tag into it, and this file
// needs no further change — the reader already prefers it.
// Six stages, corrected against how the work actually flows.
//
// The previous seven were miscounted and partly redundant:
//   '1st LOP Request'   a 2nd and 3rd request stay in the SAME stage, so
//                       numbering the first one was wrong. Now 'LOP requested'.
//   'Waiting for LOP'   the same state as 'LOP requested'. Merged.
//   'Shipped'           dispensing IS shipping here. Merged into one stage.
//   'Waiting for settlement'  was missing entirely, and it is where PI orders
//                       actually sit longest: after the first payment lands,
//                       the case waits to settle.
export const PI_STAGES = [
  'Order received',
  'LOP requested',
  'Dispense/Shipped',
  'Delivered',
  'Waiting for first payment',
  'Waiting for settlement',
];
/** Custom field on the sales order that mirrors the Striven tag. */
export const STRIVEN_STAGE_FIELD = 'Stage';

/**
 * Stage names that have been RENAMED, old → new.
 *
 * A stage name is not only a caption: it is the literal string written into
 * places this file does not control, and those outlive the rename —
 *   · the portal's own stage store (Supabase `pi_stages`), holding whatever
 *     string was current when someone moved the order by hand
 *   · the Striven `Stage` custom field, typed by staff in Striven
 * Both are matched against the stage list, so without this map a renamed stage
 * stops matching and every order resting on one silently falls back to stage 1
 * — a wrong board with no error anywhere to say so.
 *
 * Keys are matched case-insensitively after trimming, like the label maps.
 * Renamed 2026-08-12: 'Dispensed & shipped' → 'Dispense/Shipped'.
 */
export const STAGE_RENAMES = {
  'dispensed & shipped': 'Dispense/Shipped',
};

/** The current name for a stage string from any source. Unknown names pass
 *  through untouched, so this never invents a stage. */
export function canonicalStage(s) {
  const raw = String(s ?? '').trim();
  return STAGE_RENAMES[raw.toLowerCase()] ?? raw;
}

// ── PIP: its own pipeline ────────────────────────────────────────────────────
// A PIP order NEVER goes to Lienstar. It is billed through the customer to the
// auto insurer at the full billed amount and paid in full — no advance, no
// lien, no settlement. So the PI stages do not describe it: 'LOP requested'
// and 'Waiting for settlement' are steps a PIP order can never reach, and
// leaving them on the board would show a pipeline with two permanently empty
// stages and imply a wait that does not exist.
//
// The routing decision is the ORDER TYPE — the new PIP type Crystal is creating
// in Striven. isPipType() in _striven.js already recognises it.
//
// Until that type exists the LABEL is the only signal an order is PIP, so an
// order carrying any label below is treated as PIP regardless of its type. A
// staff member does not tag an order "Waiting on PIP Payment" unless the auto
// insurer is the payer, so the label is a reliable statement of the payer.
// Once the order type ships, TYPE wins and this stays as the backstop for
// orders written before the type existed.
//
// PIP still reports as PI everywhere else (revenue, commission, verticals):
// only the pipeline splits. soClass() is deliberately unchanged.
// THREE stages, not four. There is no dispatch stage: shipping is work that
// happens inside 'Order received', and the only transition that matters to the
// money is "are we waiting on the insurer" and then "is it settled".
export const PIP_STAGES = [
  'Order received',
  'Waiting on PIP Payment',
  'Bill settled',
];

/**
 * Labels that IDENTIFY an order as PIP (not the same thing as PIP_LABEL_STAGE,
 * which places an already-PIP order on the board).
 *
 * Deliberately narrow: only labels that name PIP outright. 'Shipped' or 'Paid'
 * say nothing about who pays, so an order carrying only those stays on the PI
 * board — moving it would silently strip a lien case out of the PI pipeline.
 */
/**
 * ── REVIEW LABELS: exceptions, not stages ───────────────────────────────────
 *
 * These describe an order that has STOPPED, not one that has progressed. A
 * pipeline stage answers "how far along is this"; HOLD, Attorney Denied and
 * Case Dropped answer "why has this gone nowhere", which is a different
 * question and belongs to a different queue.
 *
 * They used to be mapped into stages — HOLD and Attorney Denied into 'LOP
 * requested', Case Dropped into 'Order received' — which made a stalled order
 * indistinguishable from one that is actively being chased, and quietly
 * inflated the stage it landed in.
 *
 * A label listed here contributes NO stage. The order still appears on the
 * board wherever its OTHER labels place it: an order tagged
 * "HOLD, 3rd LOP Request" is still a live LOP chase, it just also needs
 * looking at. Only an order whose sole label is one of these falls back to
 * stage 1, and it is surfaced in the review queue either way.
 *
 * Applies to BOTH boards — a stall is a stall whoever is paying.
 */
export const REVIEW_LABELS = [
  'attorney denied',
  'hold',
  'case dropped',
];

export const PIP_IDENTIFYING_LABELS = [
  'waiting on pip payment',
  'waiting for pip payment',
];

// Same rules as PI_LABEL_STAGE below: label → stage (or stages), listed
// everywhere attested, furthest along is the current position.
// EVERY label in the Striven vocabulary appears below, including the ones that
// resolve to stage 1. Listing them all is the point: an unlisted label is
// indistinguishable from a mapped-to-stage-1 label at runtime, and only the
// explicit list shows a reader that the label was considered.
export const PIP_LABEL_STAGE = {
  // → 1. Order received. Everything before the money is outstanding, INCLUDING
  // dispatch: with no shipping stage, a shipped order is still simply received.
  // An order labelled both 'Shipped' and 'Waiting on PIP Payment' still lands
  // in stage 2, because furthest along wins.
  'shipped': 'Order received',
  'dispense': 'Order received',
  'cancelled': 'Order received',
  // 'hold' and 'case dropped' are NOT here: see REVIEW_LABELS above. They say
  // the order has stopped, not how far it got, so they carry no stage.
  // LOP / Lienstar / settlement labels CANNOT legitimately apply to PIP — it
  // never goes to Lienstar and never settles. They are mapped rather than left
  // out so behaviour is deterministic, but a PIP order carrying one is a
  // mislabel in Striven, and leaving it in stage 1 is what makes that visible.
  'waiting for lop': 'Order received',
  '1st lop request': 'Order received',
  '2nd lop request': 'Order received',
  '3rd lop request': 'Order received',
  // 'attorney denied' is NOT here either: see REVIEW_LABELS above.
  'enter into lienstar': 'Order received',
  'hold for settlement': 'Order received',
  'negotiating': 'Order received',

  // → 2. Waiting on PIP Payment. The bill is with the auto insurer.
  // Striven spells it "Waiting on PIP Payment"; "waiting for" is how people say
  // it. Both map, so a relabel cannot silently drop an order to stage 1.
  'waiting on pip payment': 'Waiting on PIP Payment',
  'waiting for pip payment': 'Waiting on PIP Payment',
  // Delivery is what puts the bill in front of the insurer, so these are the
  // same wait under different names.
  'delivered': 'Waiting on PIP Payment',
  'pod sent': 'Waiting on PIP Payment',
  'waiting for first payment': 'Waiting on PIP Payment',
  'waiting for final payment': 'Waiting on PIP Payment',
  'waiting for reimbursement': 'Waiting on PIP Payment',
  'tricare order submitted': 'Waiting on PIP Payment',

  // → 3. Bill settled. PIP is paid in full in one go: no advance, no
  // settlement negotiation, so 'Paid' IS the end of the pipeline.
  'paid': 'Bill settled',
  'tricare paid': 'Bill settled',
};

// ── VA: its own pipeline ─────────────────────────────────────────────────────
// A VA order is billed to the Department of Veterans Affairs and paid in full
// off the invoice. No attorney, no lien, no Lienstar, no settlement — so the PI
// stages describe none of it, exactly as they describe none of PIP.
//
// The routing decision here is simpler than PIP's: VA is already its own
// VERTICAL (soClass → 'VA'), so no identifying label is needed and none is
// guessed at. Every order with vertical 'VA' is on this board and nothing else
// is.
//
// FIVE STAGES, and they are the ones the labels on the VA book actually attest
// to: Paid (204), HOLD (45), Waiting for Reimbursement (12), Shipped (10), POD
// Sent (1), Delivered (1), and 2 orders with no label at all.
//
//   - there IS a dispatch stage. This board first shipped with four stages and
//     'Shipped' folded into 'Order received', copying PIP's "no dispatch stage"
//     reasoning. That was wrong, and wrong from a bad census: the count was
//     taken from the VA-only labels report, which covers 216 of the 264 VA
//     orders and happens to omit every one of the newest shipped ones. The
//     visible symptom was 10 orders sitting under 'Order received' tagged
//     "Shipped, Waiting for Reimbursement" — plainly not orders that had merely
//     been received.
//   - 'Paid' IS a stage here, which PI deliberately does not have. On PI that
//     was a fair call ("past the end of this pipeline"); on VA it would put 204
//     of 264 orders — 77% of the book — in a stage named for waiting. The
//     terminal state is the whole shape of this board.
//   - there is still no LOP and no settlement stage: those are Lienstar steps a
//     VA order can never reach.
export const VA_STAGES = [
  'Order received',
  'Dispense/Shipped',
  'Delivered',
  'Waiting on VA payment',
  'Paid',
];

// Same three rules as PI_LABEL_STAGE below: label → stage (or stages), listed
// at every stage attested, furthest along is the current position. Keys are
// matched case-insensitively after trimming.
//
// Every label in the Striven vocabulary appears here, including the ones that
// resolve to stage 1 — an unlisted label and a mapped-to-stage-1 label are
// indistinguishable at runtime, and only the explicit list shows a reader that
// the label was considered rather than forgotten.
export const VA_LABEL_STAGE = {
  // → 1. Order received. Where an order sits until a label says otherwise. Only
  // the two genuinely pre-dispatch states resolve here.
  'cancelled': 'Order received',
  // 'hold' and 'case dropped' are NOT here: see REVIEW_LABELS above. They say
  // the order has stopped, not how far it got, so they carry no stage. This is
  // where 11 of the 216 VA rows go.
  //
  // LOP / Lienstar / settlement / PIP labels CANNOT legitimately apply to a VA
  // order — there is no attorney and no auto insurer in this programme. They
  // are mapped rather than left out so the behaviour is deterministic, but an
  // order carrying one is a mislabel in Striven, and leaving it in stage 1 is
  // what makes that visible instead of promoting it on a false signal.
  'waiting for lop': 'Order received',
  '1st lop request': 'Order received',
  '2nd lop request': 'Order received',
  '3rd lop request': 'Order received',
  'enter into lienstar': 'Order received',
  'hold for settlement': 'Order received',
  'negotiating': 'Order received',
  'waiting on pip payment': 'Order received',
  'waiting for pip payment': 'Order received',

  // → 2. Dispense/Shipped. Dispensing IS shipping here, exactly as on PI.
  // Every one of the 10 orders carrying 'Shipped' also carries 'Waiting for
  // Reimbursement', so in practice this card lists them and the payment card
  // holds them — which is the point: whoever works dispatch still sees them.
  'shipped': 'Dispense/Shipped',
  'dispense': 'Dispense/Shipped',

  // → 3. BOTH 'Delivered' and 'Waiting on VA payment', on the same reasoning PI
  // uses for this label: delivery is a milestone of its own AND the event that
  // puts the claim in front of the payer. Mapping it to the wait alone would
  // leave the Delivered card permanently empty; mapping it to Delivered alone
  // would hide the money that is now outstanding.
  'delivered': ['Delivered', 'Waiting on VA payment'],

  // → 4. Waiting on VA payment. The claim is with the VA.
  //
  // 'POD Sent' USED TO ALSO LIST AT 'Delivered', on the reading that proof of
  // delivery evidences delivery. It does not go there any more: the Delivered
  // card then held an order whose labels were "Paid, POD Sent" — a row carrying
  // no Delivered label at all, on a card named for that label. Inferring a
  // milestone from a document is a claim this data does not make.
  //
  // Sending the POD is a BILLING action anyway: it is what submits the claim to
  // the VA, so the wait is the honest place for it. PI still maps 'pod sent' to
  // its own Delivered stage; no PI order currently carries the label, and
  // changing a board nobody has questioned is not this fix's business.
  'pod sent': 'Waiting on VA payment',
  'waiting for first payment': 'Waiting on VA payment',
  'waiting for final payment': 'Waiting on VA payment',
  'waiting for reimbursement': 'Waiting on VA payment',
  // Says the claim went out, whoever it names. The programme wording is wrong
  // on a VA order, but the fact it states about the claim is not.
  'tricare order submitted': 'Waiting on VA payment',

  // → 4. Paid. The VA pays in full off the invoice, in one go: 'Paid' is the
  // end of this pipeline, not a step past it. 'TriCare Paid' is the same
  // statement about the money under the wrong programme's name, and hiding
  // received money in stage 1 over a mislabel would be the worse error.
  'paid': 'Paid',
  'tricare paid': 'Paid',
};

// ── Striven LABEL → PI stage ─────────────────────────────────────────────────
// Striven tags a sales order with LABELS, and an order can carry several at
// once ("Waiting for first payment, Shipped"). Three rules turn a label SET
// into the board:
//
//   1. this map, label → one stage OR a list of stages. A list is for a label
//      that is genuinely true of more than one stage at the same time; see
//      'delivered' below.
//   2. LISTED EVERYWHERE IT IS ATTESTED. The order appears at every stage its
//      labels reach, so "Waiting for first payment, Shipped" shows on the
//      dispatch card AND the payment card. Nothing is back-filled: a stage no
//      label names stays empty, even if the order must logically have passed
//      through it.
//   3. FURTHEST ALONG WINS, for its CURRENT position — the single stage the
//      order counts at in the flow bar. That same example is awaiting payment
//      now; it is merely also on record as having shipped.
//
// Anything not listed here leaves the order in 'Order received' — the state a
// sales order is in from the moment it is created.
//
// Keys are matched case-insensitively after trimming.
export const PI_LABEL_STAGE = {
  // → LOP requested. A 1st/2nd/3rd request is the SAME state (see PI_STAGES
  // above).
  //
  // HOLD and Attorney Denied USED TO SIT HERE and no longer do — they are the
  // chase stalling, not a step of it, so counting them as an active LOP request
  // overstated this stage and hid the stall. They are in REVIEW_LABELS above.
  'waiting for lop': 'LOP requested',
  '1st lop request': 'LOP requested',
  '2nd lop request': 'LOP requested',
  '3rd lop request': 'LOP requested',

  // → Dispense/Shipped. Dispensing IS shipping here.
  'shipped': 'Dispense/Shipped',
  'dispense': 'Dispense/Shipped',

  // → BOTH 'Delivered' and 'Waiting for first payment'.
  //
  // Delivery is two things at once: a milestone of its own, and the event that
  // puts the order into Lienstar and starts the wait for the first payment
  // ("it has to enter into stage 5 waiting for the first payment
  // SIMULTANEOUSLY"). It used to resolve to the payment stage alone, because
  // only one stage could win per label — so the Delivered stage sat permanently
  // empty even though delivered orders existed. A label may now attest to
  // several stages, so both are true at once and neither is lost. The order's
  // CURRENT position is still the furthest of them, i.e. unchanged.
  'delivered': ['Delivered', 'Waiting for first payment'],
  'enter into lienstar': 'Waiting for first payment',
  'waiting for first payment': 'Waiting for first payment',

  // → Waiting for settlement.
  'negotiating': 'Waiting for settlement',
  // These three were not in the brief. Left unmapped they fell to 'Order
  // received', which put 29 of the furthest-along orders in the furthest-back
  // stage — a worse answer than any of the alternatives. All three are waits
  // that happen AFTER the first payment, so they sit with settlement:
  //   'Waiting for final payment' (29) — the balance after the first payment
  //   'Waiting on PIP Payment'     (3) — the patient's own auto policy paying
  //   'Hold for Settlement'        (1) — says settlement outright
  // Move any of them if the business reads them differently.
  'waiting for final payment': 'Waiting for settlement',
  'waiting on pip payment': 'Waiting for settlement',
  'hold for settlement': 'Waiting for settlement',

  // The rest of the vocabulary, listed so no label is silently unhandled.
  'waiting for reimbursement': 'Waiting for settlement',   // the wait after the first payment
  'pod sent': 'Delivered',                                 // proof of delivery
  // 'Paid' is past the end of this pipeline — PI_STAGES stops at settlement, so
  // the furthest stage available is the closest true answer. Add a 'Paid' stage
  // if the business wants completed orders shown separately.
  'paid': 'Waiting for settlement',
  'tricare paid': 'Waiting for settlement',
  'tricare order submitted': 'Dispense/Shipped',
  // 'CANCELLED' is here for completeness only: cancelled orders never reach
  // this pipeline — getOrderAnalytics drops them before it is built.
  // 'case dropped' is NOT here: a dropped case has stopped, not progressed, so
  // it carries no stage and goes to the review queue. See REVIEW_LABELS above.
  'cancelled': 'Order received',
};

// ── Commission already PAID OUT ──────────────────────────────────────────────
// Vertical → the LAST MONTH whose commission has actually been paid, inclusive.
// Everything at or before it reads Paid; everything after stays Payable / Due.
//
// This exists because "Payable / Due" was overstating what is owed. The
// reconciliation sheet signs a cycle off, and the portal was still calling that
// money payable months after it left the bank — so a rep's board showed
// everything they had ever earned as though it were all still coming.
//
// A MONTH, not a date, because commission settles per payout cycle: the run on
// the 15th pays the previous month whole, so a month is either paid or it is
// not. Compared as a string, which sorts correctly for YYYY-MM.
//
// PER VERTICAL, because the programmes settle independently — the VA book is
// reconciled and paid on a different rhythm from TriCare and PI. A vertical
// absent from this map has nothing marked paid, which is the safe default: it
// keeps money in Payable / Due rather than quietly declaring it settled.
//
// KEEP THIS CURRENT. Override with the app_config key COMMISSION_PAID_THROUGH
// (the same JSON shape) so it can be advanced the moment a run goes out,
// without a redeploy. Left to rot it does not go wrong loudly — it simply keeps
// reporting the newest paid month as still owed.
export const COMMISSION_PAID_THROUGH = {
  // ADVANCED TO JULY by instruction: the July cycle has gone out. It settles in
  // the 15 Aug 26 run, which is now behind us, so every VA line whose payout
  // cycle resolves to 2026-07 or earlier reads Paid rather than Payable / Due.
  //
  // Previously '2026-06', with the note that July was still owed because the
  // sheet called that cycle "Payable 15 Aug 26 (due)". The sheet may still say
  // so until Crystal re-labels it; this key is the override that does not wait
  // for that, which is exactly what it is for.
  VA: '2026-07',
  // TRICARE AND PI ARE NAMED TOO, by instruction ("mark paid for the commission
  // of reps of July"), and what that does is worth stating because it is more
  // than the words describe. Neither had a paid-through before, so neither had a
  // single line marked paid. The comparison is `month <= through`, so setting
  // them to July does not mark July alone — it marks the WHOLE of each book up
  // to and including July as paid, earlier months included.
  //
  // That is the intended reading of "the amount that was payable for July is
  // paid now": what stood in Payable / Due was the accumulated unpaid balance,
  // not one month's slice, and settling it settles the lot. It was raised before
  // it was applied, and confirmed.
  //
  // IF THAT IS EVER WRONG — a vertical genuinely behind on an earlier month —
  // this is the line to correct, and the correction is to move that vertical
  // BACK to its true last-paid month, not to remove it. An absent vertical means
  // "nothing paid", which would swing the error the other way.
  TriCare: '2026-07',
  PI: '2026-07',
  // No DOL key: verticalOfCommissionLine() folds a line to TriCare, VA or PI and
  // nothing else, so a DOL entry here could never match a line.
};

// ── Standings masking ────────────────────────────────────────────────────────
// LARGELY MOOT. This governed how much of a PEER's row a rep received, back when
// they received one: true meant order counts only, false let units and accounts
// through as well. A rep is now restricted to their own data and gets no peer
// row at all, so there is nothing left for the flag to mask on a rep login.
//
// It is kept, and kept true, because it still governs the per-row `lean`
// redaction in getRepOverview. If peer rows are ever reinstated, that redaction
// is what stops them arriving unredacted — setting this false would widen what
// a peer row carries the moment one exists again.
export const STANDINGS_ORDERS_ONLY = true;

// Names that carry orders in Striven but must NOT appear on the leaderboard.
//
// EMPTY NOW, AND THAT IS THE POINT. Every name below was removed from REP_NAMES
// when the roster was narrowed to the five producing reps, so there is no longer
// a roster row for this list to hide: the roster IS producers only, and a name
// off it never reaches a leaderboard to be excluded from one.
//
// Kept as an empty export rather than deleted. It is the mechanism for "a rep
// who is not ranked" — a real distinction from EXCLUDED_REPS below — and the
// next non-producer to need a roster row will need it back. Re-adding a name
// here is also the ONLY correct way to unrank someone: dropping them from
// REP_NAMES instead moves their orders to off-roster volume and zeroes their
// commission row, which is a different decision.
//
// The former contents, all six now off-roster entirely: Crystal Chambers,
// Angel Santiago, Kinley Shepherd, Zach Shank, House Account, Santiago Family
// Chiropractic. The reasoning that put them here is preserved below.
//
// They are real Sales Rep values, so they stay in REP_NAMES and keep earning
// their commission rows; they are simply not producers being ranked against
// each other. Crystal's own orders are demos, Zach has left, and Angel and
// Kinley are ops rather than sales.
//
// Denise Zavala is deliberately NOT here: she folds into Maylon Sanders in
// commRep(), so her orders rank under Maylon rather than disappearing.
//
// Cassie is not here because she is in EXCLUDED_REPS instead — a harder rule.
// This list unranks a rep who still exists; she has been removed outright.
//
// 'House Account' (a house bucket, not a person) and 'Santiago Family
// Chiropractic' (a practice, not a rep) were previously left ON the board — the
// meeting had covered both ways. Both have since been named explicitly for
// removal, so the board is now producers only.
export const STANDINGS_EXCLUDE = [];

// ── Hard exclusions: not reps at all ─────────────────────────────────────────
// NOT THE SAME THING AS STANDINGS_EXCLUDE, and the difference is the whole
// point. A standings-excluded name is a rep who is not ranked: they keep a
// roster row, a commission figure and a login. A name here is not a rep in any
// sense — it is dropped from every roster, picker, total, drill and remark, and
// no money is reported against it anywhere in the dashboard.
//
// Excluded by instruction ("do not consider them in reps or anywhere in the
// dashboard"):
//   · CMC (direct)  — a direct-sales channel, not a person. It never reached
//                     REP_NAMES; it was minted by reconRep() in _striven.js
//                     from the reconciliation sheet's own "CMC" rows and
//                     appended to striven.byRep as a payee. Its rows also sit
//                     in a different layout in the source workbook (the
//                     3/15/2026 tab: no rep column, a claim value where the
//                     commission belongs), so there is no rep figure to report
//                     even if it were wanted.
//
//   · Cassie        — removed by instruction ("remove Cassie from Dashboard,
//                     she is no longer needed"), with her credentials revoked
//                     at the same time. Off the roster, off the leaderboard,
//                     out of every total.
//
// CASSIE HAS BEEN EXCLUDED, REINSTATED, AND EXCLUDED AGAIN. The middle step is
// worth keeping because its reasoning has NOT gone away: she was reinstated
// because dropping her made Commission Due disagree with the reconciliation
// sheet, which still signs off $20,255.00 to her (Mar $11,680.00, Apr
// $1,200.00, May $350.00, Jun $7,025.00) across 58 lines.
//
// THAT DISAGREEMENT IS BACK, DELIBERATELY. Commission Due is now $169,909.20
// against a sheet that pays $190,164.20. She was also still producing when this
// was done — 10 TriCare orders in August 2026, ranked 3rd that month — so those
// orders become unattributed off-roster volume rather than disappearing.
//
// The sheet has to drop her too, or the two will not reconcile. Until it does,
// the gap is exactly her figure and this paragraph is the explanation for it.
//
// TWO EARLIER NOTES HERE WERE WRONG and are deleted rather than corrected: they
// said she was "deliberately still absent from REP_NAMES" and had "no
// REP_DIRECTORY entry, so no login". She was on both. The removal above is what
// makes those statements true.
//
// Matched case-insensitively against the FOLDED name — the value commRep() and
// reconRep() produce, not the raw Striven / sheet spelling. Both folds are kept
// deliberately so every variant ("Maverick Medical- Cassie Wates", "CMC",
// "cmc direct") lands on one canonical string for this list to catch.
export const EXCLUDED_REPS = [
  'CMC (direct)',
  'Cassie',
];

// ── Who works under whom ─────────────────────────────────────────────────────
// SUPERVISOR → THE REPS UNDER THEM, by canonical name. One declaration, because
// the relationship drives two opposite-facing rules and they must not drift:
//
//   · the supervisor's login MARKS the sub-rep's row as theirs (display only —
//     no figure moves, and they get no more of that rep's data than of any
//     other peer's)
//   · the sub-rep's login cannot see the supervisor AT ALL — see blindspotsFor
//
// Declaring the pair in two places is how one of those gets added and the other
// forgotten, which on the second rule means a silent disclosure.
//
// NOT THE SAME AS commRep()'s SUB-REP FOLD. Denise Zavala is folded INTO Maylon
// Sanders: she has no roster row, no login, and her orders are his because he is
// paid on them. Jillian is a rep in her own right — her own roster entry, her
// own login, her own $57,234 — who happens to work under Alle. Nothing rolls up.
export const REP_SUB_REPS = {
  'Alle Ann Dubberley': ['Jillian Colin'],
};

// ── Per-rep blind spots ──────────────────────────────────────────────────────
// EXTRA pairs, beyond what the hierarchy above already implies. Keyed by the
// VIEWER's canonical name; the values are names their login must show nothing
// about — no row, no order count, no mention anywhere in the payload.
//
// Empty because the only live case (Jillian must not see Alle) is derived from
// REP_SUB_REPS. This stays as the escape hatch for a pair that is NOT a
// reporting line — two reps who simply must not see each other.
//
// NOT the same as the two exclusion lists above, and the difference is the
// direction. STANDINGS_EXCLUDE and EXCLUDED_REPS are properties of the rep being
// hidden: nobody sees them, including an admin in the second case. This is a
// property of the PAIR — Alle is a normal rep with a full row on every other
// login, and on her own; she is withheld from Jillian specifically.
export const REP_BLINDSPOTS = {};

const normRep = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Every rep this viewer must not see, as a set of lower-cased canonical names.
 *
 * The union of the reporting lines (a sub-rep does not see the rep they work
 * under) and any explicit REP_BLINDSPOTS pair. Resolved here rather than at the
 * call site so the server and its tests cannot disagree about the rule.
 *
 * ADMINS ARE NEVER BLINDED — the caller checks that. An admin's "view as"
 * preview IS blinded, because viewerFor() resolves it to a rep viewer and the
 * point of the preview is to show what that rep sees.
 */
export function blindspotsFor(viewer, subReps = REP_SUB_REPS, extra = REP_BLINDSPOTS) {
  const v = normRep(viewer);
  const out = new Set();
  if (!v) return out;
  for (const [boss, subs] of Object.entries(subReps || {})) {
    if ((subs || []).some((s) => normRep(s) === v)) out.add(normRep(boss));
  }
  const key = Object.keys(extra || {}).find((k) => normRep(k) === v);
  for (const n of (key ? extra[key] : [])) out.add(normRep(n));
  return out;
}

/** The rep `sub` works under, in canonical spelling, or null. */
export function supervisorOf(sub, subReps = REP_SUB_REPS) {
  const s = normRep(sub);
  if (!s) return null;
  const hit = Object.entries(subReps || {}).find(([, subs]) => (subs || []).some((x) => normRep(x) === s));
  return hit ? hit[0] : null;
}

// The sheet verification gate is gone with the sheet feed: MIN_MATCH_RATE had
// no meaning once Striven became the single source.

// ── Rep roster ───────────────────────────────────────────────────────────────
// THE reps are the names on the commission sheet — nothing else. Read live from
// both configured workbooks (Team + Christy, 9 tabs), normalised by commRep():
//
//   Alle Ann   106 lines   VA
//   Jillian     86 lines   TriCare, PI
//   Cassie      58 lines   TriCare
//   Christy     30 lines   VA
//
// The sheet spells several of these inconsistently ("Alle Anne", "Christy Tan",
// "Jillian Colin"); commRep() in _striven.js folds every variant onto the four
// canonical names above, and covers 100% of the live rows (no "Unknown").
// Striven books orders under plenty of other people (house/clinic accounts, ops
// staff) — they are NOT reps, and an order booked to one is reported as
// unmatched rather than commissioned.
/**
 * The commission roster: every distinct "Sales Rep" value in Striven except
 * Rishi Arora, folded to display names by commRep().
 *
 * This widened from the original four. Before, 85 orders worth $542,204 sat
 * outside the roster and showed as "Not a rep"; the largest single holder was
 * Maylon Sanders with 35 orders.
 *
 * Order counts below are from the live book at the time of the change
 * (413 non-cancelled, non-demo orders totalling $1,339,961).
 *
 * NARROWED TO THE FIVE PRODUCING REPS, by instruction. The list had widened to
 * eleven to cover every distinct "Sales Rep" value in Striven, and six of those
 * were never people being paid:
 *
 *   · House Account                — a house bucket, not a person
 *   · Santiago Family Chiropractic — a practice, not a rep
 *   · Angel Santiago               — books under the house account
 *   · Crystal Chambers             — finance/admin, and an admin login. NOT the
 *                                    rep "Christy" (Christy Tan)
 *   · Kinley Shepherd, Zach Shank  — non-producers
 *
 * NOBODY LOSES A PENNY. All six were already at $0: the reconciliation sheet
 * signs off nothing for any of them, and the merge zeroes a rep the sheet does
 * not carry. What they had was an engine-computed `strivenPayable` ($1,479,
 * $1,275 and $740 for Kinley, House Account and Crystal; $0 for the rest) that
 * was never payable.
 *
 * THEIR ORDERS ARE NOT DELETED. 77 of them stay in the book and are counted as
 * off-roster volume (`striven.offRoster`), so every order total on every screen
 * is unchanged — the attribution moves, the business does not.
 *
 * This also collapses the 5-vs-11 split that made "Reps" mean one thing on My
 * Dashboard (producers, via STANDINGS_EXCLUDE) and another on Commission (the
 * whole list). One roster now, so the two cannot disagree.
 *
 * WIDENED TO SIX AND NARROWED BACK TO FOUR. Alek Sigman and Alyssa Parker were
 * added by instruction on the strength of orders booked under their names in
 * Striven's Sales Rep field, then removed again by instruction: they are
 * OPERATIONS, and being named on an order you processed is not the same as
 * selling it. See the note beside their removal in REP_NAMES.
 *
 * Rishi Arora and Kevin Parker are off-roster for the same reason (admins with
 * an order apiece).
 */
// FULL NAMES, by instruction. These were short forms ("Alle Ann", "Christy",
// "Jillian") and they are the identity key, not a label — so this array, the
// logins below, REP_SUB_REPS above and commRep()'s returns in _striven.js all
// carry the same strings and must be edited together. There are SIX now: adding
// a rep means adding them here AND teaching both fold tables (commRep and
// RECON_REP_ALIASES) to produce the same spelling, or the roster row exists and
// nothing ever lands on it. commRep() is where
// the raw Striven spellings are folded onto them; its comment explains why the
// rename happens there rather than in a display layer.
export const REP_NAMES = [
  'Alle Ann Dubberley',             // 156 orders — Maverick Medical - Alle Ann Dubberley
  'Jillian Colin',                  //  95 orders — Maverick Medical- Jillian Colin
  'Christy Tan',                    //  67 orders — CVT Medical - Christy Tan
  'Maylon Sanders',                 //  35 orders — already the full name
  // ── REMOVED, by instruction: Alek Sigman and Alyssa Parker ─────────────────
  // They are OPERATIONS, not sales. They were added here when orders were seen
  // booked under their names in Striven's Sales Rep field, but appearing in that
  // field is not the same as being a rep — ops staff are recorded against an
  // order they processed. This roster decides who is RANKED and who is PAID, and
  // neither applies to them.
  //
  // WHAT MOVES, measured against the live book rather than assumed: Alek carried
  // 1 order ($59.90) and Alyssa none, and BOTH were on $0 commission — so this
  // takes no money off anyone and moves a single order out of the rep-attributed
  // book into `striven.offRoster`, where the other ops and house names already
  // sit (Crystal Chambers, Kinley Shepherd, House Account, Rishi Arora, Kevin
  // Parker). Every order total on every screen is unchanged; the attribution
  // moves, the business does not.
  //
  // THE NAME FOLDS IN commRep() AND RECON_REP_ALIASES ARE DELIBERATELY KEPT.
  // They are not roster membership — they canonicalise the many spellings
  // Striven and the sheets use ("Maverick Medical - Alek Sigman") onto one
  // string. Deleting them would not remove anyone; it would scatter that one
  // order across raw spellings in the off-roster tail and make it harder to see,
  // not easier. Off-roster names are normal and are counted, just not ranked.
  //
  // NEITHER HAD A LOGIN. There is nothing to revoke in REP_DIRECTORY below.
  // CASSIE IS GONE FROM HERE, by instruction ("remove Cassie from Dashboard,
  // she is no longer needed"), together with her login and her commission — see
  // EXCLUDED_REPS above, which is what actually enforces it. Taking her off the
  // roster alone would only have emptied her own dashboard while leaving her
  // money in every company total.
  //
  // 'Denise Zavala' is not here for a different reason: she is Maylon's sub-rep
  // and commRep() folds her orders into 'Maylon Sanders', who is paid on them.
];

// email → repName → role. The ONLY place accounts are provisioned; there is
// deliberately no signup flow. Override via the app_config key REP_DIRECTORY
// (a JSON array of the same shape) to add accounts without a redeploy.
//
// Three finance/ops accounts are admins; the four reps each hold a login and are
// listed below. Every row in `dashboard_users` must appear here — an account
// that logs in without a directory row resolves to { repName: null, role: 'rep' },
// which is safe (company data still 403s) but useless: no repName means no own
// row, so the rep sees an empty dashboard rather than their own numbers.
//
// CAUTION: Crystal (finance, owns the workbook) is NOT the rep "Christy". They
// are different people with similar names — never map crystal@ to a repName.
// christy@ below is the rep; crystal@ above stays repName: null.
export const REP_DIRECTORY = [
  { email: 'admin@sportsmedrecovery.com', repName: null, role: 'admin' },
  { email: 'crystal@sportsmedrecovery.com', repName: null, role: 'admin' },
  { email: 'rishi@sportsmedrecovery.com', repName: null, role: 'admin' },
  // Kevin: FULL admin — the entire Company side (P&L, AR/AP, QuickBooks) and
  // every rep's revenue and commission. There is no partial-company role, so
  // "decide what he sees later" currently means widening from nothing or
  // narrowing from everything; this is the latter, chosen deliberately.
  { email: 'kevin@sportsmedrecovery.com', repName: null, role: 'admin' },
  // Rep logins. repName must stay exactly as spelled in REP_NAMES above.
  { email: 'alle@sportsmedrecovery.com', repName: 'Alle Ann Dubberley', role: 'rep' },
  { email: 'jillian@sportsmedrecovery.com', repName: 'Jillian Colin', role: 'rep' },
  // RESTORED, and the note that used to sit here was wrong twice over: it said
  // cassie@ had been removed with her roster entry and that `dashboard_users`
  // held no row for her, so there was nothing to revoke. Both were checked
  // against the live tables and both are false — she has a `dashboard_users`
  // login AND a row in the app_config REP_DIRECTORY override, and she is back
  // on the roster above.
  //
  // The override is why the error was invisible: app_config wins over this
  // list, so she signed in fine while the checked-in fallback said she did not
  // exist. That drift only shows up the day the override is cleared or a fresh
  // environment comes up without it — at which point she authenticates, matches
  // no rep row, and lands on an empty dashboard. Exactly Maylon's failure below.
  // cassie@ REMOVED with the rest of her removal — see EXCLUDED_REPS. The
  // app_config REP_DIRECTORY override must be cleared too, or she keeps the
  // login this file no longer grants: that override WINS over this list, and
  // it is the exact drift the note above warns about, in the other direction.
  { email: 'christy@sportsmedrecovery.com', repName: 'Christy Tan', role: 'rep' },
  // Added after the fact: the dashboard_users login existed but this row did
  // not, so Maylon authenticated successfully and then matched no rep row —
  // an empty dashboard with every tile at zero. This is the failure the note
  // above describes; a login without a directory row fails closed and silent.
  { email: 'maylon@sportsmedrecovery.com', repName: 'Maylon Sanders', role: 'rep' },
];

// Verticals. VA and PI are active; DOL is future (may have zero orders);
// TriCare is legacy — retained for historical data, not required going forward.
export const VERTICALS = ['VA', 'PI', 'DOL', 'TriCare'];
export const LEGACY_VERTICALS = ['TriCare'];
