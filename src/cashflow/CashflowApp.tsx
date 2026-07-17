import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { fetchStrivenStatus, type StrivenStatus } from './strivenApi';

// Lazy-loaded so recharts (heavy) only downloads when a chart tab is opened.
const OverviewCharts = lazy(() => import('./components/OverviewCharts').then((m) => ({ default: m.OverviewCharts })));
const OrdersTab = lazy(() => import('./components/OrdersTab').then((m) => ({ default: m.OrdersTab })));
const ArApTab = lazy(() => import('./components/ArApTab').then((m) => ({ default: m.ArApTab })));
const PLTab = lazy(() => import('./components/PLTab').then((m) => ({ default: m.PLTab })));
const VendorsItemsTab = lazy(() => import('./components/VendorsItemsTab').then((m) => ({ default: m.VendorsItemsTab })));
const AccountsTab = lazy(() => import('./components/AccountsTab').then((m) => ({ default: m.AccountsTab })));
const ExceptionsTab = lazy(() => import('./components/ExceptionsTab').then((m) => ({ default: m.ExceptionsTab })));

const LazyLoading = () => <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading…</div>;

export type ViewKey = 'overview' | 'receivables' | 'payables' | 'pl' | 'orders' | 'tracking' | 'vendors' | 'catalog' | 'accounts' | 'exceptions';

export default function App() {
  // null = checking, true = allowed, false = needs login (gate enabled server-side).
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/status').then((r) => setAuthed(r.status !== 401)).catch(() => setAuthed(true));
  }, []);
  const signOut = () => {
    try { localStorage.removeItem('smr_user'); } catch { /* ignore */ }
    fetch('/api/logout', { method: 'POST' }).catch(() => {}).finally(() => window.location.reload());
  };
  if (authed === null) return null;
  if (!authed) return <LoginScreen onOk={() => setAuthed(true)} />;
  return <Dashboard onSignOut={signOut} />;
}

function LoginScreen({ onOk }: { onOk: () => void }) {
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: pw }) });
      if (r.ok) {
        try { localStorage.setItem('smr_user', username.trim()); } catch { /* storage may be blocked */ }
        onOk();
      } else setErr('Invalid username or password');
    } catch { setErr('Could not reach the server'); }
    finally { setBusy(false); }
  }
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/SMR%20Logo.png" alt="Sports Med Recovery" />
        <div className="login-sub">Sign in to your dashboard</div>
        {err && <div className="login-err">{err}</div>}
        <div className="login-field">
          <label>Username</label>
          <input className="login-input" type="text" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="" />
        </div>
        <div className="login-field">
          <label>Password</label>
          <input className="login-input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="" />
        </div>
        <button className="login-btn" type="submit" disabled={busy || !username || !pw}>
          {busy ? <><span className="login-spinner" />Signing in…</> : 'Sign in'}
        </button>
        <div className="login-foot">🔒 Secure access · PHI protected</div>
      </form>
    </div>
  );
}

const VIEW_KEYS: ViewKey[] = ['overview', 'receivables', 'payables', 'pl', 'orders', 'tracking', 'vendors', 'catalog', 'accounts', 'exceptions'];
const initialView = (): ViewKey => {
  const h = (typeof location !== 'undefined' ? location.hash.replace('#', '') : '') as ViewKey;
  return VIEW_KEYS.includes(h) ? h : 'overview';
};

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [view, setViewRaw] = useState<ViewKey>(initialView);
  const setView = (v: ViewKey) => { setViewRaw(v); if (typeof history !== 'undefined') history.replaceState(null, '', `#${v}`); };
  const [striven, setStriven] = useState<StrivenStatus | null>(null);

  useEffect(() => {
    fetchStrivenStatus().then(setStriven).catch(() => setStriven({ connected: false, company: null }));
  }, []);

  // Let #hash links (e.g. Overview stat-tiles) switch tabs.
  useEffect(() => {
    const onHash = () => { const h = location.hash.replace('#', '') as ViewKey; if (VIEW_KEYS.includes(h)) setViewRaw(h); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const TABS: Record<ViewKey, ReactNode> = {
    overview: <OverviewCharts />,
    receivables: <ArApTab initialMode="ar" />,
    payables: <ArApTab initialMode="ap" />,
    pl: <PLTab />,
    orders: <OrdersTab />,
    tracking: <OrdersTab initialMode="tracking" />,
    vendors: <VendorsItemsTab initialMode="vendors" />,
    catalog: <VendorsItemsTab initialMode="items" />,
    accounts: <AccountsTab />,
    exceptions: <ExceptionsTab />,
  };

  return (
    <div className="shell">
      <Sidebar
        view={view}
        onChange={setView}
        connected={striven?.connected ?? false}
        onSignOut={onSignOut}
        identifier={striven?.connected ? (striven.company ?? undefined) : undefined}
      />
      <main className="main">
        {(Object.keys(TABS) as ViewKey[]).map((k) => (
          <div key={k} style={{ display: view === k ? 'block' : 'none' }}>
            {view === k && <Suspense fallback={<LazyLoading />}>{TABS[k]}</Suspense>}
          </div>
        ))}
      </main>
    </div>
  );
}
