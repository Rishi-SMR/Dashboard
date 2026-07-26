import { useEffect, useState } from 'react';
import { fetchCommission, type CommissionResult, type StrivenCommission, type StrivenCommRep } from '../strivenApi';
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
  const [detail, setDetail] = useState<null | 'total' | 'TriCare' | 'VA' | 'PI'>(null);
  const [source, setSource] = useState<'sheet' | 'striven'>('sheet');
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
        <div className="ov-headright" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="seg" style={{ display: 'inline-flex', background: 'var(--panel-2)', borderRadius: 8, padding: 3 }}>
            <button className={`btn ghost ${source === 'sheet' ? 'active' : ''}`} style={segStyle(source === 'sheet')} onClick={() => setSource('sheet')}>From the sheet</button>
            <button className={`btn ghost ${source === 'striven' ? 'active' : ''}`} style={segStyle(source === 'striven')} onClick={() => setSource('striven')}>From Striven</button>
          </div>
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

      {data && data.configured !== false && source === 'striven' && (
        <StrivenCommissionView striven={data.striven} sheetTotal={data.grandTotal} />
      )}

      {data && data.configured !== false && source === 'sheet' && (
        <>
          {(data.errors?.length > 0) && (
            <div className="qb-flash warn" style={{ marginBottom: 12 }}>
              ⚠️ {data.errors.join(' · ')}
            </div>
          )}

          {/* Total + program tiles — click any card to drill into its breakdown */}
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: detail ? 8 : 14 }}>
            <KpiR ico="cash" tint={C.brand} label="Total commission" value={data.grandTotal} format={formatCurrency} foot={`${data.itemCount} lines · ${data.periodCount} pay periods · tap for detail`} deltaText="all periods" onClick={() => setDetail(detail === 'total' ? null : 'total')} />
            <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat per device · tap for detail" deltaText={pct(bp.TriCare, data.grandTotal)} onClick={() => setDetail(detail === 'TriCare' ? null : 'TriCare')} />
            <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat per device · tap for detail" deltaText={pct(bp.VA, data.grandTotal)} onClick={() => setDetail(detail === 'VA' ? null : 'VA')} />
            <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="computed · tap for detail" deltaText={pct(bp.PI, data.grandTotal)} onClick={() => setDetail(detail === 'PI' ? null : 'PI')} />
          </div>

          {/* KPI drill-down panel */}
          {detail && <KpiDetail detail={detail} data={data} onClose={() => setDetail(null)} />}

          {/* Patient-level reconciliation anomaly callouts */}
          {flagged.map((r) => (
            <div key={r.rep} className="qb-flash warn" style={{ marginBottom: 12, borderLeft: `3px solid ${C.negative}` }}>
              ⚠️ <b>{r.rep} — attribution break.</b>{' '}
              Only <b>{r.recon.same} of {r.count}</b> commission lines ({r.matchRate}%) match an order booked under {r.rep} in Striven
              {' '}({formatCurrency(r.recon.commSame)}).
              {r.recon.diff > 0 && <> {r.recon.diff} line{r.recon.diff === 1 ? '' : 's'} ({formatCurrency(r.recon.commDiff)}) are booked under {r.recon.bookedUnder.map((b, j) => <span key={b.rep}><b>{b.rep}</b> ({b.count}){j < r.recon.bookedUnder.length - 1 ? ', ' : ''}</span>)}.</>}
              {r.recon.none > 0 && <> <b>{r.recon.none} line{r.recon.none === 1 ? '' : 's'} ({formatCurrency(r.recon.commNone)})</b> have no matching order in Striven at all.</>}
              {' '}Commission is being paid on orders that aren't credited to this rep in Striven — worth a data-integrity check.
            </div>
          ))}

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
                  <th className="num">Comm / ord.</th><th className="num" title="% of a rep's commission lines that match an order booked under them in Striven">Patient match</th><th className="num">% of value</th>
                  <th style={{ width: '12%' }} />
                </tr></thead>
                <tbody>
                  {reps.length === 0 && <tr><td colSpan={13} style={{ color: C.muted }}>No commission data.</td></tr>}
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
                      <td className="num" style={{ fontWeight: 700, color: r.matchRate != null && r.matchRate < 50 ? C.negative : C.ink }}
                        title={`${r.recon.same} same rep · ${r.recon.diff} other rep · ${r.recon.none} not in Striven`}>
                        {r.matchRate != null ? `${r.matchRate}%` : '—'}
                      </td>
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
                    <td /><td /><td /><td />
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
const segStyle = (active: boolean): React.CSSProperties => ({ border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 700, background: active ? C.brand : 'transparent', color: active ? '#fff' : C.sub, cursor: 'pointer' });
const monthLabel = (m: string) => { if (!m || m === 'unknown') return 'Undated'; const [y, mo] = m.split('-'); const N = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${N[+mo] || mo} ${y}`; };

// Commission computed FROM Striven (rate card) — sheet-shaped: month selector +
// per-rep TriCare/VA/PI bifurcation. Replaces dependence on the manual workbook.
function StrivenCommissionView({ striven, sheetTotal }: { striven?: StrivenCommission; sheetTotal: number }) {
  const [month, setMonth] = useState<string>('all');
  if (!striven || !striven.available) {
    return <div className="section"><div className="page-sub" style={{ padding: 16 }}>Striven order data isn't loaded yet — computed commission needs the Striven sales-order cache. Try Refresh, or open the Orders tab first.</div></div>;
  }
  const sel = month === 'all' ? null : striven.months.find((m) => m.month === month);
  const reps: StrivenCommRep[] = sel ? sel.reps : striven.byRep;
  const bp = sel ? { TriCare: sel.TriCare, VA: sel.VA, PI: sel.PI } : striven.byProgram;
  const total = sel ? sel.total : striven.grandTotal;
  const maxRep = Math.max(1, ...reps.map((r) => r.total));
  const gap = striven.grandTotal - sheetTotal;
  const totalOrders = reps.reduce((s, r) => s + r.orders, 0);

  return (
    <>
      {/* One plain-language line: what this screen is */}
      <div style={{ marginBottom: 14, padding: '11px 14px', background: 'var(--panel-2)', borderRadius: 10, fontSize: 13.5, color: C.sub, lineHeight: 1.5 }}>
        Commission worked out <b style={{ color: C.ink }}>directly from Striven orders</b> — same shape as Crystal's sheet (by month, by rep, split into TriCare / VA / PI), but nothing is typed by hand. Cancelled &amp; test orders are left out.
      </div>

      {/* KPI strip — total + the three programs */}
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
        <KpiR ico="cash" tint={C.brand} label={sel ? monthLabel(sel.month) : 'Total commission'} value={total} format={formatCurrency} foot={sel ? `${sel.orders} orders this month` : `${totalOrders} orders · ${striven.months.length} months`} deltaText={sel ? 'selected month' : 'all months'} />
        <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat rate per order" deltaText={pct(bp.TriCare, total)} />
        <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat rate per unit" deltaText={pct(bp.VA, total)} />
        <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="% of order value" deltaText={pct(bp.PI, total)} />
      </div>

      {/* Month selector — pick a month or see all */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 600, marginRight: 4 }}>Month:</span>
        <button className="btn ghost" style={segStyle(month === 'all')} onClick={() => setMonth('all')}>All</button>
        {striven.months.map((m) => (
          <button key={m.month} className="btn ghost" style={segStyle(month === m.month)} onClick={() => setMonth(m.month)}>
            {monthLabel(m.month)}
          </button>
        ))}
      </div>

      {/* Per-rep bifurcation for the selected scope */}
      <div className="section chart-card">
        <div className="section-head"><div>
          <h2 className="section-title">{sel ? monthLabel(sel.month) : 'All months'} — commission by rep</h2>
          <div className="section-sub">What each rep earned, split into TriCare / VA / PI. Names come from Striven, so house &amp; clinic accounts show too.</div>
        </div></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 34 }}>#</th><th>Rep</th>
              <th className="num">TriCare</th><th className="num">VA</th><th className="num">PI</th>
              <th className="num">Orders</th><th className="num">Total</th>
              <th style={{ width: '20%' }} />
            </tr></thead>
            <tbody>
              {reps.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No orders in this period.</td></tr>}
              {reps.map((r, i) => (
                <tr key={r.rep}>
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 700 }} title={`${r.units} units`}>{r.rep}</td>
                  <td className="num">{r.tricare ? formatCurrency(r.tricare) : '—'}</td>
                  <td className="num">{r.va ? formatCurrency(r.va) : '—'}</td>
                  <td className="num">{r.pi ? formatCurrency(r.pi) : '—'}</td>
                  <td className="num">{r.orders}</td>
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
                <td className="num">{totalOrders}</td>
                <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(total)}</td><td />
              </tr></tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Progressive disclosure — the "how" stays out of the way until asked */}
      <details style={{ marginTop: 12, background: 'var(--panel-2)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: C.sub }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, color: C.ink }}>How is this calculated?</summary>
        <div style={{ marginTop: 10, lineHeight: 1.6 }}>
          <b>Source.</b> Striven sales orders that are active or completed — cancelled &amp; test orders are excluded (no commission on those).<br />
          <b>Rates used.</b>
          <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>
            <li><b>VA</b> — $425 per unit. <span style={{ color: C.positive, fontWeight: 700 }}>Exact</span> (checked against the sheet).</li>
            <li><b>TriCare</b> — $369.78 per order. <i>Estimate</i> (sheet average).</li>
            <li><b>Personal Injury</b> — 2.677% of order value. <i>Estimate</i> (derived from the sheet).</li>
          </ul>
          <b>Sheet vs Striven.</b> The manual sheet totals {formatCurrency(sheetTotal)}; this Striven calculation totals {formatCurrency(striven.grandTotal)} ({gap >= 0 ? '+' : ''}{formatCurrency(gap)}). The difference is mostly orders that are in Striven but were never added to the sheet, plus the two estimated rates above.<br />
          <span style={{ color: C.muted }}>TriCare &amp; PI stay estimates until Kevin/Crystal confirm the official rate card — then these become exact too. 🔒 No patient names are used.</span>
        </div>
      </details>
    </>
  );
}

// Drill-down for a tapped KPI card: the metric's full per-rep breakdown.
function KpiDetail({ detail, data, onClose }: { detail: 'total' | 'TriCare' | 'VA' | 'PI'; data: CommissionResult; onClose: () => void }) {
  const isTotal = detail === 'total';
  const key = detail === 'TriCare' ? 'tricare' : detail === 'VA' ? 'va' : detail === 'PI' ? 'pi' : 'total';
  const rows = data.reps
    .map((r) => ({ rep: r.rep, amount: r[key as 'tricare' | 'va' | 'pi' | 'total'], match: r.matchRate, flag: r.flag, count: r.count }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  const title = isTotal ? 'Total commission — by rep (all programs)' : `${detail === 'PI' ? 'Personal Injury' : detail} commission — by rep`;
  return (
    <div className="section chart-card" style={{ marginBottom: 14, borderLeft: `3px solid ${isTotal ? C.brand : PROG_C[detail]}` }}>
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 className="section-title">{title}</h2>
          <div className="section-sub">{rows.length} rep{rows.length === 1 ? '' : 's'} · {formatCurrency(sum)}{isTotal ? ' across all pay periods' : ''}</div>
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Close detail">✕ Close</button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th style={{ width: 34 }}>#</th><th>Rep</th><th className="num">Amount</th><th className="num">Share</th>
            {isTotal && <><th className="num">Lines</th><th className="num">Patient match</th></>}
            <th style={{ width: '30%' }} />
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.rep}>
                <td style={{ color: C.muted }}>{i + 1}</td>
                <td style={{ fontWeight: 700 }}>{r.flag && <span style={{ marginRight: 5 }}>⚠️</span>}{r.rep}</td>
                <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.amount)}</td>
                <td className="num">{sum > 0 ? `${Math.round((r.amount / sum) * 100)}%` : '—'}</td>
                {isTotal && <><td className="num">{r.count}</td>
                  <td className="num" style={{ color: r.match != null && r.match < 50 ? C.negative : C.ink }}>{r.match != null ? `${r.match}%` : '—'}</td></>}
                <td>
                  <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${sum > 0 ? (r.amount / rows[0].amount) * 100 : 0}%`, background: REP_C[i % REP_C.length], borderRadius: 999 }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
