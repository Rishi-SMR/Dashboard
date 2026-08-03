/**
 * Currency formatting: the single definition for the whole app.
 *
 * This was once swapped for a throwing stub (`money.rep.ts`) in a separate rep
 * build, so that bundle could not render currency at all. That split is gone:
 * the rep portal shows dollars on nearly every screen, so the stub would have
 * thrown everywhere, and rep visibility is now enforced by ROLE on the server
 * (company routes are admin-only; other reps' figures are nulled before
 * serialization) rather than by which bundle the browser downloaded.
 *
 * If you are about to import this from a component that both audiences render,
 * stop: split the component instead.
 */

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const usdCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Board figures: whole dollars, comma grouped. `$1,339,961`. */
export const formatUsd = (n: number): string =>
  Number.isFinite(n) ? usd.format(n) : '-';

/** Reconciliation figures, where cents have to tie out. */
export const formatUsdCents = (n: number): string =>
  Number.isFinite(n) ? usdCents.format(n) : '-';

/** Marks this build as the one that can render money. */
export const CAN_RENDER_MONEY = true;
