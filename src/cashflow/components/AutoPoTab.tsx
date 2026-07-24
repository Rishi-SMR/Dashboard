import { useEffect, useMemo, useState } from 'react';
import {
  fetchAutoPoCandidates, fetchAutoPoPreview, autoPoRaise, fetchAutoPoPdf, autoPoSendEmail,
  type AutoPoCandidatesResult, type AutoPoCandidate, type AutoPoEntry, type AutoPoLine,
  type AutoPoRunResult, type AutoPoPreview, type AutoPoPdf, type AutoPoEmailResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

// Demo default recipient — editable per the client's ask ("abhi email mera rahega").
const DEFAULT_TO = 'infineedsolutions@gmail.com';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const entryOf = (r: AutoPoRunResult | null): AutoPoEntry | null => r?.processed?.[0] ?? null;

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
            <span className="live-dot" /> Sales Order → vendor Purchase Order. Pick an order → vendor auto-fills from your reports → generate the PO → email it{agoText ? ` · synced ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      <div className={`qb-flash ${demoOnly ? 'warn' : 'err'}`} style={{ marginBottom: 14 }}>
        {demoOnly
          ? <>🧪 <b>Pilot mode</b> — only <b>test / demo</b> orders can generate a PO. Real patient orders are ignored server-side. Every step is a deliberate click.</>
          : <>🔴 <b>Live for ALL orders</b> — the demo gate is OFF. Switch back to pilot before testing.</>}
        <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800, background: live ? 'rgba(220,38,38,.10)' : C.brandLight, color: live ? '#B91C1C' : C.brandDark }}>
          default mode: {live ? '● LIVE' : '● DRY'}
        </span>
      </div>

      {err && <div className="error" style={{ marginBottom: 14 }}>{err}</div>}

      {data && (
        <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
          <KpiR ico="doc" tint={C.brand} label="Recent sales orders" value={cands.length} foot="newest first" deltaText="from Striven, live" />
          <KpiR ico="shield" tint="#16A34A" label="Test / demo eligible" value={testCount} foot="can generate in pilot" deltaText="the only ones that fire" />
          <KpiR ico="clip" tint="#F59E0B" label="Without a PO yet" value={noPoCount} foot="no linked PO" deltaText="candidates" />
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
            <thead><tr><th>Sales Order</th><th>Placed</th><th>Type</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} style={{ color: C.muted }}>No orders in this view.</td></tr>}
              {rows.map((c) => (
                <tr key={c.soId}>
                  <td style={{ fontWeight: 700 }}>{c.ref}</td>
                  <td>{fmtDate(c.date)}</td>
                  <td>{c.testy
                    ? <span className="pill-tag" style={{ background: 'rgba(22,163,74,.12)', color: '#166534' }}>🧪 {c.kind}</span>
                    : <span className="pill-tag" style={{ background: 'var(--card-2, #f1f5f9)', color: 'var(--muted-strong)' }}>{c.kind}</span>}</td>
                  <td>{c.hasPo
                    ? <span className="pill-tag tag-ok">✓ PO linked</span>
                    : <span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ No PO</span>}</td>
                  <td><button className="btn" style={{ padding: '5px 12px', fontSize: 13, background: 'var(--accent)', color: '#fff' }} onClick={() => setSelected(c)}>Open →</button></td>
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

function StepDot({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  const bg = done ? '#16A34A' : active ? 'var(--accent)' : 'var(--card-2, #e5e7eb)';
  const fg = done || active ? '#fff' : 'var(--muted-strong)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', background: bg, color: fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, flex: 'none' }}>{done ? '✓' : n}</span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: active || done ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
    </div>
  );
}

function AutoPoModal({ cand, demoOnly, onClose, onDone }: { cand: AutoPoCandidate; demoOnly: boolean; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<AutoPoPreview | null>(null);
  const [prevErr, setPrevErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genEntry, setGenEntry] = useState<AutoPoEntry | null>(null);
  const [genNote, setGenNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null); setPrevErr(null);
    fetchAutoPoPreview(cand.soId).then(setPreview).catch((e) => setPrevErr(e instanceof Error ? e.message : 'Failed to load the order.'));
  }, [cand.soId]);

  const blocked = !!preview && demoOnly && !preview.testy;
  const createdPos = (genEntry?.lines ?? []).filter((l) => l.poId);
  const step = genEntry ? 3 : 1;

  async function generate() {
    if (!confirm(`Generate the vendor PO(s) in Striven for ${cand.ref}?\n\nThis creates REAL purchase order(s) (status In Progress).`)) return;
    setGenerating(true); setErr(null);
    try {
      const r = await autoPoRaise(cand.soId);
      setGenNote(r.note ?? null);
      setGenEntry(entryOf(r));
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Generate failed.'); }
    finally { setGenerating(false); }
  }

  return (
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 740 }}>
        <div className="drill-head">
          <div>
            <div className="title">Auto-PO · {cand.ref}</div>
            <div className="sub">Order → vendor (from your reports) → generate PO → email the PO PDF.</div>
          </div>
          <button className="drill-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div style={{ display: 'flex', gap: 18, padding: '10px 16px', borderBottom: '1px solid var(--border, #e5e7eb)', flexWrap: 'wrap' }}>
          <StepDot n={1} label="Review order & vendor" active={step === 1} done={step > 1} />
          <StepDot n={2} label="Generate PO" active={step === 1} done={step === 3} />
          <StepDot n={3} label="PDF & email" active={step === 3} done={false} />
        </div>

        <div className="drill-body">
          {err && <div className="error" style={{ margin: 8 }}>{err}</div>}

          {/* STEP 3 — created POs: PDF + email */}
          {genEntry && (
            <div className="section" style={{ margin: 0 }}>
              {genNote && <div className="qb-flash warn" style={{ marginBottom: 12 }}>{genNote}</div>}
              {genEntry.skipped
                ? <div className="qb-flash warn" style={{ marginBottom: 12 }}>⚠ Skipped: {genEntry.skipped}</div>
                : <div className="qb-flash ok" style={{ marginBottom: 12 }}>✓ {createdPos.length} purchase order(s) created in Striven for {cand.ref}.</div>}

              {createdPos.map((l, i) => <PoDeliveryCard key={i} line={l} />)}

              {!genEntry.skipped && createdPos.length === 0 && (
                <div className="page-sub" style={{ fontSize: 13 }}>
                  No PO was created — none of the lines had a prior PO to copy a vendor from. Add an item→vendor mapping and retry.
                </div>
              )}
              <button className="btn ghost" onClick={onClose} style={{ marginTop: 8 }}>Done</button>
            </div>
          )}

          {/* STEP 1 — review */}
          {!genEntry && (
            <div className="section" style={{ margin: 0 }}>
              {!preview && !prevErr && <div className="page-sub" style={{ padding: 12 }}>Loading order & matching vendors…</div>}
              {prevErr && <div className="error">{prevErr}</div>}

              {preview && (
                <>
                  {blocked && (
                    <div className="qb-flash warn" style={{ marginBottom: 12 }}>
                      ⚠ <b>{cand.ref}</b> is not a test/demo order — in pilot mode it can't generate a PO (real patient orders are protected).
                    </div>
                  )}
                  <div className="qb-plan-row"><span className="qb-plan-k">Order</span><span className="qb-plan-v"><b>{preview.ref}</b> <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>· placed {fmtDate(preview.orderDate)} · {preview.type}</span></span></div>
                  <div className="qb-plan-row"><span className="qb-plan-k">Vendors</span><span className="qb-plan-v">{preview.vendors.length
                    ? preview.vendors.map((v, i) => <span key={i} className="pill-tag tag-ok" style={{ marginRight: 6 }}>🏢 {v}</span>)
                    : <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>none matched from reports — will resolve on generate</span>}</span></div>

                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table className="data-table">
                      <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th>Vendor</th></tr></thead>
                      <tbody>
                        {preview.lines.map((l, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{l.itemName}</td>
                            <td className="num">{l.qty}</td>
                            <td className="num">{l.unit != null ? formatCurrency(l.unit) : '—'}</td>
                            <td>{l.vendor
                              ? <span className="pill-tag tag-ok" title={l.vendorSource === 'reports' ? 'From your vendor-items report' : ''}>✓ {l.vendor}</span>
                              : <span className="pill-tag" style={{ background: 'rgba(245,158,11,.12)', color: '#92400E' }}>○ resolve on generate</span>}</td>
                          </tr>
                        ))}
                        {preview.lines.length === 0 && <tr><td colSpan={4} style={{ color: C.muted }}>This order has no line items.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="page-sub" style={{ marginTop: 8, fontSize: 12 }}>
                    Vendor comes from your <b>Reports → Vendor items</b> mapping (which item you buy from whom). On generate, any unmatched line is resolved from its most recent PO.
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
                    <button className="btn" onClick={generate} disabled={generating || blocked || preview.lines.length === 0}
                      style={{ background: (blocked || preview.lines.length === 0) ? 'var(--muted)' : 'var(--accent)', color: '#fff' }}>
                      {generating ? 'Generating…' : blocked ? 'Blocked (not a test order)' : 'Generate PO →'}
                    </button>
                    <button className="btn ghost" onClick={onClose} disabled={generating}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// A created PO: fetch its PDF, preview + download it, and email it to an editable recipient.
function PoDeliveryCard({ line }: { line: AutoPoLine }) {
  const poId = line.poId as number;
  const [pdf, setPdf] = useState<AutoPoPdf | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const [to, setTo] = useState(DEFAULT_TO);
  const [subject, setSubject] = useState(`Purchase Order PO-${poId} — ${line.itemName}`);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<AutoPoEmailResult | null>(null);

  useEffect(() => {
    setLoadingPdf(true); setPdfErr(null);
    fetchAutoPoPdf(poId).then(setPdf).catch((e) => setPdfErr(e instanceof Error ? e.message : 'Failed to fetch the PDF.')).finally(() => setLoadingPdf(false));
  }, [poId]);

  async function send() {
    setSending(true); setSent(null);
    try { setSent(await autoPoSendEmail(poId, to.trim(), subject)); }
    catch (e) { setSent({ ok: false, error: e instanceof Error ? e.message : 'Send failed.' }); }
    finally { setSending(false); }
  }

  const dataUri = pdf ? `data:application/pdf;base64,${pdf.pdfBase64}` : '';
  const validTo = /.+@.+\..+/.test(to.trim());

  return (
    <div className="section" style={{ margin: '0 0 12px', border: '1px solid var(--border, #e5e7eb)', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontWeight: 800 }}>PO #{poId} <span className="pill-tag tag-ok" style={{ marginLeft: 6 }}>🏢 {line.vendor || 'vendor'}</span></div>
        <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>{line.itemName} × {line.qty}</div>
      </div>

      {/* PDF */}
      {loadingPdf && <div className="page-sub" style={{ fontSize: 13 }}>Fetching PO PDF…</div>}
      {pdfErr && <div className="error" style={{ marginBottom: 8 }}>{pdfErr}</div>}
      {pdf && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <a className="btn" href={dataUri} download={pdf.filename} style={{ background: 'var(--accent)', color: '#fff', textDecoration: 'none', padding: '6px 14px', fontSize: 13 }}>⬇ {pdf.filename}</a>
            <a className="btn ghost" href={dataUri} target="_blank" rel="noreferrer" style={{ padding: '6px 14px', fontSize: 13 }}>Open in tab ↗</a>
            <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>{(pdf.size / 1024).toFixed(0)} KB</span>
          </div>
          <object data={dataUri} type="application/pdf" width="100%" height="220" style={{ border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, marginBottom: 12 }}>
            <span className="page-sub" style={{ fontSize: 12 }}>Preview unavailable — use Download / Open in tab.</span>
          </object>
        </>
      )}

      {/* Email */}
      <div style={{ borderTop: '1px dashed var(--border, #e5e7eb)', paddingTop: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>📧 Email this PO <span className="page-sub" style={{ fontWeight: 400, fontSize: 12 }}>· professional PO email + PDF attached</span></div>
        {line.vendorEmail && (
          <div className="page-sub" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
            Vendor contact found: <b>{line.vendorEmail}</b>{' '}
            <button className="btn ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setTo(line.vendorEmail as string)}>Use this →</button>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <label className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>To</label>
          <input className="login-input" style={{ height: 36 }} value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@email.com" />
          <label className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Subject</label>
          <input className="login-input" style={{ height: 36 }} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={send} disabled={sending || !pdf || !validTo}
            style={{ background: (!pdf || !validTo) ? 'var(--muted)' : '#16A34A', color: '#fff' }}>
            {sending ? 'Sending…' : 'Send email with PDF →'}
          </button>
          <span className="page-sub" style={{ margin: 0, fontSize: 12 }}>Demo: editable recipient — defaults to the internal inbox, not the real vendor.</span>
        </div>
        {sent && (sent.ok
          ? <div className="qb-flash ok" style={{ marginTop: 10 }}>✓ Sent to <b>{sent.to}</b>{sent.id ? ` · id ${sent.id}` : ''}</div>
          : <div className="qb-flash err" style={{ marginTop: 10 }}>⚠ {sent.error}</div>)}
      </div>
    </div>
  );
}
