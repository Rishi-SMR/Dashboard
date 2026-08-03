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
export const PI_STAGES = [
  'Order received',
  '1st LOP Request',
  'Waiting for LOP',
  'Dispensed',
  'Waiting for first payment',
  'Shipped',
  'Delivered',
];
/** Custom field on the sales order that mirrors the Striven tag. */
export const STRIVEN_STAGE_FIELD = 'Stage';

// ── Standings masking ────────────────────────────────────────────────────────
// When true, a rep sees ONLY the order count for other reps — units, devices and
// account counts are nulled too, so Team Standings is strictly order-count-only.
// Set false to let reps compare volume more richly (units and accounts return).
// Money is never affected by this flag; it is withheld from non-self rows always.
export const STANDINGS_ORDERS_ONLY = true;

// ── Sheet verification gate ──────────────────────────────────────────────────
// A rep's sheet figures count as authoritative only at or above this patient
// match rate AND with no unresolved bookedUnder exceptions.
export const MIN_MATCH_RATE = 90;

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
  'Denise Zavala',                  //   2 orders — Maylon Sanders - Denise Zavala
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
  // Rep logins. repName must stay exactly as spelled in REP_NAMES above.
  { email: 'alle@sportsmedrecovery.com', repName: 'Alle Ann', role: 'rep' },
  { email: 'jillian@sportsmedrecovery.com', repName: 'Jillian', role: 'rep' },
  { email: 'cassie@sportsmedrecovery.com', repName: 'Cassie', role: 'rep' },
  { email: 'christy@sportsmedrecovery.com', repName: 'Christy', role: 'rep' },
];

// Verticals. VA and PI are active; DOL is future (may have zero orders);
// TriCare is legacy — retained for historical data, not required going forward.
export const VERTICALS = ['VA', 'PI', 'DOL', 'TriCare'];
export const LEGACY_VERTICALS = ['TriCare'];
