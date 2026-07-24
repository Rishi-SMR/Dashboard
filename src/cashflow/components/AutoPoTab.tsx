import { useEffect, useMemo, useState } from 'react';
import {
  fetchAutoPoCandidates, fetchAutoPoPlan, autoPoRaise,
  type AutoPoCandidatesResult, type AutoPoCandidate, type AutoPoEntry, type AutoPoRunResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// Pull the single per-SO entry out of an auto-po run response.
const entryOf = (r: AutoPoRunResult | null): AutoPoEntry | null => r?.processed?.[0] ?? null;
// A plan is raisable only if at least one line resolved a vendor from a prior PO.
const raisableLines = (e: AutoPoEntry | null) => (e?.lines ?? []).filter((l) => !!(l.plan?.vendor || l.vendor));

export function AutoPoTab() {
  const [data, setData] = useState<AutoPoCandidatesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);
  const [filter, setFilter] = useState<'test' | 'no-po' | 'all'>('test');
  const [selected, setSelected] = useState<AutoPoCandidate | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try { const d = await fetchAutoPoCandidates(); setData(d); setLastSync(Date.now()); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load sales orders.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cands = data?.candidates ?? [];
  const testCount = cands.filter((c) => c.testy).length;
  const noPoCount = cands.filter((c) => !c.hasPo).length;
  const live = data?.mode === 'live';
  const demoOnly = data?.demoOnly ?? true;

  const rows = useMemo(() => cands.filter((c) => {
    if (filter === 'test') return c.testy;
    if (filter === 'no-po') return !c.hasPo;
    return true;
  }), [cands, filter]);

  const seg = (k: 'test' | 'no-po' | 'all', label: string) => (
    <button className="btn ghost" onClick={() => setFilter(k)}
      style={{ padding: '6px 14px', fontSize: 13, fontWeight: 700, ...(filter === k ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}) }}>{label}</button>
  );

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Auto-PO</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sales Order → vendor Purchase Order. Pick an order, we build the PO from its items' last vendor, you raise it{agoText ? ` · synced ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      {/* Pilot-mode banner — makes the safety posture unmistakable. */}
      <div className={`qb-flash ${demoOnly ? 'warn' : 'err'}`} style={{ marginBottom: 14 }}>
        {demoOnly
          ? <>🧪 <b>Pilot mode</b> — only <b>test / demo</b> orders can raise a PO. Real patient orders are ignored server-side, so nothing can go out by mistake. Raising is a deliberate click per order (nothing is automatic yet).</>
          : <>🔴 <b>Live for ALL orders</b> — the demo gate is OFF. Any order you raise creates a real vendor PO. Switch back to pilot before testing.</>}
        <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800, background: live ? 'rgba(220,38,38,.10)' : C.brandLight, color: live ? '#B91C1C' : C.brandDark }}>
          default mode: {live ? '● LIVE' : '● DRY'}
        </span>
      </div>

      {err && <div className="error" style={{ marginBottom: 14 }}>{err}</div>}

      {data && (
        <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
          <KpiR ico="doc" tint={C.brand} label="Recent sales orders" value={cands.length} foot="newest first" deltaText="from Striven, live" />
          <KpiR ico="shield" tint="#16A34A" label="Test / demo eligible" value={testCount} foot="can raise in pilot" deltaText="the only ones that fire" />
          <KpiR ico="clip" tint="#F59E0B" label="Without a PO yet" value={noPoCount} foot="no linked PO" deltaText="candidates to raise" />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {seg('test', `Test / demo (${testCount})`)}{seg('no-po', `No PO (${noPoCount})`)}{seg('all', `All (${cands.length})`)}
        </div>
        <div className="page-sub" style={{ margin: 0, fontSize: 12 }}>🔒 Patients shown as SO-&lt;id&gt; — names never reach this screen.</div>
      </div>

      {loading && !data && <div className="page-sub" style={{ padding: 12 }}>Loading sales orders…</div>}
      {!loading && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Sales Order</th><th>Placed</th><th>Type</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} style={{ color: C.muted }}>No orders in this view.</td></tr>}
              {rows.map((c) => (
                <tr key={c.soId}>
                  <td style={{ fontWeight: 700 }}>{c.ref}</td>
                  <td>{fmtDate(c.date)}</td>
                  <td>
                    {c.testy
                      ? <span className="pill-tag" style={{ background: 'rgba(22,163,74,.12)', color: '#166534' }}>🧪 {c.kind}</span>
                      : <span className="pill-tag" style={{ background: 'var(--card-2, #f1f5f9)', color: 'var(--muted-strong)' }}>{c.kind}</span>}
                  </td>
                  <td>{c.hasPo
                    ? <span className="pill-tag tag-ok">✓ PO linked</span>
                    : <span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ No PO</span>}</td>
                  <td>{c.hasPo
                    ? <span className="page-sub" style={{ fontSize: 12 }}>already raised</span>
                    : <button className="btn" style={{ padding: '5px 12px', fontSize: 13, background: 'var(--accent)', color: '#fff' }} onClick={() => setSelected(c)}>Build &amp; raise →</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <AutoPoModal cand={selected} demoOnly={demoOnly} onClose={() => setSelected(null)} onDone={load} />}
    </div>
  );
}

function AutoPoModal({ cand, demoOnly, onClose, onDone }: { cand: AutoPoCandidate; demoOnly: boolean; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<AutoPoRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [result, setResult] = useState<AutoPoRunResult | null>(null);

  useEffect(() => {
    setPlan(null); setErr(null);
    fetchAutoPoPlan(cand.soId)
      .then(setPlan)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to build the plan.'));
  }, [cand.soId]);

  const entry = entryOf(plan);
  const raisable = raisableLines(entry);
  const blocked = !entry || !!entry.skipped || raisable.length === 0;

  async function raise() {
    if (!confirm(`Raise ${raisable.length} vendor PO line(s) in Striven for ${cand.ref}?\n\nThis creates a REAL purchase order in Striven (status In Progress).`)) return;
    setRaising(true); setErr(null);
    try { const r = await autoPoRaise(cand.soId); setResult(r); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Raise failed.'); }
    finally { setRaising(false); }
  }

  const resEntry = entryOf(result);

  return (
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 680 }}>
        <div className="drill-head">
          <div>
            <div className="title">Raise vendor PO for {cand.ref}</div>
            <div className="sub">Vendor + item mapping is filled from each item's most recent purchase order. Nothing is created until you confirm.</div>
          </div>
          <button className="drill-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drill-body">
          {!plan && !err && <div className="page-sub" style={{ padding: 12 }}>Building plan… <span style={{ opacity: .7 }}>(scanning prior POs for each item — a few seconds)</span></div>}
          {err && <div className="error" style={{ margin: 8 }}>{err}</div>}

          {/* Result view (after raising) */}
          {result && (
            <div className="section" style={{ margin: 0 }}>
              {result.note
                ? <div className="qb-flash warn" style={{ marginBottom: 12 }}>{result.note}</div>
                : resEntry?.skipped
                  ? <div className="qb-flash warn" style={{ marginBottom: 12 }}>⚠ Skipped: {resEntry.skipped}</div>
                  : <div className="qb-flash ok" style={{ marginBottom: 12 }}>✓ Done — {(resEntry?.lines ?? []).filter((l) => /created/i.test(l.result)).length} PO line(s) created in Striven for {cand.ref}.</div>}
              {resEntry && !resEntry.skipped && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13.5, color: 'var(--muted-strong)' }}>
                  {resEntry.lines.map((l, i) => (
                    <li key={i}>{/created/i.test(l.result) ? '➕ Created' : '•'} <b>{l.itemName}</b> ×{l.qty}{l.vendor ? ` → ${l.vendor}` : ''}{l.poId ? ` · PO #${l.poId}` : ''}{!/created/i.test(l.result) && !l.poId ? ` — ${l.result}` : ''}</li>
                  ))}
                </ul>
              )}
              <div className="qb-flash warn" style={{ marginBottom: 12 }}>📧 Vendor email is the next step — for now the PO sits in Striven for you to send. (Pilot emails will go to the internal inbox, not the real vendor.)</div>
              <button className="btn ghost" onClick={onClose} style={{ marginTop: 4 }}>Done</button>
            </div>
          )}

          {/* Plan view (before raising) */}
          {plan && !result && (
            <div className="section" style={{ margin: 0 }}>
              {entry?.skipped && (
                <div className="qb-flash warn" style={{ marginBottom: 12 }}>
                  ⚠ This order won't raise a PO — <b>{entry.skipped}</b>
                  {demoOnly && /pilot gate/i.test(entry.skipped) && <> . In pilot mode only test/demo orders are allowed.</>}
                </div>
              )}
              {entry && !entry.skipped && (
                <>
                  <div className="qb-plan-row"><span className="qb-plan-k">Sales order</span><span className="qb-plan-v"><b>{cand.ref}</b> <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>· placed {fmtDate(cand.date)}{entry.type ? ` · ${entry.type}` : ''}</span></span></div>
                  <div className="qb-plan-row"><span className="qb-plan-k">Lines</span><span className="qb-plan-v"><b>{entry.lines.length}</b> item(s) · <b>{raisable.length}</b> with a known vendor</span></div>

                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table className="data-table">
                      <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th>Vendor</th><th>Drop-ship</th></tr></thead>
                      <tbody>
                        {entry.lines.map((l, i) => {
                          const vendor = l.plan?.vendor || l.vendor || '';
                          const ok = !!vendor;
                          return (
                            <tr key={i}>
                              <td style={{ fontWeight: 600 }}>{l.itemName}</td>
                              <td className="num">{l.qty}</td>
                              <td className="num">{l.plan?.unitPrice != null ? formatCurrency(l.plan.unitPrice) : '—'}</td>
                              <td>{ok
                                ? <span className="pill-tag tag-ok">✓ {vendor}</span>
                                : <span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ no prior PO — unknown</span>}</td>
                              <td>{l.plan?.dropShipTo || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {raisable.length < entry.lines.length && (
                    <div className="page-sub" style={{ marginTop: 8, fontSize: 12.5 }}>
                      Items with no prior PO have no known vendor — they're skipped. Add an item→vendor mapping later to cover those.
                    </div>
                  )}
                </>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
                <button className="btn" onClick={raise} disabled={raising || blocked}
                  style={{ background: blocked ? 'var(--muted)' : 'var(--accent)', color: '#fff' }}>
                  {raising ? 'Raising…' : blocked ? 'Nothing to raise' : `Raise ${raisable.length} PO line(s) →`}
                </button>
                <button className="btn ghost" onClick={onClose} disabled={raising}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
