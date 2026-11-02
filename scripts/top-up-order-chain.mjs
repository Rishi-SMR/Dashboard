/**
 * Pulls `order_chain` (order → invoices / POs) up to date.
 *
 * Same incremental logic refreshAll() runs on its 6h cycle, callable by hand
 * when you don't want to wait for the cron — and the way to clear a large
 * backlog in one pass, since a terminal has no 60s cap.
 *
 * Pass --dry-run to fetch and report without writing anything to Supabase.
 *
 * Run: node scripts/top-up-order-chain.mjs [--dry-run]
 */
import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { refreshOrderChain } = await import('../api/_striven.js');

const dryRun = process.argv.includes('--dry-run');
const out = await refreshOrderChain({ budgetMs: 10 * 60_000, dryRun });

console.log(`orders          : ${out.orders}`);
console.log(`invoices linked : ${out.invoicesLinked} of ${out.invoices}`);
console.log(`queued          : ${out.queued}`);
console.log(`fetched         : ${out.fetched}`);
console.log(`failed          : ${out.failed}`);
console.log(`remaining       : ${out.remaining}`);
console.log(`complete        : ${out.complete}`);
console.log(`took            : ${(out.ms / 1000).toFixed(1)}s${dryRun ? '  (dry run — nothing written)' : ''}`);

if (!out.complete) {
  console.error('\nDid not finish — run again to continue.');
  process.exit(1);
}
