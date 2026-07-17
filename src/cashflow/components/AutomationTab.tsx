import { useEffect, useState } from 'react';
import { runAutoPo, type AutoPoResult, type AutoPoEntry } from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtAt = (s: string) =>
  new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One processed-SO result card: what the automation did (or would do) per line.
function EntryView({ e }: { e: AutoPoEntry }) {
  return (
    <div className="section chart-card" style={{ marginBottom: 14 }}>
      <div className="section-head" style={{ marginBottom: e.skipped ? 0 : undefined }}>
        <div>
          <h2 className="section-title">
            <span className={`pill-tag ${e.mode === 'live' ? 'tag-danger' : 'tag-info'}`} style={{ marginRight: 8, textTransform: 'uppercase', fontSize: 10 }}>{e.mode}</span>
            SO {e.soId} · {e.soNumber}
          </h2>
          <div className="section-sub">{e.type || '—'} · {fmtAt(e.at)}</div>
        </div>
      </div>
      {e.skipped ? (
        <div className="info-banner" style={{ marginBottom: 0 }}><span className="info-banner-icon">ℹ</span><span>Skipped: {e.skipped}</span></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Item</th><th className="num">Qty</th><th>Vendor</th><th>Result</th></tr>
            </thead>
            <tbody>
              {e.lines.map((l, i) => (
                <tr key={i}>
                  <td><strong>{l.itemName}</strong></td>
                  <td className="num">{l.qty}</td>
                  <td>{l.vendor || '—'}</td>
                  <td>
                    {/PO CREATED/.test(l.result)
                      ? <span className="pill-tag tag-ok">✓ PO created{l.poId ? ` · #${l.poId}` : ''}</span>
                      : /DRY-RUN/.test(l.result)
                        ? <span className="pill-tag tag-info">Dry-run: PO ban jata</span>
                        : <span className="pill-tag tag-warn">{l.result}</span>}
                    {l.plan && (
                      <div className="muted-note" style={{ marginTop: 4 }}>
                        {l.plan.title}{l.plan.dropShipTo ? ` · drop-ship: ${l.plan.dropShipTo}` : ''}{l.plan.unitPrice != null ? ` · ${formatCurrency(l.plan.unitPrice)}/unit` : ''}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AutomationTab() {
  const [status, setStatus] = useState<AutoPoResult | null>(null);
  const [soId, setSoId] = useState('315');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AutoPoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function loadStatus() {
    try {
      setStatus(await runAutoPo({ action: 'status' }));
      setLastSync(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load automation status.');
    }
  }
  useEffect(() => { loadStatus(); }, []);

  async function run(params: Record<string, string>, label: string) {
    setBusy(label); setError(null);
    try {
      const r = await runAutoPo(params);
      setResult(r);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Automation run failed.');
    } finally { setBusy(null); }
  }

  const testDry = () => { if (soId.trim()) run({ so: soId.trim(), mode: 'dry' }, 'dry'); };
  const testLive = () => {
    if (!soId.trim()) return;
    if (window.confirm(`SO ${soId} ke liye Striven mein SACH MEIN PO create hoga (DEMO gate ke andar). Continue?`)) {
      run({ so: soId.trim(), mode: 'live' }, 'live');
    }
  };
  const pollNow = () => run({}, 'poll');

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Automation</h1>
          <div className="page-sub">
            <span className="live-dot" /> Auto-PO · Sales Order placed → vendor PO raised{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={loadStatus}>↻ Refresh status</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <KpiR ico="trend" tint={status?.mode === 'live' ? '#16A34A' : '#D97706'} label="Mode" value={status?.mode === 'live' ? 1 : 0}
          format={() => (status?.mode === 'live' ? 'LIVE' : 'DRY-RUN')}
          deltaText={status?.mode === 'live' ? 'POs really get created' : 'plan only · nothing is created'}
          foot="AUTO_PO_MODE env se default" />
        <KpiR ico="shield" tint="#2563EB" label="Pilot Gate" value={status?.demoOnly === false ? 0 : 1}
          format={(n) => (n ? 'DEMO ONLY' : 'ALL ORDERS')}
          deltaText={status?.demoOnly === false ? 'har order process hoga' : 'sirf DEMO/test orders'}
          foot="real patients safe" />
        <KpiR ico="clock" tint="#7C3AED" label="Checkpoint" value={status?.checkpoint ?? 0}
          format={(n) => (n ? `SO ${Math.round(n)}` : '—')}
          deltaText="isse purane orders kabhi nahi chhede jayenge" foot="poll yahan se aage dekhta hai" />
        <KpiR ico="clip" tint="#0D9488" label="Runs Logged" value={status?.log?.length ?? 0}
          deltaText={`${status?.processedCount ?? 0} SOs processed (live)`} foot="last 20 runs neeche" />
      </div>

      <div className="exec-grid12">
        <div className="section chart-card g12-5">
          <div className="section-head"><div><h2 className="section-title">Test a Sales Order</h2><div className="section-sub">SO id daalo → dry-run dekho · SO-315 = DEMO Hidow</div></div></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="tbl-search" style={{ width: 120 }} value={soId} onChange={(e) => setSoId(e.target.value.replace(/\D/g, ''))} placeholder="SO id" />
            <button className="btn" disabled={!!busy || !soId.trim()} onClick={testDry}>
              {busy === 'dry' ? 'Running…' : '▶ Dry-run (safe)'}
            </button>
            <button className="ac-review" style={{ marginLeft: 0 }} disabled={!!busy || !soId.trim()} onClick={testLive}>
              {busy === 'live' ? 'Creating…' : '⚡ Live: PO banao'}
            </button>
          </div>
          <div className="muted-note" style={{ marginTop: 12 }}>
            Dry-run kuch create nahi karta — sirf exact plan dikhata hai (vendor, qty, drop-ship). Live pe bhi DEMO gate laga hai.
          </div>
        </div>

        <div className="section chart-card g12-3">
          <div className="section-head"><div><h2 className="section-title">Poll Now</h2><div className="section-sub">Jaise cron chalata hai</div></div></div>
          <div className="card-body" style={{ justifyContent: 'flex-start' }}>
            <button className="btn ghost" disabled={!!busy} onClick={pollNow}>{busy === 'poll' ? 'Polling…' : '⟳ Naye SOs check karo'}</button>
            <div className="muted-note" style={{ marginTop: 10 }}>Checkpoint ke baad ke naye Sales Orders process karta hai (max 3 per run).</div>
          </div>
        </div>

        <div className="section chart-card g12-4">
          <div className="section-head"><div><h2 className="section-title">Kaise chalta hai</h2><div className="section-sub">3 steps</div></div></div>
          <div className="ins-list">
            <div className="ins-item"><span className="ins-dot" style={{ background: 'rgba(37,99,235,0.10)', color: '#2563EB' }}>1</span><span>Naya SO milta hai (poll/test) → <b>DEMO gate</b> check</span></div>
            <div className="ins-item"><span className="ins-dot" style={{ background: 'rgba(124,58,237,0.10)', color: '#7C3AED' }}>2</span><span>Har item ka <b>pichhla PO</b> dhoondh ke vendor + terms milte hain</span></div>
            <div className="ins-item"><span className="ins-dot" style={{ background: 'rgba(22,163,74,0.12)', color: '#16A34A' }}>3</span><span>PO banta hai — <b>drop-ship current customer</b>, title mein SO number</span></div>
          </div>
        </div>
      </div>

      {result && (
        <>
          <div className="kpi-eyebrow" style={{ marginTop: 20 }}>
            <span className="ey-label">Latest Run Result</span>
            <span className="ey-pill">{result.mode.toUpperCase()}{result.note ? ` · ${result.note}` : ''}</span>
          </div>
          {(result.processed ?? []).map((e, i) => <EntryView key={i} e={e} />)}
          {!result.processed?.length && result.note && (
            <div className="info-banner"><span className="info-banner-icon">ℹ</span><span>{result.note}</span></div>
          )}
        </>
      )}

      {(status?.log?.length ?? 0) > 0 && (
        <>
          <div className="kpi-eyebrow" style={{ marginTop: 20 }}>
            <span className="ey-label">Run History</span>
            <span className="ey-pill">last {status!.log!.length}</span>
          </div>
          {status!.log!.map((e, i) => <EntryView key={`${e.at}-${i}`} e={e} />)}
        </>
      )}
    </div>
  );
}
