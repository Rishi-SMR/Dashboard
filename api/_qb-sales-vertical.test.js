import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salesByVertical } from './_qb.js';

/**
 * Deposits as the books actually carry them: some with a payee Name, most with
 * only the bank's memo text. Every line lands in one vertical, and the
 * verticals add back to total income.
 */
const lines = [
  { name: '', memo: 'CMC SOLUTIONS, L PAYROLL 6semk86 CMC SOLUTIONS, L PAYROLL 6semk86sk27', amount: 14300 },
  { name: '', memo: 'INCOMING WIRE TRANSFER LIENSTAR INCOMING WIRE TRANSFER LIENSTAR LLC 97272321', amount: 17941.2 },
  { name: 'Lienstar', memo: '', amount: 6565.35 },
  { name: 'Hi-Dow International Incorporated', memo: '', amount: 514500 },
  { name: '', memo: 'HI-DOW INTERNATI QUICKBOOKS XXXXX0276', amount: 114000 },
  { name: 'Integrated Surg Distributor', memo: '', amount: 160559.9 },
  { name: '', memo: 'ACH INTEGRATED SURG TEMPLE DISTRIBUTOR PAYOUT - APRIL', amount: 9394.44 },
  { name: 'Integrated Surgical', memo: '', amount: 483.89 },
  { name: 'Amazon', memo: '', amount: 129.89 },
  { name: '', memo: 'InstPmt Intuit 17419826 07/31', amount: 0.17 },
];

test('each payer maps to its vertical', () => {
  const total = lines.reduce((t, l) => t + l.amount, 0);
  const by = Object.fromEntries(salesByVertical(lines, total).map((v) => [v.vertical, v.value]));
  assert.equal(by.TriCare, 14300);
  assert.equal(by.PI, 24506.55);
  assert.equal(by.VA, 798938.23);
  assert.equal(by.Other, 130.06);
});

test('each vertical lists its receipts, dated, oldest first', () => {
  const dated = [
    { date: '2026-07-10', name: '', memo: 'INCOMING WIRE TRANSFER LIENSTAR LLC 99438125', amount: 42778.65 },
    { date: '2026-05-06', name: '', memo: 'INCOMING WIRE TRANSFER LIENSTAR LLC 97272321', amount: 17941.2 },
  ];
  const pi = salesByVertical(dated, 60719.85).find((v) => v.vertical === 'PI');
  assert.deepEqual(pi.deposits.map((d) => [d.date, d.payer, d.amount]), [
    ['2026-05-06', 'Lienstar', 17941.2],
    ['2026-07-10', 'Lienstar', 42778.65],
  ]);
});

test('verticals always add to total income; a gap is named under Other', () => {
  const total = Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100;
  const v = salesByVertical(lines, total + 50);
  const sum = Math.round(v.reduce((t, x) => t + x.value, 0) * 100) / 100;
  assert.equal(sum, total + 50);
  const other = v.find((x) => x.vertical === 'Other');
  assert.ok(other.payers.some((p) => p.name === 'Not itemised in the detail report' && p.value === 50));
});
