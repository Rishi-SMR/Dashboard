/**
 * Data-quality sweep — the things audit-consistency.mjs does NOT cover.
 *
 * That script checks the portal agrees with itself. This one checks the portal
 * agrees with Striven, and that nothing is quietly missing: stale caches,
 * orders with no enrichment, orders with no device lines, reps off the roster,
 * devices priced off a fallback rate.
 *
 * Run: node scripts/audit-data.mjs
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const S = await import('../api/_striven.js');
const { REP_NAMES } = await import('../api/_commission-config.js');
const ADMIN = { repName: null, role: 'admin' };

const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const isCancelled = (s) => /cancel|void|denied|reject|lost|fail/i.test(String(s || ''));
const isDemo = (s) => /\bdemo\b|\btest\b/i.test(String(s || ''));

const findings = [];
const ok = (t, d) => findings.push({ level: 'OK', t, d });
const warn = (t, d) => findings.push({ level: 'WARN', t, d });
const bad = (t, d) => findings.push({ level: 'ISSUE', t, d });

// ── 1. Live Striven vs our cache ─────────────────────────────────────────────
const BASE = 'https://api.striven.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let liveCount = null;
try {
  const g = (k) => process.env[k];
  const tk = await (await fetch(`${BASE}/accesstoken`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: g('STRIVEN_CLIENT_ID'), client_secret: g('STRIVEN_CLIENT_SECRET') }),
  })).json();
  const H = { Authorization: `Bearer ${tk.access_token}`, 'User-Agent': UA, 'Content-Type': 'application/json' };
  let all = [], pi = 0;
  for (;;) {
    const j = await (await fetch(`${BASE}/v1/sales-orders/search`, { method: 'POST', headers: H, body: JSON.stringify({ PageIndex: pi, PageSize: 100 }) })).json();
    const d = j.data || j.Data || [];
    all.push(...d);
    if (d.length < 100) break;
    pi++;
  }
  liveCount = all.length;
} catch (e) { warn('Striven live check', `could not reach Striven: ${e.message}`); }

const soList = (await S.sbCacheRead('so'))?.data || [];
const soDet = (await S.sbCacheRead('so_detail'))?.data || {};
const rcHit = await S.sbCacheRead('report_patient_items');
const rc = rcHit?.data?.orders || [];

if (liveCount != null) {
  if (liveCount === soList.length) ok('Striven vs cache', `${liveCount} sales orders, exact match`);
  else bad('Striven vs cache', `Striven has ${liveCount}, our cache has ${soList.length} — run npm run cache:topup-all`);
}

// ── 2. Cache freshness ───────────────────────────────────────────────────────
const health = await S.getCacheHealth();
for (const c of health.caches) {
  const label = `${c.key} (${c.ageHours}h)`;
  if (c.stale) bad('Cache stale', `${label}${c.manualOnly ? ' — manual refresh only' : ''}`);
  else if (c.manualOnly && c.ageHours > 24) warn('Cache ageing', `${label} — manual refresh only`);
  else ok('Cache fresh', label);
}

// ── 3. Enrichment coverage ───────────────────────────────────────────────────
const live = soList.filter((so) => { const d = soDet[so.id]; return d && !isCancelled(d.status); });
const noDetail = soList.filter((so) => !soDet[so.id]);
if (noDetail.length) bad('Missing so_detail', `${noDetail.length} order(s) have no enrichment and vanish from every figure — run npm run cache:topup`);
else ok('so_detail coverage', `all ${soList.length} orders enriched`);

const haveItems = new Set(rc.map((o) => String(o.soId)));
const noItems = live.filter((so) => { const d = soDet[so.id]; return !haveItems.has(String(so.id)) && !isDemo(d.type) && !isDemo(d.status); });
if (noItems.length) bad('Missing device lines', `${noItems.length} live non-DEMO order(s) show no devices — run npm run cache:topup-reports`);
else ok('Device-line coverage', 'every live non-DEMO order has its lines');

const demoNoItems = live.filter((so) => { const d = soDet[so.id]; return !haveItems.has(String(so.id)) && (isDemo(d.type) || isDemo(d.status)); });
if (demoNoItems.length) warn('DEMO devices', `${demoNoItems.length} DEMO order(s) carry no device lines — excluded by gen-reports.mjs by design, so their Devices column stays blank`);

// ── 4. Analytics-level checks ────────────────────────────────────────────────
const an = await S.getOrderAnalytics(ADMIN);
const orders = an.orders || [];

const roster = new Set(REP_NAMES);
const offRoster = orders.filter((o) => !roster.has(o.rep));
if (offRoster.length) warn('Off-roster orders', `${offRoster.length} order(s) booked to ${[...new Set(offRoster.map((o) => o.rep))].join(', ')} — counted in the book, no commission`);

const unclassified = orders.filter((o) => o.vertical === 'Other');
if (unclassified.length) warn('Unclassified vertical', `${unclassified.length} order(s) fall outside PI/VA/TriCare/DEMO/Contract`);
else ok('Vertical coverage', 'every order maps to a known Striven type');

const noPayer = orders.filter((o) => o.account === 'Unassigned');
if (noPayer.length) warn('No payer', `${noPayer.length} order(s) have no billed account (${usd(noPayer.reduce((s, o) => s + o.revenue, 0))})`);

const revNoUnits = orders.filter((o) => o.revenue > 0 && o.units === 0);
if (revNoUnits.length) warn('Revenue without devices', `${revNoUnits.length} order(s) carry value but no device lines (${usd(revNoUnits.reduce((s, o) => s + o.revenue, 0))})`);

const unitsNoRev = orders.filter((o) => o.units > 0 && o.revenue === 0);
if (unitsNoRev.length) warn('Devices without revenue', `${unitsNoRev.length} order(s) ship devices at $0 — no commission is earned on these`);

const undated = orders.filter((o) => !o.date);
if (undated.length) warn('Undated orders', `${undated.length} order(s) have no date — excluded from every period filter, including custom ranges`);
else ok('Dates', 'every order carries a creation date');

// ── 5. Commission coverage ───────────────────────────────────────────────────
const comm = await S.getCommissionFor(ADMIN);
const sv = comm.striven || {};
if (sv.bookOrders && sv.commissionedOrders != null) {
  const gap = sv.bookOrders - sv.commissionedOrders;
  if (gap > 0) warn('Commission coverage', `${sv.commissionedOrders} of ${sv.bookOrders} orders priced — ${gap} earn nothing`);
  else ok('Commission coverage', 'every order priced');
}
if (sv.rateGaps?.length) warn('Fallback rates', `${sv.rateGaps.length} device type(s) priced off the fallback, not COMMISSION_RATES: ${sv.rateGaps.slice(0, 6).join(', ')}${sv.rateGaps.length > 6 ? '…' : ''}`);
if (comm.unmatched?.length) warn('Unmatched orders', `${comm.unmatched.length} report order(s) could not be tied to a sales order (${usd(comm.unmatchedValue || 0)})`);

const zeroRepRows = (sv.byRep || []).filter((r) => (r.orders || 0) > 0 && (r.total || 0) === 0);
if (zeroRepRows.length) warn('Reps earning nothing', `${zeroRepRows.map((r) => `${r.rep} (${r.orders} orders)`).join(', ')}`);

// ── Report ───────────────────────────────────────────────────────────────────
const order = { ISSUE: 0, WARN: 1, OK: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);
console.log('\nDATA QUALITY SWEEP');
console.log('='.repeat(78));
for (const f of findings) console.log(`${f.level.padEnd(6)} ${f.t.padEnd(24)} ${f.d}`);
const issues = findings.filter((f) => f.level === 'ISSUE').length;
const warns = findings.filter((f) => f.level === 'WARN').length;
console.log('='.repeat(78));
console.log(issues === 0
  ? `NO ISSUES. ${warns} item(s) flagged for awareness.`
  : `${issues} ISSUE(S) need action, ${warns} flagged for awareness.`);
process.exit(issues === 0 ? 0 : 1);
