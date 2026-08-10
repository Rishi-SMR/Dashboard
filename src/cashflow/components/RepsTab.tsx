import { useEffect, useState } from 'react';
import { fetchRepOverview, fetchMe, type Me, type RepOverview, type RepRow, type RepVertical } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { KpiExec, HUE, useSyncAgo } from '../chartKit';
import { OrderDashboard } from './OrderDashboard';
import { PiPipeline } from './PiPipeline';
import { DashboardOverview } from './DashboardOverview';
import { Leaderboard } from './Leaderboard';
import { isKevinLogin } from '../viewProfile';

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
// 'team', 'verticals' and 'mine' are GONE. They were three sub-tabs above one
// dashboard; the roster table and the rep × vertical matrix now render on the
// Overview itself, and "rep detail" was never a page — clicking any rep, on the
// leaderboard or in either table, has always opened the same modal.
//
// What is left is not a tab set: 'orders' and 'pipeline' are separate SIDEBAR
// entries that happen to mount this component, so the in-page tab bar is gone
// with them.
type RepSub = 'overview' | 'orders' | 'pipeline';
export function RepsTab({ initialSub = 'overview' }: { initialSub?: RepSub }) {
  const [data, setData] = useState<RepOverview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  // No setter: nothing in the page switches sub-views any more. `sub` is fixed
  // by which sidebar entry mounted this component.
  const [sub] = useState<RepSub>(initialSub);
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
  // THE LOGIN DECIDES, NOT THE PROFILE.
  //
  // This gate was keyed on the view profile, which is a localStorage value and
  // therefore BROWSER-wide, not per-user. Anyone who previewed Kevin's board
  // left `smr.viewProfile=kevin` behind, so Crystal and Rishi signing in on the
  // same machine afterwards lost their "View as" picker with nothing on screen
  // explaining why — the profile of a previous session silently removing a
  // control from a different person's login.
  //
  // Kevin's own login still has no picker, which is what was asked for. An
  // admin PREVIEWING his layout keeps theirs: previewing a board is not the
  // same as being the person whose board it is, and they need the control to
  // get back out.
  const isKevin = isKevinLogin(me?.email);
  // KEVIN'S BOARD IS KEVIN'S BOARD. The rep-preview picker is a finance/ops
  // tool, and on the owner view it only muddies whose figures are on screen —
  // so it is not offered, and any preview left running from Crystal's view is
  // dropped on the way in rather than persisting into a board that no longer
  // shows a way out of it. Switching back to Crystal restores the picker.
  useEffect(() => { if (isKevin && viewAs) setViewAs(null); }, [isKevin, viewAs]);

  const isManager = data?.role === 'admin';
  // Which sub-view renders. Every remaining value is legal for both roles — the
  // team-only views are gone — but this still normalises anything unexpected
  // (a stale `sub`, an old `initialSub` from a bookmarked hash) back to the
  // overview rather than rendering nothing.
  const REP_VIEWS: RepSub[] = ['overview', 'orders', 'pipeline'];
  const view: RepSub = REP_VIEWS.includes(sub) ? sub : 'overview';
  const reps = data?.reps ?? [];
  const t = data?.teamTotals;
  // ONE scope for this whole page: the PRODUCING REPS, and nothing else.
  //
  // The KPI strip used to read `bookTotals` — the whole order book — so that the
  // headline figures matched Orders & Revenue on sight. That reconciliation cost
  // more than it bought once the non-producers left the roster: the strip said
  // 459 orders while the Commission tile beside it paid on 374, and every drill
  // needed an "Off roster" row to make its rows sum to its own Total.
  //
  // Orders & Revenue still reports the whole book (459). The two pages now
  // answer different questions, which is the honest reading: this one is about
  // the reps. `bookTotals` is still sent and still reconciles server-side.
  const kt = t;

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
          {/* NOT on Kevin's board — see the effect above. */}
          {me?.role === 'admin' && !isKevin && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
              View as
              <select value={viewAs ?? ''} onChange={(e) => setViewAs(e.target.value || null)}
                style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                {/* The unrestricted view, named for the person who owns it.
                    NOTE: this is Crystal Chambers the finance/ops ADMIN — not
                    the rep row of the same name (her demo orders), which is
                    excluded from the roster. And not the rep "Christy", who is
                    a different person with a similar name. Selecting a name
                    below previews that rep's view; the empty value is this. */}
                <option value="">Crystal Chambers (everything)</option>
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

      {/* The .ov-tabs strip (Overview / Roster / By vertical / Rep detail) is
          gone. It switched between four views of ONE dataset, so reading the
          roster meant leaving the figures that framed it; the roster and the
          rep × vertical matrix are now sections of the dashboard, in the order
          you would read them. Nothing was dropped except the switching. */}

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* Filters, verticals, accounts, device types, saved views: the same
          dashboard, reached from the rep side and scoped to the caller. */}
      {view === 'orders' && <OrderDashboard viewAs={viewAs} />}
      {view === 'pipeline' && <div className="section chart-card"><PiPipeline viewAs={viewAs} /></div>}

      {data && view !== 'orders' && view !== 'pipeline' && (
        <>
          {/* A REP LEADS WITH THE LEADERBOARD: their rank is the thing they
              open this page for, and the server sends peer rows (name and order
              count only) so there is a field to rank against.
              This is the purpose-built `Leaderboard`, not the manager's
              `OverviewPanel` — podium, milestones, gap-to-next and a drawer,
              designed against ~380px. A manager keeps OverviewPanel beside
              Units by device; they come here for the book, not for a rank. */}
          {view === 'overview' && !isManager && (
            <Leaderboard reps={reps} viewAs={viewAs} />
          )}

          {/* The house KPI card (KpiExec, shared from chartKit): the same
              component the company Overview renders, so the two dashboards read
              as one product. `sub` carries what the old card's foot strip said;
              `chip` carries the qualifier. Hues come from the shared HUE map, so
              a metric keeps its colour across tabs: revenue is always the brand
              blue, commission always amber. */}
          {/* A rep gets THREE tiles: orders, devices (units), and their own
              commission — the whole of what they are permitted to see. Accounts
              went with Revenue and the rep count: the server nulls it for a
              non-admin now, so the tile would have read "-" regardless.
              A manager keeps FIVE. The grid modifier tracks the count so each
              row still fills exactly. */}
          {/* `kpi-compact` on both: these cards carry no sparkline and no
              month-on-month delta, so the full-size card reserved height for
              things that are never drawn. A manager's five fit ONE line
              (kpi-strip-5 → a 10-column track, span 2); a rep's three ride the
              base span-4 rule, which is already one line. */}
          <div className={`kpi-strip kpi-compact ${isManager ? 'kpi-strip-5' : ''}`}
            style={{ marginBottom: 12, marginTop: isManager ? 0 : 12 }}>
            {isManager && (
              <KpiExec label="Reps" value={t?.reps ?? 0} format={(x: number) => String(x)} hue={HUE.revenue}
                sub="on the commission sheet" chip="team" onClick={() => setDrill('reps')} />
            )}
            <KpiExec label={isManager ? 'Orders' : 'Your orders'} value={kt?.orders ?? 0} format={(x: number) => String(x)} hue={HUE.ar}
              sub="cancelled excluded" chip={isManager ? 'order book' : 'yours'} onClick={() => setDrill('orders')} />
            <KpiExec label={isManager ? 'Devices' : 'Your devices'} value={num(kt?.units)} format={() => n(kt?.units)} hue={HUE.ap}
              sub="units on those orders" chip={isManager ? 'order book' : 'yours'} onClick={() => setDrill('units')} />
            {isManager && (
              <KpiExec label="Accounts" value={num(kt?.accounts)} format={() => n(kt?.accounts)} hue={HUE.sales}
                sub="vendors billed" chip="order book" onClick={() => setDrill('accounts')} />
            )}
            {/* The "Revenue / order value / SMR" tile was removed on request.
                The strip modifier moved 6 → 5 with it: leaving kpi-strip-6 in
                place would have spanned 2 of 12 columns five times and left a
                third of the row empty. */}
            <KpiExec label={isManager ? 'Commission' : 'Your commission'} value={num(t?.commission)} format={money} hue={HUE.po}
              sub="units × device rate" chip={isManager ? 'SMR' : 'yours'} onClick={() => setDrill('commission')} />
          </div>

          {/* MANAGER ONLY — the "minimal dashboard" for a rep is the tiles plus
              the leaderboard, and this deck is neither. It also carried a live
              bug for them: its readout sums `o.revenue`, which the server nulls
              for a rep, so it printed a confident "$0" next to real order and
              unit counts. Its filter bar, device donut and PI funnel are all
              reachable from My Orders and My Pipeline. */}
          {view === 'overview' && isManager && (
            <DashboardOverview reps={reps} viewAs={viewAs}
              aside={<OverviewPanel reps={reps} onPickRep={setSel} />} />
          )}

          {/* MANAGER ONLY. It ranks "top volume" and "top pay" across the
              roster; a rep now holds the only row in that roster, so it would
              crown them leader of a field of one. */}
          {view === 'overview' && isManager && <TeamShape reps={reps} />}

          {/* The Leaderboard used to render here, at the foot. It is now passed
              into DashboardOverview as `aside` so it sits BESIDE Units by
              device. Rendering it in both places would have shown it twice. */}

          {/* Why every figure on this page is lower than Orders & Revenue.
              This used to be a footnote about a tail the KPI strip already
              counted. Now the strip is rep-scoped, it is the ONLY thing that
              explains the difference between the two pages — so it states the
              other page's number rather than leaving the reader to find it. */}
          {data.unattributed && data.unattributed.orders > 0 && (
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14, background: 'var(--panel-2)', borderRadius: 10, padding: '9px 13px' }}>
              Every figure on this page covers the <b style={{ color: C.sub }}>producing reps</b> only. A further{' '}
              <b style={{ color: C.sub }}>{data.unattributed.orders} orders</b> ({formatCurrency(data.unattributed.revenue)}) are
              booked in Striven to house/clinic accounts, ops staff, departed names or nobody at all — so{' '}
              <b style={{ color: C.sub }}>Orders &amp; Revenue reports {data.bookTotals?.orders ?? '—'}</b> against this page's{' '}
              <b style={{ color: C.sub }}>{t?.orders}</b>. Where any excluded name does earn commission it is still paid: see My
              Commission, which reports the full book.
            </div>
          )}

          {/* THE ROSTER — was the "Roster" tab. Manager-only: a rep's payload
              carries peer rows for the leaderboard's ranking, but reduced to a
              name and an order count, so every money column here would be a
              dash for them. Clicking a row still opens that rep's detail, which
              is what the "Rep detail" tab did. */}
          {view === 'overview' && isManager && (
            <div className="section chart-card" style={{ marginBottom: 14 }}>
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
            </div>
          )}

          {/* REP × VERTICAL — was the "By vertical" tab. Manager-only for the
              same reason as the roster above. */}
          {view === 'overview' && isManager && (
            // Plain house card, like every other section on this page. It used
            // to carry a 3px accent rule and a deeper one-off shadow to "read as
            // the subject of the page": but it is the only card in the app
            // dressed that way, and now that it sits among the other sections
            // rather than alone under a tab, it read as a different design
            // rather than an emphasised one.
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

          {/* "Rep detail" was never a page of its own — it rendered a grid of
              rep cards whose only job was to open the modal below. Every rep on
              this dashboard is already clickable (the leaderboard, and every
              roster row), and they open that same modal, so the picker was a
              third way to do what two other lists already did.
              Its rep-side branch was unreachable: 'mine' was not in REP_VIEWS,
              so a rep could never land on it. Their own breakdown opens from
              their leaderboard row. */}
        </>
      )}

      {sel && <RepModal rep={sel} onClose={() => setSel(null)} />}
      {drill && data && (
        <KpiDrill metric={drill} reps={reps} data={data} onClose={() => setDrill(null)} onPickRep={(r) => { setDrill(null); setSel(r); }} />
      )}
    </div>
  );
}

// 'revenue' is GONE from this union, not merely unused: the Revenue tile was
// the only thing that could set it, so leaving the branch would have been a
// drill nothing on the page could open.
type DrillKey = 'reps' | 'orders' | 'units' | 'accounts' | 'verticals' | 'commission';

/**
 * Per-rep breakdown of a tapped headline figure.
 *
 * Money metrics are left BLANK wherever the server withheld the value, so a rep
 * can open Commission and still see the shape of the team by volume without
 * anyone else's pay appearing. Counts are shared, money is not. The footnote
 * below the table says how many rows are withheld.
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

  const MONEY = metric === 'commission';
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
    commission: { title: 'Commission by rep', sub: 'units × per-device rate. Visible only where you are permitted to see it.', col: 'Commission', tint: C.warning },
  };
  const cfg = CFG[metric];
  const valOf = (r: RepRow): number | null =>
    metric === 'commission' ? r.commission
      : metric === 'units' ? r.units
        : metric === 'accounts' ? r.accounts
          : metric === 'verticals' ? r.verticals
            : r.orders;

  const rowsSorted = [...reps].sort((a, b) => (valOf(b) ?? -1) - (valOf(a) ?? -1) || b.orders - a.orders);
  const known = rowsSorted.map(valOf).filter((v): v is number => v != null);

  // Accounts and verticals are DISTINCT counts, not additive quantities. Two
  // reps billing the same law firm are two rows of 1, but one account: so the
  // column sums to more than the book's true total. Say "Sum of rep counts"
  // rather than "Total", and print the real figure underneath.
  //
  // There is no longer an "off roster" row. It existed to carry the gap between
  // the rep rows and a KPI strip that reported the WHOLE book; the strip is
  // rep-scoped now, so the rows already sum to their own Total and the extra
  // line would have double-counted orders this page no longer claims.
  const DISTINCT = metric === 'accounts' || metric === 'verticals';

  const sum = known.reduce((s, v) => s + v, 0);
  const max = Math.max(1, ...known);
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

          {/* Distinct counts still need their explanation: the column sums to
              more than the real figure because reps share payers. This reads
              the REP-SCOPED accounts count now, the same number the KPI shows. */}
          {DISTINCT && metric === 'accounts' && data.teamTotals?.accounts != null && (
            <div style={{ fontSize: 12.5, color: C.sub, background: 'var(--panel-2)', borderRadius: 10, padding: '10px 13px', marginTop: 12 }}>
              The reps bill <b>{data.teamTotals.accounts} distinct accounts</b>. The column above sums to more because reps share
              payers: Veterans Affairs and TriCare are single-payer programmes billed by several reps, so each rep counts them once.
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

  // Only producers are ranked. House/ops/departed names (Crystal's demos, Angel,
  // Cassie, Kinley, Zach) carry orders in Striven but are not competing, and a
  // leaderboard that lists them reads as noise. Their own row still survives if
  // one of them is somehow the viewer, so nobody ever loses sight of their own.
  const ranked = [...(data?.reps ?? [])]
    .filter((r) => !r.standingsExcluded || r.isSelf)
    .sort((a, b) => b.orders - a.orders);
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
 *
 * Rendered for BOTH roles. A rep sees the same ranking a manager does, built
 * from the same peer rows — name, order count and the per-vertical split that
 * draws the bar. No money is on this panel for anybody, so nothing about it
 * needs to differ by role.
 *
 * The "Full roster →" button is gone with the Roster tab it pointed at: on a
 * manager's dashboard the roster table now sits further down the same page, and
 * a rep has no roster to go to.
 */
function OverviewPanel({ reps, onPickRep }: {
  reps: RepRow[]; onPickRep: (r: RepRow) => void;
}) {
  // Only producers are ranked — the same rule (and the same server flag) that
  // getRepOverview applies. This panel used to rank the raw roster, so house,
  // ops and departed names sat on the landing page's leaderboard while the
  // server had already dropped them: two boards, one roster, different answers.
  const ranked = [...reps]
    .filter((r) => !r.standingsExcluded || r.isSelf)
    .sort((a, b) => b.orders - a.orders);
  if (!ranked.length) return null;

  // `own` is the server's word for "this row arrived unredacted" — true on every
  // row for a manager, true only on their own for a rep. Opening a peer's
  // breakdown as a rep would have shown a modal of dashes: name, order count,
  // and a column of nulls where the figures they may not see used to be.
  const canOpen = (r: RepRow) => Boolean(r.own);
  const openableCount = ranked.filter(canOpen).length;
  // The bar scale's denominator: every bar is read against the leader's.
  const leader = ranked[0]?.orders ?? 0;

  return (
    <>
      {/* marginBottom 0: the KPI strip below carries its own top gap, so the
          default card margin was stacking two gaps into one seam. */}
      <div className="section chart-card" style={{ marginBottom: 0 }}>
        <div className="section-head" style={{ minHeight: 0, marginBottom: 6 }}>
          <div>
            <h2 className="section-title" style={{ fontSize: 15 }}>Leaderboard</h2>
            <div className="section-sub">
              {openableCount > 1
                ? 'By orders booked. Click a rep for their full breakdown.'
                : 'By orders booked. Click your own row for your full breakdown.'}
            </div>
          </div>
        </div>
        {/* THE BAR takes the slack, not the name.
            The name column was `minmax(0, 1fr)`, so on a full-width card it
            swallowed every spare pixel and shoved a 132px bar and the order
            count to the far right — the void in the middle of each row. The
            name is now bounded and the mix bar is the flexible column, so a row
            fills its width instead of spanning it. MixBar is normalised to each
            rep's own total, so stretching it changes nothing it means. */}
        <div style={{ display: 'grid', gap: 2, padding: '2px 2px 0' }}>
          {ranked.map((r, i) => (
            <button key={r.rep} className="lb-row" onClick={canOpen(r) ? () => onPickRep(r) : undefined}
              disabled={!canOpen(r)}
              title={canOpen(r) ? `${r.rep}'s full breakdown` : `${r.rep}'s figures are confidential to them`}
              style={{
                display: 'grid', gridTemplateColumns: '18px minmax(80px, 170px) minmax(0, 1fr) 84px',
                gap: 10, alignItems: 'center',
                textAlign: 'left', cursor: canOpen(r) ? 'pointer' : 'default', width: '100%',
                background: r.isSelf ? 'var(--panel-2)' : 'transparent',
                border: `1px solid ${r.isSelf ? `${C.brand}44` : 'transparent'}`,
                borderRadius: 8, padding: '4px 8px',
                // A disabled button greys its text by default; these rows are
                // not unavailable, only unopenable, and must stay fully legible.
                opacity: 1, color: 'inherit',
              }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: i === 0 ? C.ink : C.muted, fontVariantNumeric: 'tabular-nums' }}>
                {i === 0 ? '🥇' : i + 1}
              </span>
              <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.brand, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rep}</span>
                {r.isSelf && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.positive }}>You</span>}
              </span>
              <MixBar parts={r.byVertical} total={r.orders} height={8} scale={leader ? r.orders / leader : 0} />
              {/* Orders only. The money column that sat here is gone: this
                  board ranks by volume, and the figure was each rep's own
                  commission — available in full on My Commission and on the
                  rep's own drill-down, so nothing is lost by dropping it. The
                  share-of-leader percentage went too; the bar already carries
                  the comparison, and rank says who is ahead. */}
              <span style={{ fontSize: 11.5, color: C.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', textAlign: 'right' }}>
                <b style={{ color: C.ink, fontSize: 13 }}>{r.orders}</b> orders
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * One rep's split across verticals, by order count.
 *
 * `height` defaults to the 9px the roster and rep-detail tables use; the
 * leaderboard passes a thinner bar so its rows stay on one line.
 *
 * `scale` (0-1) is how much of the TRACK this rep's bar fills. It defaults to 1,
 * which is the right answer inside a table row where the bar only has to show a
 * mix. On the leaderboard it is the rep's share of the leader's orders — without
 * it every bar ran the full width, because the segments are normalised to each
 * rep's OWN total, and four reps on 166 / 99 / 72 / 39 orders drew four
 * identical bars. The rank number was doing all the work.
 */
function MixBar({ parts, total, height = 9, scale = 1 }: {
  parts: RepVertical[]; total: number; height?: number; scale?: number;
}) {
  const shown = parts.filter((p) => p.orders > 0);
  if (!shown.length || !total) return <div style={{ height, borderRadius: 999, background: 'var(--panel-2)' }} />;
  const pct = Math.max(0, Math.min(1, scale)) * 100;
  return (
    <div title={`${total} order${total === 1 ? '' : 's'} · ${shown.map((p) => `${p.vertical}: ${p.orders}`).join(' · ')}`}
      style={{ height, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
      {/* Outer track is the leader's length; this fill is this rep's share of
          it, and the segments inside divide THAT by vertical. */}
      <div className="mix-fill" style={{ display: 'flex', height: '100%', width: `${pct}%`, borderRadius: 999, overflow: 'hidden', transition: 'width .35s cubic-bezier(.22,.75,.3,1), filter .15s ease' }}>
        {shown.map((p) => (
          <div key={p.vertical} style={{ width: `${(p.orders / total) * 100}%`, background: V_C[p.vertical] || C.muted }} />
        ))}
      </div>
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
        {/* The "reconciled against the sheet" badge is gone with the sheet feed:
            Striven is the only source, so there is nothing to reconcile against
            and every figure here IS the computation. */}
      </div>
    </div>
  );
}

// Another rep's money: left BLANK.
//
// This used to render a "CONFIDENTIAL" pill — the absence was named so it read
// as a policy rather than as missing data. It is a blank cell now, on request.
// The footnote under each table still says whose figures are withheld and why,
// so the reason survives even though the marker does not.
//
// Kept as a component rather than deleted: it marks every place the server
// withheld a value, so the rule stays greppable and there is one thing to
// change if the pill is ever wanted back.
function Confidential() {
  return null;
}

function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tint || C.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ManagerRepPicker lived here: the body of the "Rep detail" tab, a grid of rep
// cards whose only action was to open RepModal. The leaderboard and the roster
// table already do that, so it went with the tab.

// One rep in full. Used inline for a rep's own view, and in a modal from the
// team table.
function RepDetail({ rep, inline = false }: { rep: RepRow; inline?: boolean }) {
  const totalOrders = rep.byVertical.reduce((s, v) => s + v.orders, 0) || 1;
  // Revenue and Accounts are DROPPED, not shown empty. The server withholds
  // both from a rep, so these rendered as a "-" tile and a column of
  // CONFIDENTIAL chips — furniture announcing a figure the reader will never be
  // given. Driven off the payload rather than a role flag, so a manager (who is
  // sent the figures) still gets both.
  const showRevenue = rep.revenue != null;
  const showAccounts = rep.accounts != null;
  const showVertRevenue = rep.byVertical.some((v) => v.revenue != null);
  const cols = (n: number) => ({ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: 10 } as const);
  const body = (
    <>
      <div className="cm-stat-grid" style={{ ...cols(showRevenue ? 4 : 3), marginBottom: 16 }}>
        <Stat label="Commission" value={money(rep.commission)} tint={C.brand} />
        <Stat label="Payable / due" value={money(rep.payable)} tint={C.positive} />
        <Stat label="Waiting" value={money(rep.waiting)} tint={C.warning} />
        {showRevenue && <Stat label="Revenue" value={money(rep.revenue)} />}
      </div>

      <div className="cm-stat-grid" style={{ ...cols(showAccounts ? 4 : 3), marginBottom: 18 }}>
        <Stat label="Orders" value={String(rep.orders)} />
        <Stat label="Devices" value={n(rep.units)} />
        {showAccounts && <Stat label="Accounts" value={n(rep.accounts)} />}
        <Stat label="Device types" value={n(rep.devices)} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
      <table className="data-table">
        <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Devices</th>{showVertRevenue && <th className="num">Revenue</th>}<th className="num">Share of orders</th><th style={{ width: '24%' }} /></tr></thead>
        <tbody>
          {rep.byVertical.map((v) => (
            <tr key={v.vertical}>
              <td style={{ fontWeight: 700, color: V_C[v.vertical] }}>
                <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: V_C[v.vertical], marginRight: 8 }} />
                {v.vertical}
              </td>
              <td className="num" style={{ fontWeight: 700 }}>{v.orders || '-'}</td>
              <td className="num">{n(v.units)}</td>
              {showVertRevenue && (
                <td className="num" style={{ fontWeight: 800 }}>{v.revenue != null ? (v.revenue ? formatCurrency(v.revenue) : '-') : <Confidential />}</td>
              )}
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
            {/* The accounts clause is dropped when there is no figure. It read
                "98 orders · 206 devices · accounts" for a rep, because a null
                renders as nothing and left its own label stranded. */}
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {rep.orders} orders · {rep.units} devices
              {rep.accounts != null && ` · ${rep.accounts} accounts`}
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
