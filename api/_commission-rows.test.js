import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
// getCommission() computes three per-rep money figures — paid, payable, waiting
// — but the rep ROWS it serializes are assembled by a separate `REP_NAMES.map`,
// and that map listed only two of them. `paidTotal` was calculated on
// striven.byRep by splitPaid() and then never copied across, so it reached the
// browser as undefined and the Commission table's Paid column printed "-" for
// every rep.
//
// IT HID BEHIND THE PAYABLE COLUMN. While a rep is still owed something their
// row reads sensibly and nobody looks twice. It only becomes visible for a rep
// who has been paid in full — Maylon Sanders, whose entire $4,489.86 falls
// inside COMMISSION_PAID_THROUGH — whose row then showed "-" under Paid and
// "$0.00" under Payable. A workbook that had loaded perfectly, presenting as one
// that had not loaded at all.
//
// STATIC, because the runtime alternative needs Striven credentials and a
// network round trip, and this is a question about the source: does the row
// builder carry every figure the engine produces? Reading it answers that
// offline and deterministically.

const SRC = readFileSync(new URL('./_striven.js', import.meta.url), 'utf8');

/** The `REP_NAMES.map(...)` that builds the serialized rep rows. */
function repRowBuilder() {
  const start = SRC.indexOf('const reps = REP_NAMES.map((rep) => {');
  assert.notEqual(start, -1, 'could not find the rep-row builder in _striven.js');
  const end = SRC.indexOf('}).sort(', start);
  assert.notEqual(end, -1, 'could not find the end of the rep-row builder');
  return SRC.slice(start, end);
}

// The three the engine produces per rep. splitPaid() sets paid and payable;
// the order walk accumulates waiting.
const ENGINE_MONEY = ['paidTotal', 'payableTotal', 'waitingTotal'];

for (const field of ENGINE_MONEY) {
  test(`the rep row carries ${field}`, () => {
    assert.ok(repRowBuilder().includes(`${field}:`),
      `getCommission()'s rep rows omit ${field}, so it reaches the browser as `
      + 'undefined and money() renders it as "-". The engine computes it on '
      + 'striven.byRep; this map has to copy it across.');
  });
}

test('every figure splitPaid() assigns is carried to the rep rows', () => {
  // Derived from the source rather than hard-coded, so a FOURTH figure added to
  // splitPaid() later is caught by this test without anyone editing it.
  const fn = SRC.slice(SRC.indexOf('const splitPaid ='), SRC.indexOf('striven.paidTotal ='));
  const assigned = [...fn.matchAll(/\br\.(\w+Total)\s*=/g)].map((m) => m[1]);
  assert.ok(assigned.length >= 2, `expected splitPaid's caller to assign totals, found: ${assigned}`);
  const builder = repRowBuilder();
  for (const f of assigned) {
    assert.ok(builder.includes(`${f}:`),
      `splitPaid's caller sets r.${f} but the rep-row builder does not carry it.`);
  }
});
