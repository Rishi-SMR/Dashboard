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
  'Dispensed & shipped',
  'Delivered',
  'Waiting for first payment',
  'Waiting for settlement',
];
/** Custom field on the sales order that mirrors the Striven tag. */
export const STRIVEN_STAGE_FIELD = 'Stage';

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

  // → Dispensed & shipped. Dispensing IS shipping here.
  'shipped': 'Dispensed & shipped',
  'dispense': 'Dispensed & shipped',

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
  'tricare order submitted': 'Dispensed & shipped',
  // 'CANCELLED' is here for completeness only: cancelled orders never reach
  // this pipeline — getOrderAnalytics drops them before it is built.
  // 'case dropped' is NOT here: a dropped case has stopped, not progressed, so
  // it carries no stage and goes to the review queue. See REVIEW_LABELS above.
  'cancelled': 'Order received',
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
// They are real Sales Rep values, so they stay in REP_NAMES and keep earning
// their commission rows; they are simply not producers being ranked against
// each other. Crystal's own orders are demos, Cassie and Zach have left, and
// Angel and Kinley are ops rather than sales.
//
// Denise Zavala is deliberately NOT here: she folds into Maylon Sanders in
// commRep(), so her orders rank under Maylon rather than disappearing.
//
// 'House Account' (a house bucket, not a person) and 'Santiago Family
// Chiropractic' (a practice, not a rep) were previously left ON the board — the
// meeting had covered both ways. Both have since been named explicitly for
// removal, so the board is now producers only.
export const STANDINGS_EXCLUDE = [
  'Crystal Chambers',
  'Angel Santiago',
  'Cassie',
  'Kinley Shepherd',
  'Zach Shank',
  'House Account',
  'Santiago Family Chiropractic',
];

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
 * THREE OF THESE ARE NOT INDIVIDUAL PEOPLE — kept because they are real values
 * in Striven's Sales Rep field, but flag them if commission should not accrue:
 *   · House Account                  (10 orders) — a house bucket, not a person.
 *     Note repIsUnassigned() in _striven.js still treats this string as
 *     unassigned for the ORDER-BOOK view, so the two views disagree by design.
 *   · Santiago Family Chiropractic   (17 orders) — a practice, not a rep.
 *   · Crystal Chambers               ( 2 orders) — finance/admin, not a sales
 *     rep. She also holds an admin login in REP_DIRECTORY. Distinct from the
 *     rep "Christy" (Christy Tan).
 *
 * Rishi Arora is excluded by instruction (1 order, $0).
 */
export const REP_NAMES = [
  'Alle Ann',                       // 156 orders — Maverick Medical - Alle Ann Dubberley
  'Jillian',                        //  95 orders — Maverick Medical- Jillian Colin
  'Christy',                        //  67 orders — CVT Medical - Christy Tan
  'Maylon Sanders',                 //  35 orders
  'Santiago Family Chiropractic',   //  17 orders
  'Angel Santiago',                 //  14 orders — House Account- Angel Santiago
  'House Account',                  //  10 orders
  'Cassie',                         //  10 orders — Maverick Medical- Cassie Wates
  'Kinley Shepherd',                //   3 orders
  'Crystal Chambers',               //   2 orders
  // 'Denise Zavala' removed: she is Maylon's sub-rep and commRep() folds her
  // orders into 'Maylon Sanders', who is the one actually paid on them.
  'Zach Shank',                     //   1 order
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
  { email: 'alle@sportsmedrecovery.com', repName: 'Alle Ann', role: 'rep' },
  { email: 'jillian@sportsmedrecovery.com', repName: 'Jillian', role: 'rep' },
  { email: 'cassie@sportsmedrecovery.com', repName: 'Cassie', role: 'rep' },
  { email: 'christy@sportsmedrecovery.com', repName: 'Christy', role: 'rep' },
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
