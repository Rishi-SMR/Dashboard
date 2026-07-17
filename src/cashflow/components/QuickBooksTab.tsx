import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchQbStatus, fetchQbReconcile, qbCreateMissing, fetchQbInvoices,
  qbPrepareInvoiceDoc, qbPostInvoiceDoc,
  type QbStatus, type QbReconcile, type QbEntityKind,
  type QbInvoicesResult, type QbInvoiceRow, type QbInvoiceDocPlan, type QbPostResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

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

type Tab = 'customers' | 'vendors' | 'items' | 'invoices';

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
            <span className="live-dot" /> Sync Striven into QuickBooks in the right order — customers, vendors, items, then invoices{agoText ? ` · checked ${agoText}` : ''}
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
          <Workspace prod={status.env === 'production'} />
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

const TABS: { key: Tab; label: string }[] = [
  { key: 'customers', label: '1 · Customers' },
  { key: 'vendors', label: '2 · Vendors' },
  { key: 'items', label: '3 · Items' },
  { key: 'invoices', label: '4 · Invoices' },
];

function Workspace({ prod }: { prod: boolean }) {
  const [tab, setTab] = useState<Tab>('customers');
  return (
    <>
      <div className="ov-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`ov-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'customers' && <ReconcilePanel kind="customers" title="Customers" note="Patients / bill-to parties. Created automatically when you post an invoice, or create them all now." />}
      {tab === 'vendors' && <ReconcilePanel kind="vendors" title="Vendors" note="Suppliers. Needed before bills and purchase orders reference them." />}
      {tab === 'items' && <ReconcilePanel kind="items" title="Items" note="Products / services. Created as QuickBooks Service items on a default income account." />}
      {tab === 'invoices' && <InvoicesPanel prod={prod} />}
    </>
  );
}

// ── Reconcile + bulk-create for Customers / Vendors / Items ──────────────────
function ReconcilePanel({ kind, title, note }: { kind: QbEntityKind; title: string; note: string }) {
  const [rec, setRec] = useState<QbReconcile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const cancel = useRef(false);

  async function load() {
    setLoading(true); setErr(null);
    try { setRec(await fetchQbReconcile(kind)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to reconcile.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { cancel.current = false; load(); return () => { cancel.current = true; }; }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createAll() {
    if (!rec || rec.missingCount === 0) return;
    if (!confirm(`Create ${rec.missingCount} missing ${title.toLowerCase()} in QuickBooks?`)) return;
    setRunning(true); cancel.current = false;
    const total = rec.missingCount;
    let done = 0, failed = 0;
    setProgress({ done: 0, total, failed: 0 });
    try {
      for (;;) {
        if (cancel.current) break;
        const r = await qbCreateMissing(kind, 30);
        done += r.createdCount; failed += r.failed.length;
        setProgress({ done, total, failed });
        if (r.remaining === 0 || r.createdCount === 0) break; // done, or only failures remain
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Bulk create failed.'); }
    finally { setRunning(false); await load(); }
  }

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{title} — Striven vs QuickBooks</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>{note}</div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading || running}>{loading ? 'Checking…' : '↻ Re-check'}</button>
      </div>

      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
      {loading && !rec && <div className="page-sub" style={{ padding: 12 }}>Comparing…</div>}

      {rec && (
        <>
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
            <KpiR ico="users" tint={C.brand} label="In Striven" value={rec.strivenCount} foot={`${title.toLowerCase()} in Striven`} deltaText={`${rec.qbCount} in QuickBooks`} />
            <KpiR ico="shield" tint="#16A34A" label="Already in QuickBooks" value={rec.matchedCount} foot="matched by name" deltaText="no action needed" />
            <KpiR ico="clock" tint="#F59E0B" label="Not in QuickBooks" value={rec.missingCount} foot="ready to create" deltaText="Striven only" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={createAll} disabled={running || rec.missingCount === 0}
              style={{ background: rec.missingCount === 0 ? 'var(--muted)' : 'var(--accent)', color: '#fff' }}>
              {running ? 'Creating…' : rec.missingCount === 0 ? 'All synced ✓' : `Create ${rec.missingCount} missing in QuickBooks`}
            </button>
            {running && <button className="btn ghost" onClick={() => { cancel.current = true; }}>Stop</button>}
            {progress && (
              <span className="page-sub" style={{ margin: 0, fontSize: 13 }}>
                {progress.done} / {progress.total} created{progress.failed ? ` · ${progress.failed} failed` : ''}
              </span>
            )}
          </div>

          {rec.missingInQb.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead><tr><th>{title.replace(/s$/, '')}</th><th>QuickBooks</th></tr></thead>
                <tbody>
                  {rec.missingInQb.map((c, i) => (
                    <tr key={i}><td style={{ fontWeight: 600 }}>{c.name}</td><td><span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ Not in QuickBooks</span></td></tr>
                  ))}
                </tbody>
              </table>
              {rec.missingCount > rec.missingInQb.length && <div className="page-sub" style={{ marginTop: 6, fontSize: 12 }}>Showing {rec.missingInQb.length} of {rec.missingCount}.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Invoices: Striven → QuickBooks with the ORIGINAL invoice date ────────────
function InvoicesPanel({ prod }: { prod: boolean }) {
  const [data, setData] = useState<QbInvoicesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'pending' | 'posted' | 'all'>('pending');
  const [selected, setSelected] = useState<QbInvoiceRow | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const cancel = useRef(false);

  async function load() {
    setLoading(true); setErr(null);
    try { setData(await fetchQbInvoices()); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load invoices.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const invoices = data?.invoices ?? [];
  const pending = invoices.filter((r) => !r.posted);
  const pendingValue = pending.reduce((s, r) => s + Number(r.total || 0), 0);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return invoices.filter((r) => {
      if (filter === 'pending' && r.posted) return false;
      if (filter === 'posted' && !r.posted) return false;
      if (term && !`${r.number} ${r.customer}`.toLowerCase().includes(term)) return false;
      return true;
    }).slice(0, 100);
  }, [invoices, q, filter]);

  async function postAllPending() {
    if (!pending.length) return;
    if (!confirm(`Post ${pending.length} pending invoices to QuickBooks?\n\nEach is created with its ORIGINAL Striven invoice date. This creates ${pending.length} real invoices${prod ? ' in your live company' : ''}.`)) return;
    setRunning(true); cancel.current = false;
    let done = 0, failed = 0;
    setProgress({ done: 0, total: pending.length, failed: 0 });
    for (const inv of pending) {
      if (cancel.current) break;
      try { const r = await qbPostInvoiceDoc(inv.id); if (!r.ok) failed++; else done++; }
      catch { failed++; }
      setProgress({ done, total: pending.length, failed });
    }
    setRunning(false); await load();
  }

  const seg = (k: 'pending' | 'posted' | 'all', label: string) => (
    <button className="btn ghost" onClick={() => setFilter(k)}
      style={{ padding: '6px 14px', fontSize: 13, fontWeight: 700, ...(filter === k ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}) }}>{label}</button>
  );

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Invoices — Striven → QuickBooks</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Each invoice is created in QuickBooks with its <b>original Striven date</b> and number — not today's date.</div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading || running}>{loading ? 'Loading…' : '↻ Re-check'}</button>
      </div>

      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}

      {data && (
        <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
          <KpiR ico="doc" tint={C.brand} label="Posted to QuickBooks" value={data.postedCount} foot="invoices already in QB" deltaText={`${data.count} Striven invoices`} />
          <KpiR ico="clock" tint="#F59E0B" label="Pending" value={pending.length} foot="not yet in QuickBooks" deltaText="ready to post" />
          <KpiR ico="cash" tint="#16A34A" label="Pending value" value={pendingValue} format={formatCurrency} foot="total not yet in QB" deltaText="across pending invoices" />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {seg('pending', 'Pending')}{seg('posted', 'Posted')}{seg('all', 'All')}
          {pending.length > 0 && (
            <button className="btn" onClick={postAllPending} disabled={running}
              style={{ marginLeft: 8, background: 'var(--accent)', color: '#fff', padding: '6px 14px', fontSize: 13, fontWeight: 700 }}>
              {running ? 'Posting…' : `Post all ${pending.length} pending`}
            </button>
          )}
          {running && <button className="btn ghost" onClick={() => { cancel.current = true; }} style={{ padding: '6px 12px', fontSize: 13 }}>Stop</button>}
          {progress && <span className="page-sub" style={{ margin: 0, fontSize: 13 }}>{progress.done} / {progress.total} posted{progress.failed ? ` · ${progress.failed} failed` : ''}</span>}
        </div>
        <input className="login-input" style={{ maxWidth: 240, height: 38 }} placeholder="Search invoice / customer…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {loading && <div className="page-sub" style={{ padding: 12 }}>Loading invoices…</div>}
      {!loading && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="num">Total</th><th className="num">Open</th><th>QuickBooks</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ color: C.muted }}>No invoices in this view.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>#{r.number}</td>
                  <td>{r.customer || '—'}</td>
                  <td>{fmtDate(r.date)}</td>
                  <td className="num">{formatCurrency(r.total)}</td>
                  <td className="num">{r.open > 0 ? formatCurrency(r.open) : '—'}</td>
                  <td>{r.posted
                    ? <span className="pill-tag tag-ok">✓ Invoice {r.posted.docNumber || r.posted.invoiceId}</span>
                    : <span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ Not posted</span>}</td>
                  <td>{r.posted
                    ? <span className="page-sub" style={{ fontSize: 12 }}>{fmtDate(r.posted.at)}</span>
                    : <button className="btn" style={{ padding: '5px 12px', fontSize: 13, background: 'var(--accent)', color: '#fff' }} onClick={() => setSelected(r)}>Post →</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <InvoiceDocModal inv={selected} onClose={() => setSelected(null)} onPosted={load} />}
    </div>
  );
}

function InvoiceDocModal({ inv, onClose, onPosted }: { inv: QbInvoiceRow; onClose: () => void; onPosted: () => void }) {
  const [plan, setPlan] = useState<QbInvoiceDocPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<QbPostResult | null>(null);

  useEffect(() => {
    qbPrepareInvoiceDoc(inv.id).then(setPlan).catch((e) => setErr(e instanceof Error ? e.message : 'Failed to build the plan.'));
  }, [inv.id]);

  async function post(force = false) {
    setPosting(true); setErr(null);
    try { const r = await qbPostInvoiceDoc(inv.id, force); setResult(r); if (r.ok) onPosted(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Post failed.'); }
    finally { setPosting(false); }
  }

  const blocked = !!plan && (plan.lines.length === 0 || plan.customer.name.trim() === '');

  return (
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 640 }}>
        <div className="drill-head">
          <div>
            <div className="title">Post Invoice #{inv.number} to QuickBooks</div>
            <div className="sub">Created with the original Striven date — nothing posts until you confirm.</div>
          </div>
          <button className="drill-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drill-body">
          {!plan && !err && <div className="page-sub" style={{ padding: 12 }}>Building plan…</div>}
          {err && <div className="error" style={{ margin: 8 }}>{err}</div>}

          {result && (
            <div className="section" style={{ margin: 0 }}>
              {result.ok
                ? <div className="qb-flash ok" style={{ marginBottom: 12 }}>✓ Invoice created — <b>#{result.invoice?.docNumber || result.invoice?.invoiceId}</b> for {result.invoice?.customer} · {formatCurrency(result.invoice?.total ?? 0)}</div>
                : <div className="qb-flash err" style={{ marginBottom: 12 }}>⚠ {result.message || 'Already posted.'}</div>}
              {result.steps && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13.5, color: 'var(--muted-strong)' }}>
                  {result.steps.map((s, i) => <li key={i}>{s.action === 'created' ? '➕ Created' : '✓ Matched'} {s.step}: <b>{s.name}</b></li>)}
                </ul>
              )}
              <button className="btn ghost" onClick={onClose} style={{ marginTop: 4 }}>Done</button>
            </div>
          )}

          {plan && !result && (
            <div className="section" style={{ margin: 0 }}>
              {plan.alreadyPosted && <div className="qb-flash warn" style={{ marginBottom: 12 }}>Already posted — Invoice {plan.alreadyPosted.docNumber || plan.alreadyPosted.invoiceId} on {fmtDate(plan.alreadyPosted.at)}.</div>}
              {plan.warnings.map((w, i) => <div key={i} className="qb-flash warn" style={{ marginBottom: 10 }}>⚠ {w}</div>)}

              <div className="qb-plan-row"><span className="qb-plan-k">Date</span><span className="qb-plan-v"><b>{fmtDate(plan.invoice.date)}</b> <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>(original Striven date · due {fmtDate(plan.invoice.dueDate)})</span></span></div>
              <div className="qb-plan-row"><span className="qb-plan-k">Invoice #</span><span className="qb-plan-v"><b>{plan.invoice.number}</b>{plan.invoice.order ? <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>· {plan.invoice.order}</span> : null}</span></div>
              <div className="qb-plan-row">
                <span className="qb-plan-k">Customer</span>
                <span className="qb-plan-v"><b>{plan.customer.name || '(none)'}</b>{' '}
                  {plan.customer.status === 'matched'
                    ? <span className="pill-tag tag-ok">✓ Existing</span>
                    : <span className="pill-tag" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>➕ Will be created</span>}</span>
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
                <button className="btn" onClick={() => post(false)} disabled={posting || blocked || !!plan.alreadyPosted}
                  style={{ background: (blocked || plan.alreadyPosted) ? 'var(--muted)' : 'var(--accent)', color: '#fff' }}>
                  {posting ? 'Posting…' : 'Post invoice to QuickBooks'}
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
