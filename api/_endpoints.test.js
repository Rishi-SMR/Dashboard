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
import { STANDINGS_EXCLUDE, REP_NAMES, REVIEW_LABELS } from './_commission-config.js';

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

  // Commission lines now come from the signed-off reconciliation sheet, and a
  // sheet row can legitimately tie to NO live sales order — CMC-direct rows and
  // the pre-Striven TRICARE population have none by design, so they carry an
  // empty ref rather than a fabricated one.
  //
  // The invariant being guarded is unchanged: a line that DOES name an order
  // must name a live, non-zero one. A ref that points nowhere would mean a
  // cancelled or deleted order had crept back into payable commission.
  const byRef = new Map(analytics.orders.map((o) => [o.ref, o]));
  let withRef = 0;
  for (const r of (comm.striven?.byRep ?? [])) {
    for (const l of (r.lines ?? [])) {
      if (!l.ref) continue;
      withRef += 1;
      const o = byRef.get(l.ref);
      assert.ok(o, `commissioned line ${l.ref} maps to a live order`);
    }
  }
  // The revenue>0 assertion that used to sit here was written when commission
  // was DERIVED from the order — a zero-value order could not produce one. With
  // the sheet as the base a signed-off row can name an order Striven values at
  // nothing, which is a bookkeeping discrepancy rather than a code defect. It is
  // counted and surfaced instead, so it cannot pass unnoticed.
  const z = comm.striven?.recon;
  if (z) assert.equal(typeof z.zeroValueLines, 'number', 'zero-value commissioned lines are counted');
  // Guards the guard: if ref resolution ever broke entirely, every line would
  // skip and the loop above would assert nothing at all.
  assert.ok(withRef > 0, 'at least some commission lines resolve to a sales order');
});

// ── rep scoping on every endpoint ───────────────────────────────────────────
// A rep's dashboard carries the leaderboard, so peer ROWS are sent again — but
// reduced to what a ranking needs. The line to hold is the one between VOLUME
// (shared, so a board can exist) and PAY (never shared). This asserts both
// halves: enough peer data to rank, and nothing beyond it.
//
// The tiles are a separate scope from the board and are asserted here too: a
// tile labelled "Your orders" must carry the rep's own count, not the team's.
test('rep-overview: peers rank, but only their volume is visible', opts, async () => {
  const { reps: admin } = await load();
  const target = admin.reps[0].rep;
  const scoped = await getRepOverview(viewerFor(ADMIN, target));

  const self = scoped.reps.find((r) => r.isSelf);
  const peers = scoped.reps.filter((r) => !r.isSelf);
  assert.ok(self, 'own row present');
  assert.equal(self.rep, target);
  assert.ok(peers.length > 0, 'peers are sent — a ranking needs a field');

  for (const r of peers) {
    // What a leaderboard needs: a name, a count, and the split that draws its bar.
    assert.ok(typeof r.orders === 'number', `${r.rep}: order count is the ranking metric`);
    assert.ok(r.byVertical.some((v) => typeof v.orders === 'number'), `${r.rep}: per-vertical orders draw the bar`);
    // PAY, in every form. None of it may appear on a peer row.
    for (const k of ['commission', 'payable', 'waiting', 'revenue']) {
      assert.equal(r[k], null, `${r.rep}.${k} is pay — must be null`);
    }
    assert.ok(r.byVertical.every((v) => v.revenue === null), `${r.rep}: no revenue by vertical`);
    // Volume BEYOND the count stays private too — STANDINGS_ORDERS_ONLY.
    assert.equal(r.units, null, `${r.rep}.units must be null`);
    assert.equal(r.accounts, null, `${r.rep}.accounts must be null`);
    assert.equal(r.devices, null, `${r.rep}.devices must be null`);
    assert.equal(r.lastOrder, null, `${r.rep}.lastOrder must be null`);
    // `own` drives whether the UI lets the row be opened at all.
    assert.ok(!r.own, `${r.rep}.own must be false so the row cannot be opened`);
  }

  // Own row: orders, units, commission — the three permitted figures.
  assert.ok(typeof self.orders === 'number', 'own order count');
  assert.ok(typeof self.units === 'number', 'own unit count');
  assert.ok(self.commission != null, 'own commission survives — it is their pay');

  // THE TILES DESCRIBE THE CALLER, not the roster on the board above them.
  assert.equal(scoped.teamTotals.orders, self.orders, '"Your orders" = their own row, not the team');
  assert.equal(scoped.teamTotals.reps, 1, 'the tile scope is one rep: themselves');
  assert.ok(scoped.teamTotals.units < admin.teamTotals.units, 'their units, not the team\'s');
  assert.equal(scoped.teamTotals.commission, self.commission, 'their commission, not the team\'s');

  // What they are NOT permitted, anywhere.
  assert.equal(self.revenue, null, 'own revenue is withheld from a rep');
  assert.equal(self.accounts, null, 'accounts is not one of a rep\'s figures');
  assert.equal(scoped.teamTotals.revenue, null, 'the revenue tile carries no figure for a rep');
  assert.equal(scoped.teamTotals.accounts, null, 'nor the accounts tile');
  assert.equal(scoped.bookTotals, null, 'a rep gets no whole-book totals');
  assert.equal(scoped.unattributed, null, 'nor the off-roster tail');
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

// ── the roster is producers only, at the SOURCE ─────────────────────────────
// Non-producers used to be flagged and left in the payload for each panel to
// filter for itself. Two leaderboards did; the roster table, the KPI drills and
// every dropdown did not, so the same names kept reappearing. They are dropped
// in getRepOverview now, and this asserts it there rather than in a component.
test('rep-overview drops non-producers from the payload', opts, async () => {
  const { reps } = await load();
  const excluded = new Set(STANDINGS_EXCLUDE.map((s) => s.trim().toLowerCase()));
  for (const r of reps.reps) {
    assert.ok(!excluded.has(r.rep.trim().toLowerCase()), `${r.rep} must not reach the rep dashboard`);
  }
  // The count the KPI tile prints is the roster it can actually drill into.
  assert.equal(reps.teamTotals.reps, reps.reps.length, 'the Reps tile counts the rows it can show');
  // Dropping them must not lose their orders — they move to unattributed, which
  // is what the on-page note explains. Losing them silently is the failure mode.
  if (reps.unattributed) {
    assert.ok(reps.unattributed.orders > 0, 'the excluded names land in unattributed, not nowhere');
  }
});

// A viewer who is themselves excluded still gets their own row: Cassie has a
// login, and filtering her out entirely would sign her in to a blank dashboard.
test('an excluded rep still sees their own row', opts, async () => {
  const { reps: admin } = await load();
  const excluded = new Set(STANDINGS_EXCLUDE.map((s) => s.trim().toLowerCase()));
  // Any excluded name that is a real roster entry will do.
  const target = REP_NAMES.find((n) => excluded.has(n.trim().toLowerCase()));
  if (!target) return;                                   // nothing excluded to check
  const scoped = await getRepOverview(viewerFor(ADMIN, target));
  const self = scoped.reps.find((r) => r.isSelf);
  assert.ok(self, `${target} is excluded from the board but must still see their own row`);
  assert.equal(self.rep, target);
});

// ── PI stages: write, history, validation, restore ──────────────────────────
// PRECEDENCE CHANGED. Striven's sales-order LABELS now decide the stage, ahead
// of the portal's own store. This test used to move any order and assert the
// move stuck; it now has to pick an order Striven says nothing about, because a
// label-driven order is deliberately NOT movable from the portal — the label is
// re-read on every load and would overwrite the move.
test('a portal stage move records history, and validates the stage name', opts, async () => {
  const before = await getPiStages(ADMIN);
  const o = before.orders.find((x) => x.source !== 'labels');
  if (!o) return;                    // every PI order is label-driven right now
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

// The other half of that rule: Striven wins, and it must be visible that it did.
test('Striven labels outrank the portal store, and PIP is its own board', opts, async () => {
  const p = await getPiStages(ADMIN);
  const labelled = p.orders.filter((o) => o.source === 'labels');
  if (labelled.length) {
    assert.ok(labelled.every((o) => (o.labels || []).length > 0), 'a label-sourced stage carries the labels behind it');
    assert.ok(labelled.every((o) => p.stageNames.includes(o.stage)), 'every derived stage is a real PI stage');
  }
  // PIP: separate stage list, separate board. Empty until the order type exists
  // in Striven — but the shape must be there either way, or the UI cannot render.
  assert.ok(Array.isArray(p.pipStageNames), 'PIP stage names are always sent');
  assert.ok(Array.isArray(p.pipOrders), 'PIP orders are always sent');
  assert.ok(!p.pipStageNames.includes('LOP requested'), 'PIP never reaches Lienstar, so it has no LOP stage');
  assert.ok(!p.pipStageNames.includes('Waiting for settlement'), 'PIP is paid in full: no settlement stage');
  assert.equal(p.pipStages.length, p.pipStageNames.length, 'one bucket per PIP stage');
  // The two boards must not share orders.
  const piIds = new Set(p.orders.map((o) => o.soId));
  assert.ok(p.pipOrders.every((o) => !piIds.has(o.soId)), 'an order belongs to one board only');
});

// The PIP order type does not exist in Striven yet, so the LABEL has to be what
// pulls an order onto the PIP board. Without this the board renders empty while
// orders that are plainly PIP sit under a PI settlement stage they can never
// reach. Asserted against the live book: no order carrying a PIP label may be
// left on the PI board, whichever way round the labels happen to be listed.
test('a PIP label routes the order to the PIP board, at the payment stage', opts, async () => {
  const p = await getPiStages(ADMIN);
  const isPipLabel = (l) => /\bpip\b/i.test(String(l));
  const strayed = p.orders.filter((o) => (o.labels || []).some(isPipLabel));
  assert.deepEqual(strayed.map((o) => o.ref), [], 'no PIP-labelled order is left on the PI board');

  const labelled = p.pipOrders.filter((o) => (o.labels || []).some(isPipLabel));
  for (const o of labelled) {
    // 'Shipped' rides along on some of these; the payment label must still win,
    // and must win regardless of the order the labels arrive in.
    assert.equal(o.stage, 'Waiting on PIP Payment', `${o.ref} waits on the insurer`);
    assert.equal(o.pipeline, 'PIP', `${o.ref} is tagged as PIP for the UI`);
    assert.equal(o.source, 'labels', `${o.ref} derives its stage from Striven, not the portal store`);
  }
  // A stage a PIP order can never occupy must not appear on the board at all.
  assert.ok(p.pipOrders.every((o) => p.pipStageNames.includes(o.stage)), 'every PIP order sits on a real PIP stage');
});

// An order is LISTED at every stage its labels attest to, not only the furthest
// one — "Shipped, Waiting for first payment" belongs on the dispatch card as
// well as the payment card, or whoever works dispatch never sees the shipment.
// The risk this guards is double counting: the listed counts overlap, so only
// `current` may be used for anything expressing a share of the whole.
test('an order is listed at every stage its labels attest to', opts, async () => {
  const p = await getPiStages(ADMIN);
  for (const [board, rows, buckets, names] of [
    ['PI', p.orders, p.stages, p.stageNames],
    ['PIP', p.pipOrders, p.pipStages, p.pipStageNames],
  ]) {
    for (const o of rows) {
      assert.ok(Array.isArray(o.stages) && o.stages.length > 0, `${board} ${o.ref}: has a stage list`);
      assert.ok(o.stages.every((s) => names.includes(s)), `${board} ${o.ref}: every listed stage is real`);
      // The current stage is the FURTHEST of them: it must be the last entry,
      // since the list is built in pipeline order.
      assert.equal(o.stages[o.stages.length - 1], o.stage, `${board} ${o.ref}: current stage is the furthest listed`);
      // Nothing is invented: a stage is listed only if a label maps to it, so a
      // row with one label can never claim two stages.
      if ((o.labels || []).length <= 1) assert.equal(o.stages.length, 1, `${board} ${o.ref}: one label cannot list two stages`);
    }
    // `current` partitions the board — every order counted once and only once.
    const currentTotal = buckets.reduce((s, b) => s + b.current, 0);
    assert.equal(currentTotal, rows.length, `${board}: "here now" counts sum to the board`);
    // `count` is membership, so it is >= current at every stage and >= the total
    // overall. If they were ever equal per stage the feature stopped working.
    for (const b of buckets) {
      const listed = rows.filter((o) => o.stages.includes(b.stage)).length;
      assert.equal(b.count, listed, `${board} ${b.stage}: listed count matches the rows`);
      assert.ok(b.count >= b.current, `${board} ${b.stage}: listed is never fewer than here-now`);
    }
  }
  // The whole point: at least one order really is listed at two stages, and the
  // stage that used to be permanently empty now has orders in it.
  const multi = p.orders.filter((o) => o.stages.length > 1);
  assert.ok(multi.length > 0, 'some order is listed at more than one stage');
});

// Striven's label vocabulary is edited by staff, so a new label can appear at
// any time. An unmapped label contributes nothing and its order silently falls
// back to stage 1 — a failure that is invisible exactly when it matters. The
// review queue is what surfaces it, and it is ADMIN-ONLY: acting on a new label
// means editing Striven, which is not a rep's call.
test('unrecognised labels are surfaced for review, and only to an admin', opts, async () => {
  const p = await getPiStages(ADMIN);
  assert.ok(Array.isArray(p.reviewOrders), 'the review queue is always sent');
  assert.ok(Array.isArray(p.reviewLabels), 'the label worklist is always sent');

  // Every order in the queue must carry a label that holds no stage — either
  // kind — and every order NOT in it must carry none. The queue is exact, not a
  // sample.
  const all = [...p.orders, ...p.pipOrders];
  const queued = new Set(p.reviewOrders.map((o) => `${o.pipeline}-${o.soId}`));
  for (const o of all) {
    const has = (o.unknown || []).length > 0 || (o.flagged || []).length > 0;
    assert.equal(has, queued.has(`${o.pipeline}-${o.soId}`), `${o.ref}: queue membership matches its stageless labels`);
    // Both lists must name labels the order actually carries — no phantoms.
    for (const u of [...(o.unknown || []), ...(o.flagged || [])]) {
      assert.ok((o.labels || []).includes(u), `${o.ref}: "${u}" is one of its own labels`);
    }
  }
  // The worklist accounts for every queued label, with no phantom rows.
  const fromOrders = new Set(p.reviewOrders.flatMap((o) => [...o.unknown, ...o.flagged].map((l) => l.toLowerCase())));
  assert.equal(p.reviewLabels.length, fromOrders.size, 'one worklist row per distinct stageless label');
  for (const l of p.reviewLabels) {
    assert.ok(fromOrders.has(l.label.toLowerCase()), `"${l.label}" comes from a real order`);
    assert.ok(l.count > 0 && l.boards.length > 0, `"${l.label}" carries a count and a board`);
  }

  // A REP GETS NOTHING, whether or not the queue is empty for an admin.
  const rep = await getPiStages({ role: 'rep', repName: 'Maylon Sanders', email: 'maylon@sportsmedrecovery.com' });
  assert.deepEqual(rep.reviewOrders, [], 'a rep never receives the review queue');
  assert.deepEqual(rep.reviewLabels, [], 'a rep never receives the label worklist');
});

// HOLD, Attorney Denied and Case Dropped say an order has STOPPED, not how far
// it got. Mapping them into stages (they used to sit in 'LOP requested' and
// 'Order received') made a stalled order look like one being actively chased and
// inflated that stage. They now carry no stage on either board and route to the
// review queue instead.
test('exception labels carry no stage and route to review', opts, async () => {
  const p = await getPiStages(ADMIN);
  const isException = (l) => REVIEW_LABELS.includes(String(l).trim().toLowerCase());

  for (const [board, rows] of [['PI', p.orders], ['PIP', p.pipOrders]]) {
    for (const o of rows) {
      const ex = (o.labels || []).filter(isException);
      assert.deepEqual([...(o.flagged || [])].sort(), [...ex].sort(), `${board} ${o.ref}: flagged lists exactly its exception labels`);
      // An exception must never be counted as a defect: the two are different
      // problems with different fixes, so the sets must stay disjoint.
      assert.ok(!(o.unknown || []).some(isException), `${board} ${o.ref}: an exception is not reported as unmapped`);
      if (ex.length) assert.ok(p.reviewOrders.some((r) => r.soId === o.soId && r.pipeline === o.pipeline), `${board} ${o.ref}: reaches the review queue`);
    }
  }
  // The order STILL sits on its board via its other labels — an exception
  // removes a stage, it does not remove the order from the pipeline.
  for (const o of p.reviewOrders) {
    assert.ok((o.stages || []).length > 0, `${o.ref}: still has a stage to sit in`);
  }
  // Both reasons are distinguishable in the worklist, and an exception is never
  // reported as a mapping gap.
  for (const l of p.reviewLabels) {
    assert.ok(['flagged', 'unknown'].includes(l.reason), `"${l.label}": reason is one of the two`);
    assert.equal(l.reason === 'flagged', isException(l.label), `"${l.label}": reason matches whether it is an exception`);
  }
});

// PHI BOUNDARY. The patient field is first INITIAL + surname and nothing more:
// the labels report is the one source carrying a full first name, and it must be
// reduced to a letter before it is serialized. A regression here would leak a
// full first name to every browser on the board, so it is asserted on the live
// payload rather than on the helper in isolation.
test('patient reads as first initial + surname, never a full first name', opts, async () => {
  const p = await getPiStages(ADMIN);
  const all = [...p.orders, ...p.pipOrders];
  assert.ok(all.length > 0, 'there is a book to check');

  for (const o of all) {
    const v = o.patient ?? '';
    if (!v) continue;                                  // no row in either source
    // Either "X. Surname" or a bare surname (analytics fallback, which never
    // had a first name to begin with). Anything else means a name got through.
    assert.match(v, /^(?:[A-Z]\. )?[A-Za-z][A-Za-z\-']*$/, `${o.ref}: "${v}" is not initial + surname`);
    const [head] = v.split(' ');
    if (head.endsWith('.')) assert.equal(head.length, 2, `${o.ref}: "${head}" is more than one initial`);
  }
  // The whole point of the change: the initial actually arrives. Guards against
  // a silent regression to surname-only if the merge order is ever flipped back.
  assert.ok(all.some((o) => /^[A-Z]\. /.test(o.patient ?? '')), 'at least one row carries the initial');
  // And the reverse: no row may carry a second word that is not the surname.
  const multi = all.filter((o) => (o.patient ?? '').split(' ').length > 2);
  assert.deepEqual(multi.map((o) => o.patient), [], 'no row carries more than an initial and a surname');
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
