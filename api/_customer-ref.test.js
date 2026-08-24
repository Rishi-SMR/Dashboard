import test from 'node:test';
import assert from 'node:assert/strict';
import { customerRef } from './_striven.js';

// These run with MASK_PHI at its default (on). The point of the whole helper is
// what it does in that state, so a test that only passed with masking off would
// be testing nothing.

test('a real name never reaches the caller', () => {
  // THE HIPAA GUARANTEE. If this ever returns the name, the fix has become the
  // leak it was meant to avoid.
  const out = customerRef({ id: 1234, name: 'Jane Q. Patient' });
  assert.equal(out, 'PT-1234');
  assert.ok(!/jane|patient/i.test(out), 'the name must not survive in any form');
});

test('the de-identified reference is shown instead of nothing', () => {
  // The reported bug: the SO detail card printed "-" because maskName() returned
  // '' on a live Striven read. A reference is what every cached screen shows for
  // the same customer, so the detail card must show it too.
  assert.equal(customerRef({ id: 88, name: 'Someone Real' }), 'PT-88');
  assert.notEqual(customerRef({ id: 88, name: 'Someone Real' }), '');
});

test('an already-scrubbed reference passes straight through', () => {
  // Cached datasets arrive with the name already rewritten by scrubPhi. It must
  // not be re-prefixed into PT-PT-1234.
  assert.equal(customerRef({ id: 1234, name: 'PT-1234' }), 'PT-1234');
  // Even where the cached ref and the row id disagree, the stored ref wins —
  // it is what the rest of the cache joins on.
  assert.equal(customerRef({ id: 9, name: 'PT-1234' }), 'PT-1234');
});

test('a customer with no id yields nothing rather than a broken reference', () => {
  // "PT-undefined" on screen is worse than a dash: it looks like a real
  // reference and resolves to nobody.
  assert.equal(customerRef({ name: 'Someone Real' }), '');
  assert.equal(customerRef({}), '');
  assert.equal(customerRef(null), '');
  assert.equal(customerRef(undefined), '');
});
