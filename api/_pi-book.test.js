// THE PI LIEN SPLIT — pure-function tests over piBookOf().
//
// These need no credentials: piBookOf takes the mapped invoice rows getAR has
// already built and returns the four-tranche split the Receivables tab renders.
// The property worth protecting is that the split PARTITIONS the case value —
// advanceReceived + advanceOpen + remainder === caseValue on every row — because
// the four sections on screen are read against each other and against the
// programme total, and a drift of a cent there is a reconciliation nobody can
// close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { piBookOf } from './_striven.js';

/** A mapped invoice row, shaped exactly as getAR builds them. */
const row = (o) => ({
  id: o.id ?? 1, number: String(o.number ?? o.id ?? 1),
  vertical: o.vertical ?? 'PI',
  patient: o.patient ?? 'A. Patient', payer: o.payer ?? 'Some Law Firm',
  dueDate: o.dueDate ?? '2026-01-31',
  total: o.total, ledgerOpen: o.ledgerOpen, caseValue: o.caseValue ?? null,
});

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

// The everyday shape: Striven raises the 15% as the invoice, and it is unpaid.
const RAISED_UNPAID = row({ id: 10, total: 899.25, ledgerOpen: 899.25, caseValue: 5995 });
// The same case once the advance lands.
const RAISED_PAID = row({ id: 11, total: 899.25, ledgerOpen: 0, caseValue: 5995 });
// Billed at the full case price rather than the advance, and unpaid.
const GROSS_UNPAID = row({ id: 12, total: 5995, ledgerOpen: 5995, caseValue: 5995 });
// No sales order joined: caseValue null, so the invoice stands in for the case.
const UNJOINED = row({ id: 13, total: 1200, ledgerOpen: 1200, caseValue: null });
// Part-paid — nothing in the live book is, but the arithmetic has to hold.
const PART_PAID = row({ id: 14, total: 899.25, ledgerOpen: 400, caseValue: 5995 });

test('the three tranches partition the case value on every row', () => {
  const book = piBookOf([RAISED_UNPAID, RAISED_PAID, GROSS_UNPAID, UNJOINED, PART_PAID]);
  const seen = new Map();
  for (const s of [book.received, book.awaiting, book.balance]) {
    for (const r of s.invoices) seen.set(r.number, r);
  }
  for (const r of seen.values()) {
    near(r.advanceReceived + r.advanceOpen + r.remainder, r.caseValue, `row ${r.number} does not close`);
  }
  near(
    book.totals.advanceReceived + book.totals.advanceOpen + book.totals.remainder,
    book.totals.caseValue,
    'book totals do not close',
  );
});

test('a raised, unpaid advance is outstanding and carries the 85% behind it', () => {
  const { invoices: [r] } = piBookOf([RAISED_UNPAID]).awaiting;
  near(r.advance, 899.25, 'advance');
  near(r.advanceReceived, 0, 'received');
  near(r.advanceOpen, 899.25, 'outstanding');
  near(r.remainder, 5095.75, 'case balance');
  // It is NOT in the received section: nothing has arrived.
  assert.equal(piBookOf([RAISED_UNPAID]).received.count, 0);
});

test('a collected advance moves to received and keeps its case balance', () => {
  const book = piBookOf([RAISED_PAID]);
  assert.equal(book.awaiting.count, 0, 'nothing is outstanding once the advance is in');
  const [r] = book.received.invoices;
  near(r.advanceReceived, 899.25, 'received');
  near(r.remainder, 5095.75, 'case balance');
  // This is the row getAR's `invoices` list drops — no ledger balance — and the
  // reason the split is taken above that filter.
  assert.equal(book.balance.count, 1);
});

test('an invoice billed at the full case price is held to the 15% advance', () => {
  const [r] = piBookOf([GROSS_UNPAID]).awaiting.invoices;
  near(r.advance, 899.25, 'capped to 15% of the order, not the $5,995 billed');
  near(r.remainder, 5095.75, 'the rest is still lien exposure');
});

test('an invoice with no order joined has no 85% behind it', () => {
  const book = piBookOf([UNJOINED]);
  const [r] = book.awaiting.invoices;
  assert.equal(r.joined, false, 'flagged, so the reader knows the case value is the invoice');
  near(r.caseValue, 1200, 'the invoice stands in for the case');
  // No order means no case value, so there is no 15% rule to apply and no lien
  // behind it. Anything else invents a gross the book cannot support — and
  // would put a figure here that the AR Open tile on the same page contradicts.
  near(r.advanceOpen, 1200, 'the whole thing is outstanding');
  near(r.remainder, 0, 'nothing is coming after it');
  assert.equal(book.balance.count, 0, 'it must not appear in the case-balance section');
  assert.equal(r.overRate, false, 'no order, so there is no rate to be over');
});

// ── SECTION 2 MUST TIE TO THE AR OPEN TILE ON THE SAME PAGE ─────────────────
// Both sit on the Receivables tab, one panel apart, and both claim to say what
// PI still owes. arOwedOf() is the tile's rule; this is the section's. They are
// written independently — the section works off the advance, the tile off the
// ledger balance — so the agreement is worth asserting rather than assuming.
test('advance outstanding matches what the AR tile reports for the same invoice', () => {
  const owed = (r) => {          // arOwedOf(), for a PI row
    const cap = Number.isFinite(r.caseValue) && r.caseValue > 0 ? r.caseValue * 0.15 : null;
    return cap == null ? r.ledgerOpen : Math.min(r.ledgerOpen, cap);
  };
  // Every shape in the live book. GROSS part-paid is deliberately excluded: the
  // two rules genuinely differ there, it does not occur, and piBookOf says so.
  for (const r of [RAISED_UNPAID, RAISED_PAID, GROSS_UNPAID, UNJOINED, PART_PAID]) {
    const book = piBookOf([r]);
    const row = [...book.awaiting.invoices, ...book.received.invoices][0];
    near(row.advanceOpen, owed(r), `invoice ${r.number}`);
  }
});

test('a part-paid advance appears in both received and outstanding, for its own halves', () => {
  const book = piBookOf([PART_PAID]);
  assert.equal(book.received.count, 1);
  assert.equal(book.awaiting.count, 1);
  near(book.received.amount, 499.25, 'what landed');
  near(book.awaiting.amount, 400, 'what has not');
  near(book.received.amount + book.awaiting.amount, 899.25, 'together, the advance');
});

test('an advance banked above the rate is reported at what arrived, not at the cap', () => {
  // #170 in the live book: settled for $639.60 against a $239.85 cap. Reporting
  // it at the cap would put less in the invoiced column than has demonstrably
  // been received.
  const over = row({ id: 15, total: 639.60, ledgerOpen: 0, caseValue: 1599 });
  const [r] = piBookOf([over]).received.invoices;
  near(r.advanceReceived, 639.60, 'money in the bank outranks the projection');
  near(r.remainder, 959.40, 'and the balance is the rest of the case');
});

test('non-PI invoices and zero-value rows are not in the book at all', () => {
  const va = row({ id: 20, vertical: 'VA', total: 4000, ledgerOpen: 4000, caseValue: null });
  const zero = row({ id: 21, total: 0, ledgerOpen: 0, caseValue: null });
  const book = piBookOf([va, zero]);
  assert.equal(book.totals.count, 0);
  assert.equal(book.received.count + book.awaiting.count + book.balance.count, 0);
});

test('the order join supplies the reference and rep the sections name cases by', () => {
  const [r] = piBookOf([RAISED_UNPAID], { 10: { soId: '207', ref: 'SO-207', rep: 'Jillian Colin' } }).awaiting.invoices;
  assert.equal(r.ref, 'SO-207');
  assert.equal(r.soId, '207');
  assert.equal(r.rep, 'Jillian Colin');
});

test('a missing order join costs the display columns and no figure', () => {
  const [r] = piBookOf([RAISED_UNPAID], {}).awaiting.invoices;
  assert.equal(r.ref, '');
  assert.equal(r.rep, '');
  near(r.advanceOpen, 899.25, 'the money is unaffected');
});
