import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Guards the substring bug that put Incomplete orders in the Delivered bucket.
 *
 * `/complete|closed|done/` matches "Incomplete" — "complete" is a substring of
 * it. The Delivered drill listed orders whose own Status column read
 * "Incomplete", and the same test was duplicated in eight places.
 */

// The server's own classifier, lifted from source so the test tracks the shipped code.
const SRC = readFileSync(new URL('./_striven.js', import.meta.url), 'utf8');
const soGroupOf = eval(
  '(' + SRC.slice(SRC.indexOf('(status) => {', SRC.indexOf('const soGroupOf =')),
    SRC.indexOf('\n};', SRC.indexOf('const soGroupOf =')) + 2) + ')',
);

test('server: Incomplete is active, never completed', () => {
  for (const s of ['Incomplete', 'incomplete', 'IN-COMPLETE', 'In Complete', 'Order Incomplete']) {
    assert.equal(soGroupOf(s), 'active', `"${s}" must not be treated as completed`);
  }
});

test('server: genuinely finished statuses still classify as completed', () => {
  for (const s of ['Completed', 'complete', 'Closed', 'Done', 'Delivered', 'Order Completed']) {
    assert.equal(soGroupOf(s), 'completed', `"${s}" should be completed`);
  }
});

test('server: cancelled wins over everything', () => {
  for (const s of ['Canceled', 'Cancelled', 'Void', 'Denied', 'Rejected']) {
    assert.equal(soGroupOf(s), 'cancelled');
  }
});

test('server: unknown and open statuses stay active', () => {
  for (const s of ['In Progress', 'Draft', 'Pending', '', null, undefined, 'Unknown']) {
    assert.equal(soGroupOf(s), 'active');
  }
});

test('client helper mirrors the server on the Incomplete case', () => {
  // The client copy lives in format.ts; assert the same two defences are present
  // so the two sides cannot drift apart again.
  const fmt = readFileSync(new URL('../src/cashflow/format.ts', import.meta.url), 'utf8');
  assert.match(fmt, /export const isIncompleteStatus/);
  assert.match(fmt, /if \(isIncompleteStatus\(v\)\) return false;/,
    'isCompletedStatus must reject Incomplete explicitly, not rely on the regex alone');
  assert.match(fmt, /\\b\(\?:complete\|completed\|closed\|done\|delivered\|fulfilled\)\\b/,
    'the completed test must use word boundaries');
});

test('no component still uses the naive substring test', () => {
  // The bug was duplicated eight times; this stops a ninth appearing.
  const files = [
    '../src/cashflow/components/OrderDashboard.tsx',
    '../src/cashflow/components/OrdersTab.tsx',
    '../src/cashflow/components/OrderTrackingTab.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const naive = src.match(/\/complete\|closed\|done\//g) || [];
    assert.equal(naive.length, 0, `${f} still contains the naive /complete|closed|done/ test`);
  }
});
