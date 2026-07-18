// HIPAA remediation: rewrite the already-cached Supabase datasets so no patient
// name remains at rest. Names become PT-<Striven customer id> references.
// Idempotent — safe to re-run. Run: node scripts/scrub-phi-cache.mjs
//
// Covers every cache key, not just the four obvious ones: the first pass missed
// tasks, projects, the QuickBooks posted maps and the auto-PO log, which
// scripts/hipaa-check.mjs later caught.
import fs from 'node:fs';
for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const S = await import('../api/_striven.js');

const KEYS = ['customers', 'invoices', 'so', 'payments', 'tasks', 'projects',
  'qb_posted', 'qb_posted_inv', 'so_detail', 'order_chain', 'auto_po_state'];

const refMap = await S.customerRefMap();
if (!refMap.size) { console.error('ABORT — could not read customer names from Striven, so nothing can be mapped.'); process.exit(1); }
console.log(`Loaded ${refMap.size} Striven customer names for mapping (held in memory only).\n`);

for (const key of KEYS) {
  const row = await S.sbCacheRead(key);
  const data = row?.data;
  if (data == null) { console.log(`${key.padEnd(14)} (nothing cached)`); continue; }
  const before = JSON.stringify(data);
  const scrubbed = S.scrubPhi(key, data, refMap);
  const after = JSON.stringify(scrubbed);
  if (before === after) { console.log(`${key.padEnd(14)} already clean`); continue; }
  await S.sbCacheWrite(key, scrubbed);
  const n = Array.isArray(data) ? `${data.length} rows` : `${Object.keys(data).length} entries`;
  console.log(`${key.padEnd(14)} REWRITTEN — ${n} (${before.length} → ${after.length} bytes)`);
}
console.log('\nDone. Verify with: node scripts/hipaa-check.mjs');
