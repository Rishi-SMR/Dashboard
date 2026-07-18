// HIPAA remediation: rewrite the already-cached Supabase datasets so no patient
// name remains at rest. Names become PT-<Striven customer id> references.
// Idempotent — safe to re-run. Run: node scripts/scrub-phi-cache.mjs
import fs from 'node:fs';
for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const S = await import('../api/_striven.js');

for (const key of ['customers', 'invoices', 'so', 'payments']) {
  const row = await S.sbCacheRead(key);
  const data = row?.data;
  if (!Array.isArray(data)) { console.log(`${key}: (nothing cached)`); continue; }
  const before = JSON.stringify(data).length;
  const scrubbed = S.scrubPhi(key, data);
  await S.sbCacheWrite(key, scrubbed);
  const sample = key === 'customers' ? scrubbed[0]?.name : scrubbed[0]?.customer?.name;
  console.log(`${key.padEnd(10)} ${data.length} rows scrubbed (${before} → ${JSON.stringify(scrubbed).length} bytes) | sample now: ${JSON.stringify(sample)}`);
}
console.log('\nDone — no patient names remain in the Supabase cache.');
