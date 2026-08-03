/**
 * Audience-neutral number formatting: safe in BOTH builds.
 *
 * There is deliberately no currency function here. Money lives in `./money`,
 * which the rep build does not resolve (see vite.config.ts). Adding a currency
 * formatter to this file would defeat that: this module is imported by the rep
 * bundle, so anything in it ships to a rep's browser.
 */

/** Counts and units. Grouped with commas, never abbreviated: a board that
 *  says "1.2k orders" cannot be reconciled against Striven. */
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const formatCount = (n: number): string =>
  Number.isFinite(n) ? integer.format(Math.round(n)) : '-';

/** Units are counts with a different word attached; kept separate so the call
 *  site reads as what it means. */
export const formatUnits = formatCount;

const oneDp = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Days Sales Outstanding. Returns the figure and its unit separately, because
 * they are typeset differently: the value is mono, the unit is Inter. Joining
 * them into one string would force the whole thing into one face.
 */
export function formatDso(days: number | null | undefined): { value: string; unit: string } {
  if (days == null || !Number.isFinite(days)) return { value: '-', unit: '' };
  return { value: oneDp.format(days), unit: days === 1 ? 'day' : 'days' };
}

/** Percentages. One decimal below 10, whole numbers above: precision where it
 *  changes a decision, not everywhere. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '-';
  const pct = fraction * 100;
  return `${Math.abs(pct) < 10 ? oneDp.format(pct) : integer.format(Math.round(pct))}%`;
}

/** Ratio of two counts, guarded against divide-by-zero. */
export const formatShare = (part: number, whole: number): string =>
  whole > 0 ? formatPercent(part / whole) : '-';
