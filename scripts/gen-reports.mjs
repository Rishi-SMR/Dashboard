// Build two aggregation reports into Supabase striven_cache (cancelled excluded):
//   report_vendor_items  — per vendor, what items we buy (from POs)
//   report_patient_items — per patient, what they order (from SOs), ranked by #SOs
// Line-item data comes from Striven detail calls (a few minutes, one-off / periodic).
// Run: node scripts/gen-reports.mjs
import fs from 'node:fs';
for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const S = await import('../api/_striven.js');
const { striven, sbCacheRead, sbCacheWrite } = S;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isCancelled = (s) => /cancel|void|denied|reject|lost|fail/i.test(String(s || ''));
const isDemo = (s) => /\bdemo\b|\btest\b/i.test(String(s || ''));

const soList = (await sbCacheRead('so'))?.data || [];
const soDet = (await sbCacheRead('so_detail'))?.data || {};
const poList = (await sbCacheRead('po'))?.data || [];

// ── Patients ← Sales Orders ────────────────────────────────────────────────
const patients = new Map();
let soDone = 0, soSkip = 0;
for (const so of soList) {
  const meta = soDet[so.id] || {};
  if (isCancelled(meta.status) || isDemo(meta.type) || isDemo(meta.status)) { soSkip++; continue; }
  let d; try { d = await striven('GET', `/v1/sales-orders/${so.id}`); } catch { continue; }
  const name = d.customer?.name || '(no customer)';
  if (isDemo(name)) { soSkip++; continue; }
  const p = patients.get(name) || { patient: name, soCount: 0, totalValue: 0, items: new Map() };
  p.soCount += 1;
  for (const li of (d.lineItems || [])) {
    const item = li.item?.name; if (!item) continue;
    const qty = Number(li.qty ?? li.quantity ?? 0);
    const val = round2(qty * Number(li.price ?? 0) + Number(li.shippingPrice ?? 0));
    p.totalValue = round2(p.totalValue + val);
    const it = p.items.get(item) || { item, qty: 0, value: 0, soCount: 0 };
    it.qty += qty; it.value = round2(it.value + val); it.soCount += 1; p.items.set(item, it);
  }
  patients.set(name, p);
  if (++soDone % 25 === 0) console.log(`  SOs ${soDone} done…`);
}
const patientReport = [...patients.values()]
  .map((p) => ({ patient: p.patient, soCount: p.soCount, totalValue: p.totalValue, items: [...p.items.values()].sort((a, b) => b.qty - a.qty) }))
  .sort((a, b) => b.soCount - a.soCount || b.totalValue - a.totalValue);

// ── Vendors ← Purchase Orders ──────────────────────────────────────────────
const vendors = new Map();
let poDone = 0, poSkip = 0;
for (const po of poList) {
  let d; try { d = await striven('GET', `/v1/purchase-orders/${po.id}`); } catch { continue; }
  if (isCancelled(d.status?.name)) { poSkip++; continue; }
  const name = d.vendor?.name || '(no vendor)';
  const v = vendors.get(name) || { vendor: name, poCount: 0, totalCost: 0, items: new Map() };
  v.poCount += 1;
  for (const li of (d.lineItems || [])) {
    const item = li.item?.name; if (!item) continue;
    const qty = Number(li.qty ?? li.quantity ?? 0);
    const cost = round2(qty * Number(li.unitCost ?? li.price ?? li.unitPrice ?? 0));
    v.totalCost = round2(v.totalCost + cost);
    const it = v.items.get(item) || { item, qty: 0, cost: 0, poCount: 0 };
    it.qty += qty; it.cost = round2(it.cost + cost); it.poCount += 1; v.items.set(item, it);
  }
  vendors.set(name, v);
  if (++poDone % 25 === 0) console.log(`  POs ${poDone} done…`);
}
const vendorReport = [...vendors.values()]
  .map((v) => ({ vendor: v.vendor, poCount: v.poCount, totalCost: v.totalCost, items: [...v.items.values()].sort((a, b) => b.cost - a.cost) }))
  .sort((a, b) => b.totalCost - a.totalCost || b.poCount - a.poCount);

const stamp = new Date().toISOString();
await sbCacheWrite('report_patient_items', { patients: patientReport, count: patientReport.length, generatedAt: stamp, note: 'Cancelled and demo/test orders excluded.' });
await sbCacheWrite('report_vendor_items', { vendors: vendorReport, count: vendorReport.length, generatedAt: stamp, note: 'Cancelled POs excluded.' });

console.log(`\nDONE — patients: ${patientReport.length} (${soDone} SOs, ${soSkip} skipped) · vendors: ${vendorReport.length} (${poDone} POs, ${poSkip} skipped)`);
