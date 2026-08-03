import { useEffect, useRef, useState } from 'react';
import { printToPdf } from '../export';
import { fetchCommission, fetchMe, type Me, type CommissionResult, type StrivenCommRep, type StrivenOrderLine, type UnmatchedOrder } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PROG_C: Record<string, string> = { TriCare: '#0D9488', PI: '#2563EB', VA: '#16A34A', DOL: '#7C3AED' };
const REP_C = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DB2777', '#0891B2'];

// A dollar field is `null` when it belongs to another rep — the server strips it
// before serialization, so there is nothing here to un-hide. Render the absence
// honestly rather than as $0, which would read as "earned nothing".
const money = (v: number | null | undefined) => (v == null ? '—' : formatCurrency(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const monthLabel = (m: string) => {
  if (!m || m === 'unknown') return 'Undated';
  const [y, mo] = m.split('-');
  const N = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${N[+mo] || mo} ${y}`;
};
const segStyle = (active: boolean): React.CSSProperties => ({
  border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 700,
  background: active ? C.brand : 'transparent', color: active ? '#fff' : C.sub, cursor: 'pointer',
});

// ── Commission ───────────────────────────────────────────────────────────────
// One view: the final commission figure per rep, computed here from Striven
// orders as `units × per-device rate`. Orders labelled `hold` are excluded
// entirely; `waiting for reimbursement` counts toward the total but is reported
// as pending rather than payable.
//
// A rep sees their own dollars in full and only ORDER COUNTS for everyone else —
// the redaction happens server-side, so another rep's pay never reaches the
// browser. Admins see everything. No patient names anywhere.
export function CommissionTab() {
  const [data, setData] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [month, setMonth] = useState<string>('all');
  const [repSel, setRepSel] = useState<StrivenCommRep | null>(null);
  const [drill, setDrill] = useState<null | 'total' | 'TriCare' | 'VA' | 'PI'>(null);
  const [peer, setPeer] = useState<StrivenCommRep | null>(null);
  const [viewAs, setViewAs] = useState<string | null>(null);   // admin preview only
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false, as: string | null = viewAs) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchCommission(as)); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load commission.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(false, viewAs); const r = setInterval(() => load(true, viewAs), 120_000); return () => clearInterval(r); }, [viewAs]);
  // Identity decides what the payload already CONTAINS — it is not a client-side
  // filter. The server redacted before this ever reached the browser.
  useEffect(() => { fetchMe().then(setMe).catch(() => setMe(null)); }, []);

  const isAdmin = me?.role === 'admin' && !viewAs;
  // While previewing, `myRep` is the previewed rep: the server has already
  // redacted to exactly what that person would receive.
  const myRep = viewAs ?? me?.repName ?? null;
  const s = data?.striven;
  const sel = month === 'all' ? null : s?.months.find((m) => m.month === month) ?? null;
  const reps: StrivenCommRep[] = sel ? sel.reps : (s?.byRep ?? []);
  const own = myRep ? reps.find((r) => r.rep === myRep) ?? null : null;
  const maxRep = Math.max(1, ...reps.map((r) => num(r.total)));

  // Totals for the scope on screen, summed off the rendered rows so the footer
  // can never drift from the table.
  // Off-roster volume is shown only on the all-months view: the figure covers
  // the whole book and has no month breakdown to filter by, so adding it to a
  // single month's column would overstate that month.
  const off = month === 'all' ? s?.offRoster : undefined;
  const showOff = Boolean(off && off.orders > 0);

  const vt = reps.reduce((a, r) => ({
    TriCare: a.TriCare + num(r.nTricare), VA: a.VA + num(r.nVa), PI: a.PI + num(r.nPi),
    orders: a.orders + num(r.orders), units: a.units + num(r.units),
  }), showOff
    ? { TriCare: num(off?.nTricare), VA: num(off?.nVa), PI: num(off?.nPi), orders: num(off?.orders), units: num(off?.units) }
    : { TriCare: 0, VA: 0, PI: 0, orders: 0, units: 0 });
  const bp = sel
    ? { TriCare: sel.TriCare, VA: sel.VA, PI: sel.PI }
    : (s?.byProgram ?? { TriCare: null, VA: null, PI: null });
  const total = sel ? sel.total : (s?.grandTotal ?? null);

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Commission</h1>
          <div className="page-sub">
            <span className="live-dot" /> Final figure by rep &amp; vertical, computed from Striven orders
            {agoText ? ` · updated ${agoText}` : ''}
            {myRep && !isAdmin && <span style={{ marginLeft: 8, color: C.muted }}>· showing your pay only</span>}
            {isAdmin && <span style={{ marginLeft: 8, color: C.brand, fontWeight: 700 }}>· admin</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* The "Orders & revenue" toggle lived here too, rendering the same
              dashboard reachable from the sidebar and from Reps. Removed — this
              tab is commission only. */}
          {me?.role === 'admin' && (
            <ViewAs reps={(data?.reps ?? []).map((r) => r.rep)} value={viewAs} onChange={setViewAs} />
          )}
          {<button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>}
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && !s?.available && !loading && (
        <div className="section"><div className="page-sub" style={{ padding: 16 }}>
          No Striven order data loaded yet — the commission engine needs the sales-order cache. Try Refresh, or open the Orders tab first.
        </div></div>
      )}

      {viewAs && (
        <div className="qb-flash warn" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>👁 Previewing exactly what <b>{viewAs}</b> sees. The server has already stripped every other rep's pay from this response — this is not a client-side filter.</span>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setViewAs(null)}>Exit preview</button>
        </div>
      )}

      {data && s?.available && myRep && <AccessNote who={myRep} />}

      {data && s?.available && (
        <>
          {/* Payable/Due vs Waiting — the caller's own state, or company-wide for admin. */}
          <StateSplit
            who={own ? own.rep : (isAdmin ? 'All reps' : null)}
            payable={own ? own.payableTotal : (isAdmin ? s.payableTotal : null)}
            waiting={own ? own.waitingTotal : (isAdmin ? s.waitingTotal : null)}
            held={s.heldOrders}
            zeroValue={s.zeroValueOrders}
          />

          <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <KpiR ico="cash" tint={C.brand} label={sel ? monthLabel(sel.month) : 'Total commission'} value={total} format={money}
              foot={`${vt.orders} orders · ${vt.units} units · tap for detail`} deltaText={sel ? 'selected month' : 'all months'}
              onClick={() => setDrill(drill === 'total' ? null : 'total')} />
            <KpiR ico="shield" tint={PROG_C.TriCare} label="TriCare" value={bp.TriCare} format={money}
              foot={`${vt.TriCare} orders · legacy vertical`} deltaText={pct(bp.TriCare, total)}
              onClick={() => setDrill(drill === 'TriCare' ? null : 'TriCare')} />
            <KpiR ico="clip" tint={PROG_C.VA} label="VA" value={bp.VA} format={money}
              foot={`${vt.VA} orders · units × device rate`} deltaText={pct(bp.VA, total)}
              onClick={() => setDrill(drill === 'VA' ? null : 'VA')} />
            <KpiR ico="trend" tint={PROG_C.PI} label="Personal Injury" value={bp.PI} format={money}
              foot={`${vt.PI} orders · units × device rate`} deltaText={pct(bp.PI, total)}
              onClick={() => setDrill(drill === 'PI' ? null : 'PI')} />
          </div>

          {drill && <KpiDrill
            title={`${drill === 'total' ? 'Total commission' : drill === 'PI' ? 'Personal Injury' : drill} — by rep${sel ? ` · ${monthLabel(sel.month)}` : ''}`}
            sub="Dollar figures appear only for your own row."
            accent={drill === 'total' ? C.brand : PROG_C[drill]}
            rows={reps.map((r) => ({
              name: r.rep,
              value: drill === 'total' ? r.total : drill === 'TriCare' ? r.tricare : drill === 'VA' ? r.va : r.pi,
              orders: drill === 'total' ? num(r.orders) : drill === 'TriCare' ? num(r.nTricare) : drill === 'VA' ? num(r.nVa) : num(r.nPi),
            }))}
            onClose={() => setDrill(null)}
          />}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 600, marginRight: 4 }}>Month:</span>
            <button className="btn ghost" style={segStyle(month === 'all')} onClick={() => setMonth('all')}>All</button>
            {s.months.map((m) => (
              <button key={m.month} className="btn ghost" style={segStyle(month === m.month)} onClick={() => setMonth(m.month)}>
                {monthLabel(m.month)}
              </button>
            ))}
          </div>

          <div className="section chart-card">
            <div className="section-head"><div>
              <h2 className="section-title">{sel ? monthLabel(sel.month) : 'All months'} · by rep</h2>
              <div className="section-sub">
                Order counts are shown for every rep; commission is shown for your own row only.
                {' '}Tap your row for the order-by-order figure.
              </div>
            </div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th style={{ width: 34 }}>#</th><th>Rep</th>
                  <th className="num" title="Orders booked in TriCare">TriCare ord.</th>
                  <th className="num" title="Orders booked in VA">VA ord.</th>
                  <th className="num" title="Orders booked in PI">PI ord.</th>
                  <th className="num">Orders</th><th className="num">Units</th>
                  <th className="num">Payable / Due</th><th className="num">Waiting</th>
                  <th className="num">Commission</th>
                  <th style={{ width: '18%' }} />
                </tr></thead>
                <tbody>
                  {reps.length === 0 && <tr><td colSpan={11} style={{ color: C.muted }}>No orders in this period.</td></tr>}
                  {reps.map((r, i) => {
                    const mine = myRep === r.rep;
                    const open = isAdmin || mine;
                    return (
                      <tr key={r.rep} onClick={() => (open ? setRepSel(r) : setPeer(r))}
                        style={{ cursor: 'pointer', background: mine ? 'var(--panel-2)' : undefined, borderLeft: mine ? `3px solid ${C.brand}` : '3px solid transparent' }}
                        title={open ? 'Click for the order-by-order figure' : `Click to see ${r.rep}'s order volume by vertical`}>
                        <td style={{ color: C.muted }}>{i + 1}</td>
                        <td style={{ fontWeight: 700, color: C.brand }}>
                          {r.rep}
                          {mine && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                        </td>
                        <OrderCountCells t={num(r.nTricare)} v={num(r.nVa)} p={num(r.nPi)} />
                        <td className="num">{num(r.orders)}</td>
                        <td className="num">{num(r.units)}</td>
                        <td className="num" style={{ color: r.payableTotal == null ? C.muted : C.positive, fontWeight: 700 }}>{money(r.payableTotal)}</td>
                        <td className="num" style={{ color: r.waitingTotal == null ? C.muted : C.warning, fontWeight: 700 }}>{money(r.waitingTotal)}</td>
                        <td className="num" style={{ fontWeight: 800 }}>
                          {r.total == null
                            ? <span title={`Commission is confidential to ${r.rep}. Their order volume is shown across this row.`}
                                style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: C.sub, background: 'var(--panel-2)', border: `1px solid ${C.muted}33`, borderRadius: 999, padding: '2px 9px' }}>
                                Confidential
                              </span>
                            : money(r.total)}
                        </td>
                        <td>
                          {r.total == null
                            ? <VerticalBar parts={[{ n: num(r.nTricare), c: PROG_C.TriCare, label: 'TriCare' }, { n: num(r.nVa), c: PROG_C.VA, label: 'VA' }, { n: num(r.nPi), c: PROG_C.PI, label: 'PI' }]} />
                            : <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${(num(r.total) / maxRep) * 100}%`, background: REP_C[i % REP_C.length], borderRadius: 999 }} />
                              </div>}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Orders booked to someone who is not a rep. Carried as a row
                      so the columns tie to the order book — without it the table
                      totalled 450 orders / 643 units against a book of 452/644. */}
                  {showOff && off && (
                    <tr style={{ background: 'var(--panel-2)' }}
                      title={`Booked in Striven to ${off.reps.join(', ')} — not on the commission roster. Counted in the order book; earns no commission.`}>
                      <td style={{ color: C.muted }}>—</td>
                      <td style={{ fontWeight: 600, color: C.sub, fontStyle: 'italic' }}>
                        Off roster
                        <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: C.muted }}>
                          {off.reps.join(', ')}
                        </span>
                      </td>
                      <OrderCountCells t={off.nTricare} v={off.nVa} p={off.nPi} />
                      <td className="num" style={{ color: C.sub }}>{off.orders}</td>
                      <td className="num" style={{ color: C.sub }}>{off.units}</td>
                      <td className="num" style={{ color: C.muted }}>$0</td>
                      <td className="num" style={{ color: C.muted }}>$0</td>
                      <td className="num" style={{ color: C.muted, fontWeight: 700 }}>$0</td>
                      <td />
                    </tr>
                  )}
                </tbody>
                {reps.length > 0 && (
                  <tfoot><tr className="total-row">
                    <td /><td>Total</td>
                    <td className="num">{vt.TriCare}</td><td className="num">{vt.VA}</td><td className="num">{vt.PI}</td>
                    <td className="num">{vt.orders}</td><td className="num">{vt.units}</td>
                    <td className="num" style={{ color: C.positive, fontWeight: 700 }}>{money(own ? own.payableTotal : (isAdmin ? s.payableTotal : null))}</td>
                    <td className="num" style={{ color: C.warning, fontWeight: 700 }}>{money(own ? own.waitingTotal : (isAdmin ? s.waitingTotal : null))}</td>
                    <td className="num" style={{ fontWeight: 800 }}>{money(total)}</td><td />
                  </tr></tfoot>
                )}
              </table>
            </div>
            {/* The volume columns and the money columns come from different
                sets, and saying so is what stops a real book against $0 from
                reading as a calculation fault. */}
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.6 }}>
              🔒 No patient names · commission = units × per-device rate · orders on hold are excluded
              {data?.striven?.bookOrders != null && data?.striven?.commissionedOrders != null && (
                <>
                  <br />
                  Order and unit counts are the <b>full Striven book</b>. Commission is computed on the{' '}
                  <b>{data.striven.commissionedOrders} of {data.striven.bookOrders}</b> orders that tie to device lines —
                  a rep can hold real orders and still earn $0 where that link is missing.
                </>
              )}
            </div>
          </div>

          {/* Orders with no usable sales order — vertical + whatever else exists. */}
          {s.unmatched && s.unmatched.length > 0 && <UnmatchedTable rows={s.unmatched} totalValue={s.unmatchedValue} />}

          {s.rateGaps && s.rateGaps.length > 0 && (
            <div className="qb-flash warn" style={{ marginTop: 12 }}>
              ⚠️ {s.rateGaps.length} device{s.rateGaps.length === 1 ? '' : 's'} have no entry in the rate card and were priced off the legacy per-vertical fallback:
              {' '}<b>{s.rateGaps.slice(0, 6).join(', ')}</b>{s.rateGaps.length > 6 ? ` and ${s.rateGaps.length - 6} more` : ''}.
              {' '}Add them to COMMISSION_RATES for an exact figure.
            </div>
          )}
        </>
      )}

      {repSel && <RepModal rep={repSel} onClose={() => setRepSel(null)} />}
      {peer && <PeerModal rep={peer} onClose={() => setPeer(null)} />}
    </div>
  );
}

// Admin-only preview of one rep's view. The request goes back to the server with
// ?as=<rep>; the server re-runs redaction for that identity. It can only ever
// narrow — a rep-role session passing the same parameter is ignored.
function ViewAs({ reps, value, onChange }: { reps: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const names = [...new Set(reps)].filter(Boolean);
  if (!names.length) return null;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
      View as
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}
        style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
        <option value="">Admin (everything)</option>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

// States the access rule plainly, so a rep is never left guessing why a column
// is locked. Their own row is highlighted with the same brand rule used below.
function AccessNote({ who }: { who: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--panel-2)', borderRadius: 10, padding: '11px 14px', marginBottom: 14, fontSize: 13, color: C.sub }}>
      <span style={{ fontSize: 15, lineHeight: 1.2 }}>🔐</span>
      <div>
        <b style={{ color: C.ink }}>You are signed in as {who}.</b> Your own row — highlighted below — shows your commission,
        orders, units and the order-by-order breakdown in full. For every other rep you can see how many orders they booked in
        each vertical, but not their pay. <span style={{ color: C.muted }}>Click any row to see what is available.</span>
      </div>
    </div>
  );
}

// What one rep may see about another: volume by vertical, no dollars. Clicking a
// peer row opens this instead of the pay detail, so the boundary is explicit
// rather than a dead click.
function PeerModal({ rep, onClose }: { rep: StrivenCommRep; onClose: () => void }) {
  const t = num(rep.nTricare), v = num(rep.nVa), p = num(rep.nPi);
  const tot = t + v + p;
  const rows: [string, number, number, string][] = [
    ['TriCare', t, num(rep.uTricare), PROG_C.TriCare],
    ['VA', v, num(rep.uVa), PROG_C.VA],
    ['Personal Injury', p, num(rep.uPi), PROG_C.PI],
  ];
  return (
    <Modal title={rep.rep} accent={C.muted} sub={`Order volume by vertical · ${tot} order${tot === 1 ? '' : 's'}`} onClose={onClose}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--panel-2)', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontSize: 13, color: C.sub }}>
        <span style={{ fontSize: 15, lineHeight: 1.2 }}>🔒</span>
        <div><b style={{ color: C.ink }}>{rep.rep}'s commission is confidential.</b> You can see their order volume, not their pay —
          the dollar figures were removed on the server before this page loaded.</div>
      </div>

      <div className="cm-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        <Stat label="Orders" value={String(num(rep.orders))} tint={C.brand} />
        <Stat label="Units" value={String(num(rep.units))} />
        <Stat label="Commission" value="Confidential" tint={C.sub} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Orders by vertical</div>
      <table className="data-table">
        <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Share</th><th style={{ width: '34%' }} /></tr></thead>
        <tbody>
          {rows.map(([name, n, u, c]) => (
            <tr key={name}>
              <td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: c, marginRight: 8 }} />{name}</td>
              <td className="num" style={{ fontWeight: 700 }}>{n || '-'}</td>
              <td className="num">{u || '-'}</td>
              <td className="num">{tot > 0 && n > 0 ? `${Math.round((n / tot) * 100)}%` : '—'}</td>
              <td>
                <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${tot ? (n / tot) * 100 : 0}%`, background: c, borderRadius: 999 }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="total-row">
          <td>Total</td><td className="num" style={{ fontWeight: 800 }}>{tot}</td>
          <td className="num">{num(rep.units)}</td><td /><td />
        </tr></tfoot>
      </table>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
        🔒 No patient names. Order counts are operational data and are shared across the team; commission is not.
      </div>
    </Modal>
  );
}

const pct = (n: number | null | undefined, total: number | null | undefined) =>
  (n != null && total != null && total > 0 ? `${Math.round((n / total) * 100)}% of total` : '—');

// Order counts are non-financial and survive redaction, so every rep can see how
// much volume every other rep booked in each vertical — just not their pay.
function OrderCountCells({ t, v, p }: { t: number; v: number; p: number }) {
  const cell = (n: number, key: string) => (
    <td key={key} className="num" style={{ color: n ? C.ink : C.muted, fontWeight: n ? 700 : 400 }}>{n || '-'}</td>
  );
  return <>{cell(t, 't')}{cell(v, 'v')}{cell(p, 'p')}</>;
}

// Payable/Due vs Waiting. `waiting for reimbursement` orders are in the total but
// are not yet payable; `hold` orders are excluded upstream and appear in neither.
function StateSplit({ payable, waiting, held, zeroValue, who }: { payable?: number | null; waiting?: number | null; held?: number; zeroValue?: number; who?: string | null }) {
  if (payable == null && waiting == null) return null;
  const p = payable ?? 0, w = waiting ?? 0, tot = p + w;
  return (
    <div className="section chart-card" style={{ marginBottom: 14 }}>
      <div className="section-head"><div>
        <h2 className="section-title">{who ? `${who} — commission state` : 'Commission state'}</h2>
        <div className="section-sub">
          Payable/Due is fillable &amp; reimbursed. Waiting is awaiting reimbursement — counted in the total, not yet payable.
          {held ? ` ${held} order${held === 1 ? '' : 's'} on hold are excluded from the calculation entirely.` : ''}
          {zeroValue ? ` ${zeroValue} order${zeroValue === 1 ? '' : 's'} with $0 order value earn no commission and are excluded too.` : ''}
        </div>
      </div></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: '4px 2px 2px' }}>
        <Stat label="Payable / Due" value={money(p)} tint={C.positive} />
        <Stat label="Waiting for reimbursement" value={money(w)} tint={C.warning} />
        <Stat label="Total" value={money(tot)} tint={C.brand} />
      </div>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', margin: '12px 2px 2px' }}
        title={`Payable ${money(p)} · Waiting ${money(w)}`}>
        {p > 0 && <div style={{ width: `${(p / (tot || 1)) * 100}%`, background: C.positive }} />}
        {w > 0 && <div style={{ width: `${(w / (tot || 1)) * 100}%`, background: C.warning }} />}
      </div>
    </div>
  );
}

// Stacked share bar — used for reps whose dollars are withheld, so the row still
// says something useful about their mix.
function VerticalBar({ parts, height = 9 }: { parts: { n: number; c: string; label: string }[]; height?: number }) {
  const shown = parts.filter((p) => p.n > 0);
  const tot = shown.reduce((s, p) => s + p.n, 0);
  if (!tot) return <div style={{ height, borderRadius: 999, background: 'var(--panel-2)' }} />;
  return (
    <div title={shown.map((p) => `${p.label}: ${p.n}`).join(' · ')}
      style={{ display: 'flex', height, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
      {shown.map((p) => <div key={p.label} style={{ width: `${(p.n / tot) * 100}%`, background: p.c }} />)}
    </div>
  );
}

// Orders the engine could not tie to a sales order. They are NOT commissioned —
// but the vertical and volume are real, so they are surfaced rather than lost.
function UnmatchedTable({ rows, totalValue }: { rows: UnmatchedOrder[]; totalValue?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section chart-card" style={{ marginTop: 14 }}>
      <div className="section-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}><div>
        <h2 className="section-title">No sales order · {rows.length} order{rows.length === 1 ? '' : 's'}</h2>
        <div className="section-sub">
          These could not be matched to a sales order, so they earn no commission and are excluded from every figure above.
          Vertical and volume are shown from what is available{totalValue ? ` · ${formatCurrency(totalValue)} of order value` : ''}. Tap to {open ? 'hide' : 'show'}.
        </div>
      </div></div>
      {open && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Vertical</th><th>Item</th><th className="num">Units</th><th className="num">Order value</th>
              <th>Status</th><th>Rep</th><th>Why</th>
            </tr></thead>
            <tbody>
              {rows.map((u, i) => (
                <tr key={`${u.soId}-${i}`}>
                  <td style={{ fontWeight: 700, color: PROG_C[u.prog] || C.ink }}>{u.prog}</td>
                  <td style={{ color: C.sub, fontSize: 12.5 }}>{u.item || '-'}{u.itemCount > 1 ? ` +${u.itemCount - 1}` : ''}</td>
                  <td className="num">{u.units || '-'}</td>
                  <td className="num">{u.value ? formatCurrency(u.value) : '-'}</td>
                  <td style={{ fontSize: 12.5 }}>{u.status || '-'}</td>
                  <td style={{ fontSize: 12.5 }}>{u.rep || <span style={{ color: C.muted }}>unassigned</span>}</td>
                  <td style={{ fontSize: 12, color: C.warning }}>{u.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Modal shell — backdrop + card, closes on Esc / backdrop click.
function Modal({ title, sub, accent, onClose, children }: { title: string; sub?: string; accent?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(760px, 100%)', maxHeight: '90vh', overflowY: 'auto', overflowX: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${accent || C.brand}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, wordBreak: 'break-word' }}>{title}</div>
            {sub && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>
        <div style={{ padding: '16px 18px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tint || C.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// Order-by-order detail for one rep. Only ever opened for the caller's own row
// (or by an admin), so the dollar columns are always populated here.
function RepModal({ rep, onClose }: { rep: StrivenCommRep; onClose: () => void }) {
  const lines: StrivenOrderLine[] = rep.lines || [];
  const cpo = num(rep.orders) ? num(rep.total) / num(rep.orders) : 0;
  const progs: [string, number | null, number, string][] = [
    ['TriCare', rep.tricare, num(rep.nTricare), PROG_C.TriCare],
    ['VA', rep.va, num(rep.nVa), PROG_C.VA],
    ['Personal Injury', rep.pi, num(rep.nPi), PROG_C.PI],
  ];
  // Prints ONLY what this modal already holds. `rep` is the payload the server
  // sent, and peers' lines and money are stripped there before serialization —
  // so a rep can never produce a PDF of anyone else's commission, and this
  // needs no extra fetch or permission check of its own.
  const sheetRef = useRef<HTMLDivElement>(null);

  return (
    <Modal title={rep.rep} sub={`Final commission ${money(rep.total)} · ${num(rep.orders)} orders · ${num(rep.units)} units`} onClose={onClose}>
      <div ref={sheetRef}>
      {/* Statement header — only on paper, where the modal's own title bar and
          the surrounding page are gone. */}
      <div className="print-only" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{rep.rep} — commission statement</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          Sports Med Recovery · generated {new Date().toLocaleDateString()} · commission = units × per-device rate
        </div>
      </div>

      <div className="cm-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Payable / Due" value={money(rep.payableTotal)} tint={C.positive} />
        <Stat label="Waiting" value={money(rep.waitingTotal)} tint={C.warning} />
        <Stat label="Orders" value={String(num(rep.orders))} />
        <Stat label="Per order" value={money(cpo)} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
        By vertical <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· commission and orders</span>
      </div>
      <div style={{ marginBottom: 18 }}>
        {progs.filter(([, v, n]) => num(v) > 0 || n > 0).map(([name, v, n, c]) => (
          <div key={name} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{name}
                <span style={{ color: C.muted, fontWeight: 600, marginLeft: 6 }}>{n} order{n === 1 ? '' : 's'}</span>
              </span>
              <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                {money(v)}{num(rep.total) ? ` · ${Math.round((num(v) / num(rep.total)) * 100)}%` : ''}
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${num(rep.total) ? (num(v) / num(rep.total)) * 100 : 0}%`, background: c, borderRadius: 999 }} />
            </div>
          </div>
        ))}
      </div>

      {lines.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>
            Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {lines.length} orders</span>
          </div>
          <table className="data-table">
            <thead><tr>
              <th>Order</th><th>Device</th><th>Vertical</th><th className="num">Units</th>
              <th className="num">Order value</th><th className="num">Commission</th><th>State</th>
            </tr></thead>
            <tbody>
              {lines.map((ln, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600, color: ln.ref ? C.brand : C.muted }}>{ln.ref || 'no SO'}</td>
                  <td style={{ color: C.sub, fontSize: 12.5 }}>{ln.item || '-'}</td>
                  <td>{ln.prog}</td>
                  <td className="num">{ln.units}</td>
                  <td className="num">{formatCurrency(ln.value)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(ln.comm)}</td>
                  <td>
                    {ln.state === 'waiting'
                      ? <span style={{ color: C.warning, fontWeight: 600 }}>Waiting</span>
                      : <span style={{ color: C.positive, fontWeight: 600 }}>Payable</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 Shown by SO reference, no patient names. Commission = units × per-device rate. Orders on hold are excluded and do not appear here.
          </div>
        </>
      )}
      </div>

      {/* Download sits outside the printed region, so the button itself never
          appears in the PDF. */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.muted}22` }}>
        <button className="btn ghost" onClick={() => printToPdf(sheetRef.current)}
          title="Open the print dialog — choose “Save as PDF” for a statement of your own commission">
          ⎙ Download PDF
        </button>
      </div>
    </Modal>
  );
}

// Per-rep breakdown of a tapped KPI. Dollars appear only where the server sent
// them; every rep still contributes their order count.
function KpiDrill({ title, sub, accent, rows, onClose }: {
  title: string; sub?: string; accent: string;
  rows: { name: string; value: number | null; orders: number }[]; onClose: () => void;
}) {
  const sorted = rows.filter((r) => num(r.value) > 0 || r.orders > 0)
    .sort((a, b) => (num(b.value) - num(a.value)) || (b.orders - a.orders));
  const sum = sorted.reduce((s, r) => s + num(r.value), 0);
  const maxO = Math.max(1, ...sorted.map((r) => r.orders));
  return (
    <Modal title={title} sub={sub} accent={accent} onClose={onClose}>
      <table className="data-table">
        <thead><tr>
          <th style={{ width: 34 }}>#</th><th>Rep</th><th className="num">Orders</th>
          <th className="num">Commission</th><th className="num">Share</th><th style={{ width: '30%' }} />
        </tr></thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={6} style={{ color: C.muted }}>No data.</td></tr>}
          {sorted.map((r, i) => (
            <tr key={r.name}>
              <td style={{ color: C.muted }}>{i + 1}</td>
              <td style={{ fontWeight: 700 }}>{r.name}</td>
              <td className="num" style={{ fontWeight: 700 }}>{r.orders || '-'}</td>
              <td className="num" style={{ fontWeight: 800 }}>{money(r.value)}</td>
              <td className="num">{r.value != null && sum > 0 ? `${Math.round((r.value / sum) * 100)}%` : '—'}</td>
              <td>
                <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(r.orders / maxO) * 100}%`, background: accent, borderRadius: 999 }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
