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
// HIPAA: patient NAMES are PHI and are never stored here. Each patient is keyed
// by a reference derived from their Striven customer id (PT-<id>) — traceable
// back inside Striven by authorised staff, but not identifying on its own.
// Minimum-necessary PHI: LAST NAME ONLY (per client SOW, for order matching).
// Full name / first name / DOB / address are never taken. "Last, First" → Last;
// "First Last" → last token.
const lastNameOnly = (name) => {
  const v = String(name ?? '').trim();
  if (!v) return '';
  if (v.includes(',')) return v.split(',')[0].trim();
  const parts = v.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
};
// The shared "patient reference number" (e.g. 273 / 316) that can group multiple
// SOs. Best-effort: it lives in a Striven custom field whose exact name we can't
// see from here, so try the common ones, then any reference/claim/case-looking
// field, then the SO's own referenceNumber. If none, '' (shows as — = unmapped,
// so it's obvious we need the field name confirmed against live data).
const REF_FIELDS = ['Reference', 'Patient Reference', 'Reference #', 'Ref', 'Ref #', 'Claim', 'Claim #', 'Claim Number', 'Case', 'Case #', 'Case Number', 'File #', 'File Number', 'Matter', 'Matter #'];
const refOf = (d) => {
  const cfs = Array.isArray(d?.customFields) ? d.customFields : [];
  for (const name of REF_FIELDS) {
    const f = cfs.find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
    const val = String(f?.valueText ?? '').trim();
    if (val) return val;
  }
  const fuzzy = cfs.find((x) => /reference|claim|case|matter|file\s*#/i.test(String(x.name || '')) && String(x.valueText ?? '').trim());
  if (fuzzy) return String(fuzzy.valueText).trim();
  return String(d?.referenceNumber ?? '').trim();
};
const progOf = (t) => { const s = String(t?.name ?? t ?? '').toLowerCase(); if (/tri.?care/.test(s)) return 'TriCare'; if (/\bva\b|veteran/.test(s)) return 'VA'; if (/\bpi\b|personal injury/.test(s)) return 'PI'; return 'Other'; };
// Retry the detail fetch once — a single transient failure used to silently drop
// the SO (continue), which hid orders from the sequence (e.g. a missing 316).
const soFetch = async (id) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await striven('GET', `/v1/sales-orders/${id}`); } catch { /* retry */ }
  }
  return null;
};

const patients = new Map();
const orders = [];                                 // SO-wise view (one row per sales order)
let soDone = 0, soSkip = 0, soFail = 0;
for (const so of soList) {
  const meta = soDet[so.id] || {};
  if (isCancelled(meta.status) || isDemo(meta.type) || isDemo(meta.status)) { soSkip++; continue; }
  const d = await soFetch(so.id);
  if (!d) {
    // Detail fetch failed after a retry — DON'T drop it silently. Emit a flagged
    // placeholder so the order still shows in the sequence for follow-up.
    soFail++;
    orders.push({ soId: so.id, so: `SO-${so.id}`, ref: '', custRef: '', lastName: '', program: progOf(meta.type), date: so.dateCreated ?? null, value: Number(meta.total ?? 0), items: [], incomplete: true });
    continue;
  }
  if (isDemo(d.customer?.name)) { soSkip++; continue; }   // name used only to filter test rows, never stored
  const custRef = d.customer?.id ? `PT-${d.customer.id}` : '(unassigned)';
  const patientRef = refOf(d);                        // the shared 273/316-style reference
  const lastName = lastNameOnly(d.customer?.name);    // minimum-necessary PHI
  const program = progOf(d.type);
  const p = patients.get(custRef) || { ref: custRef, soCount: 0, totalValue: 0, items: new Map() };
  p.soCount += 1;
  const soItems = [];
  let soValue = 0;
  for (const li of (d.lineItems || [])) {
    const item = li.item?.name; if (!item) continue;
    const qty = Number(li.qty ?? li.quantity ?? 0);
    const val = round2(qty * Number(li.price ?? 0) + Number(li.shippingPrice ?? 0));
    soValue = round2(soValue + val);
    p.totalValue = round2(p.totalValue + val);
    const it = p.items.get(item) || { item, qty: 0, value: 0, soCount: 0 };
    it.qty += qty; it.value = round2(it.value + val); it.soCount += 1; p.items.set(item, it);
    soItems.push({ item, qty, value: val });
  }
  patients.set(custRef, p);
  orders.push({ soId: so.id, so: `SO-${so.id}`, ref: patientRef, custRef, lastName, program, date: (d.dateCreated ?? so.dateCreated ?? null), value: soValue, items: soItems });
  if (++soDone % 25 === 0) console.log(`  SOs ${soDone} done…`);
}
const patientReport = [...patients.values()]
  .map((p) => ({ ref: p.ref, soCount: p.soCount, totalValue: p.totalValue, items: [...p.items.values()].sort((a, b) => b.qty - a.qty) }))
  .sort((a, b) => b.soCount - a.soCount || b.totalValue - a.totalValue);
// Sort SO-wise rows by reference (numeric-aware) so gaps in the sequence are obvious.
orders.sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }) || a.soId - b.soId);

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
await sbCacheWrite('report_patient_items', { patients: patientReport, orders, count: patientReport.length, orderCount: orders.length, generatedAt: stamp, note: 'Cancelled and demo/test orders excluded. Sales-order-wise view with patient last name + reference (minimum-necessary PHI, per client SOW) — full name / DOB / address never stored; access is audit-logged.' });
await sbCacheWrite('report_vendor_items', { vendors: vendorReport, count: vendorReport.length, generatedAt: stamp, note: 'Cancelled POs excluded.' });

console.log(`\nDONE — patients: ${patientReport.length}, orders: ${orders.length} (${soDone} SOs, ${soSkip} skipped, ${soFail} detail-fetch failures flagged) · vendors: ${vendorReport.length} (${poDone} POs, ${poSkip} skipped)`);
if (soFail) console.log(`  ⚠ ${soFail} sales order(s) could not be detailed and are flagged "incomplete" — re-run to retry.`);
