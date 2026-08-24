import { C } from '../chartTheme';

/**
 * THE PERIOD PICKER, and the month vocabulary that goes with it.
 *
 * Extracted from RepsTab once a SECOND board needed it. The two would otherwise
 * have carried their own copies, which is exactly how this app ended up with one
 * control saying "Jun 2026" and another "June 2026" — a difference small enough
 * to look like two unrelated features and cause a month to be changed on the
 * wrong page.
 *
 * Full month names deliberately, matching the Period filter on the Overview
 * page. One vocabulary for periods across the whole app.
 */

/** Sentinel for "no month filter". Not a month string, so it cannot collide. */
export const ALL_TIME = 'all';

const MONTH_LABEL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-08' → 'August 2026'. Built from the parts rather than parsed as a date:
 *  `new Date('2026-08')` is UTC midnight and renders as the PREVIOUS month in
 *  any timezone behind UTC, which would mislabel every entry in the list. */
export const monthLabel = (m: string) => {
  const [y, mo] = m.split('-');
  const i = Number(mo) - 1;
  return MONTH_LABEL[i] ? `${MONTH_LABEL[i]} ${y}` : m;
};

/** The current month in LOCAL time, as a '2026-08' key. `toISOString()` would
 *  shift to UTC and roll the month over on the 1st for half the world. */
export const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Resolve the period a board should OPEN on.
 *
 * The current month, unless nothing was booked in it — on the 1st of a month, or
 * at a year turn, that names an empty period and the board would open on a blank
 * state that reads as a failed load. Falls back to the newest month that has
 * something in it, and to `fallback` when the list is empty entirely.
 */
export const defaultMonth = (months: string[], fallback: string = ALL_TIME) => {
  if (!months.length) return fallback;
  const now = thisMonthKey();
  return months.includes(now) ? now : months[months.length - 1];
};

export function MonthSelect({ months, month, onMonth, title }: {
  months: string[]; month: string; onMonth: (m: string) => void;
  /** Overrides the tooltip where a board wants to name what it re-scopes. */
  title?: string;
}) {
  if (!months.length) return null;
  return (
    // `.ov-filter` is the app's existing filter chip: a muted label beside a bare
    // select in a bordered pill. Reused rather than restyled, so this reads as
    // the same KIND of control as the Period filter on the Overview page.
    //
    // The label is VISIBLE. It was screen-reader-only once, which left a bare
    // month name floating in a card header — indistinguishable at a glance from
    // the other period control in this app.
    <label className="ov-filter" style={{ marginLeft: 'auto', flex: 'none' }}>
      <span className="fl">Period</span>
      <select value={month} onChange={(e) => onMonth(e.target.value)}
        title={title ?? 'Rank on a single month, or on the whole book'}
        style={{ color: C.ink }}>
        {/* Newest first: the month someone wants is nearly always the last one,
            and it should not sink to the bottom of a list that grows monthly. */}
        {[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        <option value={ALL_TIME}>All time</option>
      </select>
    </label>
  );
}
