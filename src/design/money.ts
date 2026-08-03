// Currency formatting for the EXEC audience — the only module in the tree that
// is allowed to name USD or construct an Intl currency formatter.
//
// vite.config.js aliases the bare specifier `@money` here for the exec build
// and to ./money.rep.ts for the rep build, so this file must never be imported
// by a relative path: that would bypass the alias and ship the formatter to
// reps regardless of which build ran.
//
// Restored from the pre-refactor implementation in src/cashflow/format.ts
// (commit 63018f8), which declared these two formatters inline before the
// audience split moved them behind the alias. Digit settings are unchanged:
// whole dollars by default, cents only when a caller asks for detail.

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currencyDetailed = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/** Whole dollars: 1234.56 -> "$1,235". */
export const formatUsd = (n: number): string => currency.format(n);

/** Dollars and cents: 1234.56 -> "$1,234.56". */
export const formatUsdCents = (n: number): string => currencyDetailed.format(n);
