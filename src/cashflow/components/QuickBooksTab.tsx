import { useEffect, useMemo, useState } from 'react';
import {
  fetchQbStatus, fetchStrivenSO, fetchQbCustomers, qbPrepareInvoice, qbPostInvoice,
  type QbStatus, type SoResult, type SoRecent, type QbCustomer, type QbPlan, type QbPostResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// Read ?qb=connected / ?qb=error&reason=… left by the OAuth callback redirect.
function readQbFlash(): { kind: 'ok' | 'err'; text: string } | null {
  try {
    const p = new URLSearchParams(location.search);
    const v = p.get('qb');
    if (v === 'connected') return { kind: 'ok', text: 'QuickBooks connected successfully.' };
    if (v === 'error') return { kind: 'err', text: `QuickBooks connection failed: ${p.get('reason') || 'unknown error'}` };
  } catch { /* ignore */ }
  return null;
}
function clearQbFlash() {
  try { const u = new URL(location.href); u.searchParams.delete('qb'); u.searchParams.delete('reason'); history.replaceState(null, '', u.toString()); } catch { /* ignore */ }
}

export function QuickBooksTab() {
  const [status, setStatus] = useState<QbStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(readQbFlash());
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function loadStatus(silent = false) {
    if (!silent) setLoading(true);
    try { const s = await fetchQbStatus(); setStatus(s); setLastSync(Date.now()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to reach QuickBooks status.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { loadStatus(); if (flash) { clearQbFlash(); const t = setTimeout(() => setFlash(null), 6000); return () => clearTimeout(t); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>QuickBooks</h1>
          <div className="page-sub">
            <span className="live-dot" /> Post Striven records into QuickBooks Online — customers, items &amp; invoices{agoText ? ` · checked ${agoText}` : ''}
            {status?.connected && (
              <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: status.env === 'production' ? 'rgba(220,38,38,.10)' : C.brandLight, color: status.env === 'production' ? '#B91C1C' : C.brandDark }}>
                {status.env === 'production' ? '● PRODUCTION' : '● SANDBOX (test)'}
              </span>
            )}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={() => loadStatus()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {flash && (
        <div className={flash.kind === 'ok' ? 'qb-flash ok' : 'qb-flash err'} style={{ marginBottom: 14 }}>
          {flash.kind === 'ok' ? '✓ ' : '⚠ '}{flash.text}
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !status && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {status && !status.connected && <ConnectCard status={status} />}
      {status && status.connected && (
        <>
          <ConnectedBar status={status} onDisconnect={() => loadStatus()} />
          <PostInvoicePanel />
          <CustomersPanel />
        </>
      )}
    </div>
  );
}

function ConnectCard({ status }: { status: QbStatus }) {
  return (
    <div className="section" style={{ maxWidth: 620 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: '#2CA01C', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 20 }}>qb</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Connect QuickBooks Online</div>
          <div className="page-sub" style={{ margin: 0 }}>Link your {status.env === 'production' ? 'company' : 'sandbox test company'} to post from this dashboard.</div>
        </div>
      </div>
      {!status.configured && (
        <div className="error" style={{ marginTop: 10 }}>QuickBooks app keys are not configured yet. Add QB_CLIENT_ID / QB_CLIENT_SECRET in Supabase app_config first.</div>
      )}
      {status.error && <div className="page-sub" style={{ marginTop: 4, color: '#B91C1C' }}>Last error: {status.error}</div>}
      <a className="btn" href="/api/qb/connect" style={{ display: 'inline-block', marginTop: 14, background: 'var(--accent)', color: '#fff', textDecoration: 'none' }}>
        Connect to QuickBooks →
      </a>
      <div className="page-sub" style={{ marginTop: 12, fontSize: 12.5 }}>
        You'll sign in to Intuit and pick a company. Access refreshes automatically afterwards — you won't need to reconnect.
      </div>
    </div>
  );
}

function ConnectedBar({ status, onDisconnect }: { status: QbStatus; onDisconnect: () => void }) {
  const [busy, setBusy] = useState(false);
  async function disconnect() {
    if (!confirm('Disconnect QuickBooks? You will need to reconnect to post again.')) return;
    setBusy(true);
    try { await fetch('/api/qb/disconnect'); onDisconnect(); } finally { setBusy(false); }
  }
  return (
    <div className="section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: '#2CA01C', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>qb</div>
        <div>
          <div style={{ fontWeight: 800 }}>{status.company || 'QuickBooks company'}</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>
            Connected{status.connectedAt ? ` · ${fmtDate(status.connectedAt)}` : ''} · Realm {status.realmId}
          </div>
        </div>
      </div>
      <button className="btn ghost" onClick={disconnect} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
    </div>
  );
}

// ── Post a Striven Sales Order as a QuickBooks Invoice ──────────────────────
function PostInvoicePanel() {
  const [so, setSo] = useState<SoResult | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SoRecent | null>(null);

  useEffect(() => { fetchStrivenSO().then(setSo).catch(() => setSo(null)).finally(() => setLoading(false)); }, []);

  const rows = useMemo(() => {
    const list = so?.recent ?? [];
    const term = q.trim().toLowerCase();
    const f = term ? list.filter((r) => `${r.ref} ${r.payer} ${r.rep} ${r.type}`.toLowerCase().includes(term)) : list;
    return f.slice(0, 40);
  }, [so, q]);

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Post a Sales Order to QuickBooks</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Pick a Striven order → preview → post as an invoice. The customer and items are matched or created automatically.</div>
        </div>
        <input className="login-input" style={{ maxWidth: 260, height: 38 }} placeholder="Search orders…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {loading && <div className="page-sub" style={{ padding: 12 }}>Loading sales orders…</div>}
      {!loading && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Order</th><th>Type</th><th>Payer</th><th>Date</th><th className="num">Value</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ color: C.muted }}>No orders.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>{r.ref}</td>
                  <td>{r.type || '—'}</td>
                  <td>{r.payer || '—'}</td>
                  <td>{fmtDate(r.date)}</td>
                  <td className="num">{formatCurrency(r.value)}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td><button className="btn ghost" style={{ padding: '5px 12px', fontSize: 13 }} onClick={() => setSelected(r)}>Prepare →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <PostInvoiceModal so={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PostInvoiceModal({ so, onClose }: { so: SoRecent; onClose: () => void }) {
  const [plan, setPlan] = useState<QbPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<QbPostResult | null>(null);

  useEffect(() => {
    qbPrepareInvoice(so.id).then(setPlan).catch((e) => setErr(e instanceof Error ? e.message : 'Failed to build the plan.'));
  }, [so.id]);

  async function post(force = false) {
    setPosting(true); setErr(null);
    try {
      const r = await qbPostInvoice(so.id, force);
      if (!r.ok && r.alreadyPosted) { setResult(r); return; } // already posted (not forced)
      setResult(r);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Post failed.'); }
    finally { setPosting(false); }
  }

  const blocked = !!plan && (plan.lines.length === 0 || plan.customer.name.trim() === '');

  return (
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 640 }}>
        <div className="drill-head">
          <div>
            <div className="title">Post {so.ref} to QuickBooks</div>
            <div className="sub">Preview exactly what will be created — nothing is posted until you confirm.</div>
          </div>
          <button className="drill-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drill-body">
          {!plan && !err && <div className="page-sub" style={{ padding: 12 }}>Building plan…</div>}
          {err && <div className="error" style={{ margin: 8 }}>{err}</div>}

          {result && (
            <div className="section" style={{ margin: 0 }}>
              {result.ok ? (
                <div className="qb-flash ok" style={{ marginBottom: 12 }}>
                  ✓ Invoice created in QuickBooks — <b>{result.invoice?.docNumber ? `Invoice #${result.invoice.docNumber}` : `ID ${result.invoice?.invoiceId}`}</b> for {result.invoice?.customer} · {formatCurrency(result.invoice?.total ?? 0)}
                </div>
              ) : (
                <div className="qb-flash err" style={{ marginBottom: 12 }}>
                  ⚠ {result.message || 'Already posted.'}
                </div>
              )}
              {result.steps && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13.5, color: 'var(--muted-strong)' }}>
                  {result.steps.map((s, i) => (
                    <li key={i}>{s.action === 'created' ? '➕ Created' : '✓ Matched'} {s.step}: <b>{s.name}</b></li>
                  ))}
                </ul>
              )}
              {!result.ok && result.alreadyPosted && (
                <button className="btn" onClick={() => post(true)} disabled={posting} style={{ background: '#B91C1C', color: '#fff' }}>
                  {posting ? 'Posting…' : 'Post again anyway (creates a duplicate)'}
                </button>
              )}
            </div>
          )}

          {plan && !result && (
            <div className="section" style={{ margin: 0 }}>
              {plan.alreadyPosted && (
                <div className="qb-flash warn" style={{ marginBottom: 12 }}>
                  This order was already posted — Invoice {plan.alreadyPosted.docNumber || plan.alreadyPosted.invoiceId} on {fmtDate(plan.alreadyPosted.at)}. Posting again would duplicate it.
                </div>
              )}
              {plan.warnings.map((w, i) => <div key={i} className="qb-flash warn" style={{ marginBottom: 10 }}>⚠ {w}</div>)}

              <div className="qb-plan-row">
                <span className="qb-plan-k">Customer</span>
                <span className="qb-plan-v">
                  <b>{plan.customer.name || '(none)'}</b>{' '}
                  {plan.customer.status === 'matched'
                    ? <span className="pill-tag tag-ok">✓ Existing in QuickBooks</span>
                    : <span className="pill-tag" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>➕ Will be created</span>}
                </span>
              </div>

              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="data-table">
                  <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th><th>QuickBooks</th></tr></thead>
                  <tbody>
                    {plan.lines.map((l, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{l.name}</td>
                        <td className="num">{l.qty}</td>
                        <td className="num">{formatCurrency(l.unit)}</td>
                        <td className="num">{formatCurrency(l.amount)}</td>
                        <td>{l.item.status === 'matched'
                          ? <span className="pill-tag tag-ok">✓ {l.item.qbName}</span>
                          : <span className="pill-tag" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>➕ Create</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={3} style={{ textAlign: 'right', fontWeight: 700 }}>Invoice total</td><td className="num" style={{ fontWeight: 800 }}>{formatCurrency(plan.computedTotal)}</td><td></td></tr></tfoot>
                </table>
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
                <button className="btn" onClick={() => post(false)} disabled={posting || blocked}
                  style={{ background: blocked ? 'var(--muted)' : 'var(--accent)', color: '#fff' }}>
                  {posting ? 'Posting…' : plan.alreadyPosted ? 'Post again' : 'Post invoice to QuickBooks'}
                </button>
                <button className="btn ghost" onClick={onClose} disabled={posting}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── QuickBooks customers search (utility) ───────────────────────────────────
function CustomersPanel() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<QbCustomer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function search(term: string) {
    setLoading(true); setErr(null);
    try { const r = await fetchQbCustomers(term); setRows(r.customers); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Search failed.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { search(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>QuickBooks Customers</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Search who already exists in QuickBooks. New patients are created automatically when you post an order.</div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); search(q); }} style={{ display: 'flex', gap: 8 }}>
          <input className="login-input" style={{ maxWidth: 240, height: 38 }} placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" type="submit" disabled={loading}>{loading ? '…' : 'Search'}</button>
        </form>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Email</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {(rows ?? []).length === 0 && <tr><td colSpan={3} style={{ color: C.muted }}>{loading ? 'Loading…' : 'No customers.'}</td></tr>}
            {(rows ?? []).map((c) => (
              <tr key={c.id}><td style={{ fontWeight: 600 }}>{c.name}</td><td>{c.email || '—'}</td><td className="num">{formatCurrency(c.balance)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
