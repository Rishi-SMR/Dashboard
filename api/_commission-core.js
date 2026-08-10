// Commission engine — pure functions, no network and no I/O, so the rules that
// decide money and visibility can be unit-tested directly (see
// _commission-core.test.js). _striven.js supplies the data; this file decides
// what it is worth and who is allowed to see it.
import {
  COMMISSION_RATES, FALLBACK_VERTICAL_RATES, ORDER_LABEL_RULES,
  REP_DIRECTORY,
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

export function classifyOrderLabel(status, rules = ORDER_LABEL_RULES) {
  const s = String(status ?? '');
  if (!s.trim()) return 'payable';
  for (const re of (rules.hold || [])) if (re.test(s)) return 'hold';
  for (const re of (rules.waiting || [])) if (re.test(s)) return 'waiting';
  return 'payable';
}

// ── Per-order commission ─────────────────────────────────────────────────────
/**
 * commission = Σ (units × per-device rate) across the order's devices.
 * A `hold` order contributes $0 and produces no commission lines at all.
 * @param {{status?:string, program?:string, items?:{item:string, qty:number}[]}} order
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

  const state = classifyOrderLabel(order?.status, cfg.labelRules);

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

  const lines = [];
  const rateGaps = [];
  let units = 0, commission = 0;
  for (const it of items) {
    const qty = Number(it?.qty) || 0;
    if (qty <= 0) continue;
    const device = String(it?.item ?? '');
    const { rate, source } = rateForDevice(device, vertical, cfg);
    const comm = round2(qty * rate);
    units += qty;
    commission = round2(commission + comm);
    lines.push({ device, units: qty, rate, comm, rateSource: source, state });
    if (source === 'fallback' && device) rateGaps.push(device);
  }
  return { state, units, commission, lines, rateGaps };
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
const isOwn = (viewer, repName) => Boolean(viewer?.repName) && norm(viewer.repName) === norm(repName);

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
      waitingTotal: ownStriven ? (ownStriven.waitingTotal ?? 0) : null,
      heldOrders: ownStriven ? (ownStriven.heldOrders ?? 0) : null,
      // offRoster NAMES other people ("Kevin Parker", "Rishi Arora") and carries
      // their value. It is a reconciliation aid for an admin and a colleague
      // list to a rep, so it goes entirely.
      offRoster: null,
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
