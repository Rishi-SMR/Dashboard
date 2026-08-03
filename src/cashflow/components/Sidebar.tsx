import { useState } from 'react';
import type { ViewKey } from '../CashflowApp';

// 16px stroke icons per nav item (lucide-style, currentColor).
const svg = (children: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const NAV_ICONS: Record<ViewKey, React.ReactNode> = {
  overview: svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>),
  receivables: svg(<><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>),
  payables: svg(<><rect x="2.5" y="5" width="19" height="14" rx="2" /><line x1="2.5" y1="10" x2="21.5" y2="10" /></>),
  apsheet: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 3.5V6h8V3.5" /><line x1="8" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="16" y2="14" /><line x1="8" y1="18" x2="13" y2="18" /></>),
  pl: svg(<><line x1="6" y1="20" x2="6" y2="12" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="9" /></>),
  orders: svg(<><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M3 4h2l2.4 11.4a1 1 0 0 0 1 .6h8.8a1 1 0 0 0 1-.8L20 8H6" /></>),
  tracking: svg(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M6 8.2v7.6" /><path d="M18 8.2A9 9 0 0 1 9 17" /></>),
  autopo: svg(<><path d="M3 4h2l2.4 11.4a1 1 0 0 0 1 .6h8.8a1 1 0 0 0 1-.8L20 8H6" /><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M13 4.5l1.8 1.8L18 3" /></>),
  autoso: svg(<><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.5 4v4.2h-4.2" /></>),
  automation: svg(<><rect x="7" y="7" width="10" height="10" rx="1.6" /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" /></>),
  vendors: svg(<><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20a6.4 6.4 0 0 1 12.4 0" /><path d="M16 5a3.4 3.4 0 0 1 0 6.4" /><path d="M17.6 14.6a6.4 6.4 0 0 1 3.6 5.4" /></>),
  catalog: svg(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 20 7.5" /><path d="M12 12v9" /><path d="M12 12 4 7.5" /></>),
  accounts: svg(<><path d="m3 9 9-6 9 6" /><path d="M5 9v9" /><path d="M9.7 9v9" /><path d="M14.3 9v9" /><path d="M19 9v9" /><path d="M3 21h18" /></>),
  exceptions: svg(<><path d="M12 3 2.8 19.2a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><line x1="12" y1="17.2" x2="12" y2="17.3" /></>),
  quickbooks: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 8.5c-1.7 0-2.8.9-2.8 2.2 0 2.6 4.4 1.6 4.4 3.6 0 .9-.8 1.4-1.9 1.4" /><path d="M12 7v10" /></>),
  reports: svg(<><path d="M4 4v16h16" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></>),
  commission: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M14.5 9.3c-.5-.8-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 1.9 0 2.4 5.2 1.4 5.2 3.9 0 1.1-1.1 1.9-2.6 1.9-1.1 0-2.1-.5-2.6-1.3" /></>),
  // Reps: a person with a rising bar behind them: people plus performance.
  reps: svg(<><circle cx="8.5" cy="8" r="3.2" /><path d="M2.6 20a5.9 5.9 0 0 1 11.8 0" /><path d="M17 14v6" /><path d="M20.5 10v10" /></>),
  repsorders: svg(<><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M3 4h2l2.4 11.4a1 1 0 0 0 1 .6h8.8a1 1 0 0 0 1-.8L20 8H6" /></>),
  repspipeline: svg(<><rect x="3" y="5" width="5" height="14" rx="1.4" /><rect x="9.5" y="5" width="5" height="9" rx="1.4" /><rect x="16" y="5" width="5" height="5" rx="1.4" /></>),
  repsroster: svg(<><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20a6.4 6.4 0 0 1 12.4 0" /><path d="M16 5a3.4 3.4 0 0 1 0 6.4" /><path d="M17.6 14.6a6.4 6.4 0 0 1 3.6 5.4" /></>),
  // Standings: a podium.
  standings: svg(<><rect x="9" y="4" width="6" height="16" /><rect x="3" y="10" width="6" height="10" /><rect x="15" y="13" width="6" height="7" /></>),
};

// Views that live inside another tab: highlight the parent nav item.
const VIEW_ALIAS: Partial<Record<ViewKey, ViewKey>> = { payables: 'receivables', tracking: 'orders', catalog: 'vendors', autopo: 'automation', autoso: 'automation' };

// ── Role-driven navigation ───────────────────────────────────────────────────
// One app, two sides. An admin runs the business AND oversees the reps, so they
// get a Company/Reps switch. A rep only ever runs their own book: there is no
// switch, no company side, and no way to reach one.
//
// A manager and a rep get different vocabularies for the same underlying views
// ("Orders & Revenue" vs "My Orders") because the scope genuinely differs: the
// server has already narrowed a rep's payload to their own figures.
export type Mode = 'company' | 'reps';

/** Company side: the finance/ops dashboard, exactly as it always was. */
export const COMPANY_NAV: Array<{ key: ViewKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'receivables', label: 'AR / AP' },
  { key: 'apsheet', label: 'AP Register' },
  { key: 'pl', label: 'P&L' },
  { key: 'orders', label: 'Orders' },
  { key: 'automation', label: 'Automation' },
  { key: 'vendors', label: 'Vendors & Items' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'reports', label: 'Reports' },
  { key: 'quickbooks', label: 'QuickBooks' },
];
/** Reps side as an ADMIN sees it: every rep, unredacted. */
export const REPS_NAV: Array<{ key: ViewKey; label: string }> = [
  { key: 'reps', label: 'Dashboard' },
  { key: 'repsorders', label: 'Orders & Revenue' },
  { key: 'commission', label: 'Commission' },
  { key: 'repspipeline', label: 'PI Pipeline' },
  { key: 'repsroster', label: 'Reps' },
];
/** What a REP sees. Same views, narrowed to their own book by the server. */
export const REP_NAV: Array<{ key: ViewKey; label: string }> = [
  { key: 'reps', label: 'My Dashboard' },
  { key: 'repsorders', label: 'My Orders' },
  { key: 'commission', label: 'My Commission' },
  { key: 'repspipeline', label: 'My Pipeline' },
  { key: 'standings', label: 'Team Standings' },
];

/** Nav for a role. Until /api/me answers (role null) we show the rep nav: the
 *  narrow one: so a rep never sees the manager's entries flash past. */
export const navFor = (role: 'admin' | 'rep' | null, mode: Mode = 'reps'): Array<{ key: ViewKey; label: string }> =>
  (role === 'admin' ? (mode === 'company' ? COMPANY_NAV : REPS_NAV) : REP_NAV);

/**
 * Every view a role may reach: INCLUDING by typing a URL hash.
 *
 * The sidebar deciding what to draw is not access control: `#pl` used to open
 * the company P&L for anyone, because the router accepted any key in VIEW_KEYS.
 * This is the allow-list the router enforces, so a rep cannot navigate out of
 * their own book. Aliases (e.g. #payables → receivables) are allowed only when
 * the view they resolve to is.
 */
export const allowedViews = (role: 'admin' | 'rep' | null): Set<ViewKey> => {
  const base = role === 'admin'
    ? [...COMPANY_NAV, ...REPS_NAV].map((i) => i.key)
    : REP_NAV.map((i) => i.key);
  const set = new Set<ViewKey>(base);
  for (const [alias, target] of Object.entries(VIEW_ALIAS) as Array<[ViewKey, ViewKey]>) {
    if (set.has(target)) set.add(alias);
  }
  return set;
};

/** The tab a role opens on: the first one its nav actually offers. */
export const defaultViewFor = (role: 'admin' | 'rep' | null, mode: Mode = 'reps'): ViewKey =>
  navFor(role, mode)[0]?.key ?? 'reps';
/** Back-compat for the pre-role entry point. */
export const DEFAULT_VIEW: ViewKey = REPS_NAV[0]?.key ?? 'reps';

// Optional profile-photo + title fallbacks keyed by username. Left empty in the
// generic template; the signed-in user's own values take precedence.
const PHOTOS: Record<string, string> = {};
const TITLES: Record<string, string> = {};

// Who gets a role line under their name in the sidebar. Everyone else shows the
// name alone.
//
// This used to be `TITLES[...] || 'Full access'` with TITLES empty: so EVERY
// signed-in user, reps included, was labelled "Full access". It was only ever a
// display string (permissions come from the server-side role), but it told four
// reps they had company-wide access they do not have.
const ROLE_LINE_FOR = new Set(['rishi', 'crystal']);

function readIdentity() {
  // The server sets a JS-readable smr_user cookie on login (cleared on
  // sign-out); localStorage/sessionStorage are fallbacks for older sessions.
  const cookieUser = () => {
    try { const m = document.cookie.match(/(?:^|; )smr_user=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; }
  };
  const get = (k: string) => {
    try { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; } catch { return ''; }
  };
  const email = cookieUser() || get('smr_user');
  const raw = get('smr_name') || (email ? email.split('@')[0].split(/[._]/)[0] : 'User');
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  const emailUser = email ? email.split('@')[0].toLowerCase() : '';
  const title = get('smr_title') || TITLES[raw.toLowerCase()] || '';
  const photo = get('smr_photo') || PHOTOS[raw.toLowerCase()] || PHOTOS[emailUser] || '';
  const initial = (name || 'U').trim().charAt(0).toUpperCase();
  return { name, title, photo, initial, showRole: ROLE_LINE_FOR.has(emailUser) };
}

type Props = {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  /** Company name of the connected Striven tenant. */
  identifier?: string;
  connected: boolean;
  onSignOut?: () => void;
  /** Resolved by the app from /api/me: the sidebar never fetches it itself, so
   *  the nav and the router can never disagree about who is signed in. */
  role: 'admin' | 'rep' | null;
  /** Admin-only Company/Reps switch. Ignored for a rep. */
  mode: Mode;
  onMode: (m: Mode) => void;
};

export function Sidebar({ view, onChange, identifier, connected, onSignOut, role, mode, onMode }: Props) {
  // Global Refresh All - reload the page so every tab re-fetches fresh data.
  const [refreshing, setRefreshing] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const me = readIdentity();
  const ITEMS = navFor(role, mode);

  function handleRefreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    // A full reload makes every tab re-fetch fresh data from the server.
    window.location.reload();
  }
  // Nav pick also closes the mobile drawer.
  const pick = (v: ViewKey) => { onChange(v); setMobileOpen(false); };
  const active = ITEMS.find((i) => i.key === view || VIEW_ALIAS[view] === i.key)?.label ?? 'SMR Dashboard';

  return (
    <>
      {/* Mobile top bar (≤900px via CSS): hamburger opens the nav drawer. */}
      <div className="mobile-topbar">
        <button className="hamburger" onClick={() => setMobileOpen(true)} aria-label="Open menu" aria-expanded={mobileOpen}>☰</button>
        <img className="mt-logo" src="/SMR%20Logo.png" alt="SMR" />
        <span className="mt-title">{active}</span>
      </div>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-logo" style={{ background: '#fff', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src="/SMR%20Logo.png" alt="SMR" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">SMR Dashboard</div>
          <div className="brand-sub">Sports Med Recovery</div>
        </div>
      </div>

      {/* Company ⇄ Reps: admins only. A rep has no second side to switch to, so
          rendering this for them would advertise a door that is bolted shut. */}
      {role === 'admin' && (
        <div className="segmented mode-switch" role="tablist" aria-label="Switch section">
          <button
            role="tab"
            aria-selected={mode === 'company'}
            className={mode === 'company' ? 'active' : ''}
            onClick={() => { onMode('company'); setMobileOpen(false); }}
          >
            Company
          </button>
          <button
            role="tab"
            aria-selected={mode === 'reps'}
            className={mode === 'reps' ? 'active' : ''}
            onClick={() => { onMode('reps'); setMobileOpen(false); }}
          >
            Reps
          </button>
        </div>
      )}

      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`nav-item ${view === item.key || VIEW_ALIAS[view] === item.key ? 'active' : ''}`}
          onClick={() => pick(item.key)}
        >
          <span className="nav-icon">{NAV_ICONS[item.key]}</span>
          <span>{item.label}</span>
        </button>
      ))}

      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="avatar" style={{ position: 'relative', overflow: 'hidden' }}>
            {me.initial}
            {me.photo && (
              <img
                src={me.photo}
                alt=""
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
              />
            )}
          </div>
          <div className="who">
            <div className="who-name">{me.name}</div>
            {/* Role line only for the two accounts in ROLE_LINE_FOR, and the
                label comes from the verified /api/me role rather than a
                hardcoded string, so it cannot claim access the session lacks. */}
            {me.showRole && role && (
              <div className="who-role">{me.title || (role === 'admin' ? 'Admin' : 'Rep')}</div>
            )}
          </div>
        </div>

        {/* Striven connection status (configured server-side via striven-server/.env). */}
        <div
          className="btn ghost"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 6, cursor: 'default' }}
          title={connected ? `Linked to Striven${identifier ? ` · ${identifier}` : ''}` : 'Striven not connected: set credentials in striven-server/.env'}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: connected ? '#22c55e' : '#ef4444' }} />
          <span>{connected ? `Striven · ${identifier ?? 'Connected'}` : 'Striven · Not connected'}</span>
        </div>

        <button className="btn" onClick={handleRefreshAll} disabled={refreshing} style={{ display: 'block', width: '100%', marginBottom: 8, background: refreshing ? 'var(--muted)' : 'var(--accent)' }} title="Reload every tab with fresh data">
          {refreshing ? 'Refreshing…' : '↻ Refresh All Data'}
        </button>

        {onSignOut && (
          <button className="btn ghost" onClick={onSignOut} style={{ marginTop: 4 }}>Sign out</button>
        )}
      </div>
      </aside>
    </>
  );
}
