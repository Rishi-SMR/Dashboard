import { useState } from 'react';
import { invalidateAllCaches } from '../api';
import type { ViewKey } from '../CashflowApp';

const ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'payables', label: 'Payables' },
  { key: 'pl', label: 'P&L' },
  { key: 'orders', label: 'Orders' },
  { key: 'tracking', label: 'Order Tracking' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'exceptions', label: 'Exceptions' },
];

// Optional profile-photo + title fallbacks keyed by username. Left empty in the
// generic template; the signed-in user's own values take precedence.
const PHOTOS: Record<string, string> = {};
const TITLES: Record<string, string> = {};

function readIdentity() {
  const get = (k: string) => (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(k) : '') || '';
  const email = get('smr_user');
  const name = get('smr_name') || (email ? email.split('@')[0].split(/[._]/)[0] : 'User');
  const emailUser = email ? email.split('@')[0].toLowerCase() : '';
  const title = get('smr_title') || TITLES[name.toLowerCase()] || 'Full access';
  const photo = get('smr_photo') || PHOTOS[name.toLowerCase()] || PHOTOS[emailUser] || '';
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
        <div>
          <div className="brand-name">SMR</div>
        </div>
      </div>

      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`nav-item ${view === item.key ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
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
