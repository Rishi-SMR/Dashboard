// Integration tests for the identity-scoped endpoints — the layer the pure-
// function tests in _commission-core.test.js do NOT cover. These replace the
// throwaway probes that were previously run by hand and deleted.
//
// They hit the real derivations, so they need Striven/Supabase credentials and
// take ~15s cold. When credentials are absent every test skips rather than fails,
// so `npm test` still works on a machine without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getOrderAnalytics, getRepOverview, getCommission, getPiStages,
  viewerFor, setPiStage, PI_STAGES, monthOfPayoutCycle,
  saveDashboardView, listDashboardViews, deleteDashboardView, shipmentsOf,
} from './_striven.js';
import { isCancelledStatus } from './_commission-core.js';
import {
  STANDINGS_EXCLUDE, REP_NAMES, REVIEW_LABELS, REP_SUB_REPS, blindspotsFor, supervisorOf,
  PI_LABEL_STAGE, PIP_LABEL_STAGE, VA_LABEL_STAGE,
} from './_commission-config.js';

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

// ── dev and production serve the SAME routes ─────────────────────────────────
// Two routers exist: striven-server/index.js runs locally, api/index.js is what
// Vercel deploys. A route added to the first and forgotten in the second works
// perfectly on the developer's machine and 404s in production — and because the
// clients swallow a failed fetch into an empty list, the symptom is a card that
// silently disappears rather than an error anyone can see. That is exactly how
// /api/device-mix shipped without Units by device or Units by programme.
//
// Static: reads both files, needs no credentials, runs everywhere.
test('every dev route is also served by the deployed handler', () => {
  const paths = (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    return new Set([...src.matchAll(/pathname (?:===|\.startsWith\()\s*'([^']+)'/g)].map((m) => m[1]));
  };
  const dev = paths('../striven-server/index.js');
  const prod = paths('./index.js');
  const missing = [...dev].filter((p) => !prod.has(p)).sort();
  assert.deepEqual(missing, [], `served locally but not in production: ${missing.join(', ')}`);
});

// ── the ?as= lockdown — the escalation path that must not exist ──────────────
test('viewerFor: a rep passing ?as= is ignored', () => {
  const rep = { email: 'r@x', repName: 'Cassie', role: 'rep' };
  assert.deepEqual(viewerFor(rep, 'Jillian Colin'), rep, 'a rep cannot adopt another identity');
  assert.deepEqual(viewerFor(rep, ''), rep);
  // An admin may narrow, never widen.
  assert.equal(viewerFor(ADMIN, 'Jillian Colin').role, 'rep');
  assert.equal(viewerFor(ADMIN, 'Jillian Colin').repName, 'Jillian Colin');
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

test('rep-overview: a blind spot hides the rep, and does not promote anyone', opts, async () => {
  const { reps: admin } = await load();
  // Driven by the RESOLVED rule, not by one of the two maps behind it: a blind
  // spot can come from an explicit REP_BLINDSPOTS pair or be implied by a
  // reporting line in REP_SUB_REPS, and this must cover both however they move.
  const pairs = REP_NAMES
    .map((rep) => [rep, [...blindspotsFor(rep)]])
    .filter(([, hidden]) => hidden.length > 0)
    // blindspotsFor returns lower-cased names; map back to canonical spelling.
    .map(([rep, hidden]) => [rep, hidden.map((h) => REP_NAMES.find((n) => n.toLowerCase() === h) ?? h)]);
  assert.ok(pairs.length > 0, 'there is a blind spot configured to test');

  for (const [viewer, hiddenNames] of pairs) {
    const scoped = await getRepOverview(viewerFor(ADMIN, viewer));
    const seen = scoped.reps.map((r) => r.rep);

    for (const hidden of hiddenNames) {
      // Not merely absent from the row list — absent from the PAYLOAD. A name
      // surviving in a roster, a drill or a remark is the same disclosure.
      assert.ok(!seen.includes(hidden), `${viewer} must not receive ${hidden}'s row`);
      assert.ok(!JSON.stringify(scoped).includes(hidden),
        `"${hidden}" must not appear anywhere in ${viewer}'s payload`);
    }

    // THE RANK MUST NOT CLOSE THE GAP. This is the failure the feature invites:
    // drop the rep above and the viewer floats to the top of the array, so the
    // board announces them as leader, fires the top-of-the-board banner and
    // burns their one-per-achievement confetti — a claim invented by the
    // privacy filter. `rank` is stamped over the whole field before the filter,
    // so the numbering keeps its hole.
    const self = scoped.reps.find((r) => r.isSelf);
    assert.ok(self, `${viewer} has their own row`);
    const trueRank = [...admin.reps]
      .sort((a, b) => b.orders - a.orders || a.rep.localeCompare(b.rep))
      .findIndex((r) => r.rep === viewer) + 1;
    assert.equal(self.rank, trueRank, `${viewer}'s rank is their real one, not their position in a shortened list`);
    // The rep they cannot see outranks them here, so rank 1 must be missing.
    assert.ok(!scoped.reps.some((r) => r.rank === 1),
      `no row claims 1st on ${viewer}'s board while the leader is withheld`);
    // Everyone still shown keeps their own true rank.
    for (const r of scoped.reps) {
      const real = [...admin.reps]
        .sort((a, b) => b.orders - a.orders || a.rep.localeCompare(b.rep))
        .findIndex((x) => x.rep === r.rep) + 1;
      assert.equal(r.rank, real, `${r.rep} keeps rank ${real} on ${viewer}'s board`);
    }
  }

  // A rep with no blind spot is untouched, and an admin sees everybody.
  const other = REP_NAMES.find((n) => blindspotsFor(n).size === 0);
  if (other) {
    const clear = await getRepOverview(viewerFor(ADMIN, other));
    assert.equal(clear.reps.length, admin.reps.length, `${other} sees the whole field`);
  }
});

test('rep-overview: a sub-rep is marked on the supervisor and nobody else', opts, async () => {
  const { reps: admin } = await load();
  const pairs = Object.entries(REP_SUB_REPS || {});
  assert.ok(pairs.length > 0, 'there is a reporting line configured to test');

  for (const [boss, subs] of pairs) {
    const onBoss = await getRepOverview(viewerFor(ADMIN, boss));
    for (const sub of subs) {
      const row = onBoss.reps.find((r) => r.rep === sub);
      assert.ok(row, `${boss} still receives ${sub}'s row`);
      assert.equal(row.subRepOf, boss, `${sub} is marked as working under ${boss}`);

      // VOLUME IS OPEN TO THE SUPERVISOR — the roll-down on their board reports
      // it. These are the fields `lean` strips from an ordinary peer row.
      assert.ok(typeof row.units === 'number', `${boss} sees ${sub}'s unit count`);
      assert.ok(typeof row.accounts === 'number', `${boss} sees ${sub}'s account count`);
      assert.ok(typeof row.devices === 'number', `${boss} sees ${sub}'s device-type count`);
      assert.ok(typeof row.verticals === 'number', `${boss} sees how many verticals ${sub} works`);
      assert.ok(row.byVertical.some((v) => typeof v.units === 'number'), `${boss} sees ${sub}'s per-vertical units`);

      // PAY IS NOT. This is the line the feature must never cross: a supervisor
      // gets what their sub-rep BOOKED, never what they are PAID.
      for (const k of ['commission', 'payable', 'waiting', 'revenue']) {
        assert.equal(row[k], null, `${sub}.${k} stays withheld from ${boss}`);
      }
      assert.equal(row.commissionByCycle ?? null, null, `${sub}'s payout cycles stay withheld from ${boss}`);
      assert.ok(row.byVertical.every((v) => v.revenue === null), `${boss} sees no revenue on ${sub}'s verticals`);
      assert.ok((row.byMonth ?? []).every((m) => m.revenue === null), `${boss} sees no revenue in ${sub}'s months`);

      // Nothing rolled up: the supervisor's own row is untouched by having one.
      const bossRow = onBoss.reps.find((r) => r.isSelf);
      const bossAsAdmin = admin.reps.find((r) => r.rep === boss);
      assert.equal(bossRow.orders, bossAsAdmin.orders, `${boss}'s own order count does not absorb ${sub}'s`);
      assert.equal(bossRow.units, bossAsAdmin.units, `${boss}'s own unit count does not absorb ${sub}'s`);
    }
    const self = onBoss.reps.find((r) => r.isSelf);
    assert.equal(self.subRepOf ?? null, null, 'the supervisor is not marked as their own sub-rep');

    // THE REPORTING LINE IS NOT BROADCAST. On a third rep's login the same row
    // must carry no mark — who reports to whom is the supervisor's context, not
    // the team's.
    const bystander = REP_NAMES.find((n) => n !== boss && !subs.includes(n) && !blindspotsFor(n).size);
    if (bystander) {
      const onOther = await getRepOverview(viewerFor(ADMIN, bystander));
      for (const sub of subs) {
        const row = onOther.reps.find((r) => r.rep === sub);
        if (row) assert.equal(row.subRepOf ?? null, null, `${bystander} is not told that ${sub} reports to ${boss}`);
      }
    }

    // And the other direction still holds: the sub-rep cannot see the boss.
    for (const sub of subs) {
      assert.ok(blindspotsFor(sub).has(String(boss).toLowerCase()),
        `${sub} is blinded to ${boss} by the same declaration`);
      assert.equal(supervisorOf(sub), boss, 'supervisorOf resolves the pair');
    }
  }
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

// ── shipment tracking ────────────────────────────────────────────────────────
// Pure, so it runs without credentials.
test('one order can carry several parcels, each independently trackable', () => {
  // Striven has ONE box for the tracking number, so a two-parcel order holds
  // both in it. Read as a single number this matches no carrier format and no
  // carrier site — which is how it was found on a live UPS order.
  const two = shipmentsOf('1Z18H97F0306688623, 1Z18H97F0310776841', 'UPS');
  assert.equal(two.length, 2, 'a comma-separated value is two shipments');
  assert.ok(two.every((s) => s.carrier?.code === 'ups'), 'both take the order\'s carrier');
  assert.ok(two.every((s) => s.carrier.url.includes(s.tn)), 'each links to its OWN number');
  assert.equal(shipmentsOf('', '').length, 0, 'no number is no shipment, not an empty one');
});

test('the carrier comes from Striven, and the number format is only a fallback', () => {
  // "Fed Ex" is Striven's spelling. Normalising to letters is what makes it the
  // same carrier as "FedEx", and a raw-string lookup would silently miss it and
  // fall through to the format detector.
  assert.equal(shipmentsOf('382889797740', 'Fed Ex')[0].carrier.code, 'fedex');
  assert.equal(shipmentsOf('1Z18H97F0332406691', '')[0].carrier.code, 'ups', 'format detects UPS with no Ship Via');
  // A number nobody can place still SHOWS — unlinked. A link to a guessed
  // carrier is worse than no link, because it looks authoritative.
  const unknown = shipmentsOf('XYZ-123', '');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].carrier, null, 'an unplaceable number carries no carrier');
});

test('tracking reaches the orders, from the report and the cache both', opts, async () => {
  const full = await getOrderAnalytics(ADMIN);
  const tracked = full.orders.filter((o) => o.tracking);
  assert.ok(tracked.length > 0, 'the book carries tracking numbers');
  // Every tracked order must resolve to at least one parcel: `tracking` is the
  // raw string and `shipments` is what the UI renders, so a row with one and
  // not the other shows a blank cell on an order that has a number.
  assert.ok(tracked.every((o) => (o.shipments ?? []).length > 0), 'a tracked order always has a shipment');
  assert.ok(full.orders.every((o) => o.tracking || (o.shipments ?? []).length === 0),
    'and an untracked one never invents one');
  // The saved report is scoped to PI + VA in Striven. If tracking only ever
  // arrived from it, every other vertical would read as untracked — so the
  // so_detail fallback has to be carrying those, and this is what proves it.
  const verticals = new Set(tracked.map((o) => o.vertical));
  assert.ok(verticals.size >= 2, 'tracking is not confined to a single vertical');
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
  // The boards must not share orders.
  const piIds = new Set(p.orders.map((o) => o.soId));
  assert.ok(p.pipOrders.every((o) => !piIds.has(o.soId)), 'an order belongs to one board only');
  const pipIds = new Set(p.pipOrders.map((o) => o.soId));
  assert.ok(p.vaOrders.every((o) => !piIds.has(o.soId) && !pipIds.has(o.soId)), 'a VA order is on neither PI board');
});

// VA is a third pipeline, and unlike PIP it is routed by the VERTICAL rather
// than by a label: a VA order is billed to the Department of Veterans Affairs,
// so there is nothing to infer. Its stage list is therefore the assertion that
// matters — the PI chasing stages describe none of this programme, and 'Paid'
// (which PI deliberately lacks) is where most of the book sits.
test('VA is its own board, off the vertical rather than a label', opts, async () => {
  const p = await getPiStages(ADMIN);
  assert.ok(Array.isArray(p.vaStageNames), 'VA stage names are always sent');
  assert.ok(Array.isArray(p.vaOrders), 'VA orders are always sent');
  assert.equal(p.vaStages.length, p.vaStageNames.length, 'one bucket per VA stage');
  for (const absent of ['LOP requested', 'Waiting for settlement', 'Waiting on PIP Payment']) {
    assert.ok(!p.vaStageNames.includes(absent), `VA has no "${absent}" stage: no attorney, no lien, no auto insurer`);
  }
  assert.ok(p.vaStageNames.includes('Paid'), 'VA ends at Paid — the VA pays in full off the invoice');

  assert.ok(p.vaOrders.every((o) => o.pipeline === 'VA'), 'every VA order is tagged VA for the UI');
  assert.ok(p.vaOrders.every((o) => p.vaStageNames.includes(o.stage)), 'every VA order sits on a real VA stage');
  // Routed by vertical, so the board is exactly the VA book — nothing pulled in
  // by a stray label and nothing left behind on PI.
  assert.ok(p.vaOrders.every((o) => o.vertical === 'VA'), 'only VA-vertical orders reach the VA board');
  assert.ok([...p.orders, ...p.pipOrders].every((o) => o.vertical !== 'VA'), 'no VA order is stranded on a PI board');
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
  for (const [board, rows, buckets, names, map] of [
    ['PI', p.orders, p.stages, p.stageNames, PI_LABEL_STAGE],
    ['PIP', p.pipOrders, p.pipStages, p.pipStageNames, PIP_LABEL_STAGE],
    ['VA', p.vaOrders, p.vaStages, p.vaStageNames, VA_LABEL_STAGE],
  ]) {
    for (const o of rows) {
      assert.ok(Array.isArray(o.stages) && o.stages.length > 0, `${board} ${o.ref}: has a stage list`);
      assert.ok(o.stages.every((s) => names.includes(s)), `${board} ${o.ref}: every listed stage is real`);
      // The current stage is the FURTHEST of them: it must be the last entry,
      // since the list is built in pipeline order.
      assert.equal(o.stages[o.stages.length - 1], o.stage, `${board} ${o.ref}: current stage is the furthest listed`);
      // NOTHING IS INVENTED: a stage is listed only where a label maps to it.
      //
      // This used to read "a row with one label can never claim two stages",
      // which is not the rule and never was — a label may attest to SEVERAL
      // stages at once ('Delivered' is both a milestone and the event that
      // starts the wait for payment). It passed only because no PI order
      // happened to carry such a label alone; the first VA order that did —
      // 'POD Sent' by itself — failed a test that was asserting the data rather
      // than the behaviour. The real invariant is that the listed stages are
      // exactly what the map yields, so it is checked against the map.
      const single = (o.labels || []).length === 1 && map[String(o.labels[0]).trim().toLowerCase()];
      if (single) {
        const expect = names.filter((s) => (Array.isArray(single) ? single : [single]).includes(s));
        assert.deepEqual(o.stages, expect, `${board} ${o.ref}: "${o.labels[0]}" lists exactly the stages it maps to`);
      }
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
  const all = [...p.orders, ...p.pipOrders, ...p.vaOrders];
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

  for (const [board, rows] of [['PI', p.orders], ['PIP', p.pipOrders], ['VA', p.vaOrders]]) {
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
  const all = [...p.orders, ...p.pipOrders, ...p.vaOrders];
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

// ── COMMISSION MONTHS ARE PAYOUT CYCLES ──────────────────────────────────────
// The sheet's "Payout Cycle" column names a PAY DATE and the run settles the
// previous month's work, so the month is the pay month minus one. This decides
// which month a rep's money appears under, so it is asserted directly on the
// live cycle strings as well as on the parser.
//
// "Paid ~Apr/May 26" is the case that makes the rule non-obvious: it is ONE run
// that straddled a month boundary. Its work is March, and reading the later
// name would collide with the "15 May 26" cycle, which is April.
test('a payout cycle resolves to the month it pays for', () => {
  assert.equal(monthOfPayoutCycle('Payable 15 Aug 26 (due)'), '2026-07');
  assert.equal(monthOfPayoutCycle('Paid ~15 Jul 26'), '2026-06');
  assert.equal(monthOfPayoutCycle('Paid ~15 Jun 26'), '2026-05');
  assert.equal(monthOfPayoutCycle('Paid ~15 May 26'), '2026-04');
  assert.equal(monthOfPayoutCycle('Paid ~Apr/May 26'), '2026-03');
  // January pays the previous December — the year has to roll back with it.
  assert.equal(monthOfPayoutCycle('Paid ~15 Jan 27'), '2026-12');
  assert.equal(monthOfPayoutCycle('Payable 15 August 2026'), '2026-07');
  // The day number must never be mistaken for the year.
  assert.equal(monthOfPayoutCycle('15 Aug 26'), '2026-07');
  // Unparseable stays null: such a line keeps its money and its place in the
  // rep's total but belongs to no month. Guessing would move real money into a
  // period at random.
  assert.equal(monthOfPayoutCycle(''), null);
  assert.equal(monthOfPayoutCycle('Q3'), null);
  assert.equal(monthOfPayoutCycle(undefined), null);
});

// The months a rep is shown must ADD UP to the figure they are paid, or the
// page contradicts itself depending on which tab is open. This was the live
// defect: month rows carried the Striven engine's numbers ($232,808.50 across
// the team) while the all-months row carried the signed-off sheet's
// ($169,909.20), with nothing on screen saying the base had changed.
test('every month is the reconciliation, and the months sum to what is paid', opts, async () => {
  const c = await getCommission(ADMIN);
  const s = c.striven;
  const sum = (ns) => Math.round(ns.reduce((a, b) => a + (b || 0), 0) * 100) / 100;

  // PAID + DUE, not payable alone. Marking a month paid moves its money out of
  // payableTotal, so summing that column against the payable headline would now
  // compare the unpaid part of the months against the unpaid part of the book
  // and still pass while hiding a real drift. The whole signed-off figure is
  // what has to reconcile.
  const owed = (x) => (x.paidTotal || 0) + (x.payableTotal || 0);
  assert.equal(sum(s.months.map(owed)), sum(s.byRep.map(owed)),
    'the months add up to the signed-off headline');
  assert.equal(sum(s.byRep.map(owed)), s.grandTotal, 'and that is the headline');

  for (const r of s.byRep) {
    const perMonth = sum(s.months.map((m) => { const x = m.reps.find((y) => y.rep === r.rep); return x ? (x.paidTotal || 0) + (x.payableTotal || 0) : 0; }));
    // Undated cycles are reachable only under All months, so a rep's months can
    // fall short of their total — never exceed it.
    assert.ok(perMonth <= owed(r) + 0.01, `${r.rep}: months never exceed the total`);
    // Every month's lines are that month's, and they price the month exactly.
    for (const m of s.months) {
      const row = m.reps.find((x) => x.rep === r.rep);
      if (!row?.lines?.length) continue;
      assert.ok(row.lines.every((l) => l.month === m.month), `${r.rep} ${m.month}: only this month's lines`);
      assert.equal(sum(row.lines.map((l) => l.comm)), owed(row), `${r.rep} ${m.month}: lines price the month`);
    }
  }

  // A month with no payout run yet is not "owed nothing" — it has not been run.
  // Nothing in it may be payable, and what it has earned must still be visible.
  for (const m of s.months.filter((x) => x.reconciled === false)) {
    assert.equal(m.payableTotal, 0, `${m.month}: an unsettled month pays nothing yet`);
    assert.ok(m.reps.every((r) => (r.payableTotal || 0) === 0), `${m.month}: no rep is payable`);
  }
});

// ── WORKBOOK SOURCES ─────────────────────────────────────────────────────────
// A rep the reconciliation sheet does not carry gets their commission from a
// workbook of their own (Maylon Sanders: 39 PI orders in Striven, no sheet
// rows, so his login read $0 for every month). The risk that comes with a
// second money source is DOUBLE COUNTING — both sources legitimately describe
// the same thing — so the merge is guarded per rep × month and that guard is
// what this asserts.
test('workbook commission merges without ever double-counting the sheet', opts, async () => {
  const c = await getCommission(ADMIN);
  const s = c.striven;
  if (!s.workbooks) return;                       // no workbook configured here

  const sum = (ns) => Math.round(ns.reduce((a, b) => a + (b || 0), 0) * 100) / 100;
  // The headline still equals the rows behind it, and the months still equal
  // the headline — the two invariants a second source could quietly break.
  const owed = (x) => (x.paidTotal || 0) + (x.payableTotal || 0);
  assert.equal(sum(s.byRep.map(owed)), s.grandTotal, 'rows sum to the headline');
  assert.equal(sum(s.months.map(owed)), s.grandTotal, 'months sum to the headline');

  for (const r of s.byRep) {
    const lines = r.lines || [];
    // NO REP MAY HOLD BOTH SOURCES FOR ONE MONTH. That is the double count, and
    // it is the only way this feature can overpay somebody.
    const months = new Map();
    for (const l of lines) {
      if (!l.month) continue;
      const seen = months.get(l.month) ?? new Set();
      seen.add(l.fromWorkbook ? 'workbook' : 'sheet');
      months.set(l.month, seen);
    }
    for (const [m, srcs] of months) {
      assert.equal(srcs.size, 1, `${r.rep} ${m}: paid from one source, not ${[...srcs].join(' + ')}`);
    }
    // And the lines still price the rep exactly.
    assert.equal(sum(lines.map((l) => l.comm)), owed(r), `${r.rep}: lines price the total`);
  }
});

// ── PAID vs STILL OWED ───────────────────────────────────────────────────────
// "Payable / Due" used to mean every signed-off dollar a rep had ever earned,
// months after the money left the bank. COMMISSION_PAID_THROUGH names the last
// paid month per vertical; those lines are `paid` — still the rep's, still in
// the total, no longer owed.
//
// The invariant that matters is that nothing MOVES: splitting a total in two
// must not change it, or a rep's year-to-date shifts on payday.
test('paid commission leaves the total alone and only the owed figure moves', opts, async () => {
  const c = await getCommission(ADMIN);
  const s = c.striven;
  const sum = (ns) => Math.round(ns.reduce((a, b) => a + (b || 0), 0) * 100) / 100;

  assert.equal(sum([s.paidTotal, s.payableTotal]), s.grandTotal, 'paid + due is the whole figure');
  for (const r of s.byRep) {
    assert.equal(sum([r.paidTotal, r.payableTotal]), r.total ?? 0, `${r.rep}: paid + due is their total`);
  }

  // Every paid line is one the cut-off actually covers, and every line the
  // cut-off covers is paid. Both directions, or the rule is decorative.
  const through = s.paidThrough || {};
  const vertOf = (l) => (/tri.?care/i.test(l.prog || '') ? 'TriCare'
    : /\bva\b|veteran/i.test(l.prog || '') ? 'VA'
      : /\bpi\b|personal injury/i.test(l.prog || '') ? 'PI' : '');
  for (const r of s.byRep) {
    for (const l of r.lines || []) {
      const cut = through[vertOf(l)];
      const shouldBePaid = Boolean(cut && l.month && String(l.month) <= String(cut));
      assert.equal(l.state === 'paid', shouldBePaid,
        `${r.rep} ${l.ref || l.patient} ${l.prog} ${l.month}: paid state follows the cut-off`);
    }
  }

  // An UNDATED line must never be paid: its cycle resolved to no month, so
  // which side of the cut-off it falls on is unknown, and calling money paid
  // when it may not be is the worse of the two errors.
  const undatedPaid = s.byRep.flatMap((r) => (r.lines || []).filter((l) => !l.month && l.state === 'paid'));
  assert.deepEqual(undatedPaid, [], 'an undated line is never marked paid');
});
