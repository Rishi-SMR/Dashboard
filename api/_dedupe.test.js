import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dedupeById } from './_striven.js';

test('collapses repeated ids, keeping the most recently updated copy', () => {
  const out = dedupeById([
    { id: 1, total: 100, lastUpdatedDate: '2026-05-01T10:00:00' },
    { id: 2, total: 200, lastUpdatedDate: '2026-05-01T10:00:00' },
    { id: 1, total: 150, lastUpdatedDate: '2026-06-01T10:00:00' },   // newer edit of #1
  ]);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.id === 1).total, 150, 'newer row must win');
});

test('falls back to dateCreated when lastUpdatedDate is absent', () => {
  const out = dedupeById([
    { id: 7, total: 1, dateCreated: '2026-01-01T00:00:00' },
    { id: 7, total: 2, dateCreated: '2026-02-01T00:00:00' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].total, 2);
});

test('leaves a clean book untouched and preserves every distinct order', () => {
  // The live book is 467 rows / 467 distinct ids — dedupe must be a no-op on it.
  const rows = Array.from({ length: 467 }, (_, i) => ({ id: i + 1, total: i }));
  assert.equal(dedupeById(rows).length, 467);
});

test('orders that merely LOOK alike are never collapsed', () => {
  // SO 112 and SO 115: same patient, day, rep, type and $0 total, three minutes
  // apart — but different line items (2 devices vs 1). Real, distinct orders.
  // Keying on anything but the id would delete one of them and its devices.
  const out = dedupeById([
    { id: 112, total: 0, dateCreated: '2026-05-12T15:32:37.49' },
    { id: 115, total: 0, dateCreated: '2026-05-12T15:35:54.637' },
  ]);
  assert.equal(out.length, 2, 'look-alike orders must both survive');
});

test('rows without an id are dropped rather than crashing', () => {
  assert.equal(dedupeById([{ id: 1 }, {}, { id: null }, undefined]).length, 1);
  assert.deepEqual(dedupeById(null), []);
});

test('getSO routes the sales-order list through dedupeById', () => {
  // The guard is only worth anything if it is actually on the path.
  const src = readFileSync(new URL('./_striven.js', import.meta.url), 'utf8');
  assert.match(src, /const rows = dedupeById\(await allSO\(\)\)/);
});
