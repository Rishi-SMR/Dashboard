/**
 * Pulls `so_detail` up to date for orders that have none.
 *
 * Same incremental logic refreshAll() runs on its 6h cycle, callable by hand
 * when you don't want to wait for the cron — e.g. after spotting a gap between
 * the dashboard's order count and Striven's.
 *
 * This is NOT a substitute for scripts/gen-so-detail.mjs. That rebuilds every
 * order's detail and is what you want after bulk edits in Striven; this only
 * fills in orders that are missing entirely.
 *
 * Run: node scripts/top-up-so-detail.mjs
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { refreshDerived } = await import('../api/_striven.js');

// Run without the serverless time budget — at a terminal there is no 60s cap,
// so a large backlog finishes in one pass instead of over several cron cycles.
const out = await refreshDerived({ budgetMs: 10 * 60_000, maxOrders: 5_000 });

console.log(`missing before : ${out.missingBefore}`);
console.log(`fetched        : ${out.fetched}`);
console.log(`failed         : ${out.failed}`);
console.log(`remaining      : ${out.remaining}`);
console.log(`complete       : ${out.complete}`);
console.log(`took           : ${(out.ms / 1000).toFixed(1)}s`);

if (!out.complete) {
  console.error('\nDid not finish — run again to continue.');
  process.exit(1);
}
