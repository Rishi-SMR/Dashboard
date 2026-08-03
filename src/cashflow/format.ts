// Currency is NOT defined here. It comes from `@money`, which vite resolves to
// the real formatter for the exec build and to a throwing stub for the rep
// build (see vite.config.ts).
//
// This file is imported by shared components that both audiences render, so an
// Intl currency formatter declared here would ship to reps regardless of which
// build ran — which is exactly what happened before: `npm run verify:rep`
// found `style:"currency"` and `'USD'` in the rep bundle, traced to this
// module. Keep the definition in @money so the alias can do its job.
import { formatUsd, formatUsdCents } from '@money';

export function formatCurrency(n: number, detailed = false): string {
  return detailed ? formatUsdCents(n) : formatUsd(n);
}

/**
 * Order status classification — ONE definition, because the naive version was
 * duplicated eight times and every copy carried the same bug.
 *
 * `/complete|closed|done/` matches "Incomplete", since "complete" is a
 * substring of it. That put every Incomplete order into the Delivered bucket:
 * the Delivered drill listed orders whose own Status column read "Incomplete".
 *
 * Two defences, deliberately belt-and-braces:
 *   1. an explicit incomplete check that wins outright, so intent does not
 *      depend on regex subtlety;
 *   2. word boundaries — `\bcomplete` cannot match "incomplete" because "n"
 *      and "c" are both word characters, so there is no boundary between them.
 */
export const isIncompleteStatus = (s: string | null | undefined): boolean =>
  /\bin[\s-]?complete\b/i.test(String(s ?? ''));

export const isCompletedStatus = (s: string | null | undefined): boolean => {
  const v = String(s ?? '');
  if (isIncompleteStatus(v)) return false;
  return /\b(?:complete|completed|closed|done|delivered|fulfilled)\b/i.test(v);
};

/**
 * Is this a real billed account?
 *
 * Mirrors isRealAccount in api/_striven.js — the two MUST agree, and did not:
 * the server filtered "Unassigned" out of its account count while Orders &
 * Revenue counted every distinct value, so the same book read 78 accounts on
 * one screen and 79 on the other.
 *
 * "Unassigned" is a placeholder for an order with no payer (28 orders, mostly
 * DEMO), not a customer. Test payers are already folded into it server-side, so
 * excluding this one value is sufficient here.
 */
export const isRealAccount = (account: string | null | undefined): boolean => {
  const s = String(account ?? '').trim();
  return Boolean(s) && !/^unassigned$/i.test(s);
};

export const isCancelledStatus = (s: string | null | undefined): boolean =>
  /\b(?:cancel|cancelled|canceled|void|voided|denied|rejected|lost)\b/i.test(String(s ?? ''));

/** Anything live: not finished, not cancelled. Incomplete belongs HERE. */
export const isPendingStatus = (s: string | null | undefined): boolean =>
  !isCompletedStatus(s) && !isCancelledStatus(s);

// US phone: "9566275137" -> "(956) 627-5137"; 11-digit "1..." -> "+1 (…) …".
// Leaves anything that isn't a 10/11-digit US number as-is (trimmed).
export function formatPhone(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}

// Windowed pagination page list: 1 2 3 … cur-1 cur cur+1 … total (dedup/sorted).
// Shared by the tables so later pages stay directly reachable (not capped at 7).
export function pageList(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, 2, 3, cur - 1, cur, cur + 1, total]);
  const nums = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push('…');
    out.push(nums[i]);
  }
  return out;
}

// Keyboard-accessible props for a clickable non-button element (div/row).
// Spread onto the element and drop the bare onClick: adds role/tabIndex + Enter/Space.
export function clickableProps(onClick: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    },
  };
}
