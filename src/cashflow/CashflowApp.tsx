import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Sidebar, DEFAULT_VIEW, allowedViews, defaultViewFor, type Mode } from './components/Sidebar';
import { fetchStrivenStatus, fetchMe, type StrivenStatus } from './strivenApi';

// Lazy-loaded so recharts (heavy) only downloads when a chart tab is opened.
const OverviewCharts = lazy(() => import('./components/OverviewCharts').then((m) => ({ default: m.OverviewCharts })));
const OrdersTab = lazy(() => import('./components/OrdersTab').then((m) => ({ default: m.OrdersTab })));
const ArApTab = lazy(() => import('./components/ArApTab').then((m) => ({ default: m.ArApTab })));
const ApSheetTab = lazy(() => import('./components/ApSheetTab').then((m) => ({ default: m.ApSheetTab })));
const ArSheetTab = lazy(() => import('./components/ArSheetTab').then((m) => ({ default: m.ArSheetTab })));
const PLTab = lazy(() => import('./components/PLTab').then((m) => ({ default: m.PLTab })));
const VendorsItemsTab = lazy(() => import('./components/VendorsItemsTab').then((m) => ({ default: m.VendorsItemsTab })));
const AccountsTab = lazy(() => import('./components/AccountsTab').then((m) => ({ default: m.AccountsTab })));
const ExceptionsTab = lazy(() => import('./components/ExceptionsTab').then((m) => ({ default: m.ExceptionsTab })));
const QuickBooksTab = lazy(() => import('./components/QuickBooksTab').then((m) => ({ default: m.QuickBooksTab })));
const ReportsTab = lazy(() => import('./components/ReportsTab').then((m) => ({ default: m.ReportsTab })));
const AutomationHub = lazy(() => import('./components/AutomationHub').then((m) => ({ default: m.AutomationHub })));
const CommissionTab = lazy(() => import('./components/Commission').then((m) => ({ default: m.CommissionTab })));
const RepsTab = lazy(() => import('./components/RepsTab').then((m) => ({ default: m.RepsTab })));
const TeamStandings = lazy(() => import('./components/RepsTab').then((m) => ({ default: m.TeamStandings })));

const LazyLoading = () => <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading…</div>;

export type ViewKey = 'overview' | 'receivables' | 'payables' | 'arsheet' | 'apsheet' | 'pl' | 'orders' | 'tracking' | 'automation' | 'autopo' | 'autoso' | 'vendors' | 'catalog' | 'accounts' | 'exceptions' | 'commission' | 'reps' | 'repsorders' | 'repspipeline' | 'repsroster' | 'standings' | 'reports' | 'quickbooks';

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
      } else if (r.status === 429) {
        setErr('Too many failed attempts. Try again in 15 minutes.');
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

const VIEW_KEYS: ViewKey[] = ['overview', 'receivables', 'payables', 'apsheet', 'pl', 'orders', 'tracking', 'automation', 'autopo', 'autoso', 'vendors', 'catalog', 'accounts', 'exceptions', 'commission', 'reps', 'repsorders', 'repspipeline', 'repsroster', 'standings', 'reports', 'quickbooks'];
const readHash = (): ViewKey | null => {
  const h = (typeof location !== 'undefined' ? location.hash.replace('#', '') : '') as ViewKey;
  return VIEW_KEYS.includes(h) ? h : null;
};

const MODE_KEY = 'smr_mode';
const readMode = (): Mode => {
  try { return localStorage.getItem(MODE_KEY) === 'company' ? 'company' : 'reps'; } catch { return 'reps'; }
};

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  // Role is resolved ONCE here and handed down, so the nav and the router can
  // never disagree. Null until /api/me answers, and null is treated as 'rep'
  // by allowedViews: least privilege while the answer is in flight.
  const [role, setRole] = useState<'admin' | 'rep' | null>(null);
  const [mode, setModeRaw] = useState<Mode>(readMode);
  const [view, setViewRaw] = useState<ViewKey>(() => readHash() ?? DEFAULT_VIEW);
  const setView = (v: ViewKey) => { setViewRaw(v); if (typeof history !== 'undefined') history.replaceState(null, '', `#${v}`); };
  const [striven, setStriven] = useState<StrivenStatus | null>(null);

  useEffect(() => {
    fetchStrivenStatus().then(setStriven).catch(() => setStriven({ connected: false, company: null }));
  }, []);

  useEffect(() => {
    let live = true;
    fetchMe().then((m) => { if (live) setRole(m?.role === 'admin' ? 'admin' : 'rep'); })
      .catch(() => { if (live) setRole('rep'); });   // fail closed: least privilege
    return () => { live = false; };
  }, []);

  // ── Role gate ──────────────────────────────────────────────────────────────
  // The sidebar choosing what to DRAW is not access control. Before this, any
  // signed-in user could type #pl and open the company P&L, because the router
  // accepted every key in VIEW_KEYS. Now a view outside the role's allow-list
  // snaps back to that role's own landing tab: hash navigation included.
  const allowed = allowedViews(role);
  useEffect(() => {
    if (!allowed.has(view)) setView(defaultViewFor(role, mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, view]);

  // Let #hash links (e.g. Overview stat-tiles) switch tabs: same gate.
  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      if (h && allowedViews(role).has(h)) setViewRaw(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [role]);

  // Switching side lands on that side's first tab, so the view always matches
  // the nav the user is looking at.
  const setMode = (m: Mode) => {
    setModeRaw(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode: in-memory is fine */ }
    setView(defaultViewFor(role, m));
  };

  const TABS: Record<ViewKey, ReactNode> = {
    overview: <OverviewCharts />,
    receivables: <ArApTab initialMode="ar" />,
    payables: <ArApTab initialMode="ap" />,
    arsheet: <ArSheetTab />,
    apsheet: <ApSheetTab />,
    pl: <PLTab />,
    orders: <OrdersTab />,
    tracking: <OrdersTab initialMode="tracking" />,
    automation: <AutomationHub />,
    autopo: <AutomationHub initialTab="autopo" />,
    autoso: <AutomationHub initialTab="autoso" />,
    vendors: <VendorsItemsTab initialMode="vendors" />,
    catalog: <VendorsItemsTab initialMode="items" />,
    accounts: <AccountsTab />,
    exceptions: <ExceptionsTab />,
    commission: <CommissionTab />,
    reps: <RepsTab initialSub="overview" />,
    repsorders: <RepsTab initialSub="orders" />,
    repspipeline: <RepsTab initialSub="pipeline" />,
    // 'repsroster' opened the Roster sub-view, which no longer exists — the
    // roster is a section of the dashboard now. The key still resolves (an old
    // bookmark or #hash should not dead-end) but it lands on that dashboard,
    // where the roster is. It is no longer offered in the nav.
    repsroster: <RepsTab initialSub="overview" />,
    standings: <TeamStandings />,
    reports: <ReportsTab />,
    quickbooks: <QuickBooksTab />,
  };

  return (
    <div className="shell">
      <Sidebar
        view={view}
        onChange={setView}
        connected={striven?.connected ?? false}
        onSignOut={onSignOut}
        identifier={striven?.connected ? (striven.company ?? undefined) : undefined}
        role={role}
        mode={mode}
        onMode={setMode}
      />
      <main className="main">
        {/* Only the role's own views are mounted at all. A disallowed tab is not
            hidden with CSS: it is never rendered, so its component never runs
            and never fires its fetches. */}
        {(Object.keys(TABS) as ViewKey[]).filter((k) => allowed.has(k)).map((k) => (
          <div key={k} style={{ display: view === k ? 'block' : 'none' }}>
            {view === k && <Suspense fallback={<LazyLoading />}>{TABS[k]}</Suspense>}
          </div>
        ))}
      </main>
    </div>
  );
}
