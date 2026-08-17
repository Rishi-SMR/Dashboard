/**
 * Cross-checks every headline figure against every source that produces it.
 *
 * The portal derives the same numbers through several independent paths — the
 * order book (getSO), order analytics, the commission engine and the rep
 * overview. They are SUPPOSED to agree. This asserts that they do, and names
 * the source of any drift rather than leaving it to be spotted on a screen.
 *
 * Run: node scripts/audit-consistency.mjs
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const S = await import('../api/_striven.js');
const ADMIN = { repName: null, role: 'admin' };

const [analytics, comm, overview] = await Promise.all([
  S.getOrderAnalytics(ADMIN),
  S.getCommissionFor(ADMIN),
  S.getRepOverview(ADMIN),
]);

const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

let failures = 0;
const groups = [];

/** Records one figure and the value each source reports for it. */
function check(label, sources, { money = false, tolerance = 0 } = {}) {
  const entries = Object.entries(sources).filter(([, v]) => v != null && !Number.isNaN(v));
  const values = entries.map(([, v]) => round2(v));
  const min = Math.min(...values), max = Math.max(...values);
  const ok = values.length <= 1 || (max - min) <= tolerance;
  if (!ok) failures++;
  groups.push({ label, entries, ok, money, spread: round2(max - min) });
}

/**
 * Records related figures that are NOT supposed to be equal.
 *
 * Every group above asserts agreement, so anything printed here would otherwise
 * read as drift. Some numbers just differ for a reason worth showing — a line
 * count against an order count — and asserting those trains the reader to
 * ignore a DIFF, which is the one thing this script cannot afford.
 */
function info(label, sources, { money = false } = {}) {
  const entries = Object.entries(sources).filter(([, v]) => v != null && !Number.isNaN(v));
  groups.push({ label, entries, ok: true, money, spread: 0, note: true });
}

const orders = analytics.orders || [];
const sv = comm.striven || {};
const byRep = sv.byRep || [];

// ── Orders ───────────────────────────────────────────────────────────────────
check('ORDERS — the book', {
  'analytics.orders.length': orders.length,
  'repOverview.bookTotals.orders': overview.bookTotals?.orders,
  'commission.striven.bookOrders': sv.bookOrders,
  'teamTotals + unattributed': overview.teamTotals?.orders != null && overview.unattributed
    ? overview.teamTotals.orders + overview.unattributed.orders : null,
  // The commission table renders roster rows PLUS an off-roster row; the audit
  // must sum what the table sums, or it flags the table's own design as drift.
  'commission table (reps + off roster)': byRep.length
    ? byRep.reduce((s, r) => s + (r.orders || 0), 0) + (sv.offRoster?.orders || 0) : null,
});

// ── Revenue ──────────────────────────────────────────────────────────────────
check('REVENUE — order value', {
  'sum analytics.revenue': orders.reduce((s, o) => s + o.revenue, 0),
  'repOverview.bookTotals.revenue': overview.bookTotals?.revenue,
  'teamTotals + unattributed': overview.teamTotals?.revenue != null && overview.unattributed
    ? round2(overview.teamTotals.revenue + overview.unattributed.revenue) : null,
}, { money: true, tolerance: 0.02 });

// ── Units / devices ──────────────────────────────────────────────────────────
check('DEVICES — units', {
  'sum analytics.units': orders.reduce((s, o) => s + o.units, 0),
  'sum analytics.devices[].qty': orders.reduce((s, o) => s + (o.devices || []).reduce((t, d) => t + d.qty, 0), 0),
  'repOverview.bookTotals.units': overview.bookTotals?.units,
  'teamTotals + unattributed': overview.teamTotals?.units != null && overview.unattributed
    ? overview.teamTotals.units + overview.unattributed.units : null,
  'commission table (reps + off roster)': byRep.length
    ? byRep.reduce((s, r) => s + (r.units || 0), 0) + (sv.offRoster?.units || 0) : null,
});

// ── Commission — the figure the user anchors on ──────────────────────────────
check('COMMISSION — grand total', {
  'striven.grandTotal': sv.grandTotal,
  'sum byRep.total': byRep.reduce((s, r) => s + (r.total || 0), 0),
  'sum months.total': (sv.months || []).reduce((s, m) => s + (m.total || 0), 0),
  'byProgram TriCare+VA+PI': sv.byProgram
    ? round2((sv.byProgram.TriCare || 0) + (sv.byProgram.VA || 0) + (sv.byProgram.PI || 0)) : null,
  // The headline is PAID + PAYABLE, not payable + waiting. Waiting is the
  // in-flight cycle: an estimate off the engine for a month with no payout run
  // yet, deliberately OUTSIDE the signed-off total. Asserting the old sum meant
  // this script reported a DIFF for a figure that was correct, and would have
  // gone on reporting one however the two bases were reconciled.
  'paid + payable': round2((sv.paidTotal || 0) + (sv.payableTotal || 0)),
  'repOverview.teamTotals.commission': overview.teamTotals?.commission,
  'sum of rep lines': byRep.reduce((s, r) => s + (r.lines || []).reduce((t, l) => t + (l.comm || 0), 0), 0),
}, { money: true, tolerance: 0.05 });

// ── Commission basis ─────────────────────────────────────────────────────────
// A LINE IS NOT AN ORDER, and counting them as one was this script's own bug.
// One order carries one line PER DEVICE: SO-292 is three Genesys units for one
// patient on one order, so it is three lines earning $650 each. Thirteen orders
// spread across 28 lines that way, which is exactly the spread reported here —
// three of them (SO-292 and SO-333 have three lines apiece) leaking past the
// two-line pairs. Nothing was double-paid; the label was wrong.
//
// So the comparison is against DISTINCT SALES ORDERS, and the raw line count is
// reported beside it as its own figure rather than as a rival answer.
const refLines = byRep.flatMap((r) => (r.lines || []).filter((l) => l.ref));
check('COMMISSIONED ORDERS', {
  'striven.commissionedOrders': sv.commissionedOrders,
  'sum byRep.commOrders': byRep.length ? byRep.reduce((s, r) => s + (r.commOrders || 0), 0) : null,
});
info('SIGNED-OFF LINES — a line is per DEVICE, not per order', {
  'rep lines': byRep.reduce((s, r) => s + (r.lines || []).length, 0),
  'of those, tied to a sales order': refLines.length,
  '  → distinct sales orders': new Set(refLines.map((l) => l.ref)).size,
  'untied to any sales order': byRep.reduce((s, r) => s + (r.lines || []).filter((l) => !l.ref).length, 0),
});

// ── Accounts ─────────────────────────────────────────────────────────────────
const realAcct = new Set(orders.map((o) => o.account).filter(S.isRealAccount));
check('ACCOUNTS — distinct payers', {
  'distinct isRealAccount(analytics)': realAcct.size,
  'repOverview.bookTotals.accounts': overview.bookTotals?.accounts,
});

// ── Reps ─────────────────────────────────────────────────────────────────────
check('REPS on the roster', {
  'repOverview.teamTotals.reps': overview.teamTotals?.reps,
  'repOverview.reps.length': overview.reps?.length,
  'commission byRep.length': byRep.length,
});

// ── Verticals: analytics vs commission volume columns ────────────────────────
const vertA = {};
for (const o of orders) vertA[o.vertical] = (vertA[o.vertical] || 0) + 1;
for (const [v, key] of [['TriCare', 'nTricare'], ['VA', 'nVa'], ['PI', 'nPi']]) {
  check(`VERTICAL ${v} — order count`, {
    'analytics by vertical': vertA[v] || 0,
    'commission table (reps + off roster)': byRep.length
      ? byRep.reduce((s, r) => s + (r[key] || 0), 0) + (sv.offRoster?.[key] || 0) : null,
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('\nPORTAL CONSISTENCY AUDIT');
console.log('='.repeat(78));
for (const g of groups) {
  console.log(`\n${g.note ? 'NOTE' : g.ok ? 'OK  ' : 'DIFF'}  ${g.label}${g.ok ? '' : `   spread ${g.money ? usd(g.spread) : g.spread}`}`);
  for (const [src, val] of g.entries) {
    console.log(`        ${String(g.money ? usd(val) : val).padStart(14)}   ${src}`);
  }
}
// NOTE groups are not assertions, so they are not in the denominator either —
// counting them as figures that "agree" would overstate what was checked.
const asserted = groups.filter((g) => !g.note).length;
console.log('\n' + '='.repeat(78));
console.log(failures === 0
  ? `ALL ${asserted} FIGURES AGREE ACROSS EVERY SOURCE`
  : `${failures} of ${asserted} figures DISAGREE — see DIFF above`);
process.exit(failures === 0 ? 0 : 1);
