/**
 * Fills in device line items for orders that have none.
 *
 * `report_patient_items` carries the per-order device lines that every device,
 * unit and commission figure depends on. It is rebuilt in full only by
 * scripts/gen-reports.mjs, which re-reads EVERY order and takes minutes.
 *
 * THE EXTRACTION LIVES IN api/_striven.js (refreshReportItems), not here. It
 * used to be a copy in this file, and a copy is how the scheduled path and the
 * hand-run one come to write the cache in two different shapes. The 6h refresh
 * now calls the same function, so this script is the manual trigger for it —
 * useful right after a bulk import, when waiting for the next cycle is not
 * good enough.
 *
 * It does NOT replace gen-reports.mjs: that also rebuilds report_vendor_items
 * and recomputes every patient aggregate from scratch. Run the full generator
 * after bulk EDITS in Striven — this one only ever adds orders the report has
 * never seen.
 *
 * Run: node scripts/top-up-reports.mjs
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { refreshReportItems } = await import('../api/_striven.js');

// No wall-clock budget and no order cap: the cron run is bounded because it has
// to fit a 60s function, a terminal is not.
const r = await refreshReportItems({ budgetMs: Infinity, maxOrders: Infinity, log: (m) => console.log(m) });

if (r.skipped) {
  console.error(r.skipped);
  process.exit(1);
}
if (!r.missingBefore) {
  console.log('Nothing to do — every live order already has its device lines.');
  process.exit(0);
}
console.log(`\nskipped (DEMO)      : ${r.skippedDemo}`);
console.log(`skipped (cancelled) : ${r.skippedCancelled}`);
console.log(`added ${r.added} order(s), ${r.itemsAdded} device line(s); ${r.failed} failed`);
console.log(`report now holds ${r.orderCount} orders`);
if (r.failed) process.exit(1);
