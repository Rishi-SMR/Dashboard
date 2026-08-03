// Commission engine — pure functions, no network and no I/O, so the rules that
// decide money and visibility can be unit-tested directly (see
// _commission-core.test.js). _striven.js supplies the data; this file decides
// what it is worth and who is allowed to see it.
import {
  COMMISSION_RATES, FALLBACK_VERTICAL_RATES, ORDER_LABEL_RULES,
  MIN_MATCH_RATE, REP_DIRECTORY,
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
  if (state === 'hold') {
    // Excluded entirely — no dollars and no line. It may still appear in the
    // order views elsewhere; it simply does not exist to the commission engine.
    return { state, units: 0, commission: 0, lines: [], rateGaps: [] };
  }

  // Nothing was billed, so nothing is earned. A $0 order is excluded outright
  // rather than paying a device rate against revenue that never existed.
  if (Number(order?.value ?? 0) <= 0) {
    return { state: 'zero-value', units: 0, commission: 0, lines: [], rateGaps: [] };
  }

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

/** Roll per-order results into payable / waiting buckets for one rep. */
export function splitByState(orders) {
  let payableTotal = 0, waitingTotal = 0, heldOrders = 0, zeroValueOrders = 0, cancelledOrders = 0;
  for (const o of orders) {
    if (o.state === 'cancelled') { cancelledOrders++; continue; }
    if (o.state === 'hold') { heldOrders++; continue; }
    if (o.state === 'zero-value') { zeroValueOrders++; continue; }
    if (o.state === 'waiting') waitingTotal = round2(waitingTotal + o.commission);
    else payableTotal = round2(payableTotal + o.commission);
  }
  return { payableTotal, waitingTotal, total: round2(payableTotal + waitingTotal), heldOrders, zeroValueOrders, cancelledOrders };
}

// ── Sheet verification gate ──────────────────────────────────────────────────
/**
 * The linked sheet is historical and frozen, so its figures are only
 * authoritative once they reconcile against Striven: at or above the minimum
 * patient match rate AND with no unresolved bookedUnder exceptions.
 */
export function isRepVerified(rep, cfg = {}) {
  const min = Number.isFinite(cfg.minMatchRate) ? cfg.minMatchRate : MIN_MATCH_RATE;
  const rate = rep?.matchRate;
  if (rate == null) return false;
  if (Number(rate) < min) return false;
  const exceptions = rep?.recon?.bookedUnder;
  if (Array.isArray(exceptions) && exceptions.length > 0) return false;
  return true;
}

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
// Financial fields a rep may see ONLY on their own row.
const REP_MONEY = ['tricare', 'pi', 'va', 'total', 'payableTotal', 'waitingTotal', 'strivenValue', 'commPerOrder', 'pctOfValue'];
const STRIVEN_MONEY = ['tricare', 'va', 'pi', 'total', 'payableTotal', 'waitingTotal', 'value'];
const RECONCILE_MONEY = ['sheet', 'striven', 'diff'];

const isOwn = (viewer, repName) => Boolean(viewer?.repName) && norm(viewer.repName) === norm(repName);

function blankMoney(row, keys) {
  const out = { ...row };
  for (const k of keys) if (k in out) out[k] = null;
  return out;
}

/**
 * Redact one payload for one viewer. Runs on the SERVER before serialization —
 * another rep's dollars must never reach the browser, hidden by CSS or not.
 *
 * Rep role  → own row in full; every other rep reduced to operational counts.
 * Admin     → untouched.
 */
export function redactCommissionPayload(payload, viewer) {
  if (!payload || viewer?.role === 'admin') return payload;
  const out = { ...payload };

  // Sheet rows. A non-own row keeps only operational counts (Business Rule 1).
  const ownSheet = (payload.reps || []).find((r) => isOwn(viewer, r.rep)) || null;
  out.reps = (payload.reps || []).map((r) => {
    if (isOwn(viewer, r.rep)) return r;
    return {
      rep: r.rep,
      count: r.count ?? null,
      strivenOrders: r.strivenOrders ?? 0,
      strivenUnits: r.strivenUnits ?? 0,
      matchRate: r.matchRate ?? null,
      orderCounts: r.orderCounts || { TriCare: 0, VA: 0, PI: 0, DOL: 0 },
      verified: r.verified ?? false,
      flag: r.flag ?? null,
      recon: null,                 // entire block is financial → own row only
      redacted: true,
      ...Object.fromEntries(REP_MONEY.map((k) => [k, null])),
    };
  });

  // Company-wide dollar totals would leak the other reps in aggregate, so a rep
  // sees their OWN totals here; admins keep the true company figures.
  out.grandTotal = ownSheet ? ownSheet.total : null;
  out.byProgram = ownSheet
    ? { TriCare: ownSheet.tricare ?? 0, PI: ownSheet.pi ?? 0, VA: ownSheet.va ?? 0 }
    : { TriCare: null, PI: null, VA: null };
  out.scopedToRep = viewer?.repName ?? null;

  // Pay-period tabs carry the same per-rep dollars.
  if (Array.isArray(payload.periods)) {
    out.periods = payload.periods.map((p) => ({
      ...p,
      total: null,
      reps: (p.reps || []).map((r) => (isOwn(viewer, r.rep) ? r : blankMoney({ ...r, redacted: true }, ['tricare', 'va', 'pi', 'total']))),
    }));
  }

  // Striven-computed view.
  if (payload.striven) {
    const ownStriven = (payload.striven.byRep || []).find((r) => isOwn(viewer, r.rep)) || null;
    out.striven = {
      ...payload.striven,
      grandTotal: ownStriven ? ownStriven.total : null,
      byProgram: ownStriven
        ? { TriCare: ownStriven.tricare ?? 0, VA: ownStriven.va ?? 0, PI: ownStriven.pi ?? 0 }
        : { TriCare: null, VA: null, PI: null },
      byRep: (payload.striven.byRep || []).map((r) => (
        isOwn(viewer, r.rep) ? r : { ...blankMoney(r, STRIVEN_MONEY), lines: undefined, redacted: true }
      )),
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
          reps: (m.reps || []).map((r) => (
            isOwn(viewer, r.rep) ? r : { ...blankMoney(r, STRIVEN_MONEY), lines: undefined, redacted: true }
          )),
        };
      }),
    };
  }

  // Reconcile view.
  if (payload.reconcile) {
    out.reconcile = {
      ...payload.reconcile,
      totals: { sheet: null, striven: null, diff: null },
      reps: (payload.reconcile.reps || []).map((r) => (
        isOwn(viewer, r.rep)
          ? r
          : { ...blankMoney(r, RECONCILE_MONEY), sheetProg: null, strivenProg: null, redacted: true }
      )),
    };
  }

  return out;
}
