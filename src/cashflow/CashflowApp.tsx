import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { fetchStrivenStatus, type StrivenStatus } from './strivenApi';

// Lazy-loaded so recharts (heavy) only downloads when a chart tab is opened.
const OverviewCharts = lazy(() => import('./components/OverviewCharts').then((m) => ({ default: m.OverviewCharts })));
const OrdersTab = lazy(() => import('./components/OrdersTab').then((m) => ({ default: m.OrdersTab })));
const ReceivablesTab = lazy(() => import('./components/ReceivablesTab').then((m) => ({ default: m.ReceivablesTab })));
const PayablesTab = lazy(() => import('./components/PayablesTab').then((m) => ({ default: m.PayablesTab })));
const CatalogTab = lazy(() => import('./components/CatalogTab').then((m) => ({ default: m.CatalogTab })));
const PatientsTab = lazy(() => import('./components/PatientsTab').then((m) => ({ default: m.PatientsTab })));
const VendorsTab = lazy(() => import('./components/VendorsTab').then((m) => ({ default: m.VendorsTab })));
const OperationsTab = lazy(() => import('./components/OperationsTab').then((m) => ({ default: m.OperationsTab })));
const AccountsTab = lazy(() => import('./components/AccountsTab').then((m) => ({ default: m.AccountsTab })));

const LazyLoading = () => <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading…</div>;

export type ViewKey = 'overview' | 'receivables' | 'payables' | 'orders' | 'patients' | 'vendors' | 'catalog' | 'operations' | 'accounts';

export default function App() {
  // null = checking, true = allowed, false = needs password (gate is enabled
  // server-side only when ACCESS_PASSWORD is set; local dev is un-gated).
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/status').then((r) => setAuthed(r.status !== 401)).catch(() => setAuthed(true));
  }, []);
  if (authed === null) return null;
  if (!authed) return <PasswordGate onOk={() => setAuthed(true)} />;
  return <Dashboard onSignOut={() => window.location.reload()} />;
}

function PasswordGate({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      if (r.ok) onOk(); else setErr('Incorrect password');
    } catch { setErr('Could not reach the server'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f7f8fa', padding: 20 }}>
      <form onSubmit={submit} className="section" style={{ width: 'min(380px,100%)', padding: 28, textAlign: 'center' }}>
        <div className="brand-logo" style={{ width: 48, height: 48, margin: '0 auto 14px', background: '#fff', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src="/SMR%20Logo.png" alt="SMR" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <h1 className="page-title" style={{ fontSize: 20 }}>SMR Dashboard</h1>
        <div className="page-sub" style={{ marginBottom: 18 }}>Enter the access password to continue</div>
        <input
          type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus placeholder="Password"
          style={{ width: '100%', padding: '11px 13px', borderRadius: 9, border: '1px solid #cbd5e1', fontSize: 14, marginBottom: 10 }}
        />
        {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
        <button className="btn" type="submit" disabled={busy || !pw} style={{ width: '100%', padding: 11 }}>{busy ? 'Checking…' : 'Enter'}</button>
      </form>
    </div>
  );
}

const VIEW_KEYS: ViewKey[] = ['overview', 'receivables', 'payables', 'orders', 'patients', 'vendors', 'catalog', 'operations', 'accounts'];
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
    receivables: <ReceivablesTab />,
    payables: <PayablesTab />,
    orders: <OrdersTab />,
    patients: <PatientsTab />,
    vendors: <VendorsTab />,
    catalog: <CatalogTab />,
    operations: <OperationsTab />,
    accounts: <AccountsTab />,
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
