import { useEffect, useState } from 'react';

/**
 * VIEW PROFILES — a curated set of panels to hide for one audience.
 *
 * This is presentation ONLY. It is not access control and must never be used as
 * such: the server still returns everything the caller's ROLE permits, so a
 * hidden panel is hidden, not forbidden. Anything that genuinely must not reach
 * a browser is redacted server-side, the way peers' commission and revenue
 * already are.
 *
 * Why hide-lists rather than show-lists: a panel added to the app next month
 * should appear by default and be dropped deliberately, not vanish because
 * nobody remembered to add it to an allow-list.
 *
 * IDs are `tab.element`, chosen to survive renaming a heading.
 */
/**
 * The Company side has exactly TWO audiences — Crystal Chambers (finance/ops,
 * the unrestricted view) and Kevin (the curated owner view). Reps never reach
 * it at all: `allowedViews` keeps the whole company nav out of REP_NAV, so they
 * are not an option here and must not be listed as one.
 */
export type ViewProfile = 'crystal' | 'kevin';

/**
 * Is this Kevin's own login?
 *
 * The "no View as picker on Kevin's board" rule was keyed on the PROFILE alone,
 * which is a localStorage preference. Kevin signing in on a fresh browser gets
 * the default 'crystal' profile and therefore saw every picker — the opposite of
 * what was asked for. His identity has to count too, and it is the stronger
 * signal of the two: a profile is a preview, a login is who you are.
 *
 * Matched on the local part so the address survives a domain change.
 */
export const isKevinLogin = (email?: string | null): boolean =>
  /^kevin@/i.test(String(email ?? '').trim());

export const PROFILE_LABEL: Record<ViewProfile, string> = {
  crystal: 'Crystal Chambers',
  kevin: 'Kevin',
};

/**
 * Kevin's dashboard, per the brief. Reasons are kept beside each entry because
 * "why is this gone" is the question a future reader will actually have.
 *
 * NOT hidden, though the brief listed them: overview.revenue,
 * overview.cashReceived, overview.cashFlow, overview.revVsExpense and
 * overview.collectionRate. They were marked DROP/FIX as "broken date filter",
 * but the filter is correct — /api/trends and /api/payments simply carry no row
 * for the current month yet. They stay until the data question is settled.
 */
const KEVIN_HIDDEN: string[] = [
  // ── Overview ──
  // 'overview.devices' is NO LONGER HIDDEN — Kevin asked for the units-by-device
  // breakdown on his own board, so the tile it totals has to be visible too.
  // Leaving the tile hidden would put a breakdown on the page with no headline
  // figure to reconcile it against.
  'overview.topVendors',        // duplicated on the Vendors tab
  'overview.poSpendTop5',       // duplicate of Top Vendors
  // Reverses the original brief, which kept this as a "data-trust signal".
  // Dropped on request. NOTE: it is only the Overview PREVIEW that goes — the
  // Exceptions tab itself is untouched and still reachable from the nav and the
  // header bell, so the 64 items are not hidden, just not on this board.
  'overview.exceptions',
  'overview.collectionRate',    // dropped on request

  // ── AR / AP · Receivables ──
  'ar.accounts',                // count only, low value
  'ar.overdueSummary',          // redundant with AR Aging
  'ar.recentPayments',          // operational detail, not decision-level

  // ── AR / AP · Payables ──
  'ap.openBillsCount',          // already in the AP Open card
  'ap.billsPaidKpi',            // trivial amount
  'ap.billsPaidTable',          // one row
  'ap.vendorsList',             // belongs only on the Vendors tab

  // ── P&L ──
  'pl.cashReceived',            // already on the AR tab; keep it in one place
  'pl.expensesByVendor',        // overlaps Vendor PO Spend / Reports

  // ── Orders ──
  'orders.cancelled',           // excluded from totals anyway
  'orders.byStatus',            // same information as the KPI cards above it

  // ── Vendors & Items ──
  'vendors.suppliers',          // mostly prospects, inflated
  'vendors.prospect',           // not decision-relevant here
  'vendors.byStatus',           // pie of mostly "prospect"

  // ── Accounts (accountant-facing; only the Chart of Accounts survives) ──
  'accounts.glAccounts',
  'accounts.paymentsReceived',
  'accounts.billsPaid',
  'accounts.activeAccounts',
  'accounts.byType',
  'accounts.paymentsByMonth',
  'accounts.billPaymentsPaid',
  'accounts.recentPayments',
];

const HIDDEN: Record<ViewProfile, Set<string>> = {
  crystal: new Set(),                 // finance/ops: the whole board, nothing dropped
  kevin: new Set(KEVIN_HIDDEN),
};

// ── The live selection ───────────────────────────────────────────────────────
// Module-level rather than React context: the picker lives in the Overview
// header but the panels it governs are spread across eight lazily-loaded tabs,
// and threading a provider through all of them buys nothing a subscription
// does not. Persisted so the preview survives a tab switch or a reload.
const KEY = 'smr.viewProfile';
const EVENT = 'smr:viewprofile';

/**
 * `?view=crystal` / `?view=kevin` — THE WAY BACK.
 *
 * Kevin's board does not render the profile picker (his dashboard should read
 * as his, not as a view someone selected), and the choice is persisted, so
 * without this there would be no way to return to Crystal's view short of
 * clearing site data. The URL sets the stored profile once at load; every read
 * after that is the ordinary localStorage path.
 *
 * Applied at module scope rather than inside `read()` so it happens exactly
 * once — `read()` runs on every profile event and must stay a pure read.
 */
try {
  const q = new URLSearchParams(window.location.search).get('view');
  if (q === 'kevin' || q === 'crystal') localStorage.setItem(KEY, q);
} catch { /* private mode, or no URL — fall through to the stored value */ }

// Defaults to Crystal's unrestricted view: a stored value that no longer maps
// to a profile must fall back to showing MORE, never to hiding panels nobody
// asked to hide.
const read = (): ViewProfile => {
  try {
    return localStorage.getItem(KEY) === 'kevin' ? 'kevin' : 'crystal';
  } catch { return 'crystal'; }
};

export function setViewProfile(v: ViewProfile) {
  try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useViewProfile(): ViewProfile {
  const [v, setV] = useState<ViewProfile>(read);
  useEffect(() => {
    const h = () => setV(read());
    window.addEventListener(EVENT, h);
    // `storage` fires only in OTHER tabs, so a second window follows along.
    window.addEventListener('storage', h);
    return () => { window.removeEventListener(EVENT, h); window.removeEventListener('storage', h); };
  }, []);
  return v;
}

/** `hide('overview.devices')` → true when the active profile drops that panel. */
export function useHidden(): (id: string) => boolean {
  const profile = useViewProfile();
  return (id: string) => HIDDEN[profile].has(id);
}
