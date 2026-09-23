// ── A NAMED PERIOD IS A CLOSED CALENDAR WINDOW ───────────────────────────────
//
// THE BUG THIS CAUGHT: on 23 September the Order Dashboard's "This month" was a
// trailing THIRTY DAYS, so it reached back to 25 August and the Delivered
// orders drill listed nineteen VA orders dated 26-31 August under September. A
// rep reading their own board saw last month's work counted in this month's
// figures, and nothing on screen said the period was a rolling one.
//
// Two separate defects put an order in the wrong month, and both are guarded
// here because either one alone reproduces the symptom:
//
//  1. ROLLING WINDOWS WEARING CALENDAR LABELS. "This month" must run from the
//     1st to the last of the month, and must CLOSE at that end — an open end
//     lets a forward-dated order into a month it is not in.
//  2. UTC PARSING AT THE BOUNDARY. Order dates arrive as ISO text, and
//     `new Date('2026-09-01')` is UTC midnight, which is the evening of 31
//     August anywhere west of Greenwich. Compared against a window built from
//     LOCAL midnights, every order dated the 1st fell into the previous month.
//     Both sides of the comparison must therefore be `YYYY-MM-DD` strings.
//
// Checked on the SOURCE. These are browser components with no test harness, and
// the damage is invisible in any single number: a month count that is wrong by
// nineteen still looks like a perfectly ordinary month count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ORDER_DASH = '../src/cashflow/components/OrderDashboard.tsx';
const OVERVIEW = '../src/cashflow/components/DashboardOverview.tsx';

test('the order dashboard scopes "This month" to the calendar month', () => {
  const src = read(ORDER_DASH);

  // The exact shapes that were there before. Either one returning means a
  // rolling window is wearing a calendar label again.
  assert.doesNotMatch(src, /getDate\(\) - 29/,
    '"This month" must not be a trailing 30 days');
  assert.doesNotMatch(src, /getDate\(\) - 6\b/,
    '"This week" must not be a trailing 7 days');

  // Both month periods — the current one and a picked one — resolve through the
  // SAME bounds, so the two can never drift apart.
  assert.match(src, /if \(preset === 'month' \|\| preset === 'pick'\) \{[\s\S]*?monthBounds\(preset === 'month' \? thisMonthKey\(\) : month\)/,
    'month periods must resolve through monthBounds()');

  // Day 0 of the NEXT month is the last day of this one: the end bound exists,
  // and February and leap years need no special case.
  assert.match(src, /new Date\(y, mo, 0\)\.getDate\(\)/,
    'monthBounds must close on the real last day of the month');
});

test('the order dashboard compares dates as day strings, never as parsed UTC', () => {
  const src = read(ORDER_DASH);

  // The row filter is the one place the window is applied.
  assert.match(src, /const d = dayOf\(o\.date\);[\s\S]*?if \(start != null && d < start\) return false;[\s\S]*?if \(end != null && d > end\) return false;/,
    'the row filter must compare dayOf() strings against both bounds');
  assert.doesNotMatch(src, /const t = o\.date \? new Date\(o\.date\)\.getTime\(\) : NaN/,
    'the row filter must not parse order dates into timestamps');

  // dayOf takes the day off the ISO TEXT, which is what keeps UTC out of it.
  // The slice is asserted as a plain substring: the line it lives on tests a
  // regex, and escaping one regex inside another is how a guard ends up
  // quietly matching nothing.
  assert.match(src, /const dayOf = \(raw: string \| null \| undefined\): string =>/,
    'dayOf must be the one helper that resolves an order to a day');
  assert.ok(src.includes('.test(s)) return s.slice(0, 10);'),
    'dayOf must slice the day out of the ISO string rather than parsing it');
  // toISOString() is the other way UTC gets in: it prints the previous day for
  // anyone west of Greenwich, so the local formatter must be the one in use.
  // The CALL is what is banned, not the word — the note on `iso` explains why
  // it is banned and would otherwise trip its own guard.
  assert.doesNotMatch(src, /\.toISOString\(\)/,
    'the order dashboard must format days locally, not through toISOString()');
});

test('a picked month survives being saved as a view', () => {
  // The field has to be named in three places or a saved month view comes back
  // naming a period it no longer carries: the client type, the control that
  // hands the filters over, and the server whitelist that writes them down.
  assert.match(read('../src/cashflow/strivenApi.ts'), /export type DashFilters = \{[^}]*month\?: string/,
    'DashFilters must carry the month');
  assert.match(read(ORDER_DASH), /current=\{\{ preset, from, to, vert, month \}\}/,
    'the saved-view control must be handed the month');
  assert.match(read('./_striven.js'), /month: String\(view\?\.filters\?\.month \?\? ''\),/,
    'saveDashboardView must copy the month through its filter whitelist');
});

test('the overview dashboard closes its named periods', () => {
  const src = read(OVERVIEW);

  // "This month" and "This year" ran to Infinity, which let a forward-dated
  // order sit inside a period it is not in.
  assert.doesNotMatch(src, /period === 'mtd'[^\n]*Infinity/,
    '"This month" must close at the end of the month');
  assert.doesNotMatch(src, /period === 'ytd'[^\n]*Infinity/,
    '"This year" must close at the end of the year');
  assert.match(src, /if \(period === 'mtd'\) return \{ from: isoDay\(new Date\(now\.getFullYear\(\), now\.getMonth\(\), 1\)\), to: isoDay\(endOfMonth\) \}/,
    '"This month" must run from the 1st to the last of the current month');

  // Same UTC trap as the order board: the window is day strings on both sides.
  assert.doesNotMatch(src, /const t = new Date\(o\.date\)\.getTime\(\);/,
    'the overview filter must not parse order dates into timestamps');
  assert.match(src, /if \(!d \|\| d < win\.from \|\| d > win\.to\) return false;/,
    'the overview filter must compare day strings against both bounds');
});
