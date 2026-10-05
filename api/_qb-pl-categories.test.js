import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plExpenseCategories } from './_qb.js';

/**
 * THE SHAPE THAT TOOK /api/qb/pl DOWN.
 *
 * QuickBooks reports a cost either as a SECTION with a subtotal and accounts
 * under it, or as a BARE ACCOUNT sitting straight under Cost of Goods Sold /
 * Expenses with no group of its own. The bare branch referenced a `total`
 * binding that only exists in the section branch, so any chart of accounts with
 * one top-level account — this company has five — threw
 * "ReferenceError: total is not defined" and the whole P&L endpoint 500'd.
 *
 * Nothing caught it because the failure needs real report JSON: the parser is
 * only exercised by a live QuickBooks response. These tests supply that shape
 * directly, so the branch is covered without a network call.
 */

const rows = {
  Row: [
    {
      group: 'COGS',
      Rows: {
        Row: [
          {
            Summary: { ColData: [{ value: 'Cost of goods sold' }, { value: '123672.44' }] },
            Rows: { Row: [{ ColData: [{ value: 'Direct supplies & materials' }, { value: '123672.44' }] }] },
          },
        ],
      },
    },
    {
      group: 'Expenses',
      Rows: {
        Row: [
          {
            Summary: { ColData: [{ value: 'Total Payroll expenses' }, { value: '228373.10' }] },
            Rows: { Row: [{ ColData: [{ value: 'Wages' }, { value: '228373.10' }] }] },
          },
          // A bare account: its own category, no group above it.
          { ColData: [{ value: 'Office expenses' }, { value: '411.98' }] },
          { ColData: [{ value: 'Bank and credit card fees' }, { value: '14.00' }] },
        ],
      },
    },
  ],
};

test('a bare top-level account becomes its own category, at its own value', () => {
  const out = plExpenseCategories(rows);
  const office = out.find((c) => c.category === 'Office expenses');
  assert.ok(office, 'the bare account should appear as a category');
  assert.equal(office.total, 411.98);
  assert.deepEqual(office.accounts, [{ label: 'Office expenses', value: 411.98 }]);
});

test('every category says which cost line it belongs to', () => {
  const out = plExpenseCategories(rows);
  assert.equal(out.filter((c) => !c.section).length, 0, 'no category may be untagged');
  assert.equal(out.find((c) => c.category === 'Cost of goods sold').section, 'cogs');
  for (const name of ['Payroll expenses', 'Office expenses', 'Bank and credit card fees']) {
    assert.equal(out.find((c) => c.category === name).section, 'opex', `${name} is overhead`);
  }
});

test('each section sums to its own line, and "Total " is stripped from the name', () => {
  const out = plExpenseCategories(rows);
  const sum = (s) => out.filter((c) => c.section === s).reduce((t, c) => t + c.total, 0);
  assert.equal(Number(sum('cogs').toFixed(2)), 123672.44);
  assert.equal(Number(sum('opex').toFixed(2)), 228799.08);
  assert.ok(out.some((c) => c.category === 'Payroll expenses'), 'the subtotal row keeps the account name, not "Total Payroll expenses"');
});

test('categories come back largest first', () => {
  const totals = plExpenseCategories(rows).map((c) => c.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
});
