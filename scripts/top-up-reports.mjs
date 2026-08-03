/**
 * Fills in device line items for orders that have none.
 *
 * `report_patient_items` carries the per-order device lines that every device,
 * unit and commission figure depends on. It is rebuilt only by
 * scripts/gen-reports.mjs, which re-reads EVERY order and takes minutes — so in
 * practice it goes stale, and new orders show a blank Devices column with "—"
 * while their revenue and counts appear normally.
 *
 * This does the incremental part: only orders present in `so` but absent from
 * the report. It mirrors gen-reports.mjs's extraction exactly, including the
 * HIPAA rules — last name only, patients keyed as PT-<id>, no first names, no
 * addresses.
 *
 * It does NOT replace gen-reports.mjs: that also rebuilds report_vendor_items
 * and recomputes every patient aggregate from scratch. Run the full generator
 * after bulk edits in Striven.
 *
 * Run: node scripts/top-up-reports.mjs
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { striven, sbCacheRead, sbCacheWrite } = await import('../api/_striven.js');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isCancelled = (s) => /cancel|void|denied|reject|lost|fail/i.test(String(s || ''));
const isDemo = (s) => /\bdemo\b|\btest\b/i.test(String(s || ''));

// HIPAA: minimum necessary. Last name only — never the first name, DOB or address.
const lastNameOnly = (name) => {
  const v = String(name ?? '').trim();
  if (!v) return '';
  if (v.includes(',')) return v.split(',')[0].trim();
  const parts = v.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
};
const refOf = (d) => String(d?.orderNumber ?? d?.number ?? d?.referenceNumber ?? '').trim();
const progOf = (t) => {
  const s = String(t?.name ?? t ?? '').toLowerCase();
  if (/tri.?care/.test(s)) return 'TriCare';
  if (/\bva\b|veteran/.test(s)) return 'VA';
  if (/\bpi\b|personal injury/.test(s)) return 'PI';
  return 'Other';
};

const blob = (await sbCacheRead('report_patient_items'))?.data;
if (!blob) {
  console.error('report_patient_items is empty — run the full generator first: node scripts/gen-reports.mjs');
  process.exit(1);
}
const orders = blob.orders || [];
const patients = blob.patients || [];

const soList = (await sbCacheRead('so'))?.data || [];
const soDet = (await sbCacheRead('so_detail'))?.data || {};
const have = new Set(orders.map((o) => String(o.soId)));

const todo = [];
let skippedDemo = 0, skippedCancelled = 0;
for (const so of soList) {
  const meta = soDet[so.id] || {};
  if (have.has(String(so.id))) continue;
  if (isCancelled(meta.status)) { skippedCancelled++; continue; }
  // DEMO orders are excluded from this report by the same rule the full
  // generator applies, so they will never carry device lines. They still count
  // in the order book — see the DEMO note in _striven.js.
  if (isDemo(meta.type) || isDemo(meta.status)) { skippedDemo++; continue; }
  todo.push(so);
}

console.log(`orders in report      : ${orders.length}`);
console.log(`missing, to fetch     : ${todo.length}`);
console.log(`skipped (DEMO)        : ${skippedDemo}`);
console.log(`skipped (cancelled)   : ${skippedCancelled}\n`);

if (!todo.length) {
  console.log('Nothing to do — every live order already has its device lines.');
  process.exit(0);
}

const byRef = new Map(patients.map((p) => [p.ref, p]));
let added = 0, failed = 0, itemsAdded = 0;

for (const so of todo) {
  const meta = soDet[so.id] || {};
  let d = null;
  for (let attempt = 0; attempt < 3 && !d; attempt++) {
    try { d = await striven('GET', `/v1/sales-orders/${so.id}`); } catch { /* retry */ }
  }
  if (!d) {
    failed++;
    console.log(`  FAIL  SO ${so.id} — detail unavailable after 3 attempts`);
    continue;
  }
  // A demo customer name is used only to filter the row out; it is never stored.
  if (isDemo(d.customer?.name)) { skippedDemo++; continue; }

  const custRef = d.customer?.id ? `PT-${d.customer.id}` : '(unassigned)';
  const p = byRef.get(custRef) || { ref: custRef, soCount: 0, totalValue: 0, items: [] };
  const itemMap = new Map((p.items || []).map((i) => [i.item, { ...i }]));

  const soItems = [];
  let soValue = 0;
  for (const li of (d.lineItems || [])) {
    const item = li.item?.name;
    if (!item) continue;
    const qty = Number(li.qty ?? li.quantity ?? 0);
    const val = round2(qty * Number(li.price ?? 0) + Number(li.shippingPrice ?? 0));
    soValue = round2(soValue + val);
    const it = itemMap.get(item) || { item, qty: 0, value: 0, soCount: 0 };
    it.qty += qty; it.value = round2(it.value + val); it.soCount += 1;
    itemMap.set(item, it);
    soItems.push({ item, qty, value: val });
    itemsAdded++;
  }

  p.soCount += 1;
  p.totalValue = round2(p.totalValue + soValue);
  p.items = [...itemMap.values()].sort((a, b) => b.qty - a.qty);
  byRef.set(custRef, p);

  orders.push({
    soId: so.id, so: `SO-${so.id}`, ref: refOf(d), custRef,
    lastName: lastNameOnly(d.customer?.name), program: progOf(d.type),
    date: (d.dateCreated ?? so.dateCreated ?? null), value: soValue, items: soItems,
  });
  added++;
  console.log(`  ok    SO ${String(so.id).padEnd(5)} ${String(meta.type).padEnd(10)} ${soItems.length} device line(s)`);
}

orders.sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }) || a.soId - b.soId);
const patientReport = [...byRef.values()].sort((a, b) => b.soCount - a.soCount || b.totalValue - a.totalValue);

await sbCacheWrite('report_patient_items', {
  ...blob,
  patients: patientReport,
  orders,
  count: patientReport.length,
  orderCount: orders.length,
});

console.log(`\nadded ${added} order(s), ${itemsAdded} device line(s); ${failed} failed`);
console.log(`report now holds ${orders.length} orders across ${patientReport.length} patients`);
if (failed) process.exit(1);
