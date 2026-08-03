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
  assert.match(SRC, /filter\(\(id\) => !\(id in detail\)\)/,
    'must diff `so` against `so_detail` rather than re-fetching every order');
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

test('cache health reports age and flags manual-only caches', () => {
  assert.match(SRC, /export async function getCacheHealth/);
  // report_patient_items has no automatic refresher at all — it must be marked
  // so a stale reading is attributed correctly rather than looking like a bug.
  assert.match(SRC, /MANUAL_ONLY[\s\S]{0,80}report_patient_items/);
  assert.match(SRC, /ageHours/);
});
