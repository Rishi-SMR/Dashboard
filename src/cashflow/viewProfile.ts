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
  // 'overview.growth' is NOT hidden: the Business growth card — revenue and net
  // profit by month, off the P&L — was asked for on this board specifically. The
  // id exists so it CAN be dropped without editing OverviewCharts, not because
  // it is dropped.

  // 'overview.devices' is NO LONGER HIDDEN — Kevin asked for the units-by-device
  // breakdown on his own board, so the tile it totals has to be visible too.
  // Leaving the tile hidden would put a breakdown on the page with no headline
  // figure to reconcile it against.
  // 'overview.topVendors' is GONE, not hidden: the Top Vendors (by Spend) card
  // was removed from OverviewCharts entirely, so there is no longer a panel for
  // this id to switch off. Listing a dead id here would read as a panel someone
  // is still choosing to hide.
  //
  // 'overview.poSpendTop5' stays hidden for this board, but its reason has
  // changed: it was "duplicate of Top Vendors", and Top Vendors no longer
  // exists. It is now simply a vendor-spend card this board does not want —
  // and on every OTHER board it is the only one left.
  'overview.poSpendTop5',
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
/**
 * THE SELECTION IS PER LOGIN, NOT PER BROWSER.
 *
 * It used to be one key, `smr.viewProfile`, shared by everyone who ever signed
 * in on the machine. So Kevin's board — or one preview of it that nobody
 * switched back out of — became the DEFAULT for whoever signed in next:
 * Crystal would land on the curated Overview, panels missing, having chosen
 * nothing. Keying the store to the signed-in address is what stops one
 * person's choice from being the next person's default.
 *
 * `LEGACY_KEY` is deleted rather than migrated, and that is the point: reading
 * the old shared value into the current user's key would carry the very bug
 * forward under a new name.
 */
const LEGACY_KEY = 'smr.viewProfile';
const KEY = (who: string) => `smr.viewProfile:${who}`;
const EVENT = 'smr:viewprofile';

/**
 * The signed-in address, once /api/me has said so; null until then.
 *
 * Held at module scope for the same reason the selection is: `useHidden()` is
 * called from panels across eight lazily-loaded tabs, and every one of them
 * has to agree about whose board this is.
 */
let identity: string | null = null;

/**
 * `?view=crystal` / `?view=kevin` — THE WAY BACK.
 *
 * Kevin's board does not render the profile picker (his dashboard should read
 * as his, not as a view someone selected), and the choice is persisted, so
 * without this there would be no way to return to Crystal's view short of
 * clearing site data.
 *
 * HELD, NOT WRITTEN, until the login is known — there is no key to write it to
 * before that. It still takes effect immediately on screen, because `read()`
 * below prefers it while identity is pending.
 */
let pending: ViewProfile | null = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('view');
    return q === 'kevin' || q === 'crystal' ? q : null;
  } catch { return null; /* private mode, or no URL */ }
})();

/**
 * Binds the profile store to whoever signed in. Called once, app-level, off the
 * same /api/me the role gate uses.
 *
 * Everything before this call reads 'crystal', the unrestricted view. That is
 * deliberate in both directions: an unknown viewer must be shown MORE rather
 * than have panels hidden nobody asked to hide, and the pre-identity frame is
 * exactly where a stale 'kevin' used to leak in.
 */
export function setProfileIdentity(email?: string | null) {
  const who = String(email ?? '').trim().toLowerCase();
  if (!who || who === identity) return;
  identity = who;
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* private mode */ }
  // A `?view=` or a selection made before /api/me landed: persist it now, to
  // this login's key. setViewProfile fires the event, so this returns after.
  if (pending) { const v = pending; pending = null; setViewProfile(v); return; }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * KEVIN'S LOGIN DEFAULTS TO KEVIN'S BOARD; every other login defaults to the
 * unrestricted one.
 *
 * The curated view was previously reachable only through the shared key, which
 * meant Kevin's own board depended on somebody having selected it on that
 * browser — and per-login keys would have made that unreachable for him, since
 * his board renders no picker. His identity is the signal instead, and it is
 * the stronger one: a profile is a preview, a login is who you are.
 *
 * An explicit stored choice still wins, so `?view=crystal` remains his way out.
 */
const read = (): ViewProfile => {
  if (!identity) return pending ?? 'crystal';
  try {
    const v = localStorage.getItem(KEY(identity));
    if (v === 'kevin' || v === 'crystal') return v;
  } catch { /* private mode — fall through to the identity default */ }
  return isKevinLogin(identity) ? 'kevin' : 'crystal';
};

export function setViewProfile(v: ViewProfile) {
  // Chosen before /api/me landed. Held rather than dropped, and written to the
  // right key a moment later, so the picker never silently ignores a click.
  if (!identity) { pending = v; window.dispatchEvent(new CustomEvent(EVENT)); return; }
  try { localStorage.setItem(KEY(identity), v); } catch { /* private mode */ }
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
