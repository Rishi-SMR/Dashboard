import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commissionByTeam } from './_qb.js';

/**
 * Contract labor lines as the books carry them: named on the line from
 * September, named only in the transaction's own text before that, and spelt
 * loosely ("Preision Healing").
 */
const lines = [
  { date: '2026-09-15', type: 'Journal Entry', id: '1', name: '', memo: 'Contractor Payment for Alek Sigman', amount: 96.57 },
  { date: '2026-10-15', type: 'Journal Entry', id: '2', name: '', memo: 'Contractor Payment for Cameron Archer', amount: 2335 },
  { date: '2026-10-15', type: 'Journal Entry', id: '3', name: '', memo: 'Contractor Payment for Maverick Medical', amount: 44635 },
  { date: '2026-07-15', type: 'Journal Entry', id: '4', name: '', memo: '', amount: 12000 },
  { date: '2026-07-15', type: 'Journal Entry', id: '5', name: '', memo: '', amount: 1135.27 },
  { date: '2026-04-30', type: 'Journal Entry', id: '6', name: '', memo: '', amount: 21030 },
  { date: '2026-08-03', type: 'Expense', id: '7', name: 'Upwork', memo: '', amount: 688.8 },
];
const tx = {
  4: 'Being Paid to Preision Healing for the month ofJune | Debit for  Precision Healing',
  5: 'Contractors Payment | Debit For Taryn Griffy',
  6: 'Being amount tranferred to Commission since not in Gusto payments Report | Payroll expenses:Wages',
};
const total = lines.reduce((t, l) => t + l.amount, 0);

test('Operations payees to Operations, Upwork on its own, everyone else to Sales', () => {
  const [sales, ops, upwork] = commissionByTeam(lines, (l) => tx[l.id] || '', total);
  assert.deepEqual(ops.payees.map((p) => p.name).sort(), ['Alek Sigman', 'Cameron Archer', 'Precision Healing', 'Taryn Griffy']);
  assert.equal(ops.value, 15566.84);
  assert.deepEqual(upwork.payees.map((p) => p.name), ['Upwork']);
  assert.equal(upwork.value, 688.8);
  assert.deepEqual(sales.payees.map((p) => p.name).sort(), ['Maverick Medical', 'Unassigned']);
  assert.equal(sales.value, 65665);
});

test('the unnamed Wages entry of 30 Apr is split to Alle Ann, Jillian and Unassigned', () => {
  const [sales] = commissionByTeam(lines, (l) => tx[l.id] || '', total);
  const apr = sales.payments.filter((p) => p.date === '2026-04-30');
  assert.deepEqual(apr.map((p) => [p.payee, p.amount]), [
    ['Maverick Medical (Alle Ann)', 8925], ['Maverick Medical (Jillian)', 425], ['Unassigned', 11680],
  ]);
  assert.equal(sales.payees.find((p) => p.name === 'Unassigned').value, 11680);
});

test('the teams add to the account total; payments are dated, oldest first', () => {
  const teams = commissionByTeam(lines, (l) => tx[l.id] || '', total + 10);
  assert.equal(Math.round(teams.reduce((t, x) => t + x.value, 0) * 100) / 100, Math.round((total + 10) * 100) / 100);
  const dates = teams[0].payments.map((p) => p.date);
  assert.deepEqual(dates, [...dates].sort());
});

test('sales commission carries its vertical: Alle Ann VA, Jillian TriCare, Unassigned TriCare', () => {
  const [sales, ops] = commissionByTeam(lines, (l) => tx[l.id] || '', total);
  const apr = sales.payments.filter((p) => p.date === '2026-04-30');
  assert.deepEqual(apr.map((p) => p.vertical), ['VA', 'TriCare', 'TriCare']);
  assert.ok(ops.payments.every((p) => p.vertical === null));
});
