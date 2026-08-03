import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRealAccount } from './_striven.js';

/**
 * The account count is derived independently on the server and in Orders &
 * Revenue. They disagreed — 78 against 79 — because the client counted every
 * distinct `o.account` including the "Unassigned" placeholder.
 *
 * Two independent definitions of one figure is the actual defect; these tests
 * hold them in step.
 */

test('server: Unassigned is not an account', () => {
  assert.equal(isRealAccount('Unassigned'), false);
  assert.equal(isRealAccount('unassigned'), false);
  assert.equal(isRealAccount(''), false);
  assert.equal(isRealAccount(null), false);
});

test('server: real payers and programmes are accounts', () => {
  for (const s of ['Veterans Affairs', 'TriCare', 'Silva Law', 'Lowe Law']) {
    assert.equal(isRealAccount(s), true, `${s} should count`);
  }
});

test('client mirrors the server rule', () => {
  const fmt = readFileSync(new URL('../src/cashflow/format.ts', import.meta.url), 'utf8');
  assert.match(fmt, /export const isRealAccount/, 'the client needs its own copy of the rule');
  assert.match(fmt, /\^unassigned\$/i, 'and it must exclude the Unassigned placeholder');
});

test('Orders & Revenue filters its account set', () => {
  // The bug was a bare `accounts.add(o.account)`.
  const src = readFileSync(new URL('../src/cashflow/components/OrderDashboard.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(isRealAccount\(o\.account\)\) accounts\.add\(o\.account\)/,
    'the totals must count real accounts only, or this screen drifts from the Dashboard again');
  assert.doesNotMatch(src, /^\s*accounts\.add\(o\.account\);\s*$/m,
    'an unfiltered add would reintroduce the 78-vs-79 split');
});
