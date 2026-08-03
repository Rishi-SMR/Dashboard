import { useEffect, useState } from 'react';
import { fetchRepOverview, fetchMe, type Me, type RepOverview, type RepRow, type RepVertical } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { KpiExec, HUE, useSyncAgo } from '../chartKit';
import { OrderDashboard } from './OrderDashboard';
import { PiPipeline } from './PiPipeline';
import { DashboardOverview } from './DashboardOverview';

const money = (v: number | null | undefined) => (v == null ? '-' : formatCurrency(v));
const n = (v: number | null | undefined) => (v == null ? '-' : String(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);


// ── Reps ─────────────────────────────────────────────────────────────────────
// The business seen from the reps' side.
//
//   Manager  → every rep in full: volume, revenue by vertical, commission.
//   Rep      → their own row in full; for everyone else, order and unit counts
//              only. The stripping happens server-side, so another rep's pay
//              never reaches this component to be hidden with CSS.
// 'overview' is the landing view: headline figures and the shape of the book.
// 'team' is the roster: every rep, every column. They were the same screen until
// the sidebar offered both, which made two nav entries render one page.
type RepSub = 'overview' | 'team' | 'verticals' | 'orders' | 'pipeline' | 'mine';
export function RepsTab({ initialSub = 'overview' }: { initialSub?: RepSub }) {
  const [data, setData] = useState<RepOverview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [sub, setSub] = useState<RepSub>(initialSub);
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [sel, setSel] = useState<RepRow | null>(null);
  const [drill, setDrill] = useState<DrillKey | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      // REPLACE, never merge. Every masked field must come from this response;
      // merging would let a previous manager payload survive into a rep preview.
      setData(await fetchRepOverview(viewAs));
      setLastSync(Date.now());
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load the rep view.'); }
    finally { if (!silent) setLoading(false); }
  }
  // Changing the previewed rep drops the current payload FIRST, so no figure
  // from the previous identity can render while the new one is in flight.
  useEffect(() => { setData(null); setSel(null); load(); }, [viewAs]);
  useEffect(() => { fetchMe().then(setMe).catch(() => setMe(null)); }, []);

  const isManager = data?.role === 'admin';
  const reps = data?.reps ?? [];
  const t = data?.teamTotals;
  const own = reps.find((r) => r.isSelf) ?? null;
  // Headline figures come from the WHOLE book so the Team dashboard and Orders &
  // Revenue agree on sight. `teamTotals` remains rep-scoped for the per-rep
  // table below; only the KPI strip is reconciled. Reps get no bookTotals, so
  // they fall back to their own row.
  const kt = data?.bookTotals ?? t;
  const maxRev = Math.max(1, ...reps.map((r) => num(r.revenue)));
  const maxOrd = Math.max(1, ...reps.map((r) => r.orders));

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          {/* Uppercase needs tracking at display size or the capitals crowd. */}
          <h1 className="page-title" style={{ fontSize: 22, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {isManager ? 'Team dashboard' : 'My dashboard'}
          </h1>
          <div className="page-sub">
            <span className="live-dot" />
            {isManager
              ? 'Every rep: orders, revenue by vertical and commission'
              : `${data?.me ?? '-'} · your figures in full, order counts for the team`}
            {agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {me?.role === 'admin' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
              View as
              <select value={viewAs ?? ''} onChange={(e) => setViewAs(e.target.value || null)}
                style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                <option value="">Manager (everything)</option>
                {reps.map((r) => <option key={r.rep} value={r.rep}>{r.rep}</option>)}
              </select>
            </label>
          )}
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {viewAs && (
        <div className="qb-flash warn" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>👁 Previewing <b>{viewAs}</b>'s view. Every other rep's revenue and commission was removed on the server.</span>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setViewAs(null)}>Exit preview</button>
        </div>
      )}

      {/* subsections: the whole rep-side dashboard lives under this one tab.
          Uses .ov-tabs, the same control the company side renders (Orders,
          Automation, AR/AP). It replaces a one-off inline segmented control that
          was visibly smaller than every other tab row in the app: 12px uppercase
          on 6px padding, hugging its content, against the house 14px on 12px
          padding stretched full width. */}
      <div className="ov-tabs">
        <button className={`ov-tab${sub === 'overview' ? ' active' : ''}`} onClick={() => setSub('overview')}>Overview</button>
        <button className={`ov-tab${sub === 'team' ? ' active' : ''}`} onClick={() => setSub('team')}>Roster</button>
        <button className={`ov-tab${sub === 'verticals' ? ' active' : ''}`} onClick={() => setSub('verticals')}>By vertical</button>
        <button className={`ov-tab${sub === 'mine' ? ' active' : ''}`} onClick={() => setSub('mine')}>{isManager ? 'Rep detail' : 'My commission'}</button>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* Filters, verticals, accounts, device types, saved views: the same
          dashboard, reached from the rep side and scoped to the caller. */}
      {sub === 'orders' && <OrderDashboard viewAs={viewAs} />}
      {sub === 'pipeline' && <div className="section chart-card"><PiPipeline viewAs={viewAs} /></div>}

      {data && sub !== 'orders' && sub !== 'pipeline' && (
        <>
          {/* The house KPI card (KpiExec, shared from chartKit): the same
              component the company Overview renders, so the two dashboards read
              as one product. `sub` carries what the old card's foot strip said;
              `chip` carries the qualifier. Hues come from the shared HUE map, so
              a metric keeps its colour across tabs: revenue is always the brand
              blue, commission always amber. */}
          <div className="kpi-strip kpi-strip-6" style={{ marginBottom: 14 }}>
            <KpiExec label="Reps" value={t?.reps ?? 0} format={(x: number) => String(x)} hue={HUE.revenue}
              sub="on the commission sheet" chip="team" onClick={() => setDrill('reps')} />
            <KpiExec label="Orders" value={kt?.orders ?? 0} format={(x: number) => String(x)} hue={HUE.ar}
              sub="cancelled excluded" chip="order book" onClick={() => setDrill('orders')} />
            <KpiExec label="Devices" value={num(kt?.units)} format={() => n(kt?.units)} hue={HUE.ap}
              sub="units on those orders" chip="order book" onClick={() => setDrill('units')} />
            <KpiExec label="Accounts" value={num(kt?.accounts)} format={() => n(kt?.accounts)} hue={HUE.sales}
              sub="vendors billed" chip="order book" onClick={() => setDrill('accounts')} />
            <KpiExec label={isManager ? 'Revenue' : 'Your revenue'} value={num(kt?.revenue)} format={money} hue={HUE.cash}
              sub="order value" chip={isManager ? 'SMR' : 'yours'} onClick={() => setDrill('revenue')} />
            <KpiExec label={isManager ? 'Commission' : 'Your commission'} value={num(t?.commission)} format={money} hue={HUE.po}
              sub="units × device rate" chip={isManager ? 'SMR' : 'yours'} onClick={() => setDrill('commission')} />
          </div>

          {/* Where the team's volume actually sits. Built from order counts, so
              it renders identically for a manager and for a rep: counts are
              shared even where revenue is not. */}
          {/* The gist of every other tab, on one screen. */}
          {sub === 'overview' && <DashboardOverview reps={reps} viewAs={viewAs} />}

          {sub === 'overview' && <TeamShape reps={reps} />}

          {/* Overview stops here: the shape of the book and, for a rep, their own
              standing. The full roster lives one click away rather than being
              repeated on the landing page. */}
          {sub === 'overview' && (
            <OverviewPanel reps={reps} isManager={isManager} onPickRep={setSel} onSeeRoster={() => setSub('team')} />
          )}

          {/* Why this page's order count is lower than Orders & Revenue. */}
          {data.unattributed && data.unattributed.orders > 0 && (
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14, background: 'var(--panel-2)', borderRadius: 10, padding: '9px 13px' }}>
              These totals cover the <b style={{ color: C.sub }}>rep-attributed</b> book. A further{' '}
              <b style={{ color: C.sub }}>{data.unattributed.orders} orders</b> ({formatCurrency(data.unattributed.revenue)}) are
              booked in Striven to house/clinic accounts, ops staff or nobody at all: they earn no commission and are excluded here.
            </div>
          )}

          {sub === 'team' && (
            <div className="section chart-card">
              <div className="section-head"><div>
                <h2 className="section-title">The team</h2>
                <div className="section-sub">
                  {isManager
                    ? 'Every rep in full. Click a row for their vertical breakdown.'
                    : 'Your row is shown in full. For everyone else you can see how much they booked, but not what they earned.'}
                </div>
              </div></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th style={{ width: 34 }}>#</th><th>Rep</th>
                    <th className="num">Orders</th><th className="num">Devices</th><th className="num" title="Distinct vendors billed. VA and TriCare are single-vendor programmes, so a rep working one of them shows one account however many orders they book.">Accounts</th>
                    <th className="num">Revenue</th><th className="num">Payable</th><th className="num">Waiting</th>
                    <th className="num">Commission</th><th style={{ width: '16%' }}>Vertical mix</th>
                  </tr></thead>
                  <tbody>
                    {reps.length === 0 && <tr><td colSpan={10} style={{ color: C.muted }}>No reps.</td></tr>}
                    {reps.map((r, i) => (
                      <tr key={r.rep} onClick={() => setSel(r)} style={{ cursor: 'pointer', background: r.isSelf ? 'var(--panel-2)' : undefined, borderLeft: r.isSelf ? `3px solid ${C.brand}` : '3px solid transparent' }}
                        title={r.own ? `Full detail for ${r.rep}` : `${r.rep}'s volume: their pay is confidential`}>
                        <td style={{ color: C.muted }}>{i + 1}</td>
                        <td style={{ fontWeight: 700, color: C.brand }}>
                          {r.rep}
                          {r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>{r.orders}</td>
                        <td className="num">{n(r.units)}</td>
                        <td className="num">{n(r.accounts)}</td>
                        <td className="num">{r.own ? money(r.revenue) : <Confidential />}</td>
                        <td className="num" style={{ color: r.own ? C.positive : undefined, fontWeight: 700 }}>{r.own ? money(r.payable) : <Confidential />}</td>
                        <td className="num" style={{ color: r.own ? C.warning : undefined, fontWeight: 700 }}>{r.own ? money(r.waiting) : <Confidential />}</td>
                        <td className="num" style={{ fontWeight: 800 }}>{r.own ? money(r.commission) : <Confidential />}</td>
                        {/* Vertical mix, not a revenue bar: it works whether or
                            not this row's money is visible, and says something
                            the numeric columns don't. */}
                        <td><MixBar parts={r.byVertical} total={r.orders} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="total-row">
                    <td /><td>{isManager ? 'All reps' : 'Team'}</td>
                    <td className="num">{t?.orders}</td><td className="num">{n(t?.units)}</td><td className="num">{n(t?.accounts)}</td>
                    <td className="num" style={{ fontWeight: 800 }}>{money(t?.revenue)}</td>
                    <td /><td />
                    <td className="num" style={{ fontWeight: 800 }}>{money(t?.commission)}</td><td />
                  </tr></tfoot>
                </table>
              </div>
              {!isManager && (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
                  🔒 Revenue and commission for other reps are removed on the server before this page loads: they are not hidden in the browser.
                </div>
              )}
            </div>
          )}

          {sub === 'verticals' && (
            // Plain house card, like the other three sub-tabs. It used to carry
            // a 3px accent rule and a deeper one-off shadow to "read as the
            // subject of the page": but it is the only card in the app dressed
            // that way, so side by side with Overview / Roster / Rep detail it
            // read as a different design rather than an emphasised one.
            <div className="section chart-card">
              <div className="section-head"><div>
                <h2 className="section-title">Rep × vertical</h2>
                <div className="section-sub">Orders and units per vertical for every rep. Revenue shows where you are allowed to see it.</div>
              </div></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Rep</th>
                    {/* Each vertical column carries a faint tint of its own colour,
                        so the four bands are distinguishable without rules. */}
                    {(data.verticals || []).map((v) => (
                      <th key={v} className="num" style={{ color: V_C[v], background: `${V_C[v]}0F`, borderBottom: `2px solid ${V_C[v]}55` }}>{v}</th>
                    ))}
                    <th className="num" style={{ borderLeft: `1px solid ${C.muted}33` }}>Total orders</th>
                    <th className="num">Revenue</th>
                  </tr></thead>
                  <tbody>
                    {reps.map((r, i) => (
                      // Faint zebra banding: with three stacked figures per cell,
                      // an unbanded row is easy to lose track of across the width.
                      <tr key={r.rep} style={{ background: r.isSelf ? 'var(--panel-2)' : (i % 2 ? 'rgba(20,36,58,.02)' : undefined) }}>
                        <td style={{ fontWeight: 700, color: C.brand, borderLeft: r.isSelf ? `3px solid ${C.brand}` : '3px solid transparent' }}>
                          {r.rep}{r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                        </td>
                        {r.byVertical.map((v) => (
                          <td key={v.vertical} className="num" style={{ background: `${V_C[v.vertical]}09` }}
                            title={`${v.orders} order${v.orders === 1 ? '' : 's'}${v.units != null ? ` · ${v.units} units` : ''}${v.revenue != null ? ` · ${formatCurrency(v.revenue)}` : ''}`}>
                            {v.orders ? (
                              <>
                                <div style={{ fontWeight: 700, fontSize: 14, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                                  {v.orders}
                                  {v.units != null && <span style={{ fontSize: 11, fontWeight: 500, color: C.muted, marginLeft: 5 }}>{v.units}u</span>}
                                </div>
                                {v.revenue != null && (
                                  <div style={{ fontSize: 11.5, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(v.revenue)}</div>
                                )}
                              </>
                            ) : <span style={{ color: `${C.muted}88` }}>–</span>}
                          </td>
                        ))}
                        <td className="num" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', borderLeft: `1px solid ${C.muted}22` }}>{r.orders}</td>
                        <td className="num" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{r.own ? money(r.revenue) : <Confidential />}</td>
                      </tr>
                    ))}
                  </tbody>
                  {/* A table of parts should foot up to the whole. */}
                  <tfoot><tr className="total-row">
                    <td>Team</td>
                    {/* No per-column tint here. The total row is a solid brand
                        band with white text, and a pale tint on top of it left
                        the order counts unreadable. It reads as one band. */}
                    {(data.verticals || []).map((v) => {
                      const ord = reps.reduce((s, r) => s + (r.byVertical.find((x) => x.vertical === v)?.orders ?? 0), 0);
                      const rev = reps.reduce((s, r) => s + (r.byVertical.find((x) => x.vertical === v)?.revenue ?? 0), 0);
                      return (
                        <td key={v} className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {ord ? (
                            <>
                              <div style={{ fontWeight: 800 }}>{ord}</div>
                              {rev > 0 && <div style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.85 }}>{formatCurrency(rev)}</div>}
                            </>
                          ) : <span style={{ opacity: 0.5 }}>–</span>}
                        </td>
                      );
                    })}
                    <td className="num" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{t?.orders}</td>
                    <td className="num" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{money(t?.revenue)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          )}

          {sub === 'mine' && (
            isManager
              ? <ManagerRepPicker reps={reps} onPick={setSel} />
              : own
                ? <RepDetail rep={own} inline />
                : <div className="section"><div className="page-sub" style={{ padding: 16 }}>
                    Your account isn't mapped to a rep on the commission sheet yet, so there is no personal view to show.
                    Ask an admin to add you to the rep directory.
                  </div></div>
          )}
        </>
      )}

      {sel && <RepModal rep={sel} onClose={() => setSel(null)} />}
      {drill && data && (
        <KpiDrill metric={drill} reps={reps} data={data} onClose={() => setDrill(null)} onPickRep={(r) => { setDrill(null); setSel(r); }} />
      )}
    </div>
  );
}

type DrillKey = 'reps' | 'orders' | 'units' | 'accounts' | 'verticals' | 'revenue' | 'commission';

/**
 * Per-rep breakdown of a tapped headline figure.
 *
 * Money metrics show a Confidential pill wherever the server withheld the value,
 * so a rep can open Revenue or Commission and still see the shape of the team by
 * volume without anyone else's pay appearing. Counts are shared, money is not.
 */
function KpiDrill({ metric, reps, data, onClose, onPickRep }: {
  metric: DrillKey; reps: RepRow[]; data: RepOverview;
  onClose: () => void; onPickRep: (r: RepRow) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const MONEY = metric === 'revenue' || metric === 'commission';
  const CFG: Record<DrillKey, { title: string; sub: string; col: string; tint: string }> = {
    reps: { title: 'Reps', sub: 'The four names on the commission sheet, by order volume.', col: 'Orders', tint: C.brand },
    orders: { title: 'Orders by rep', sub: 'Cancelled and $0-value orders are excluded from every figure.', col: 'Orders', tint: V_C.PI },
    units: { title: 'Devices by rep', sub: 'Units shipped on those orders.', col: 'Units', tint: V_C.DOL },
    // "Vendors" is the client's term for the billed party. Note it is NOT
    // Striven's meaning of the word: there a vendor is a supplier on a
    // purchase order. This drill reads sales orders throughout; nothing here
    // touches the PO book.
    accounts: { title: 'Accounts by rep', sub: 'Distinct vendors billed: the law firm on a PI order, Veterans Affairs on a VA order, TriCare on a Tri-Care order. VA and TriCare are single-vendor, so a rep working one programme shows one account however many orders they book.', col: 'Accounts', tint: C.info },
    verticals: { title: 'Verticals by rep', sub: 'How many of PI / VA / TriCare / DOL each rep has orders in.', col: 'Verticals', tint: V_C.VA },
    revenue: { title: 'Revenue by rep', sub: 'Order value. Visible only where you are permitted to see it.', col: 'Revenue', tint: C.positive },
    commission: { title: 'Commission by rep', sub: 'units × per-device rate. Visible only where you are permitted to see it.', col: 'Commission', tint: C.warning },
  };
  const cfg = CFG[metric];
  const valOf = (r: RepRow): number | null =>
    metric === 'revenue' ? r.revenue
      : metric === 'commission' ? r.commission
        : metric === 'units' ? r.units
          : metric === 'accounts' ? r.accounts
            : metric === 'verticals' ? r.verticals
              : r.orders;

  const rowsSorted = [...reps].sort((a, b) => (valOf(b) ?? -1) - (valOf(a) ?? -1) || b.orders - a.orders);
  const known = rowsSorted.map(valOf).filter((v): v is number => v != null);

  // Orders, units and revenue exist for the whole book; commission and the two
  // count metrics do not. Only the first three get an off-roster row, so the
  // Total matches the KPI above for exactly the metrics that KPI reports.
  // Accounts and verticals are DISTINCT counts, not additive quantities. Two
  // reps billing the same law firm are two rows of 1, but one account: so the
  // column sums to more than the book's true total. Say "Sum of rep counts"
  // rather than "Total", and print the real figure underneath.
  const DISTINCT = metric === 'accounts' || metric === 'verticals';
  const u = data.unattributed;
  const offRoster: number | null =
    !u ? null
      : metric === 'orders' ? u.orders
        : metric === 'units' ? u.units
          : metric === 'revenue' ? u.revenue
            : null;

  const sum = known.reduce((s, v) => s + v, 0) + (offRoster ?? 0);
  const max = Math.max(1, ...known, offRoster ?? 0);
  const withheld = rowsSorted.filter((r) => valOf(r) == null).length;
  const fmt = (v: number | null) => (v == null ? null : MONEY ? formatCurrency(v) : String(v));

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(720px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${cfg.tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{cfg.title}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{cfg.sub}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 34 }}>#</th><th>Rep</th>
              <th className="num">{cfg.col}</th><th className="num">Share</th><th style={{ width: '32%' }} />
            </tr></thead>
            <tbody>
              {rowsSorted.map((r, i) => {
                const v = valOf(r);
                return (
                  <tr key={r.rep} onClick={() => onPickRep(r)} style={{ cursor: 'pointer', background: r.isSelf ? 'var(--panel-2)' : undefined }}
                    title={`Open ${r.rep}'s detail`}>
                    <td style={{ color: C.muted }}>{i + 1}</td>
                    <td style={{ fontWeight: 700, color: C.brand }}>
                      {r.rep}{r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                    </td>
                    <td className="num" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      {v == null ? <Confidential /> : fmt(v)}
                    </td>
                    <td className="num" style={{ color: C.sub }}>
                      {v != null && sum > 0 ? `${Math.round((v / sum) * 100)}%` : '-'}
                    </td>
                    <td>
                      <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${v == null ? 0 : (v / max) * 100}%`, background: r.isSelf ? cfg.tint : `${cfg.tint}99`, borderRadius: 999 }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* The book's tail, as a row rather than a footnote: without it
                  the Total reads 643 while the KPI above it reads 644, and the
                  table looks like it disagrees with its own headline. */}
              {offRoster != null && offRoster > 0 && (
                <tr style={{ background: 'var(--panel-2)' }} title="Booked in Striven to house/clinic accounts, ops staff or nobody at all. Earns no commission.">
                  <td style={{ color: C.muted }}>-</td>
                  <td style={{ fontWeight: 600, color: C.sub, fontStyle: 'italic' }}>
                    Off roster
                    <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: C.muted }}>
                      ({data.unattributed?.orders} order{data.unattributed?.orders === 1 ? '' : 's'})
                    </span>
                  </td>
                  <td className="num" style={{ fontWeight: 700, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{fmt(offRoster)}</td>
                  <td className="num" style={{ color: C.sub }}>{sum > 0 ? `${Math.round((offRoster / sum) * 100)}%` : '-'}</td>
                  <td>
                    <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(offRoster / max) * 100}%`, background: `${C.muted}88`, borderRadius: 999 }} />
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot><tr className="total-row">
              <td /><td>
                {withheld ? `Visible to you (${rowsSorted.length - withheld} of ${rowsSorted.length})`
                  : DISTINCT ? 'Sum of rep counts' : 'Total'}
              </td>
              <td className="num" style={{ fontWeight: 800 }}>{MONEY ? formatCurrency(sum) : sum}</td>
              <td /><td />
            </tr></tfoot>
          </table>

          {/* The order book has a tail that belongs to nobody on the sheet. */}
          {DISTINCT && metric === 'accounts' && data.bookTotals && (
            <div style={{ fontSize: 12.5, color: C.sub, background: 'var(--panel-2)', borderRadius: 10, padding: '10px 13px', marginTop: 12 }}>
              The order book bills <b>{data.bookTotals.accounts} distinct accounts</b>. The column above sums to more because reps share
              payers: Veterans Affairs and TriCare are single-payer programmes billed by several reps, so each rep counts them once.
            </div>
          )}
          {offRoster != null && offRoster > 0 && (
            <div style={{ fontSize: 12.5, color: C.sub, background: 'var(--panel-2)', borderRadius: 10, padding: '10px 13px', marginTop: 12 }}>
              <b>Off roster</b> is {data.unattributed?.orders} order{data.unattributed?.orders === 1 ? '' : 's'} booked in Striven to
              house/clinic accounts, ops staff or nobody at all. They are part of the order book: so this Total ties to Orders &amp;
              Revenue: but they earn no commission.
            </div>
          )}
          {withheld > 0 && (
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
              🔒 {withheld} rep{withheld === 1 ? "'s" : "s'"} figures are confidential to them. Order counts stay visible across the team; pay does not.
            </div>
          )}
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Click any row for that rep's full breakdown.</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Team Standings: the rep-facing leaderboard.
 *
 * Competitive but confidential: rank, rep name and ORDER COUNT only. No revenue,
 * commission, devices or accounts for anyone but the signed-in rep, because the
 * server never sends them. Nothing here is a client-side filter.
 */
export function TeamStandings({ viewAs }: { viewAs?: string | null }) {
  const [data, setData] = useState<RepOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null); setLoading(true); setError(null);
    fetchRepOverview(viewAs)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load standings.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };   // a slow earlier response must not land late
  }, [viewAs]);

  const ranked = [...(data?.reps ?? [])].sort((a, b) => b.orders - a.orders);
  const leader = ranked[0]?.orders ?? 0;
  const mine = ranked.find((r) => r.isSelf) ?? null;
  const myRank = mine ? ranked.findIndex((r) => r.isSelf) + 1 : null;
  const gap = mine ? leader - mine.orders : 0;
  const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '');

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Team standings</h1>
          <div className="page-sub">
            <span className="live-dot" /> Ranked by orders booked. Everyone's volume is shared; nobody's pay is.
          </div>
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {mine && (
        <div className="section chart-card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, padding: '4px 2px' }}>
            <Stat label="Your rank" value={`#${myRank} of ${ranked.length}`} tint={C.brand} />
            <Stat label="Your orders" value={String(mine.orders)} />
            <Stat label={myRank === 1 ? 'Lead over 2nd' : 'Behind the leader'}
              value={myRank === 1 ? `+${mine.orders - (ranked[1]?.orders ?? 0)}` : `${gap} order${gap === 1 ? '' : 's'}`}
              tint={myRank === 1 ? C.positive : C.warning} />
            <Stat label="Your commission" value={money(mine.commission)} tint={C.positive} />
          </div>
        </div>
      )}

      <div className="section chart-card">
        <div className="section-head"><div>
          <h2 className="section-title">Leaderboard</h2>
          <div className="section-sub">Order count only: revenue and commission are private to each rep.</div>
        </div></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 60 }}>Rank</th><th>Rep</th>
              <th className="num">Orders</th><th style={{ width: '46%' }}>Progress to leader</th>
            </tr></thead>
            <tbody>
              {ranked.length === 0 && !loading && <tr><td colSpan={4} style={{ color: C.muted }}>No reps yet.</td></tr>}
              {ranked.map((r, i) => (
                <tr key={r.rep} style={{ background: r.isSelf ? 'var(--panel-2)' : undefined, borderLeft: r.isSelf ? `3px solid ${C.brand}` : '3px solid transparent' }}>
                  <td style={{ fontWeight: 800, color: i < 3 ? C.ink : C.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {medal(i)} {i + 1}
                  </td>
                  <td style={{ fontWeight: 700, color: r.isSelf ? C.brand : C.ink }}>
                    {r.rep}
                    {r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.positive }}>You</span>}
                  </td>
                  <td className="num" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{r.orders}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 10, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}
                        title={`${r.orders} of the leader's ${leader}`}>
                        <div style={{ height: '100%', width: `${leader ? (r.orders / leader) * 100 : 0}%`, background: r.isSelf ? C.brand : `${C.muted}99`, borderRadius: 999 }} />
                      </div>
                      <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {leader ? `${Math.round((r.orders / leader) * 100)}%` : '-'}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
          🔒 Order counts are shared across the team. Revenue, commission, devices and accounts for other reps are never sent to this page.
        </div>
      </div>
    </div>
  );
}

/**
 * The landing view's body: a short leaderboard rather than the full roster.
 *
 * Deliberately NOT the roster table: Dashboard and Reps were rendering the same
 * screen, so this keeps only what belongs on a landing page: who is ahead, and a
 * way through to everything else.
 */
function OverviewPanel({ reps, isManager, onPickRep, onSeeRoster }: {
  reps: RepRow[]; isManager: boolean; onPickRep: (r: RepRow) => void; onSeeRoster: () => void;
}) {
  const ranked = [...reps].sort((a, b) => b.orders - a.orders);
  const leader = ranked[0]?.orders ?? 0;
  const self = reps.find((r) => r.isSelf) ?? null;
  if (!ranked.length) return null;

  return (
    <>
      {self && !isManager && (
        <div className="section chart-card" style={{ marginBottom: 14 }}>
          <div className="section-head"><div>
            <h2 className="section-title">Your standing</h2>
            <div className="section-sub">Your figures in full. Everyone else's pay stays with them.</div>
          </div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, padding: '2px 2px 0' }}>
            <Stat label="Rank by orders" value={`#${ranked.findIndex((r) => r.isSelf) + 1} of ${ranked.length}`} tint={C.brand} />
            <Stat label="Your orders" value={String(self.orders)} />
            <Stat label="Payable / due" value={money(self.payable)} tint={C.positive} />
            <Stat label="Waiting" value={money(self.waiting)} tint={C.warning} />
          </div>
        </div>
      )}

      <div className="section chart-card">
        <div className="section-head">
          <div>
            <h2 className="section-title">Leaderboard</h2>
            <div className="section-sub">By orders booked. Click a rep for their full breakdown.</div>
          </div>
          <button className="btn ghost" onClick={onSeeRoster}>Full roster →</button>
        </div>
        <div style={{ display: 'grid', gap: 8, padding: '2px 2px 0' }}>
          {ranked.map((r, i) => (
            <button key={r.rep} onClick={() => onPickRep(r)}
              style={{
                display: 'grid', gridTemplateColumns: '26px 1fr 130px 76px', gap: 12, alignItems: 'center',
                textAlign: 'left', cursor: 'pointer', width: '100%',
                background: r.isSelf ? 'var(--panel-2)' : 'transparent',
                border: `1px solid ${r.isSelf ? `${C.brand}44` : 'transparent'}`,
                borderRadius: 10, padding: '9px 11px',
              }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: i === 0 ? C.ink : C.muted, fontVariantNumeric: 'tabular-nums' }}>
                {i === 0 ? '🥇' : i + 1}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.brand }}>{r.rep}</span>
                {r.isSelf && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.positive }}>You</span>}
                <span style={{ display: 'block', marginTop: 4 }}><MixBar parts={r.byVertical} total={r.orders} /></span>
              </span>
              <span style={{ fontSize: 12.5, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>
                <b style={{ color: C.ink, fontSize: 15 }}>{r.orders}</b> orders
                <span style={{ color: C.muted }}> · {leader ? Math.round((r.orders / leader) * 100) : 0}%</span>
              </span>
              <span style={{ fontSize: 14, fontWeight: 800, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {r.own ? money(r.commission) : <Confidential />}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** One rep's split across verticals, by order count. */
function MixBar({ parts, total }: { parts: RepVertical[]; total: number }) {
  const shown = parts.filter((p) => p.orders > 0);
  if (!shown.length || !total) return <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)' }} />;
  return (
    <div title={shown.map((p) => `${p.vertical}: ${p.orders}`).join(' · ')}
      style={{ display: 'flex', height: 9, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
      {shown.map((p) => (
        <div key={p.vertical} style={{ width: `${(p.orders / total) * 100}%`, background: V_C[p.vertical] || C.muted }} />
      ))}
    </div>
  );
}

/**
 * The team's shape at a glance: how the order book divides across verticals, and
 * who the leaders are.
 *
 * Built entirely from ORDER COUNTS, so it renders identically for a manager and
 * for a rep: volume is shared across the team even where pay is not, which
 * means this band never goes blank on someone.
 */
function TeamShape({ reps }: { reps: RepRow[] }) {
  const VERTS = ['PI', 'VA', 'DOL', 'TriCare'];
  const byV = VERTS.map((vertical) => ({
    vertical,
    orders: reps.reduce((s, r) => s + (r.byVertical.find((v) => v.vertical === vertical)?.orders ?? 0), 0),
  })).filter((v) => v.orders > 0);
  const total = byV.reduce((s, v) => s + v.orders, 0);
  if (!total) return null;

  const topVolume = [...reps].sort((a, b) => b.orders - a.orders)[0];
  const topPay = [...reps].filter((r) => r.commission != null).sort((a, b) => (b.commission ?? 0) - (a.commission ?? 0))[0];
  const unverified = reps.filter((r) => !r.verified).length;

  // The vertical split used to be drawn here too, from rep-attributed orders
  // only (328). The donut above draws it from the whole book (413), so PI read
  // 30 in one place and 108 in the other: same screen, different scope, no
  // label saying so. The chart is the better view, so this keeps only the
  // highlights, which nothing else shows.
  return (
    <div className="section chart-card" style={{ marginBottom: 14 }}>
      <div className="section-head"><div>
        <h2 className="section-title">Leaders &amp; reconciliation</h2>
        <div className="section-sub">
          Across the {total} orders booked to the four reps.
          {' '}Everything above covers the full order book, including orders booked to house and clinic accounts.
        </div>
      </div></div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, padding: '2px 2px 0', fontSize: 13, color: C.sub }}>
        {topVolume && <span>Most orders <b style={{ color: C.ink }}>{topVolume.rep}</b> <span style={{ color: C.muted }}>({topVolume.orders})</span></span>}
        {topPay && <span>Highest commission <b style={{ color: C.ink }}>{topPay.rep}</b> <span style={{ color: C.muted }}>({money(topPay.commission)})</span></span>}
        <span style={{ color: unverified ? C.warning : C.positive }}>
          {unverified === 0
            ? 'All reps reconcile against the sheet'
            : `${unverified} of ${reps.length} rep${reps.length === 1 ? '' : 's'} not yet reconciled against the sheet`}
        </span>
      </div>
    </div>
  );
}

// Another rep's money. Named rather than blanked, so the absence reads as a
// policy rather than as missing data.
function Confidential() {
  return (
    <span title="Commission and revenue are confidential to that rep"
      style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: C.sub, background: 'var(--panel-2)', border: `1px solid ${C.muted}33`, borderRadius: 999, padding: '2px 8px' }}>
      Confidential
    </span>
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

function ManagerRepPicker({ reps, onPick }: { reps: RepRow[]; onPick: (r: RepRow) => void }) {
  return (
    <div className="section chart-card">
      <div className="section-head"><div>
        <h2 className="section-title">Rep detail</h2>
        <div className="section-sub">Pick a rep for their full breakdown.</div>
      </div></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, padding: '4px 2px' }}>
        {reps.map((r) => (
          <button key={r.rep} onClick={() => onPick(r)}
            style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--panel-2)', border: `1px solid ${C.muted}22`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.brand }}>{r.rep}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{money(r.commission)}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{r.orders} orders · {r.units} devices · {r.accounts} accounts</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// One rep in full. Used inline for a rep's own view, and in a modal from the
// team table.
function RepDetail({ rep, inline = false }: { rep: RepRow; inline?: boolean }) {
  const totalOrders = rep.byVertical.reduce((s, v) => s + v.orders, 0) || 1;
  const body = (
    <>
      <div className="cm-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Commission" value={money(rep.commission)} tint={C.brand} />
        <Stat label="Payable / due" value={money(rep.payable)} tint={C.positive} />
        <Stat label="Waiting" value={money(rep.waiting)} tint={C.warning} />
        <Stat label="Revenue" value={money(rep.revenue)} />
      </div>

      <div className="cm-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <Stat label="Orders" value={String(rep.orders)} />
        <Stat label="Devices" value={n(rep.units)} />
        <Stat label="Accounts" value={n(rep.accounts)} />
        <Stat label="Device types" value={n(rep.devices)} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
      <table className="data-table">
        <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Devices</th><th className="num">Revenue</th><th className="num">Share of orders</th><th style={{ width: '24%' }} /></tr></thead>
        <tbody>
          {rep.byVertical.map((v) => (
            <tr key={v.vertical}>
              <td style={{ fontWeight: 700, color: V_C[v.vertical] }}>
                <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: V_C[v.vertical], marginRight: 8 }} />
                {v.vertical}
              </td>
              <td className="num" style={{ fontWeight: 700 }}>{v.orders || '-'}</td>
              <td className="num">{n(v.units)}</td>
              <td className="num" style={{ fontWeight: 800 }}>{v.revenue != null ? (v.revenue ? formatCurrency(v.revenue) : '-') : <Confidential />}</td>
              <td className="num">{v.orders ? `${Math.round((v.orders / totalOrders) * 100)}%` : '-'}</td>
              <td>
                <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(v.orders / totalOrders) * 100}%`, background: V_C[v.vertical], borderRadius: 999 }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
        🔒 No patient names. Commission = units × per-device rate; cancelled and $0-value orders earn nothing.
        {rep.matchRate != null && <> Sheet reconciliation: {rep.matchRate}% {rep.verified ? '· verified' : '· unverified'}.</>}
      </div>
    </>
  );
  if (!inline) return body;
  return (
    <div className="section chart-card">
      <div className="section-head"><div>
        <h2 className="section-title">{rep.rep}</h2>
        <div className="section-sub">Your commission and the orders behind it.</div>
      </div></div>
      {body}
    </div>
  );
}

function RepModal({ rep, onClose }: { rep: RepRow; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(820px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${rep.own ? C.brand : C.muted}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{rep.rep}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {rep.orders} orders · {rep.units} devices · {rep.accounts} accounts
              {!rep.own && ' · pay is confidential'}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>
        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          {!rep.own && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--panel-2)', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontSize: 13, color: C.sub }}>
              <span style={{ fontSize: 15, lineHeight: 1.2 }}>🔒</span>
              <div><b style={{ color: C.ink }}>{rep.rep}'s revenue and commission are confidential.</b> You can see their order volume by vertical, not what they earned.</div>
            </div>
          )}
          <RepDetail rep={rep} />
        </div>
      </div>
    </div>
  );
}
