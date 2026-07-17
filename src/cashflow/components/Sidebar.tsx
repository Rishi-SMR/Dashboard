import { useState } from 'react';
import { invalidateAllCaches } from '../api';
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
  pl: svg(<><line x1="6" y1="20" x2="6" y2="12" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="9" /></>),
  orders: svg(<><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M3 4h2l2.4 11.4a1 1 0 0 0 1 .6h8.8a1 1 0 0 0 1-.8L20 8H6" /></>),
  tracking: svg(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M6 8.2v7.6" /><path d="M18 8.2A9 9 0 0 1 9 17" /></>),
  vendors: svg(<><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20a6.4 6.4 0 0 1 12.4 0" /><path d="M16 5a3.4 3.4 0 0 1 0 6.4" /><path d="M17.6 14.6a6.4 6.4 0 0 1 3.6 5.4" /></>),
  catalog: svg(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 20 7.5" /><path d="M12 12v9" /><path d="M12 12 4 7.5" /></>),
  accounts: svg(<><path d="m3 9 9-6 9 6" /><path d="M5 9v9" /><path d="M9.7 9v9" /><path d="M14.3 9v9" /><path d="M19 9v9" /><path d="M3 21h18" /></>),
  exceptions: svg(<><path d="M12 3 2.8 19.2a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><line x1="12" y1="17.2" x2="12" y2="17.3" /></>),
};

// Views that live inside another tab — highlight the parent nav item.
const VIEW_ALIAS: Partial<Record<ViewKey, ViewKey>> = { payables: 'receivables', tracking: 'orders', catalog: 'vendors' };

const ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'receivables', label: 'AR / AP' },
  { key: 'pl', label: 'P&L' },
  { key: 'orders', label: 'Orders' },
  { key: 'vendors', label: 'Vendors & Items' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'exceptions', label: 'Exceptions' },
];

// Optional profile-photo + title fallbacks keyed by username. Left empty in the
// generic template; the signed-in user's own values take precedence.
const PHOTOS: Record<string, string> = {};
const TITLES: Record<string, string> = {};

function readIdentity() {
  // The login screen stores the signed-in username in localStorage (cleared on
  // sign-out); sessionStorage keys are a legacy fallback.
  const get = (k: string) => {
    try { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; } catch { return ''; }
  };
  const email = get('smr_user');
  const raw = get('smr_name') || (email ? email.split('@')[0].split(/[._]/)[0] : 'User');
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  const emailUser = email ? email.split('@')[0].toLowerCase() : '';
  const title = get('smr_title') || TITLES[raw.toLowerCase()] || 'Full access';
  const photo = get('smr_photo') || PHOTOS[raw.toLowerCase()] || PHOTOS[emailUser] || '';
  const initial = (name || 'U').trim().charAt(0).toUpperCase();
  return { name, title, photo, initial };
}

type Props = {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  /** Company name of the connected Striven tenant. */
  identifier?: string;
  connected: boolean;
  onSignOut?: () => void;
};

export function Sidebar({ view, onChange, identifier, connected, onSignOut }: Props) {
  // Global Refresh All - reload the page so every tab re-fetches fresh data.
  const [refreshing, setRefreshing] = useState(false);
  const me = readIdentity();

  async function handleRefreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    try { await invalidateAllCaches(); } catch { /* even if it fails, reload below */ }
    window.location.reload();
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo" style={{ background: '#fff', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src="/SMR%20Logo.png" alt="SMR" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">SMR Dashboard</div>
          <div className="brand-sub">Sports Med Recovery</div>
        </div>
      </div>

      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`nav-item ${view === item.key || VIEW_ALIAS[view] === item.key ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
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
            <div className="who-role">{me.title}</div>
          </div>
        </div>

        {/* Striven connection status (configured server-side via striven-server/.env). */}
        <div
          className="btn ghost"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 6, cursor: 'default' }}
          title={connected ? `Linked to Striven${identifier ? ` · ${identifier}` : ''}` : 'Striven not connected — set credentials in striven-server/.env'}
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
  );
}
