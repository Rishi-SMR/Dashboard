import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchAutoSoCandidates, autoSoCreate, type AutoSoResult, type AutoSoCandidate, type AutoSoRunResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';
import { Portal } from './Portal';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

// Auto-SO (recurring resupply). Shows which patients are due for a repeat order,
// drafts it from their last order, and CREATES the sales order in Striven on a
// deliberate click. Safe by design: DEMO/test patients only in pilot mode
// (server-side gate), and idempotent (won't re-create within the dedup window).
export function AutoSoTab({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<AutoSoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);
  const [sel, setSel] = useState<AutoSoCandidate | null>(null); // candidate open in the create modal
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AutoSoRunResult | null>(null);

  async function doCreate() {
    if (!sel) return;
    setBusy(true); setResult(null);
    try { setResult(await autoSoCreate(sel.lastSoId)); load(true); }
    catch (e) {
      setResult({ ok: false, mode: 'live', processed: [{ at: '', templateSoId: sel.lastSoId, mode: 'live', testy: false, ref: sel.lastSo, skipped: e instanceof Error ? e.message : 'create failed' }] });
    } finally { setBusy(false); }
  }

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchAutoSoCandidates()); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load resupply candidates.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); const r = setInterval(() => load(true), 90_000); return () => clearInterval(r); }, []);

  const cands = data?.candidates ?? [];
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return cands.filter((c) =>
      (!dueOnly || c.due) &&
      (!t || c.patient.toLowerCase().includes(t) || (c.lastName || '').toLowerCase().includes(t) ||
        (c.program || '').toLowerCase().includes(t) || c.items.some((i) => i.item.toLowerCase().includes(t))));
  }, [cands, q, dueOnly]);

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      {!embedded && (
        <div className="page-head deck-head" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Auto-SO · Resupply</h1>
            <div className="page-sub">
              <span className="live-dot" /> Patients due for a repeat order: draft previews from their last order{agoText ? ` · updated ${agoText}` : ''}
            </div>
          </div>
          <div className="ov-headright">
            <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && !data.ready && (
        <div className="section">
          <div className="page-sub" style={{ padding: 16 }}>
            {data.note || 'No resupply data yet.'} It is built from the sales-order-wise report; run that data build, then refresh here.
          </div>
        </div>
      )}

      {data && data.ready && (
        <div className="section">
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
            <KpiR ico="users" tint={C.brand} label="Patients with orders" value={data.count ?? cands.length} foot="from order history" deltaText="by reference" />
            <KpiR ico="clock" tint="#D97706" label={`Due for resupply (${data.dueDays ?? 30}d+)`} value={data.dueCount ?? 0} foot="no order in the window" deltaText="candidates" />
            <KpiR ico="clip" tint="#16A34A" label="Showing" value={rows.length} foot={dueOnly ? 'due only' : 'all patients'} deltaText="rows" />
          </div>

          <div className={`qb-flash ${data.demoOnly === false ? 'err' : 'warn'}`} style={{ marginBottom: 12 }}>
            {data.demoOnly === false
              ? <>🔴 <b>Live for ALL patients</b>: the demo gate is OFF. Creating here makes a <b>REAL</b> sales order in Striven.</>
              : <>🧪 <b>Pilot mode</b>: only <b>test / demo</b> patients can create a resupply SO; real patients are ignored server-side. Every create is a deliberate click.</>}
            {' '}🔒 Last name is minimum-necessary PHI; access is audit-logged.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.sub, cursor: 'pointer' }}>
              <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
              Due only ({data.dueDays ?? 30}d+)
            </label>
            <input className="login-input" style={{ maxWidth: 260, height: 38 }} placeholder="Search ref / last name / item…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Patient</th><th>Last name</th><th>Program</th><th>Last order</th>
                <th className="num">Days since</th><th className="num">Orders</th><th className="num">Draft value</th><th />
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No candidates match.</td></tr>}
                {rows.map((c) => (
                  <Fragment key={c.patient}>
                    <tr onClick={() => c.items.length && setOpen(open === c.patient ? null : c.patient)}
                      style={{ cursor: c.items.length ? 'pointer' : 'default', background: open === c.patient ? 'var(--accent-soft-2)' : undefined }}>
                      <td style={{ fontWeight: 700 }}>{c.items.length ? (open === c.patient ? '▾ ' : '▸ ') : ''}{c.patient}</td>
                      <td>{c.lastName || '-'}</td>
                      <td><span className="pill-tag" style={{ color: PROG_C[c.program] || PROG_C.Other, borderColor: 'currentColor' }}>{c.program || '-'}</span></td>
                      <td>{c.lastSo} · {fmtDate(c.lastDate)}</td>
                      <td className="num">
                        {c.daysSince != null
                          ? <span className={`pill-tag ${c.due ? 'tag-warn' : 'tag-ok'}`}>{c.daysSince}d</span>
                          : '-'}
                      </td>
                      <td className="num">{c.orderCount}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(c.value)}</td>
                      <td className="num">
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                          onClick={(e) => { e.stopPropagation(); setSel(c); setResult(null); }}
                          disabled={!c.items.length}
                          title={c.items.length ? 'Draft + create a resupply order from the last order' : 'No items on the last order'}>
                          Create resupply →
                        </button>
                      </td>
                    </tr>
                    {open === c.patient && c.items.length > 0 && (
                      <tr><td colSpan={8} style={{ padding: '0 0 8px 0', background: 'var(--accent-soft-2)' }}>
                        <div style={{ margin: '2px 0 4px 28px', fontSize: 11.5, color: C.muted, fontWeight: 600 }}>Draft resupply: items from the last order</div>
                        <div className="table-scroll">
                          <table className="data-table" style={{ margin: '0 0 0 28px', width: 'calc(100% - 28px)' }}>
                            <thead><tr><th>Item</th><th className="num">Qty</th></tr></thead>
                            <tbody>
                              {c.items.map((it, j) => (
                                <tr key={j}><td style={{ fontWeight: 600 }}>{it.item}</td><td className="num">{it.qty}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sel && (
        // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
        // transform on an ancestor silently redefines that. See Portal.tsx.
        <Portal>
        <div className="drill-backdrop" onClick={() => !busy && setSel(null)}>
          <div className="drill" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="drill-head">
              <div>
                <div className="title">Create resupply order</div>
                <div className="sub">{sel.patient} · {sel.lastName || '-'} · from {sel.lastSo}</div>
              </div>
              <button className="drill-close" onClick={() => !busy && setSel(null)} aria-label="Close">×</button>
            </div>
            <div className="drill-body">
              <div className={`qb-flash ${data?.demoOnly === false ? 'err' : 'warn'}`} style={{ marginBottom: 12 }}>
                {data?.demoOnly === false
                  ? <>🔴 This creates a <b>REAL</b> sales order in Striven.</>
                  : <>🧪 <b>Pilot</b>: creates only if this is a <b>demo/test</b> patient; real patients are skipped server-side.</>}
              </div>
              {!result ? (
                <>
                  <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 8 }}>Draft: a repeat of the last order's items:</div>
                  <div className="table-wrap"><table className="data-table">
                    <thead><tr><th>Item</th><th className="num">Qty</th></tr></thead>
                    <tbody>
                      {sel.items.map((it, j) => <tr key={j}><td style={{ fontWeight: 600 }}>{it.item}</td><td className="num">{it.qty}</td></tr>)}
                      {sel.items.length === 0 && <tr><td colSpan={2} style={{ color: C.muted }}>No items on the last order.</td></tr>}
                    </tbody>
                  </table></div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                    <button className="btn ghost" onClick={() => setSel(null)} disabled={busy}>Cancel</button>
                    <button className="btn" onClick={doCreate} disabled={busy || !sel.items.length}>{busy ? 'Creating…' : 'Create in Striven'}</button>
                  </div>
                </>
              ) : <CreateResult result={result} onClose={() => setSel(null)} />}
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
}

function CreateResult({ result, onClose }: { result: AutoSoRunResult; onClose: () => void }) {
  const e = result.processed?.[0];
  return (
    <div>
      {e?.createdSoId ? (
        <div className="qb-flash ok">✅ Created sales order <b>#{e.createdSoId}</b> in Striven ({e.itemCount ?? 0} items).</div>
      ) : e?.skipped ? (
        <div className="qb-flash warn">⏭️ Skipped: {e.skipped}</div>
      ) : (
        <div className="qb-flash warn">Dry run: {e?.itemCount ?? 0} item(s) planned, nothing created.</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

const PROG_C: Record<string, string> = { PI: '#0A369F', VA: '#16A34A', TriCare: '#0D9488', Other: '#94A3B8' };
