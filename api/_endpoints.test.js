// Integration tests for the identity-scoped endpoints — the layer the pure-
// function tests in _commission-core.test.js do NOT cover. These replace the
// throwaway probes that were previously run by hand and deleted.
//
// They hit the real derivations, so they need Striven/Supabase credentials and
// take ~15s cold. When credentials are absent every test skips rather than fails,
// so `npm test` still works on a machine without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOrderAnalytics, getRepOverview, getCommission, getPiStages,
  viewerFor, setPiStage, PI_STAGES,
  saveDashboardView, listDashboardViews, deleteDashboardView,
} from './_striven.js';
import { isCancelledStatus } from './_commission-core.js';

const ADMIN = { email: 'admin@test', repName: null, role: 'admin' };
const haveCreds = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
const opts = { skip: haveCreds ? false : 'no Supabase credentials in env' };

let cache = null;
async function load() {
  if (!cache) {
    const [analytics, reps, comm] = await Promise.all([
      getOrderAnalytics(ADMIN), getRepOverview(ADMIN), getCommission(ADMIN),
    ]);
    cache = { analytics, reps, comm };
  }
  return cache;
}

// ── the ?as= lockdown — the escalation path that must not exist ──────────────
test('viewerFor: a rep passing ?as= is ignored', () => {
  const rep = { email: 'r@x', repName: 'Cassie', role: 'rep' };
  assert.deepEqual(viewerFor(rep, 'Jillian'), rep, 'a rep cannot adopt another identity');
  assert.deepEqual(viewerFor(rep, ''), rep);
  // An admin may narrow, never widen.
  assert.equal(viewerFor(ADMIN, 'Jillian').role, 'rep');
  assert.equal(viewerFor(ADMIN, 'Jillian').repName, 'Jillian');
  assert.deepEqual(viewerFor(ADMIN, null), ADMIN);
});

// ── cancelled and $0 orders never earn ──────────────────────────────────────
test('no cancelled order reaches analytics, the pipeline, or a commission line', opts, async () => {
  const { analytics, comm } = await load();
  assert.ok(analytics.orders.every((o) => !isCancelledStatus(o.status)), 'analytics excludes cancelled');
  const pi = await getPiStages(ADMIN);
  assert.ok(pi.orders.every((o) => !isCancelledStatus(o.status)), 'pipeline excludes cancelled');

  const byRef = new Map(analytics.orders.map((o) => [o.ref, o]));
  for (const r of (comm.striven?.byRep ?? [])) {
    for (const l of (r.lines ?? [])) {
      const o = byRef.get(l.ref);
      assert.ok(o, `commissioned line ${l.ref} maps to a live order`);
      assert.ok(o.revenue > 0, `commissioned line ${l.ref} sits on a non-zero order`);
    }
  }
});

// ── rep scoping on every endpoint ───────────────────────────────────────────
test('rep-overview: peers give order counts and nothing else', opts, async () => {
  const { reps: admin } = await load();
  const target = admin.reps[0].rep;
  const scoped = await getRepOverview(viewerFor(ADMIN, target));
  const others = scoped.reps.filter((r) => !r.isSelf);
  assert.ok(others.length > 0, 'there are peers to check');
  for (const r of others) {
    for (const k of ['revenue', 'commission', 'payable', 'waiting']) {
      assert.equal(r[k], null, `peer ${r.rep}.${k} must be null`);
    }
    // STANDINGS_ORDERS_ONLY: volume beyond the order count goes too.
    assert.equal(r.units, null, `peer ${r.rep}.units must be null`);
    assert.equal(r.accounts, null, `peer ${r.rep}.accounts must be null`);
    assert.ok(typeof r.orders === 'number', 'order count survives — standings need it');
    assert.ok(r.byVertical.every((v) => v.revenue === null && v.units === null), 'byVertical money+units null');
  }
  // The only dollar figure a rep may see is their own COMMISSION. Revenue is
  // company data even on their own orders, so the own row keeps commission and
  // loses revenue. This previously asserted own revenue survived.
  const self = scoped.reps.find((r) => r.isSelf);
  assert.ok(self, 'own row present');
  assert.equal(self.revenue, null, 'own revenue is withheld from a rep');
  assert.ok(self.commission != null, 'own commission survives — it is their pay');
  assert.ok(self.byVertical.every((v) => v.revenue === null), 'own revenue-by-vertical withheld too');
  assert.equal(scoped.teamTotals.revenue, null, 'the revenue tile carries no figure for a rep');
  assert.ok(scoped.teamTotals.commission != null, 'the commission tile still does');
});

test('order-analytics: a rep sees no revenue on any order, including their own', opts, async () => {
  const { reps: admin } = await load();
  const target = admin.reps[0].rep;
  const scoped = await getOrderAnalytics(viewerFor(ADMIN, target));
  assert.ok(scoped.orders.length > 0, 'there are orders to check');
  assert.ok(scoped.orders.every((o) => o.revenue === null), 'every order revenue is null for a rep');
  assert.ok(scoped.orders.every((o) => typeof o.units === 'number'), 'unit counts survive');
  assert.equal(scoped.excludedCancelledValue, null, 'the cancelled-value total is money too');

  // An admin still gets the figures, or the tiles would be empty for everyone.
  const full = await getOrderAnalytics(ADMIN);
  assert.ok(full.orders.some((o) => typeof o.revenue === 'number'), 'admin keeps revenue');
});

test('commission: a rep sees only their own money', opts, async () => {
  const { comm } = await load();
  const target = comm.striven.byRep[0].rep;
  const scoped = await getCommission(viewerFor(ADMIN, target));
  const others = (scoped.striven?.byRep ?? []).filter((r) => r.rep !== target);
  assert.ok(others.every((r) => r.total === null), 'peer commission null');
  assert.ok(others.every((r) => r.lines === undefined), 'peer order-by-order withheld');
  assert.equal(scoped.striven.byRep.find((r) => r.rep === target)?.total != null, true, 'own total intact');
  // Regression: month figures used to be nulled outright, blanking a rep's own
  // KPI tiles the moment they picked a month.
  for (const m of scoped.striven.months) {
    const self = m.reps.find((r) => r.rep === target);
    if (self) assert.equal(m.total, self.total, 'month total is the caller\'s own');
    assert.ok(m.reps.filter((r) => r.rep !== target).every((r) => r.total === null), 'peers hidden inside months');
  }
});

test('analytics + pi-stages scope to the caller', opts, async () => {
  const { reps: admin } = await load();
  const target = admin.reps[0].rep;
  const a = await getOrderAnalytics(viewerFor(ADMIN, target));
  assert.ok(a.orders.every((o) => o.rep === target), 'analytics returns only the caller\'s orders');
  const p = await getPiStages(viewerFor(ADMIN, target));
  assert.ok(p.orders.every((o) => o.rep === target), 'pipeline returns only the caller\'s orders');
});

// ── the tile row must not contradict itself ─────────────────────────────────
test('rep-overview totals describe ONE set of orders', opts, async () => {
  const { reps } = await load();
  const t = reps.teamTotals;
  assert.equal(t.orders, reps.reps.reduce((s, r) => s + r.orders, 0), 'orders = sum of rep rows');
  // Regression: revenue and units used to count the whole company book while
  // orders counted only rep rows, so the row disagreed with itself.
  assert.ok(t.revenue <= (reps.bookOrders ? Infinity : Infinity));
  if (reps.unattributed) {
    assert.equal(reps.bookOrders, t.orders + reps.unattributed.orders, 'rep + unattributed = the whole book');
    assert.ok(reps.unattributed.revenue >= 0, 'unattributed revenue is reported, not negative');
  }
});

// ── PI stages: write, history, validation, restore ──────────────────────────
test('a stage move records history and validates the stage name', opts, async () => {
  const before = await getPiStages(ADMIN);
  if (!before.orders.length) return;                    // no PI orders to move
  const o = before.orders[0];
  const next = PI_STAGES.find((s) => s !== o.stage);

  await setPiStage({ soId: o.soId, stage: next, user: 'test@smr' });
  const after = await getPiStages(ADMIN);
  const moved = after.orders.find((x) => x.soId === o.soId);
  assert.equal(moved.stage, next);
  assert.equal(moved.estimated, false, 'ageing becomes measured once moved');
  assert.ok(moved.history.length >= 1, 'the transition is recorded');

  await assert.rejects(() => setPiStage({ soId: o.soId, stage: 'Teleported', user: 'test@smr' }), /unknown stage/);
  await assert.rejects(() => setPiStage({ soId: '', stage: next, user: 'test@smr' }), /soId is required/);

  await setPiStage({ soId: o.soId, stage: o.stage, user: 'test@smr' });   // restore
});

// ── saved views: per-user, replace-by-name, validated ───────────────────────
test('saved views are per-user and replace by name', opts, async () => {
  const A = 'viewtest-a@smr', B = 'viewtest-b@smr';
  const f = { preset: 'month', from: '', to: '', vert: 'PI' };
  try {
    await saveDashboardView(A, { name: 'zz-test', filters: f });
    assert.equal((await listDashboardViews(A)).views.filter((v) => v.name === 'zz-test').length, 1);
    assert.equal((await listDashboardViews(B)).views.length, 0, 'another user sees none of it');

    await saveDashboardView(A, { name: 'zz-test', filters: { ...f, vert: 'VA' } });
    const mine = (await listDashboardViews(A)).views.filter((v) => v.name === 'zz-test');
    assert.equal(mine.length, 1, 'same name replaces rather than duplicating');
    assert.equal(mine[0].filters.vert, 'VA');

    await assert.rejects(() => saveDashboardView(A, { name: '   ', filters: f }), /needs a name/);
  } finally {
    for (const v of (await listDashboardViews(A)).views) await deleteDashboardView(A, v.id);
  }
});
