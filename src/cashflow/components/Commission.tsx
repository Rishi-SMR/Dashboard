import { useEffect, useState } from 'react';
import { fetchCommission, type CommissionResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PROG_C: Record<string, string> = { TriCare: '#0D9488', PI: '#2563EB', VA: '#16A34A' };
const REP_C = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DB2777', '#0891B2'];

// Commission accrual — mirrors Crystal's commission workbook (Google Sheets, live
// CSV). Shows what's accruing for the pay cycle per rep + program. Aggregated only
// — no patient names (the sheets carry PHI; we never surface it).
export function CommissionTab() {
  const [data, setData] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchCommission()); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load commission.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); const r = setInterval(() => load(true), 120_000); return () => clearInterval(r); }, []);

  const reps = data?.reps ?? [];
  const bp = data?.byProgram ?? { TriCare: 0, PI: 0, VA: 0 };
  const maxRep = Math.max(1, ...reps.map((r) => r.total));

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Commission · Accrual</h1>
          <div className="page-sub">
            <span className="live-dot" /> What's accruing this pay cycle — from the commission workbook{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && data.configured === false && (
        <div className="section"><div className="page-sub" style={{ padding: 16 }}>
          {data.note || 'No commission sheet configured yet.'} Share the commission workbook(s) and I'll wire them in.
        </div></div>
      )}

      {data && data.configured !== false && (
        <>
          {(data.errors?.length > 0 || data.sheetsRead < data.sheetsConfigured) && (
            <div className="qb-flash warn" style={{ marginBottom: 12 }}>
              ⚠️ Read {data.sheetsRead}/{data.sheetsConfigured} commission sheets{data.errors.length ? ` — couldn't read: ${data.errors.join(', ')} (share the sheet as "anyone with the link can view")` : ''}.
            </div>
          )}

          {/* Total + program tiles */}
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <KpiR ico="cash" tint={C.brand} label="Total accruing" value={data.grandTotal} format={formatCurrency} foot={`${data.itemCount} commission lines`} deltaText="this pay cycle" />
            <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat per device" deltaText={pct(bp.TriCare, data.grandTotal)} />
            <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat per device" deltaText={pct(bp.VA, data.grandTotal)} />
            <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="computed" deltaText={pct(bp.PI, data.grandTotal)} />
          </div>

          <div className="qb-flash warn" style={{ marginBottom: 12 }}>
            🔒 Aggregated from the commission sheet(s) — <b>no patient names</b> are shown or stored. VA/TriCare = flat per-device rate; PI = computed.
            {data.sources?.length > 0 && <> · {data.sources.map((s, i) => <span key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.label} sheet ↗</a>{i < data.sources.length - 1 ? ' · ' : ''}</span>)}</>}
          </div>

          {/* Rep leaderboard */}
          <div className="section chart-card">
            <div className="section-head"><div>
              <h2 className="section-title">By rep · commission due</h2>
              <div className="section-sub">Ranked by total accruing. Click the sheet link above for the line detail.</div>
            </div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th style={{ width: 40 }}>#</th><th>Rep</th><th className="num">TriCare</th><th className="num">VA</th><th className="num">PI</th>
                  <th className="num">Lines</th><th className="num">Total due</th><th style={{ width: '22%' }} />
                </tr></thead>
                <tbody>
                  {reps.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No commission data.</td></tr>}
                  {reps.map((r, i) => (
                    <tr key={r.rep}>
                      <td style={{ color: C.muted }}>{i + 1}</td>
                      <td style={{ fontWeight: 700 }}>{r.rep}</td>
                      <td className="num">{r.tricare ? formatCurrency(r.tricare) : '—'}</td>
                      <td className="num">{r.va ? formatCurrency(r.va) : '—'}</td>
                      <td className="num">{r.pi ? formatCurrency(r.pi) : '—'}</td>
                      <td className="num">{r.count}</td>
                      <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.total)}</td>
                      <td>
                        <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${(r.total / maxRep) * 100}%`, background: REP_C[i % REP_C.length], borderRadius: 999 }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {reps.length > 0 && (
                  <tfoot><tr className="total-row">
                    <td /><td>Total</td>
                    <td className="num">{formatCurrency(bp.TriCare)}</td>
                    <td className="num">{formatCurrency(bp.VA)}</td>
                    <td className="num">{formatCurrency(bp.PI)}</td>
                    <td className="num">{data.itemCount}</td>
                    <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(data.grandTotal)}</td><td />
                  </tr></tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}% of total` : '—');
