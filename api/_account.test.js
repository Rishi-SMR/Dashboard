import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTestPayer, isRealAccount } from './_striven.js';

test('drops the test payer that was showing as account #80', () => {
  // "Testing 1" — 1 order, $0, booked by Rishi Arora. The only test-shaped
  // payer in the book.
  assert.equal(isTestPayer('Testing 1'), true);
  assert.equal(isRealAccount('Testing 1'), false);
});

test('matches test/testing with or without a trailing number, any case', () => {
  for (const s of ['test', 'Test', 'TESTING', 'Testing 1', 'Test 2', 'testing12', ' Testing 3 ']) {
    assert.equal(isTestPayer(s), true, `${s} should be treated as a test payer`);
  }
});

test('never catches a real firm whose name merely contains "test"', () => {
  // This is why the pattern is ANCHORED rather than a \btest\b word boundary:
  // a boundary rule both misses "Testing" (the boundary fails before "ing")
  // and would strike a genuine firm.
  for (const s of ['Testa Law', 'Protest Legal', 'Contest Partners', 'Testerman & Co', 'Latest Law LLP']) {
    assert.equal(isTestPayer(s), false, `${s} is a real firm and must be kept`);
    assert.equal(isRealAccount(s), true);
  }
});

test('real payers and programme payers are accounts', () => {
  for (const s of ['Veterans Affairs', 'TriCare', 'Silva Law', 'Law Offices of Glenn D. Tucker, Sr.']) {
    assert.equal(isRealAccount(s), true, `${s} should count as an account`);
  }
});

test('blank and Unassigned are not accounts', () => {
  for (const s of ['', '   ', null, undefined, 'Unassigned', 'unassigned']) {
    assert.equal(isRealAccount(s), false);
  }
});

test('analytics folds a test payer into Unassigned at the source', () => {
  // Single point of truth: every account list (donut, table, totals drill)
  // reads o.account, so filtering there fixes all of them at once.
  const src = readFileSync(new URL('./_striven.js', import.meta.url), 'utf8');
  assert.match(src, /account: \(r\.payer && !isTestPayer\(/);
});
