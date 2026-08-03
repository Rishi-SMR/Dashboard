// Currency formatting for the REP audience — deliberately absent.
//
// vite.config.js aliases `@money` here when SMR_AUDIENCE=rep. The point is that
// the rep bundle must contain no Intl currency formatter, no currency-code
// literal and no dollar-sign string, because hiding money in CSS on a shared
// codebase still ships the numbers to the browser where devtools can read them.
// Excluding the module is the enforcement point; this file is what makes the
// exclusion observable rather than implicit.
//
// These throw instead of returning a placeholder so that a component rendering
// money to a rep fails loudly in review, rather than silently rendering "--"
// and leaving the leak to be discovered later. Nothing in the rep tree should
// call them — if one does, that component needs an audience guard, not a
// softer stub here.
//
// Keep this file free of any currency token: the whole contract is that the
// strings do not exist in the rep output.

const notForReps = (): never => {
  throw new Error('money formatting is not available in the rep bundle');
};

export const formatUsd = (_n: number): string => notForReps();

export const formatUsdCents = (_n: number): string => notForReps();
