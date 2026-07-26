import { useEffect, useState } from 'react';
import { fetchCommission, type CommissionResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PROG_C: Record<string, string> = { TriCare: '#0D9488', PI: '#2563EB', VA: '#16A34A' };
const REP_C = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DB2777', '#0891B2'];

// Commission CFO analysis — reads every tab of Crystal's commission workbook(s)
// (all pay periods) and reconciles each rep's accrued commission against their
// Striven order attribution (order count / units / value). Aggregated only —
// no patient names (the sheets carry PHI; we never surface it).
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
  const periods = data?.periods ?? [];
  const bp = data?.byProgram ?? { TriCare: 0, PI: 0, VA: 0 };
  const maxRep = Math.max(1, ...reps.map((r) => r.total));
  const maxPeriod = Math.max(1, ...periods.map((p) => p.total));
  const flagged = reps.filter((r) => r.flag);

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Commission · CFO Analysis</h1>
          <div className="page-sub">
            <span className="live-dot" /> All pay periods, reconciled against Striven order attribution{agoText ? ` · updated ${agoText}` : ''}
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
          {(data.errors?.length > 0) && (
            <div className="qb-flash warn" style={{ marginBottom: 12 }}>
              ⚠️ {data.errors.join(' · ')}
            </div>
          )}

          {/* Total + program tiles */}
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <KpiR ico="cash" tint={C.brand} label="Total commission" value={data.grandTotal} format={formatCurrency} foot={`${data.itemCount} lines · ${data.periodCount} pay periods`} deltaText="all periods" />
            <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat per device" deltaText={pct(bp.TriCare, data.grandTotal)} />
            <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat per device" deltaText={pct(bp.VA, data.grandTotal)} />
            <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="computed" deltaText={pct(bp.PI, data.grandTotal)} />
          </div>

          {/* Reconciliation anomaly callout */}
          {flagged.length > 0 && (
            <div className="qb-flash warn" style={{ marginBottom: 12, borderLeft: `3px solid ${C.negative}` }}>
              ⚠️ <b>Reconciliation flags ({flagged.length}):</b>{' '}
              {flagged.map((r, i) => (
                <span key={r.rep}>
                  <b>{r.rep}</b> — {r.flag === 'no-striven'
                    ? 'no matching orders in Striven (name/attribution mismatch?)'
                    : `commission is ${r.pctOfValue}% of Striven order value (${formatCurrency(r.total)} on ${r.strivenOrders} order${r.strivenOrders === 1 ? '' : 's'} / ${formatCurrency(r.strivenValue)}) — orders may be booked under a house account`}
                  {i < flagged.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </div>
          )}

          {/* Rep leaderboard + Striven reconciliation */}
          <div className="section chart-card">
            <div className="section-head"><div>
              <h2 className="section-title">By rep · commission vs Striven attribution</h2>
              <div className="section-sub">Commission (from the workbook) reconciled against each rep's Striven orders. “% of value” = commission ÷ Striven order value; a very high ratio means orders aren't landing under that rep in Striven.</div>
            </div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th style={{ width: 34 }}>#</th><th>Rep</th>
                  <th className="num">TriCare</th><th className="num">VA</th><th className="num">PI</th>
                  <th className="num">Lines</th><th className="num">Commission</th>
                  <th className="num">Striven ord.</th><th className="num">Striven $</th>
                  <th className="num">Comm / ord.</th><th className="num">% of value</th>
                  <th style={{ width: '14%' }} />
                </tr></thead>
                <tbody>
                  {reps.length === 0 && <tr><td colSpan={12} style={{ color: C.muted }}>No commission data.</td></tr>}
                  {reps.map((r, i) => (
                    <tr key={r.rep}>
                      <td style={{ color: C.muted }}>{i + 1}</td>
                      <td style={{ fontWeight: 700 }}>
                        {r.flag && <span title={r.flag === 'no-striven' ? 'Not found in Striven' : 'Commission far exceeds Striven order value'} style={{ marginRight: 5 }}>⚠️</span>}
                        {r.rep}
                      </td>
                      <td className="num">{r.tricare ? formatCurrency(r.tricare) : '—'}</td>
                      <td className="num">{r.va ? formatCurrency(r.va) : '—'}</td>
                      <td className="num">{r.pi ? formatCurrency(r.pi) : '—'}</td>
                      <td className="num">{r.count}</td>
                      <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.total)}</td>
                      <td className="num">{r.strivenOrders || '—'}</td>
                      <td className="num">{r.strivenValue ? formatCurrency(r.strivenValue) : '—'}</td>
                      <td className="num">{r.commPerOrder != null ? formatCurrency(r.commPerOrder) : '—'}</td>
                      <td className="num" style={{ fontWeight: 700, color: r.flag === 'high-ratio' ? C.negative : C.ink }}>
                        {r.pctOfValue != null ? `${r.pctOfValue}%` : '—'}
                      </td>
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
                    <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(data.grandTotal)}</td>
                    <td className="num">{reps.reduce((s, r) => s + r.strivenOrders, 0)}</td>
                    <td className="num">{formatCurrency(reps.reduce((s, r) => s + r.strivenValue, 0))}</td>
                    <td /><td /><td />
                  </tr></tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Per-period trend */}
          {periods.length > 0 && (
            <div className="section chart-card" style={{ marginTop: 14 }}>
              <div className="section-head"><div>
                <h2 className="section-title">By pay period</h2>
                <div className="section-sub">Every tab read across the commission workbook(s), largest first.</div>
              </div></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Workbook</th><th>Tab</th><th className="num">Lines</th><th className="num">Commission</th><th style={{ width: '38%' }} />
                  </tr></thead>
                  <tbody>
                    {periods.map((p, i) => (
                      <tr key={`${p.workbook}-${p.gid}`}>
                        <td style={{ fontWeight: 600 }}>{p.workbook}</td>
                        <td style={{ color: C.muted }}>gid {p.gid}</td>
                        <td className="num">{p.lines}</td>
                        <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(p.total)}</td>
                        <td>
                          <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${(p.total / maxPeriod) * 100}%`, background: REP_C[i % REP_C.length], borderRadius: 999 }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="qb-flash warn" style={{ marginTop: 12 }}>
            🔒 Aggregated from the commission sheet(s) — <b>no patient names</b> are shown or stored. VA/TriCare = flat per-device rate; PI = computed. Reconciliation matches on rep name only (no patient-level join).
            {data.sources?.length > 0 && <> · {data.sources.map((s, i) => <span key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.label} sheet ↗</a>{i < data.sources.length - 1 ? ' · ' : ''}</span>)}</>}
          </div>
        </>
      )}
    </div>
  );
}

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}% of total` : '—');
