// Commission engine tests — node:test (built in, no new dependencies).
//   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rateForDevice, classifyOrderLabel, commissionForOrder, splitByState,
  resolveIdentity, redactCommissionPayload, isCancelledStatus,
} from './_commission-core.js';

// A self-contained rate card, so these tests never depend on the placeholder
// config the client is still filling in.
const CFG = {
  rates: { 'genesis lumbar': 650, 'genesis': 100, 'pi brace': 300 },
  fallback: { VA: 425, PI: 0, TriCare: 369.78, DOL: 0 },
};

const DIRECTORY = [
  { email: 'finance@smr.example', repName: null, role: 'admin' },
  { email: 'cassie@smr.example', repName: 'Cassie', role: 'rep' },
  { email: 'dana@smr.example', repName: 'Dana', role: 'rep' },
];

// A payload shaped like the real /api/commission response.
const payload = () => ({
  ok: true,
  grandTotal: 5000,
  byProgram: { TriCare: 1000, PI: 1500, VA: 2500 },
  reps: [
    {
      rep: 'Cassie', tricare: 500, pi: 700, va: 1800, total: 3000,
      payableTotal: 2400, waitingTotal: 600, count: 9,
      strivenOrders: 9, strivenUnits: 12, strivenValue: 40000,
      commPerOrder: 333, pctOfValue: 7.5, matchRate: 95, verified: true,
      orderCounts: { TriCare: 2, VA: 5, PI: 2, DOL: 0 },
      recon: { same: 9, diff: 0, none: 0, commSame: 3000, commDiff: 0, commNone: 0, bookedUnder: [], lines: [{ ref: 'SO-1', comm: 650 }] },
    },
    {
      rep: 'Dana', tricare: 500, pi: 800, va: 700, total: 2000,
      payableTotal: 2000, waitingTotal: 0, count: 6,
      strivenOrders: 6, strivenUnits: 8, strivenValue: 25000,
      commPerOrder: 333, pctOfValue: 8, matchRate: 40, verified: false,
      orderCounts: { TriCare: 1, VA: 3, PI: 2, DOL: 0 },
      recon: { same: 2, diff: 4, none: 0, commSame: 700, commDiff: 1300, commNone: 0, bookedUnder: [{ rep: 'Cassie', count: 4 }], lines: [{ ref: 'SO-9', comm: 425 }] },
    },
  ],
  periods: [{ key: '2026-06', label: 'Jun 2026', total: 5000, reps: [
    { rep: 'Cassie', tricare: 500, va: 1800, pi: 700, total: 3000, count: 9 },
    { rep: 'Dana', tricare: 500, va: 700, pi: 800, total: 2000, count: 6 },
  ] }],
  striven: {
    available: true, grandTotal: 5200,
    byProgram: { TriCare: 1000, VA: 2600, PI: 1600 },
    byRep: [
      { rep: 'Cassie', tricare: 500, va: 1900, pi: 700, total: 3100, orders: 9, units: 12, value: 40000, lines: [{ ref: 'SO-1', comm: 650 }] },
      { rep: 'Dana', tricare: 500, va: 700, pi: 900, total: 2100, orders: 6, units: 8, value: 25000, lines: [{ ref: 'SO-9', comm: 425 }] },
    ],
    months: [{ month: '2026-06', total: 5200, TriCare: 1000, VA: 2600, PI: 1600, orders: 15, units: 20, value: 65000, reps: [
      { rep: 'Cassie', tricare: 500, va: 1900, pi: 700, total: 3100, orders: 9, units: 12, value: 40000 },
      { rep: 'Dana', tricare: 500, va: 700, pi: 900, total: 2100, orders: 6, units: 8, value: 25000 },
    ] }],
  },
  reconcile: {
    totals: { sheet: 5000, striven: 5200, diff: -200 },
    reps: [
      { rep: 'Cassie', sheet: 3000, striven: 3100, diff: -100, sheetProg: { TriCare: 500, VA: 1800, PI: 700 }, strivenProg: { TriCare: 500, VA: 1900, PI: 700 }, lines: 9, orders: 9, matchRate: 95 },
      { rep: 'Dana', sheet: 2000, striven: 2100, diff: -100, sheetProg: { TriCare: 500, VA: 700, PI: 800 }, strivenProg: { TriCare: 500, VA: 700, PI: 900 }, lines: 6, orders: 6, matchRate: 40 },
    ],
  },
});

const CASSIE = { email: 'cassie@smr.example', repName: 'Cassie', role: 'rep' };
const ADMIN = { email: 'finance@smr.example', repName: null, role: 'admin' };

// ── vi. Commission math ──────────────────────────────────────────────────────
test('vi. commission is units × per-device rate (3 × $650 = $1,950)', () => {
  const out = commissionForOrder(
    { status: 'Fillable', program: 'VA', value: 5000, items: [{ item: 'VA Genesis Lumbar', qty: 3 }] },
    CFG,
  );
  assert.equal(out.commission, 1950);
  assert.equal(out.units, 3);
  assert.equal(out.lines[0].rate, 650);
  assert.equal(out.lines[0].rateSource, 'device');
});

test('vi. multi-device orders sum per device', () => {
  const out = commissionForOrder(
    { status: 'Reimbursed', program: 'PI', value: 5000, items: [{ item: 'PI Brace', qty: 2 }, { item: 'Genesis Lumbar', qty: 1 }] },
    CFG,
  );
  assert.equal(out.commission, 2 * 300 + 650);
});

test('vi. longest matching device key wins', () => {
  assert.deepEqual(rateForDevice('VA Genesis Lumbar', 'VA', CFG), { rate: 650, source: 'device' });
  assert.deepEqual(rateForDevice('Genesis Cervical', 'VA', CFG), { rate: 100, source: 'device' });
});

test('vi. an unpriced device falls back to the vertical rate and is reported', () => {
  const out = commissionForOrder({ status: 'Fillable', program: 'VA', value: 5000, items: [{ item: 'Unknown Widget', qty: 2 }] }, CFG);
  assert.equal(out.commission, 850);                 // 2 × 425 fallback
  assert.equal(out.lines[0].rateSource, 'fallback');
  assert.deepEqual(out.rateGaps, ['Unknown Widget']);
});

// ── vii. hold: costed, but never payable ─────────────────────────────────────
// A held order is taken but not dispensed, so it is not on this cheque. It is
// still costed, because the rep needs to see what is pending: when the whole
// month is held (the Genesys backorder) a $0 answer tells them nothing.
test('vii. a `hold` order is costed like any other', () => {
  const out = commissionForOrder(
    { status: 'On Hold', program: 'VA', value: 5000, items: [{ item: 'Genesis Lumbar', qty: 3 }] },
    CFG,
  );
  assert.equal(out.state, 'hold');
  assert.equal(out.commission, 1950, '3 x $650 is earned, it is simply not yet payable');
  assert.equal(out.units, 3);
  assert.equal(out.lines.length, 1);
});

test('vii. held commission is reported as Waiting, never as payable', () => {
  const split = splitByState([
    { state: 'payable', commission: 1950 },
    { state: 'hold', commission: 1300 },
  ]);
  assert.equal(split.payableTotal, 1950, 'the cheque must not include held orders');
  assert.equal(split.waitingTotal, 1300, 'held money surfaces in the Waiting column');
  assert.equal(split.heldTotal, 1300, 'and is attributable to hold specifically');
  assert.equal(split.total, 3250);
  assert.equal(split.heldOrders, 1);
});

test('vii. hold and waiting both stay out of payable', () => {
  const split = splitByState([
    { state: 'payable', commission: 1000 },
    { state: 'waiting', commission: 200 },
    { state: 'hold', commission: 300 },
  ]);
  assert.equal(split.payableTotal, 1000);
  assert.equal(split.waitingTotal, 500, 'waiting + held');
  assert.equal(split.heldTotal, 300, 'the held share of waiting');
});

// ── ix. zero-value orders earn nothing ───────────────────────────────────────
test('ix. a $0 order earns no commission', () => {
  const out = commissionForOrder(
    { status: 'Fillable', program: 'VA', value: 0, items: [{ item: 'Genesys Lumbar', qty: 3 }] },
    CFG,
  );
  assert.equal(out.state, 'zero-value');
  assert.equal(out.commission, 0, 'no commission on revenue that never existed');
  assert.equal(out.units, 0);
  assert.deepEqual(out.lines, [], 'and no commission line');
});

test('ix. a missing or negative order value is treated the same', () => {
  for (const v of [undefined, null, -100]) {
    const out = commissionForOrder({ status: 'Fillable', program: 'VA', value: v, items: [{ item: 'Genesys Lumbar', qty: 1 }] }, CFG);
    assert.equal(out.commission, 0, `value ${v} must earn nothing`);
    assert.equal(out.state, 'zero-value');
  }
});

test('ix. zero-value orders drop out of the total and are counted separately', () => {
  const split = splitByState([
    { state: 'payable', commission: 1950 },
    { state: 'zero-value', commission: 0 },
    { state: 'hold', commission: 0 },
  ]);
  assert.equal(split.total, 1950, 'a $0 held order adds nothing to waiting either');
  assert.equal(split.zeroValueOrders, 1);
  assert.equal(split.heldOrders, 1);
});

test('ix. a held $0 order is reported as held, not zero-value', () => {
  const out = commissionForOrder({ status: 'On Hold', program: 'VA', value: 0, items: [{ item: 'Genesys Lumbar', qty: 1 }] }, CFG);
  assert.equal(out.state, 'hold', 'hold is the stronger exclusion and wins');
});

// ── x. cancelled orders earn nothing ─────────────────────────────────────────
test('x. a cancelled order earns no commission', () => {
  for (const status of ['Canceled', 'Cancelled', 'Voided', 'Denied', 'Rejected', 'CANCELED']) {
    const out = commissionForOrder({ status, program: 'VA', value: 12990, items: [{ item: 'Genesys Lumbar', qty: 3 }] }, CFG);
    assert.equal(out.state, 'cancelled', `${status} must classify as cancelled`);
    assert.equal(out.commission, 0, `${status} must earn nothing`);
    assert.equal(out.units, 0);
    assert.deepEqual(out.lines, [], 'and contribute no device line');
  }
});

test('x. cancelled beats every other rule', () => {
  // Regression: a cancelled order that also looks payable, held, or waiting must
  // still be excluded — cancellation is checked first for exactly this reason.
  const held = commissionForOrder({ status: 'Canceled - on hold', program: 'VA', value: 5000, items: [{ item: 'Genesys Lumbar', qty: 1 }] }, CFG);
  assert.equal(held.state, 'cancelled');
  const waiting = commissionForOrder({ status: 'Canceled, waiting for reimbursement', program: 'VA', value: 5000, items: [{ item: 'Genesys Lumbar', qty: 1 }] }, CFG);
  assert.equal(waiting.state, 'cancelled');
});

test('x. cancelled orders drop out of the total and are counted separately', () => {
  const split = splitByState([
    { state: 'payable', commission: 12990 },
    { state: 'cancelled', commission: 0 },
    { state: 'zero-value', commission: 0 },
    { state: 'hold', commission: 0 },
  ]);
  assert.equal(split.total, 12990, 'only the live order counts');
  assert.equal(split.cancelledOrders, 1);
  assert.equal(split.zeroValueOrders, 1);
  assert.equal(split.heldOrders, 1);
});

test('x. a live order is not mistaken for cancelled', () => {
  assert.equal(isCancelledStatus('In Progress'), false);
  assert.equal(isCancelledStatus('Completed'), false);
  assert.equal(isCancelledStatus('Incomplete'), false, 'Incomplete is not a cancellation');
  assert.equal(isCancelledStatus(''), false);
  assert.equal(isCancelledStatus(undefined), false);
  assert.equal(isCancelledStatus('Canceled'), true);
});

// ── viii. waiting for reimbursement ──────────────────────────────────────────
test('viii. `waiting for reimbursement` counts toward the total but is not payable', () => {
  const out = commissionForOrder(
    { status: 'Waiting for reimbursement', program: 'VA', value: 5000, items: [{ item: 'Genesis Lumbar', qty: 2 }] },
    CFG,
  );
  assert.equal(out.state, 'waiting');
  assert.equal(out.commission, 1300, 'still counted');

  const split = splitByState([
    { state: 'payable', commission: 1950 },
    { state: 'waiting', commission: 1300 },
  ]);
  assert.equal(split.payableTotal, 1950);
  assert.equal(split.waitingTotal, 1300);
  assert.equal(split.total, 3250, 'waiting is included in the total');
});

test('viii. hold wins over waiting when a status mentions both', () => {
  assert.equal(classifyOrderLabel('On hold - waiting for reimbursement'), 'hold');
});

test('viii. unlabelled orders stay payable', () => {
  assert.equal(classifyOrderLabel('Fillable'), 'payable');
  assert.equal(classifyOrderLabel(''), 'payable');
  assert.equal(classifyOrderLabel(undefined), 'payable');
});

// ── i / ii / iii. Rep scoping ────────────────────────────────────────────────
test('i. a rep sees their own dollars in full', () => {
  const out = redactCommissionPayload(payload(), CASSIE);
  const me = out.reps.find((r) => r.rep === 'Cassie');
  assert.equal(me.total, 3000);
  assert.equal(me.payableTotal, 2400);
  assert.equal(me.waitingTotal, 600);
  assert.equal(me.recon.lines.length, 1, 'own recon detail is expandable');
  assert.equal(out.striven.byRep.find((r) => r.rep === 'Cassie').total, 3100);
  assert.equal(out.reconcile.reps.find((r) => r.rep === 'Cassie').sheet, 3000);
});

// POLICY CHANGE. This used to assert that a peer row SURVIVED, carrying order
// counts, unit counts and matchRate with only the money nulled — the "volume is
// shared, pay is not" model. A rep is now restricted to their own data, so the
// row must not be there at all.
test('ii. a rep sees no row for another rep, not even a redacted one', () => {
  const out = redactCommissionPayload(payload(), CASSIE);
  assert.equal(out.reps.find((r) => r.rep === 'Dana'), undefined, 'no peer sheet row');
  assert.equal(out.reps.length, 1, 'the caller and nobody else');
  assert.equal(out.reps[0].rep, 'Cassie');
  // Every other collection of rep rows in the payload obeys the same rule. A
  // single missed collection would hand back the whole roster.
  assert.equal(out.striven.byRep.length, 1, 'striven.byRep: own only');
  assert.equal(out.striven.months[0].reps.length, 1, 'inside a month too');
  assert.equal(out.periods[0].reps.length, 1, 'and on a pay-period tab');
  assert.equal(out.reconcile.reps.length, 1, 'and in reconcile');
  for (const list of [out.reps, out.striven.byRep, out.striven.months[0].reps, out.periods[0].reps, out.reconcile.reps]) {
    assert.ok(list.every((r) => r.rep === 'Cassie'), 'every surviving row is the caller\'s own');
  }
});

test('iii. no figure for another rep survives anywhere in the payload', () => {
  const out = redactCommissionPayload(payload(), CASSIE);
  // Dana's dollars, the company-wide aggregates that would reveal them, AND
  // Dana's volume — the counts used to be permitted and are not any more.
  const forbidden = [2000, 2100, 800, 900, 5000, 5200, 25000];
  const seen = JSON.stringify(out);
  for (const n of forbidden) {
    assert.ok(!new RegExp(`(^|[^\\d.])${n}([^\\d]|$)`).test(seen), `value ${n} leaked: ${seen.slice(0, 200)}`);
  }
  // The NAME is disclosure too: it tells a rep who else is on the book.
  assert.ok(!seen.includes('Dana'), 'a peer\'s name must not appear anywhere in the payload');
  assert.equal(out.reconcile.totals.sheet, null);
});

test('iii. redaction is identity-driven, so no query param can widen it', () => {
  // The viewer is built from the verified session only. Even if a caller could
  // name another rep, the resolver never grants them that identity.
  const spoofed = resolveIdentity('dana@smr.example', DIRECTORY);
  assert.equal(spoofed.repName, 'Dana');
  const out = redactCommissionPayload(payload(), { ...CASSIE });
  assert.equal(out.reps.find((r) => r.rep === 'Dana'), undefined, 'Dana is absent from Cassie\'s payload');
  // An unknown account gets least privilege: a rep with no own row at all. That
  // now means an EMPTY list rather than a list of locked rows — matching no
  // name can only ever return nothing.
  const stranger = resolveIdentity('nobody@example.com', DIRECTORY);
  assert.deepEqual(stranger, { email: 'nobody@example.com', repName: null, role: 'rep' });
  const strangerOut = redactCommissionPayload(payload(), stranger);
  assert.equal(strangerOut.reps.length, 0, 'no rep row is unlocked, and none is even listed');
  assert.equal(strangerOut.grandTotal, null);
});

test('i. a rep can still see their own figures after picking a month', () => {
  const out = redactCommissionPayload(payload(), CASSIE);
  const m = out.striven.months[0];
  // Regression: month headline figures used to be nulled outright, which blanked
  // a rep's own KPI tiles the moment they selected a month.
  assert.equal(m.total, 3100, "month total is the caller's own, not the company's");
  assert.equal(m.VA, 1900);
  assert.equal(m.reps.find((r) => r.rep === 'Cassie').total, 3100);
  assert.equal(m.reps.find((r) => r.rep === 'Dana'), undefined, 'peers are absent inside the month too');
  assert.notEqual(m.total, 5200, 'the company month total must never appear');
});

test('i. a month the caller has no row in stays blank', () => {
  const p = payload();
  p.striven.months[0].reps = p.striven.months[0].reps.filter((r) => r.rep !== 'Cassie');
  const out = redactCommissionPayload(p, CASSIE);
  assert.equal(out.striven.months[0].total, null);
  assert.equal(out.striven.months[0].VA, null);
});

test("i. a rep's own aggregates are scoped to them, not the company", () => {
  const out = redactCommissionPayload(payload(), CASSIE);
  assert.equal(out.grandTotal, 3000, "grandTotal is the caller's own total");
  assert.deepEqual(out.byProgram, { TriCare: 500, PI: 700, VA: 1800 });
  assert.equal(out.scopedToRep, 'Cassie');
});

// ── iv. Admin ────────────────────────────────────────────────────────────────
test('iv. admin sees the full unredacted payload', () => {
  const before = payload();
  const out = redactCommissionPayload(before, ADMIN);
  assert.deepEqual(out, before);
  assert.equal(out.grandTotal, 5000);
  assert.equal(out.reps.find((r) => r.rep === 'Dana').total, 2000);
  assert.equal(out.reps.find((r) => r.rep === 'Dana').recon.lines.length, 1);
});

test('iv. role comes from the directory, and defaults to rep', () => {
  assert.equal(resolveIdentity('finance@smr.example', DIRECTORY).role, 'admin');
  assert.equal(resolveIdentity('CASSIE@SMR.EXAMPLE', DIRECTORY).repName, 'Cassie');
  assert.equal(resolveIdentity('who@nowhere', DIRECTORY).role, 'rep');
});

// ── iii. "View as" preview can only narrow ───────────────────────────────────
test('iii. admin "view as" narrows to that rep and never widens', async () => {
  const { viewerFor } = await import('./_striven.js');

  // Admin previewing Cassie gets exactly Cassie's view.
  const preview = viewerFor(ADMIN, 'Cassie');
  assert.equal(preview.role, 'rep');
  assert.equal(preview.repName, 'Cassie');
  const out = redactCommissionPayload(payload(), preview);
  assert.equal(out.reps.find((r) => r.rep === 'Cassie').total, 3000, 'previewed rep sees their own row');
  assert.equal(out.reps.find((r) => r.rep === 'Dana'), undefined, 'preview drops every other rep, as a rep login does');
  assert.equal(out.grandTotal, 3000, "aggregates scope to the previewed rep, not the company");
  assert.equal(out.reconcile.totals.sheet, null, 'company totals stay hidden in preview');

  // Previewing a name with no row unlocks nothing at all.
  const ghost = redactCommissionPayload(payload(), viewerFor(ADMIN, 'Nobody'));
  assert.equal(ghost.reps.length, 0);
  assert.equal(ghost.grandTotal, null);

  // A REP passing ?as= is ignored outright — this is the escalation path that
  // must not exist.
  assert.deepEqual(viewerFor(CASSIE, 'Dana'), CASSIE);
  const escalated = redactCommissionPayload(payload(), viewerFor(CASSIE, 'Dana'));
  assert.equal(escalated.reps.find((r) => r.rep === 'Dana'), undefined, 'naming Dana does not summon her row');
  assert.equal(escalated.reps.length, 1, 'the attempt yields exactly the caller\'s own row');
  assert.equal(escalated.reps.find((r) => r.rep === 'Cassie').total, 3000, 'still sees only their own');

  // Empty / missing `as` leaves the caller untouched.
  assert.deepEqual(viewerFor(ADMIN, ''), ADMIN);
  assert.deepEqual(viewerFor(ADMIN, null), ADMIN);
});

// The sheet verification gate's tests went with the gate: Striven is the only
// source now, so there is no second figure to reconcile a rep against.
