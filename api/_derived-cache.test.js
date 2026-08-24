import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./_striven.js', import.meta.url), 'utf8');

// The bug this guards: refreshAll() refreshed `so` but not the DERIVED
// `so_detail` built from it, so new orders had no detail entry and dropped out
// of the vertical counts — the dashboard read 82 PI orders against Striven's
// 108, on a cache 13 days stale. The wiring is easy to lose in a refactor and
// the symptom is silent (figures still render, just wrong), so assert it.
test('refreshAll refreshes the derived so_detail cache', () => {
  const body = SRC.slice(SRC.indexOf('async function refreshAll('));
  const end = body.indexOf('\n}\n');
  const fn = body.slice(0, end);
  assert.match(fn, /refreshDerived\(/, 'refreshAll() must call refreshDerived()');
});

test('refreshDerived only fetches orders missing from so_detail', () => {
  assert.match(SRC, /!\(id in detail\)/,
    'must diff `so` against `so_detail` rather than re-fetching every order');
  assert.match(SRC, /const missing = soRows\.map\(\(r\) => r\.id\)\.filter\(stale\)/,
    'the todo list must come from that diff');
});

// A field ADDED to so_detail reaches new orders only, because entries are
// written once and never revisited — so the whole back catalogue reads as "no
// value" and is indistinguishable from a genuinely empty one. `tracking` was
// added this way and would have been blank on 500+ orders for ever.
//
// The test pins the KEY test specifically: `!detail[id].tracking` would re-fetch
// every order Striven has no tracking number for on every single run, which
// never converges and burns the whole budget on orders that will never change.
test('refreshDerived re-fetches entries written before a field existed', () => {
  const fn = SRC.slice(SRC.indexOf('export async function refreshDerived('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /'tracking' in \(detail\[id\] \|\| \{\}\)/,
    'staleness must test for the KEY, so an empty value is not re-fetched for ever');
  assert.match(body, /tracking: String\(d\?\.trackingNumber \?\? ''\)\.trim\(\)/,
    'must store the sales order tracking number');
});

// gen-so-detail.mjs does the FULL rebuild and refreshDerived the incremental
// top-up, into the same cache. A field on one and not the other means the next
// full rebuild silently drops what the top-up filled in.
test('the full rebuild writes the same so_detail fields as the top-up', () => {
  const script = readFileSync(new URL('../scripts/gen-so-detail.mjs', import.meta.url), 'utf8');
  for (const field of ['type', 'rep', 'payer', 'total', 'invStatus', 'status', 'stage', 'tracking']) {
    assert.match(script, new RegExp(`\\b${field}:`), `gen-so-detail.mjs must write ${field}`);
  }
});

test('refreshDerived respects a wall-clock budget', () => {
  // Vercel caps the request at 60s. Without a deadline a backlog would time out
  // and write nothing, making no progress on any run.
  assert.match(SRC, /budgetMs/, 'must accept a time budget');
  assert.match(SRC, /Date\.now\(\) - started > budgetMs/, 'workers must stop at the deadline');
});

test('refreshDerived writes only when it fetched something', () => {
  assert.match(SRC, /if \(fetched > 0\)\s*\{\s*await sbCacheWrite\('so_detail'/,
    'must not rewrite the cache on a no-op run');
});

test('refreshDerived invalidates the getSO memo after writing', () => {
  // getSO() memoises the derivation for 60s; without this the fresh detail
  // would not surface until that memo expired.
  const fn = SRC.slice(SRC.indexOf('async function refreshDerived('));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /_cache\.delete\('derived:so'\)/);
});

// The SAME bug as so_detail's, one cache along: refreshAll() refreshed `so` but
// not the device lines derived from it, so every order newer than the last
// hand-run of scripts/top-up-reports.mjs rendered a blank Devices column and 0
// units while its revenue and counts looked normal. It surfaced on the VA
// pipeline as 25 of the newest orders showing "-", and it is silent by nature —
// so, like so_detail above, the wiring is asserted.
test('refreshAll refreshes the derived device lines', () => {
  const body = SRC.slice(SRC.indexOf('async function refreshAll('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /refreshReportItems\(/, 'refreshAll() must call refreshReportItems()');
  // Both top-ups are open-ended and the function is capped at 60s, so neither
  // may claim a fixed budget without regard to what the other has spent.
  assert.match(fn, /leftMs\(\)/, 'the two top-ups must share one wall-clock allowance');
});

test('refreshReportItems only fetches orders the report has never seen', () => {
  assert.match(SRC, /const have = new Set\(orders\.map\(\(o\) => String\(o\.soId\)\)\)/,
    'must diff `so` against the report rather than re-reading every order');
  // Bootstrapping from an empty blob would replace a report built from EVERY
  // order with one built from whatever happened to be missing.
  assert.match(SRC, /if \(!blob\) return \{ skipped/, 'must refuse to build the report from nothing');
});

test('cache health reports age, and nothing is manual-only any more', () => {
  assert.match(SRC, /export async function getCacheHealth/);
  assert.match(SRC, /ageHours/);
  // report_patient_items used to be listed here because nothing refreshed it.
  // It is on the 6h cycle now, so listing it would attribute an automatic
  // failure to "someone forgot to run the script".
  assert.match(SRC, /const MANUAL_ONLY = new Set\(\)/, 'no cache is hand-refreshed only');
});

// One extraction, two callers. The scheduled top-up and the hand-run script must
// not be able to write the cache in two different shapes — which is exactly what
// a copied implementation drifts into.
test('the top-up script delegates to the shared extraction', () => {
  const script = readFileSync(new URL('../scripts/top-up-reports.mjs', import.meta.url), 'utf8');
  assert.match(script, /refreshReportItems/, 'the script must call the shared function');
  assert.doesNotMatch(script, /sbCacheWrite\('report_patient_items'/, 'the script must not write the cache itself');
});
