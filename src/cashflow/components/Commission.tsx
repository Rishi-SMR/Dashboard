import { useEffect, useState } from 'react';
import { fetchCommission, type CommissionResult, type CommissionRep, type CommissionPeriod, type CommissionPeriodRep, type CommissionReconcile, type StrivenCommission, type StrivenCommRep, type StrivenCommMonth } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PROG_C: Record<string, string> = { TriCare: '#0D9488', PI: '#2563EB', VA: '#16A34A' };
const REP_C = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DB2777', '#0891B2'];

// Commission CFO analysis - reads every tab of Crystal's commission workbook(s)
// (all pay periods) and reconciles each rep's accrued commission against their
// Striven order attribution (order count / units / value). Aggregated only -
// no patient names (the sheets carry PHI; we never surface it).
export function CommissionTab() {
  const [data, setData] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [detail, setDetail] = useState<null | 'total' | 'TriCare' | 'VA' | 'PI'>(null);
  const [source, setSource] = useState<'sheet' | 'striven' | 'reconcile'>('sheet');
  const [sheetMonth, setSheetMonth] = useState<string>('all');
  const [repSel, setRepSel] = useState<CommissionRep | null>(null);
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
            <button className={`btn ghost ${source === 'reconcile' ? 'active' : ''}`} style={segStyle(source === 'reconcile')} onClick={() => setSource('reconcile')}>Reconcile</button>
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

      {data && data.configured !== false && source === 'reconcile' && (
        <ReconcileView reconcile={data.reconcile} sheetReps={data.reps} strivenReps={data.striven?.byRep} />
      )}

      {data && data.configured !== false && source === 'sheet' && (
        <>
          {(data.errors?.length > 0) && (
            <div className="qb-flash warn" style={{ marginBottom: 12 }}>
              ⚠️ {data.errors.join(' · ')}
            </div>
          )}

          {/* Total + program tiles - click any card to drill into its breakdown */}
          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: detail ? 8 : 14 }}>
            <KpiR ico="cash" tint={C.brand} label="Total commission" value={data.grandTotal} format={formatCurrency} foot={`${data.itemCount} lines · ${data.periodCount} pay periods · tap for detail`} deltaText="all periods" onClick={() => setDetail(detail === 'total' ? null : 'total')} />
            <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat per device · tap for detail" deltaText={pct(bp.TriCare, data.grandTotal)} onClick={() => setDetail(detail === 'TriCare' ? null : 'TriCare')} />
            <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat per device · tap for detail" deltaText={pct(bp.VA, data.grandTotal)} onClick={() => setDetail(detail === 'VA' ? null : 'VA')} />
            <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="computed · tap for detail" deltaText={pct(bp.PI, data.grandTotal)} onClick={() => setDetail(detail === 'PI' ? null : 'PI')} />
          </div>

          {/* KPI drill-down panel */}
          {detail && <KpiDetail detail={detail} data={data} onClose={() => setDetail(null)} />}

          {/* Pay-period tabs (from the sheet's monthly tab names) */}
          <SheetPeriodTabs periods={data.periods} value={sheetMonth} onChange={setSheetMonth} />

          {sheetMonth !== 'all' && <SheetMonthTable periods={data.periods} monthKey={sheetMonth} />}

          {sheetMonth === 'all' && <>
          {/* Patient-level reconciliation anomaly callouts */}
          {flagged.map((r) => (
            <div key={r.rep} className="qb-flash warn" style={{ marginBottom: 12, borderLeft: `3px solid ${C.negative}` }}>
              ⚠️ <b>{r.rep} - attribution break.</b>{' '}
              Only <b>{r.recon.same} of {r.count}</b> commission lines ({r.matchRate}%) match an order booked under {r.rep} in Striven
              {' '}({formatCurrency(r.recon.commSame)}).
              {r.recon.diff > 0 && <> {r.recon.diff} line{r.recon.diff === 1 ? '' : 's'} ({formatCurrency(r.recon.commDiff)}) are booked under {r.recon.bookedUnder.map((b, j) => <span key={b.rep}><b>{b.rep}</b> ({b.count}){j < r.recon.bookedUnder.length - 1 ? ', ' : ''}</span>)}.</>}
              {r.recon.none > 0 && <> <b>{r.recon.none} line{r.recon.none === 1 ? '' : 's'} ({formatCurrency(r.recon.commNone)})</b> have no matching order in Striven at all.</>}
              {' '}Commission is being paid on orders that aren't credited to this rep in Striven - worth a data-integrity check.
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
                    <tr key={r.rep} onClick={() => setRepSel(r)} style={{ cursor: 'pointer' }} title="Click for this rep's full detail">
                      <td style={{ color: C.muted }}>{i + 1}</td>
                      <td style={{ fontWeight: 700, color: C.brand }}>
                        {r.flag && <span title={r.flag === 'no-striven' ? 'Not found in Striven' : 'Commission far exceeds Striven order value'} style={{ marginRight: 5 }}>⚠️</span>}
                        {r.rep}
                      </td>
                      <td className="num">{r.tricare ? formatCurrency(r.tricare) : '-'}</td>
                      <td className="num">{r.va ? formatCurrency(r.va) : '-'}</td>
                      <td className="num">{r.pi ? formatCurrency(r.pi) : '-'}</td>
                      <td className="num">{r.count}</td>
                      <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.total)}</td>
                      <td className="num">{r.strivenOrders || '-'}</td>
                      <td className="num">{r.strivenValue ? formatCurrency(r.strivenValue) : '-'}</td>
                      <td className="num">{r.commPerOrder != null ? formatCurrency(r.commPerOrder) : '-'}</td>
                      <td className="num" style={{ fontWeight: 700, color: r.matchRate != null && r.matchRate < 50 ? C.negative : C.ink }}
                        title={`${r.recon.same} same rep · ${r.recon.diff} other rep · ${r.recon.none} not in Striven`}>
                        {r.matchRate != null ? `${r.matchRate}%` : '-'}
                      </td>
                      <td className="num" style={{ fontWeight: 700, color: r.flag === 'high-ratio' ? C.negative : C.ink }}>
                        {r.pctOfValue != null ? `${r.pctOfValue}%` : '-'}
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

          </>}

          <div className="qb-flash warn" style={{ marginTop: 12 }}>
            🔒 Aggregated from the commission sheet(s) - <b>no patient names</b> are shown or stored. VA/TriCare = flat per-device rate; PI = computed. Reconciliation matches on rep name only (no patient-level join).
            {data.sources?.length > 0 && <> · {data.sources.map((s, i) => <span key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.label} sheet ↗</a>{i < data.sources.length - 1 ? ' · ' : ''}</span>)}</>}
          </div>
        </>
      )}

      {repSel && <SheetRepModal rep={repSel} onClose={() => setRepSel(null)} />}
    </div>
  );
}

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}% of total` : '-');
const segStyle = (active: boolean): React.CSSProperties => ({ border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 700, background: active ? C.brand : 'transparent', color: active ? '#fff' : C.sub, cursor: 'pointer' });
const monthLabel = (m: string) => { if (!m || m === 'unknown') return 'Undated'; const [y, mo] = m.split('-'); const N = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${N[+mo] || mo} ${y}`; };

// Commission computed FROM Striven (rate card) - sheet-shaped: month selector +
// per-rep TriCare/VA/PI bifurcation. Replaces dependence on the manual workbook.
function StrivenCommissionView({ striven, sheetTotal }: { striven?: StrivenCommission; sheetTotal: number }) {
  const [month, setMonth] = useState<string>('all');
  const [repSel, setRepSel] = useState<StrivenCommRep | null>(null);
  if (!striven || !striven.available) {
    return <div className="section"><div className="page-sub" style={{ padding: 16 }}>Striven order data isn't loaded yet - computed commission needs the Striven sales-order cache. Try Refresh, or open the Orders tab first.</div></div>;
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
        Commission worked out <b style={{ color: C.ink }}>directly from Striven orders</b> - same shape as Crystal's sheet (by month, by rep, split into TriCare / VA / PI), but nothing is typed by hand. Cancelled &amp; test orders are left out.
      </div>

      {/* KPI strip - total + the three programs */}
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
        <KpiR ico="cash" tint={C.brand} label={sel ? monthLabel(sel.month) : 'Total commission'} value={total} format={formatCurrency} foot={sel ? `${sel.orders} orders this month` : `${totalOrders} orders · ${striven.months.length} months`} deltaText={sel ? 'selected month' : 'all months'} />
        <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={formatCurrency} foot="flat rate per order" deltaText={pct(bp.TriCare, total)} />
        <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={formatCurrency} foot="flat rate per unit" deltaText={pct(bp.VA, total)} />
        <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={formatCurrency} foot="% of order value" deltaText={pct(bp.PI, total)} />
      </div>

      {/* Month selector - pick a month or see all */}
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
          <h2 className="section-title">{sel ? monthLabel(sel.month) : 'All months'} - commission by rep</h2>
          <div className="section-sub">What each rep earned, split into TriCare / VA / PI. Only the reps on the commission sheet (house &amp; clinic accounts are left out).</div>
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
                <tr key={r.rep} onClick={() => setRepSel(r)} style={{ cursor: 'pointer' }} title="Click for this rep's full detail">
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 700, color: C.brand }}>{r.rep}</td>
                  <td className="num">{r.tricare ? formatCurrency(r.tricare) : '-'}</td>
                  <td className="num">{r.va ? formatCurrency(r.va) : '-'}</td>
                  <td className="num">{r.pi ? formatCurrency(r.pi) : '-'}</td>
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

      {/* Progressive disclosure - the "how" stays out of the way until asked */}
      <details style={{ marginTop: 12, background: 'var(--panel-2)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: C.sub }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, color: C.ink }}>How is this calculated?</summary>
        <div style={{ marginTop: 10, lineHeight: 1.6 }}>
          <b>Source.</b> Striven sales orders that are active or completed - cancelled &amp; test orders are excluded (no commission on those).<br />
          <b>Rates used.</b>
          <ul style={{ margin: '6px 0 6px 18px', padding: 0 }}>
            <li><b>VA</b> - $425 per unit. <span style={{ color: C.positive, fontWeight: 700 }}>Exact</span> (checked against the sheet).</li>
            <li><b>TriCare</b> - $369.78 per order. <i>Estimate</i> (sheet average).</li>
            <li><b>Personal Injury</b> - 2.677% of order value. <i>Estimate</i> (derived from the sheet).</li>
          </ul>
          <b>Sheet vs Striven.</b> The manual sheet totals {formatCurrency(sheetTotal)}; this Striven calculation totals {formatCurrency(striven.grandTotal)} ({gap >= 0 ? '+' : ''}{formatCurrency(gap)}). The difference is mostly orders that are in Striven but were never added to the sheet, plus the two estimated rates above.<br />
          <span style={{ color: C.muted }}>TriCare &amp; PI stay estimates until Kevin/Crystal confirm the official rate card - then these become exact too. 🔒 No patient names are used.</span>
        </div>
      </details>

      {repSel && <StrivenRepModal rep={repSel} months={striven.months} lines={striven.byRep.find((x) => x.rep === repSel.rep)?.lines || repSel.lines || []} onClose={() => setRepSel(null)} />}
    </>
  );
}

// Modal shell - backdrop + card, closes on Esc / backdrop click.
function Modal({ title, sub, accent, onClose, children }: { title: string; sub?: string; accent?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(680px, 100%)', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${accent || C.brand}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff' }}>
          <div><div style={{ fontSize: 19, fontWeight: 800, color: C.ink }}>{title}</div>{sub && <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>{sub}</div>}</div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '18px 22px' }}>{children}</div>
      </div>
    </div>
  );
}

// Small stat tile used inside the rep modals.
function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tint || C.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// Full-detail popup for one rep in the "From Striven" view.
function StrivenRepModal({ rep, months, lines, onClose }: { rep: StrivenCommRep; months: StrivenCommMonth[]; lines: StrivenOrderLine[]; onClose: () => void }) {
  const perMonth = months.map((m) => ({ month: m.month, r: m.reps.find((x) => x.rep === rep.rep) })).filter((x) => x.r) as { month: string; r: StrivenCommRep }[];
  const cpo = rep.orders ? rep.total / rep.orders : 0;
  const progs: [string, number, string][] = [['TriCare', rep.tricare, PROG_C.TriCare], ['VA', rep.va, PROG_C.VA], ['Personal Injury', rep.pi, PROG_C.PI]];
  const maxM = Math.max(1, ...perMonth.map((x) => x.r.total));
  return (
    <Modal title={rep.rep} sub={`Commission from Striven · ${formatCurrency(rep.total)} total`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Commission" value={formatCurrency(rep.total)} tint={C.brand} />
        <Stat label="Orders" value={String(rep.orders)} />
        <Stat label="Units" value={String(rep.units)} />
        <Stat label="Per order" value={formatCurrency(cpo)} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By program</div>
      <div style={{ marginBottom: 18 }}>
        {progs.filter(([, v]) => v > 0).map(([name, v, c]) => (
          <div key={name} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span style={{ fontWeight: 700 }}>{formatCurrency(v)} · {Math.round((v / rep.total) * 100)}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(v / rep.total) * 100}%`, background: c, borderRadius: 999 }} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Month by month</div>
      <table className="data-table">
        <thead><tr><th>Month</th><th className="num">TriCare</th><th className="num">VA</th><th className="num">PI</th><th className="num">Orders</th><th className="num">Total</th><th style={{ width: '22%' }} /></tr></thead>
        <tbody>
          {perMonth.map(({ month, r }) => (
            <tr key={month}>
              <td style={{ fontWeight: 600 }}>{monthLabel(month)}</td>
              <td className="num">{r.tricare ? formatCurrency(r.tricare) : '-'}</td>
              <td className="num">{r.va ? formatCurrency(r.va) : '-'}</td>
              <td className="num">{r.pi ? formatCurrency(r.pi) : '-'}</td>
              <td className="num">{r.orders}</td>
              <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.total)}</td>
              <td><div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${(r.total / maxM) * 100}%`, background: C.brand, borderRadius: 999 }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Line by line - each Striven order for this rep (mirrors the sheet). */}
      {lines.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {lines.length} orders</span></div>
          <table className="data-table">
            <thead><tr><th>Patient</th><th>Item</th><th>Program</th><th className="num">Units</th><th className="num">Order value</th><th className="num">Commission</th></tr></thead>
            <tbody>
              {lines.map((ln, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{ln.last || '-'}</td>
                  <td style={{ color: C.sub, fontSize: 12.5 }}>{ln.item || '-'}</td>
                  <td>{ln.prog}</td>
                  <td className="num">{ln.units}</td>
                  <td className="num">{formatCurrency(ln.value)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(ln.comm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>🔒 Last name only. Commission per order from the rate card (VA $425/unit exact; TriCare $369.78/order &amp; PI 2.677% of value are estimates).</div>
        </>
      )}
    </Modal>
  );
}

// Full-detail popup for one rep in the "From the sheet" view - the reconciliation
// story: how much of their commission actually ties back to their Striven orders.
function SheetRepModal({ rep, onClose }: { rep: CommissionRep; onClose: () => void }) {
  const rc = rep.recon;
  const accent = rep.flag ? C.negative : C.brand;
  const progs: [string, number, string][] = [['TriCare', rep.tricare, PROG_C.TriCare], ['VA', rep.va, PROG_C.VA], ['Personal Injury', rep.pi, PROG_C.PI]];
  const parts: [string, number, number, string][] = [
    ['Credited to this rep in Striven', rc.same, rc.commSame, C.positive],
    ['Booked under a different rep', rc.diff, rc.commDiff, C.warning],
    ['No matching order in Striven', rc.none, rc.commNone, C.negative],
  ];
  return (
    <Modal title={rep.rep} accent={accent} sub={`From the commission sheet · ${formatCurrency(rep.total)} across ${rep.count} lines`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Commission" value={formatCurrency(rep.total)} tint={C.brand} />
        <Stat label="Lines" value={String(rep.count)} />
        <Stat label="Striven orders" value={String(rep.strivenOrders)} />
        <Stat label="Patient match" value={rep.matchRate != null ? `${rep.matchRate}%` : '-'} tint={rep.matchRate != null && rep.matchRate < 50 ? C.negative : C.ink} />
      </div>

      {rep.flag && (
        <div className="qb-flash warn" style={{ marginBottom: 16, borderLeft: `3px solid ${C.negative}` }}>
          ⚠️ <b>Attribution flag.</b> Only {rc.same} of {rep.count} commission lines ({rep.matchRate}%) tie back to an order booked under {rep.rep} in Striven. Commission is being paid on orders that aren't credited to this rep - worth a data check.
        </div>
      )}

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By program</div>
      <div style={{ marginBottom: 18 }}>
        {progs.filter(([, v]) => v > 0).map(([name, v, c]) => (
          <div key={name} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span style={{ fontWeight: 700 }}>{formatCurrency(v)} · {Math.round((v / rep.total) * 100)}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(v / rep.total) * 100}%`, background: c, borderRadius: 999 }} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Where Striven books these patients</div>
      <table className="data-table">
        <thead><tr><th /><th className="num">Lines</th><th className="num">Commission</th></tr></thead>
        <tbody>
          {parts.map(([label, n, c, tint]) => (
            <tr key={label}>
              <td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: tint, marginRight: 8 }} />{label}</td>
              <td className="num">{n}</td>
              <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rc.bookedUnder.length > 0 && (
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 10 }}>
          Booked under: {rc.bookedUnder.map((b) => `${b.rep} (${b.count})`).join(', ')}
        </div>
      )}

      {/* Line-by-line, like the sheet - patient last name + device + commission,
          plus where Striven books each one. Last name only (HIPAA-safe). */}
      {rc.lines?.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>Line by line <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {rc.lines.length} lines</span></div>
          <table className="data-table">
            <thead><tr><th>Patient</th><th>Device</th><th>Program</th><th className="num">Commission</th><th>In Striven?</th></tr></thead>
            <tbody>
              {rc.lines.map((ln, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{ln.last || '-'}</td>
                  <td style={{ color: C.sub, fontSize: 12.5 }}>{ln.device || '-'}</td>
                  <td>{ln.prog}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(ln.comm)}</td>
                  <td>
                    {ln.status === 'same' && <span style={{ color: C.positive, fontWeight: 600 }}>✓ this rep</span>}
                    {ln.status === 'diff' && <span style={{ color: C.warning, fontWeight: 600 }}>↪ {ln.under}</span>}
                    {ln.status === 'none' && <span style={{ color: C.negative, fontWeight: 600 }}>✗ not found</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>🔒 Last name only (minimum-necessary). “In Striven?” shows whether that patient's order is booked under this rep, a different rep, or isn't in Striven.</div>
        </>
      )}
    </Modal>
  );
}

// Merge the sheet's pay-period tabs by month key (Team + Christy workbooks → one
// month), summing per-rep. Gives clean month tabs across both workbooks.
function mergePeriods(periods: CommissionPeriod[]) {
  const byKey: Record<string, { key: string; label: string; total: number; lines: number; reps: Record<string, CommissionPeriodRep> }> = {};
  for (const p of periods) {
    const k = byKey[p.key] = byKey[p.key] || { key: p.key, label: p.label, total: 0, lines: 0, reps: {} };
    k.total += p.total; k.lines += p.lines;
    for (const r of p.reps) {
      const R = k.reps[r.rep] = k.reps[r.rep] || { rep: r.rep, tricare: 0, va: 0, pi: 0, total: 0, count: 0 };
      R.tricare += r.tricare; R.va += r.va; R.pi += r.pi; R.total += r.total; R.count += r.count;
    }
  }
  return Object.values(byKey).map((k) => ({ ...k, reps: Object.values(k.reps).sort((a, b) => b.total - a.total) })).sort((a, b) => b.key.localeCompare(a.key));
}

function SheetPeriodTabs({ periods, value, onChange }: { periods: CommissionPeriod[]; value: string; onChange: (v: string) => void }) {
  const months = mergePeriods(periods);
  if (months.length <= 1) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 14px', alignItems: 'center' }}>
      <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 600, marginRight: 4 }}>Pay period:</span>
      <button className="btn ghost" style={segStyle(value === 'all')} onClick={() => onChange('all')}>All</button>
      {months.map((m) => <button key={m.key} className="btn ghost" style={segStyle(value === m.key)} onClick={() => onChange(m.key)}>{m.label}</button>)}
    </div>
  );
}

// Per-rep breakdown for one selected pay period (from the sheet).
function SheetMonthTable({ periods, monthKey }: { periods: CommissionPeriod[]; monthKey: string }) {
  const m = mergePeriods(periods).find((x) => x.key === monthKey);
  if (!m) return null;
  const reps = m.reps;
  const maxRep = Math.max(1, ...reps.map((r) => r.total));
  const tc = reps.reduce((s, r) => s + r.tricare, 0), va = reps.reduce((s, r) => s + r.va, 0), pi = reps.reduce((s, r) => s + r.pi, 0);
  return (
    <div className="section chart-card">
      <div className="section-head"><div>
        <h2 className="section-title">{m.label} - commission by rep (from the sheet)</h2>
        <div className="section-sub">{m.lines} lines · {formatCurrency(m.total)} this pay period.</div>
      </div></div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th style={{ width: 34 }}>#</th><th>Rep</th>
            <th className="num">TriCare</th><th className="num">VA</th><th className="num">PI</th>
            <th className="num">Lines</th><th className="num">Total</th><th style={{ width: '22%' }} />
          </tr></thead>
          <tbody>
            {reps.map((r, i) => (
              <tr key={r.rep}>
                <td style={{ color: C.muted }}>{i + 1}</td>
                <td style={{ fontWeight: 700 }}>{r.rep}</td>
                <td className="num">{r.tricare ? formatCurrency(r.tricare) : '-'}</td>
                <td className="num">{r.va ? formatCurrency(r.va) : '-'}</td>
                <td className="num">{r.pi ? formatCurrency(r.pi) : '-'}</td>
                <td className="num">{r.count}</td>
                <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(r.total)}</td>
                <td><div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${(r.total / maxRep) * 100}%`, background: REP_C[i % REP_C.length], borderRadius: 999 }} /></div></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="total-row">
            <td /><td>Total</td>
            <td className="num">{formatCurrency(tc)}</td><td className="num">{formatCurrency(va)}</td><td className="num">{formatCurrency(pi)}</td>
            <td className="num">{m.lines}</td><td className="num" style={{ fontWeight: 800 }}>{formatCurrency(m.total)}</td><td />
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}

// Reconcile - sheet (paid) vs Striven-computed (orders support), side by side per
// rep, so a person can see the gap without flipping between tabs.
function ReconcileView({ reconcile, sheetReps, strivenReps }: { reconcile?: CommissionReconcile; sheetReps: CommissionRep[]; strivenReps?: StrivenCommRep[] }) {
  const [repSel, setRepSel] = useState<string | null>(null);
  if (!reconcile || !reconcile.reps.length) {
    return <div className="section"><div className="page-sub" style={{ padding: 16 }}>Reconcile needs both the sheet and Striven data loaded. Try Refresh.</div></div>;
  }
  const { reps, totals } = reconcile;
  const max = Math.max(1, ...reps.map((r) => Math.max(r.sheet, r.striven)));
  const selRec = repSel ? reps.find((x) => x.rep === repSel) : null;
  return (
    <>
      <div style={{ marginBottom: 14, padding: '11px 14px', background: 'var(--panel-2)', borderRadius: 10, fontSize: 13.5, color: C.sub, lineHeight: 1.5 }}>
        Two numbers per rep, side by side: <b style={{ color: C.ink }}>Sheet</b> = what the workbook paid; <b style={{ color: C.ink }}>Striven</b> = what their orders actually support. A big gap means the two don't agree - worth a look.
      </div>

      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
        <KpiR ico="clip" tint={C.info} label="Sheet total" value={totals.sheet} format={formatCurrency} foot="paid per the workbook" deltaText="all periods" />
        <KpiR ico="cash" tint={C.brand} label="Striven total" value={totals.striven} format={formatCurrency} foot="orders support (rate card)" deltaText="all periods" />
        <KpiR ico="trend" tint={totals.diff >= 0 ? C.negative : C.positive} label="Difference" value={Math.abs(totals.diff)} format={formatCurrency} foot={totals.diff >= 0 ? 'sheet paid more' : 'Striven says more'} deltaText={`${totals.diff >= 0 ? '+' : '−'}${formatCurrency(Math.abs(totals.diff))}`} />
      </div>

      <div className="section chart-card">
        <div className="section-head"><div>
          <h2 className="section-title">Sheet vs Striven - by rep</h2>
          <div className="section-sub">Sorted by biggest gap. 🔵 sheet · 🟦 Striven bars. Only the reps on the commission sheet.</div>
        </div></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 34 }}>#</th><th>Rep</th>
              <th className="num">Sheet</th><th className="num">Striven</th><th className="num">Difference</th><th className="num">Match</th>
              <th style={{ width: '30%' }}>Sheet vs Striven</th>
            </tr></thead>
            <tbody>
              {reps.map((r, i) => (
                <tr key={r.rep} onClick={() => setRepSel(r.rep)} style={{ cursor: 'pointer' }} title="Click to see patient-by-patient reconcile">
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 700, color: C.brand }}>
                    {r.rep}
                    {!r.inStriven && <span style={{ fontSize: 11, color: C.warning, marginLeft: 6 }}>sheet-only</span>}
                    {!r.onSheet && <span style={{ fontSize: 11, color: C.info, marginLeft: 6 }}>Striven-only</span>}
                  </td>
                  <td className="num">{r.sheet ? formatCurrency(r.sheet) : '-'}</td>
                  <td className="num">{r.striven ? formatCurrency(r.striven) : '-'}</td>
                  <td className="num" style={{ fontWeight: 700, color: Math.abs(r.diff) < 1 ? C.muted : r.diff > 0 ? C.negative : C.positive }}>
                    {Math.abs(r.diff) < 1 ? '-' : `${r.diff > 0 ? '+' : '−'}${formatCurrency(Math.abs(r.diff))}`}
                  </td>
                  <td className="num" style={{ color: r.matchRate != null && r.matchRate < 50 ? C.negative : C.ink }}>{r.matchRate != null ? `${r.matchRate}%` : '-'}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div style={{ height: 7, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${(r.sheet / max) * 100}%`, background: C.info, borderRadius: 999 }} /></div>
                      <div style={{ height: 7, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${(r.striven / max) * 100}%`, background: C.brand, borderRadius: 999 }} /></div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="total-row">
              <td /><td>Total</td>
              <td className="num">{formatCurrency(totals.sheet)}</td>
              <td className="num">{formatCurrency(totals.striven)}</td>
              <td className="num" style={{ fontWeight: 700 }}>{`${totals.diff > 0 ? '+' : '−'}${formatCurrency(Math.abs(totals.diff))}`}</td>
              <td /><td />
            </tr></tfoot>
          </table>
        </div>
      </div>

      <div className="qb-flash warn" style={{ marginTop: 12 }}>
        🔒 <b>Last name only</b>. Sheet = actual workbook payout; Striven = commission the orders support via the rate card (VA exact; TriCare/PI estimated). Click a rep to reconcile patient by patient. Differences come from orders not on the sheet, sheet lines with no Striven order, or the estimated rates.
      </div>

      {repSel && selRec && (
        <ReconcileRepModal
          rep={repSel}
          sheetLines={sheetReps.find((x) => x.rep === repSel)?.recon.lines || []}
          strivenLines={strivenReps?.find((x) => x.rep === repSel)?.lines || []}
          sheetTotal={selRec.sheet}
          strivenTotal={selRec.striven}
          onClose={() => setRepSel(null)}
        />
      )}
    </>
  );
}

// Patient-by-patient reconcile for one rep: merge the rep's sheet lines with
// their Striven order lines by last name → matched / only-on-sheet (not in
// Striven) / only-in-Striven (not on sheet).
function ReconcileRepModal({ rep, sheetLines, strivenLines, sheetTotal, strivenTotal, onClose }: { rep: string; sheetLines: CommissionLine[]; strivenLines: StrivenOrderLine[]; sheetTotal: number; strivenTotal: number; onClose: () => void }) {
  const up = (s: string) => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
  type Row = { last: string; prog: string; sheet: number; striven: number; detail: string; status: 'both' | 'sheet' | 'striven' };
  const map = new Map<string, Row>();
  for (const l of sheetLines) {
    const k = up(l.last); if (!k) continue;
    const e = map.get(k) || { last: l.last, prog: l.prog, sheet: 0, striven: 0, detail: l.device, status: 'sheet' };
    e.sheet += l.comm; if (!e.detail) e.detail = l.device; map.set(k, e);
  }
  for (const l of strivenLines) {
    const k = up(l.last); if (!k) continue;
    const e = map.get(k) || { last: l.last, prog: l.prog, sheet: 0, striven: 0, detail: l.item, status: 'striven' };
    e.striven += l.comm; if (!e.detail) e.detail = l.item; map.set(k, e);
  }
  const rows = [...map.values()].map((e) => ({ ...e, status: (e.sheet > 0 && e.striven > 0 ? 'both' : e.sheet > 0 ? 'sheet' : 'striven') as Row['status'] }))
    .sort((a, b) => Math.max(b.sheet, b.striven) - Math.max(a.sheet, a.striven));
  const nBoth = rows.filter((r) => r.status === 'both').length;
  const nSheet = rows.filter((r) => r.status === 'sheet');
  const nStriven = rows.filter((r) => r.status === 'striven');
  const sumSheet = nSheet.reduce((s, r) => s + r.sheet, 0);
  const sumStriven = nStriven.reduce((s, r) => s + r.striven, 0);
  return (
    <Modal title={rep} accent={C.info} sub={`Sheet ${formatCurrency(sheetTotal)} vs Striven ${formatCurrency(strivenTotal)} · patient by patient`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="In both" value={String(nBoth)} tint={C.positive} />
        <Stat label="Only on sheet" value={`${nSheet.length} · ${formatCurrency(sumSheet)}`} tint={C.negative} />
        <Stat label="Only in Striven" value={`${nStriven.length} · ${formatCurrency(sumStriven)}`} tint={C.warning} />
      </div>
      <table className="data-table">
        <thead><tr><th>Patient</th><th>Item / device</th><th>Program</th><th className="num">Sheet</th><th className="num">Striven</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ fontWeight: 600 }}>{r.last || '-'}</td>
              <td style={{ color: C.sub, fontSize: 12.5 }}>{r.detail || '-'}</td>
              <td>{r.prog}</td>
              <td className="num">{r.sheet ? formatCurrency(r.sheet) : '-'}</td>
              <td className="num">{r.striven ? formatCurrency(r.striven) : '-'}</td>
              <td>
                {r.status === 'both' && <span style={{ color: C.positive, fontWeight: 600 }}>✓ in both</span>}
                {r.status === 'sheet' && <span style={{ color: C.negative, fontWeight: 600 }}>✗ not in Striven</span>}
                {r.status === 'striven' && <span style={{ color: C.warning, fontWeight: 600 }}>✗ not on sheet</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>🔒 Last name only. Matched by last name: "in both" = on the sheet and in this rep's Striven orders; "not in Striven" = paid but no order under this rep; "not on sheet" = Striven order never paid on the sheet.</div>
    </Modal>
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
  const title = isTotal ? 'Total commission - by rep (all programs)' : `${detail === 'PI' ? 'Personal Injury' : detail} commission - by rep`;
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
                <td className="num">{sum > 0 ? `${Math.round((r.amount / sum) * 100)}%` : '-'}</td>
                {isTotal && <><td className="num">{r.count}</td>
                  <td className="num" style={{ color: r.match != null && r.match < 50 ? C.negative : C.ink }}>{r.match != null ? `${r.match}%` : '-'}</td></>}
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
