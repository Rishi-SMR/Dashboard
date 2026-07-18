// HIPAA remediation: rename any QuickBooks customer that is a patient name into
// its PT-<Striven customer id> reference, so Intuit holds no PHI. Renaming a
// customer keeps every linked transaction intact (it is only the display name).
// Customers that do not match a Striven customer are left untouched and listed.
// Run: node scripts/qb-migrate-customers-to-refs.mjs [--apply]
import fs from 'node:fs';
for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APPLY = process.argv.includes('--apply');
const S = await import('../api/_striven.js');
const Q = await import('../api/_qb.js');

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const strivenByName = new Map();
for (const r of await S.allCustomers()) if (r.id && (r.name ?? '').trim()) strivenByName.set(norm(r.name), r.id);

const qbCustomers = (await Q.qbApi('query?query=' + encodeURIComponent('select Id, DisplayName, SyncToken from Customer maxresults 1000')))?.QueryResponse?.Customer ?? [];

const toRename = [], alreadyRef = [], unmatched = [];
for (const c of qbCustomers) {
  const name = String(c.DisplayName ?? '');
  if (/^PT-\d+$/.test(name)) { alreadyRef.push(name); continue; }
  const id = strivenByName.get(norm(name));
  if (id) toRename.push({ c, ref: `PT-${id}` });
  else unmatched.push(name);
}

console.log(`QuickBooks customers: ${qbCustomers.length}`);
console.log(`  already a reference : ${alreadyRef.length}`);
console.log(`  WILL RENAME (PHI)   : ${toRename.length}`);
for (const t of toRename) console.log(`      "${t.c.DisplayName}"  ->  ${t.ref}`);
console.log(`  not a Striven customer (left untouched): ${unmatched.length}`);
for (const n of unmatched) console.log(`      "${n}"`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to perform the renames.'); process.exit(0); }

let done = 0, failed = 0;
for (const { c, ref } of toRename) {
  try {
    await Q.qbApi('customer', { method: 'POST', body: { Id: c.Id, SyncToken: c.SyncToken, sparse: true, DisplayName: ref } });
    console.log(`  renamed ${c.Id} -> ${ref}`); done++;
  } catch (e) { console.error(`  FAILED ${c.Id} (${c.DisplayName}): ${e.message}`); failed++; }
}
console.log(`\nDONE — renamed ${done}, failed ${failed}. Intuit now holds ${failed === 0 ? 'no' : 'fewer'} patient names.`);
