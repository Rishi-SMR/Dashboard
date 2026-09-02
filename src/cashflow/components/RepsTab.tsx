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
import { Portal } from './Portal';
import { StatStrip } from './StatStrip';
import { MonthOverMonth } from './MonthOverMonth';
import { BusinessGrowth } from './BusinessGrowth';
import { ALL_TIME, MonthSelect, monthLabel, defaultMonth } from './MonthSelect';

const money = (v: number | null | undefined) => (v == null ? '-' : formatCurrency(v));
/**
 * COMMISSION AND PAY, to the cent.
 *
 * A second formatter rather than switching `money` outright, because this page
 * carries two kinds of dollar and only one of them needs cents. Revenue is a
 * board figure — a scale, where ".00" is noise. Commission, Payable and Waiting
 * are what a rep is PAID, they are checked against Crystal's reconciliation
 * sheet line by line, and the rates are not whole dollars (369.78 for a TriCare
 * fallback; $2,489.86 signed off in Maylon's workbook), so rounding them loses
 * real money from a column that is meant to add up.
 *
 * Matches the Commission tab exactly, which matters more than it looks: the
 * pay figures here are cut by the same payout cycle that tab reports, so the
 * two screens show the same number for the same month — and one of them
 * rounding would have made the same number look like two.
 */
const pay = (v: number | null | undefined) => (v == null ? '-' : formatCurrency(v, true));
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
type RepSub = 'overview' | 'orders' | 'pipeline' | 'vapipeline';
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

  // THE PERIOD, HELD HERE rather than inside the panel that renders the control.
  // Two panels answer to it — the leaderboard tile and The team table — and a
  // selector that silently governed only its own card would leave the two
  // disagreeing on screen about the same month. (The Rep × vertical table was
  // the third; it has been removed, and its picker with it.)
  //
  // Set from the payload's month list once it arrives (see the effect below):
  // the default is the CURRENT month, and it cannot be chosen before the list
  // that says which months exist has loaded.
  const [month, setMonth] = useState<string>(ALL_TIME);
  useEffect(() => {
    const list = data?.months ?? [];
    if (!list.length) return;
    // Current month, or the newest month with anything in it — see defaultMonth.
    setMonth(defaultMonth(list));
  }, [data?.months]);

  const isManager = data?.role === 'admin';
  // Which sub-view renders. Every remaining value is legal for both roles — the
  // team-only views are gone — but this still normalises anything unexpected
  // (a stale `sub`, an old `initialSub` from a bookmarked hash) back to the
  // overview rather than rendering nothing.
  const REP_VIEWS: RepSub[] = ['overview', 'orders', 'pipeline', 'vapipeline'];
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
      {/* Same component, the VA programme. One implementation for every board:
          the stages come from the server, so the two pages cannot drift. */}
      {view === 'vapipeline' && <div className="section chart-card"><PiPipeline viewAs={viewAs} kind="VA" /></div>}

      {data && view !== 'orders' && view !== 'pipeline' && view !== 'vapipeline' && (
        <>
          {/* A REP LEADS WITH THE LEADERBOARD: their rank is the thing they
              open this page for, and the server sends peer rows (name and order
              count only) so there is a field to rank against.
              This is the purpose-built `Leaderboard`, not the manager's
              `OverviewPanel` — podium, milestones, gap-to-next and a drawer,
              designed against ~380px. A manager keeps OverviewPanel beside
              Units by device; they come here for the book, not for a rank. */}
          {view === 'overview' && !isManager && (
            <Leaderboard reps={reps} months={data.months} viewAs={viewAs} boardScoped={data.boardScoped} />
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

          {/* WHICH WAY THEY ARE MOVING — directly under the tiles that say how
              much, because that is the question the tiles leave open. Every
              other figure on this landing page is a level: a rank, a count, a
              running total. None of them can tell a rep whether this month is
              better than the last one, which is the first thing they look for.

              SCOPED TO THE LOGIN. A rep gets THEIR OWN row and nothing else —
              `isSelf` is the server's mark for "this row arrived unredacted for
              this caller", so the card cannot draw a peer's pay even by
              accident. A manager gets `teamByMonth` for the counts and the
              roster for the pay line, because teamByMonth carries revenue and
              no commission (see the note in the component).

              NOTE FOR ANYONE DEBUGGING A BLANK CARD: `isSelf` is false on every
              row when the login's directory `repName` does not match the roster
              spelling exactly, and this card then has no source and renders
              nothing. That is a DIRECTORY fault, not a fault here — the same
              mismatch zeroes the KPI tiles above it. See REP_NAMES. */}
          {view === 'overview' && (
            <MonthOverMonth
              months={data.months ?? []}
              rep={isManager ? null : (reps.find((r) => r.isSelf) ?? null)}
              team={isManager ? data.teamByMonth : undefined}
              reps={isManager ? reps : undefined} />
          )}

          {/* THE COMPANY'S OWN LINE, under the per-rep one. Reps growth
              above draws orders, devices and commission — volume and the cost of
              selling it — and a month can book more orders while billing less,
              so neither of those is the business's trajectory. This is revenue
              booked per month, on the same order-date basis as the counts.

              IT READS THE P&L, NOT THIS PAYLOAD, and fetches it itself: net
              margin only means anything when revenue and profit are cut from the
              same statement, and `teamByMonth` carries the ORDER BOOK's revenue
              with no cost at all. The card says which book it is on.

              MANAGER ONLY: the P&L endpoints are company-wide and the server
              refuses them to a rep. */}
          {view === 'overview' && isManager && <BusinessGrowth />}

          {/* MANAGER ONLY — the "minimal dashboard" for a rep is the tiles plus
              the leaderboard, and this deck is neither. It also carried a live
              bug for them: its readout sums `o.revenue`, which the server nulls
              for a rep, so it printed a confident "$0" next to real order and
              unit counts. Its filter bar, device donut and PI funnel are all
              reachable from My Orders and My Pipeline. */}
          {view === 'overview' && isManager && (
            <DashboardOverview reps={reps} viewAs={viewAs}
              aside={<OverviewPanel reps={reps} months={data.months} month={month} onMonth={setMonth} onPickRep={setSel} />} />
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
              {/* THE SAME `month` the Rep × vertical card and the leaderboard
                  tile answer to — see where it is declared. A third selector
                  with its own state would let two tables on one page show
                  different months while both said "the team". */}
              <div className="section-head">
                <div>
                  <h2 className="section-title">The team</h2>
                  <div className="section-sub">
                    {isManager
                      ? 'Every rep in full. Click a row for their vertical breakdown.'
                      : 'Your row is shown in full. For everyone else you can see how much they booked, but not what they earned.'}
                    {/* THE TWO BASES, STATED. Order columns are cut by the
                        order's own date; pay is cut by the payout cycle, which
                        is what the business settles on and what the Commission
                        tab reports — so the two pages show the same figure for
                        the same month. Naming both is the price of that. */}
                    {' '}{month === ALL_TIME
                      ? 'Showing the whole book.'
                      : <>Showing <b>{monthLabel(month)}</b> — orders by order date, pay by payout cycle (matching Commission).</>}
                  </div>
                </div>
                <MonthSelect months={data.months ?? []} month={month} onMonth={setMonth}
                  title="Read the team one month at a time, or over the whole book" />
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th style={{ width: 34 }}>#</th><th>Rep</th>
                    <th className="num">Orders</th><th className="num">Devices</th><th className="num" title="Distinct vendors billed. VA and TriCare are single-vendor programmes, so a rep working one of them shows one account however many orders they book.">Accounts</th>
                    <th className="num">Revenue</th><th className="num">Payable</th><th className="num">Waiting</th>
                    <th className="num">Commission</th><th style={{ width: '16%' }}>Orders by vertical</th>
                  </tr></thead>
                  <tbody>
                    {reps.length === 0 && <tr><td colSpan={10} style={{ color: C.muted }}>No reps.</td></tr>}
                    {/* NESTED, exactly as on the leaderboard tile: Jillian is
                        drawn on the line under Alle rather than wherever the
                        roster's own order puts her, so the one relationship in
                        the team reads the same way on both surfaces. `#` stays
                        the rep's own position — see nestSubReps. */}
                    {nestSubReps(reps).map(({ r, rank, nested }) => {
                      // EVERY FIGURE ON THE ROW COMES FROM ONE PROJECTION, so a
                      // month's orders can never sit beside an all-time dollar.
                      // repInPeriod passes the row straight through on All time.
                      const p = repInPeriod(r, month);
                      return (
                      <tr key={r.rep} className={nested ? 'tr-nested' : undefined} onClick={() => setSel(r)} style={{ cursor: 'pointer', background: r.isSelf ? 'var(--panel-2)' : undefined, borderLeft: r.isSelf ? `3px solid ${C.brand}` : '3px solid transparent' }}
                        title={[
                          r.own ? `Full detail for ${r.rep}` : `${r.rep}'s volume: their pay is confidential`,
                          r.subRepOf ? `Sub-rep of ${r.subRepOf} — SMR pays ${r.subRepOf}, who pays ${r.rep}` : '',
                        ].filter(Boolean).join(' · ')}>
                        {/* Blank on a nested row, for the reason spelled out on
                            the board tile's rank cell: she is drawn under Alle
                            rather than in the standings, so there is no position
                            here to state. */}
                        <td style={{ color: C.muted }}>{nested ? '' : rank}</td>
                        <td className="rep-cell" style={{ fontWeight: 700, color: C.brand }}>
                          {/* The tie, in the indent — the table's version of the
                              elbow the board tile draws. Only where the row was
                              actually nested: a sub-rep whose supervisor is not
                              in the list has no line above to point at. */}
                          {nested && <span className="lb-tie" aria-hidden="true" />}
                          {r.rep}
                          {r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                          {/* THE REPORTING LINE, in the one table that lists the
                              whole team. It is the reason this table needed it:
                              a manager reading ten rows of Rep / Orders / Pay
                              has no way to tell that two of those rows are one
                              pay chain — SMR settles Jillian's commission with
                              Alle, who settles with Jillian — and the leaderboard
                              tile beside it cannot say so for a rep who happens
                              to be scrolled past. `is-wide` takes the plated form
                              because a table cell has the room the tile does not.

                              Server-gated exactly as the tile's is: `subRepOf`
                              only ever arrives on the supervisor's own payload
                              and an admin's. */}
                          {r.subRepOf && (
                            <div className="lb-subline" title={`SMR pays ${r.subRepOf}, who pays ${r.rep}`}>
                              <span className="lb-subline-el" aria-hidden="true" />
                              Sub-rep of <b>{r.subRepOf}</b>
                            </div>
                          )}
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>{p.orders}</td>
                        <td className="num">{n(p.units)}</td>
                        <td className="num">{n(p.accounts)}</td>
                        <td className="num">{r.own ? money(p.revenue) : <Confidential />}</td>
                        {/* The three money columns are the PAYOUT CYCLE's, so
                            they read the same here as on the Commission tab. */}
                        <td className="num" style={{ color: r.own ? C.positive : undefined, fontWeight: 700 }}>{r.own ? pay(p.payable) : <Confidential />}</td>
                        <td className="num" style={{ color: r.own ? C.warning : undefined, fontWeight: 700 }}>{r.own ? pay(p.waiting) : <Confidential />}</td>
                        <td className="num" style={{ fontWeight: 800 }}>{r.own ? pay(p.earned) : <Confidential />}</td>
                        {/* The COUNT per vertical, not a bar. Still the thing a
                            revenue bar could not be — it works whether or not
                            this row's money is visible — but it now answers
                            "how many in each" instead of leaving the reader to
                            estimate it off a segment width. */}
                        <td><VerticalCounts parts={p.byVertical} total={p.orders} /></td>
                      </tr>
                      );
                    })}
                  </tbody>
                  {/* THE FOOTER FOLLOWS THE PERIOD TOO, or the rows would sum to
                      something the total contradicts.
                      ACCOUNTS COMES FROM THE SERVER, not from adding the column
                      above it: a distinct payer count cannot be summed across
                      reps — two of them billing one law firm are one payer, and
                      the rendered rows add to 60 against a true 57. Money and
                      counts are re-summed here from the rows on screen. */}
                  {(() => {
                    const scoped = month !== ALL_TIME;
                    const tm = scoped ? (data.teamByMonth ?? []).find((x) => x.month === month) : null;
                    const proj = reps.map((r) => repInPeriod(r, month));
                    const sum = (pick: (p: ReturnType<typeof repInPeriod>) => number | null | undefined) =>
                      proj.reduce((s, p) => s + (Number(pick(p)) || 0), 0);
                    return (
                      <tfoot><tr className="total-row">
                        <td /><td>{isManager ? 'All reps' : 'Team'}</td>
                        <td className="num">{scoped ? (tm?.orders ?? 0) : t?.orders}</td>
                        <td className="num">{scoped ? n(tm?.units ?? 0) : n(t?.units)}</td>
                        <td className="num">{scoped ? n(tm?.accounts ?? 0) : n(t?.accounts)}</td>
                        <td className="num" style={{ fontWeight: 800 }}>{money(scoped ? (tm?.revenue ?? 0) : t?.revenue)}</td>
                        {/* THE FOOTER FOLLOWS THE ROWS. These three sum columns
                            that now print cents; rounding the total while the
                            rows above it carry decimals is the one way to make
                            a correct column look wrong — it can be out by up to
                            half a dollar per row with nothing on screen to say
                            why. Revenue beside them keeps whole dollars,
                            because its rows do. */}
                        <td className="num" style={{ color: C.positive, fontWeight: 700 }}>{pay(sum((p) => p.payable))}</td>
                        <td className="num" style={{ color: C.warning, fontWeight: 700 }}>{pay(sum((p) => p.waiting))}</td>
                        <td className="num" style={{ fontWeight: 800 }}>{pay(scoped ? sum((p) => p.earned) : t?.commission)}</td><td />
                      </tr></tfoot>
                    );
                  })()}
                </table>
              </div>
              {/* The "a further $X belongs to no month" note is GONE, and that
                  is the point of the change above rather than an oversight. It
                  existed because commission was cut by the sales order's date
                  and 127 signed-off lines tie to no live order, so that money
                  fell out of every period. Payout cycles have no such hole —
                  every line settles in some run — so the months now sum to the
                  All time figure and there is nothing left to warn about. */}
            </div>
          )}

          {/* REP × VERTICAL lived here — the rep-by-vertical matrix with its
              own Period picker. Removed on request. Nothing it showed is lost:
              the orders-per-vertical breakdown is the "Orders by vertical"
              column on The team above, that table now answers to the same
              period selector, and the undated-commission note moved with it. */}

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

      {/* THE SUB-REPS GO IN WITH THE REP. A supervisor's row on the drill carries
          their sub-reps' volume folded in, so the detail behind it has to be able
          to say which part is whose — otherwise the reader clicks 316 and is
          shown 213 with nothing accounting for the difference. */}
      {sel && (
        <RepModal
          rep={sel}
          subs={reps.filter((r) => String(r.subRepOf ?? '').trim().toLowerCase() === sel.rep.trim().toLowerCase())}
          onPickRep={setSel}
          onClose={() => setSel(null)} />
      )}
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

  /**
   * WHICH SUPERVISORS ARE UNFOLDED.
   *
   * A sub-rep is FOLDED INTO their supervisor by default and the supervisor's
   * figure carries both: SMR pays Maylon, who pays David/Dino, so "Maylon's
   * volume" as the business reads it is the pair's. Unfolding splits them —
   * the supervisor drops to their own figure and the sub-rep stands under it —
   * which is the question the fold exists to answer: how much of that total is
   * whose.
   *
   * FOLDED UNTIL CLICKED, on instruction. This drill is read as a ranking, and
   * a ranking has to be of comparable things: a sub-rep listed beside the rep
   * who is paid for their book puts the same volume on the board twice, once
   * under each name, and pushes every rep below them down a place. Folded,
   * every row is one payee. Splitting them is the deliberate act.
   *
   * IT WAS OPEN BY DEFAULT BEFORE, so that nobody arriving to look up a rep
   * found them missing from the list. The row answers that without being
   * unfolded: the caret sits on it, its title names who is inside, and the row
   * itself says "incl. …" for as long as they are.
   *
   * THE STATE HOLDS WHAT IS OPEN, not what is folded, and that is deliberate: a
   * set seeded with "every supervisor" would have to be built from `reps` at
   * mount, and this dialog can mount before the payload lands — which would
   * seed it empty and quietly unfold the very rows the default exists to
   * collapse. An empty set means everything is folded, whatever arrives later.
   */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (rep: string) => setOpened((prev) => {
    const next = new Set(prev);
    if (next.has(rep)) next.delete(rep); else next.add(rep);
    return next;
  });

  const MONEY = metric === 'commission';
  const CFG: Record<DrillKey, { title: string; sub: string; col: string; tint: string }> = {
    // COUNTED, NOT SPELLED OUT. It said "the four names" and the roster is
    // seven; a hard-coded count is a caption that goes stale the day someone is
    // hired.
    reps: { title: 'Reps', sub: `The ${reps.length} names on the commission sheet, by order volume. A sub-rep is folded into the rep who pays them — open the caret to split them out.`, col: 'Orders', tint: C.brand },
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

  const keyOf = (n: string | null | undefined) => String(n ?? '').trim().toLowerCase();
  const present = new Set(reps.map((r) => keyOf(r.rep)));
  /** The rows folded into this one — only where the supervisor is on screen. */
  const subsOf = (boss: RepRow) => reps.filter((x) => x.subRepOf && keyOf(x.subRepOf) === keyOf(boss.rep));
  /**
   * A supervisor's figure WITH their sub-reps in it.
   *
   * Null stays null: a withheld figure cannot be added to, and printing the
   * sub-rep's number alone under the supervisor's name would attribute it to
   * the wrong person. A withheld SUB adds nothing rather than voiding the
   * total — the supervisor's own figure is still true, and the footnote below
   * already says some rows are confidential.
   */
  const rolled = (r: RepRow): number | null => {
    const own = valOf(r);
    if (own == null) return null;
    return subsOf(r).reduce((sum, x) => sum + (valOf(x) ?? 0), own);
  };
  /**
   * RANKED ON THE ROLLED-UP FIGURE, whether or not the row is unfolded. Ranking
   * on whichever number happens to be displayed would make rows jump places as
   * the reader opens and closes them, which is a list reordering itself under
   * the cursor for no reason the reader caused.
   */
  const rowsSorted = [...reps]
    .filter((r) => !(r.subRepOf && present.has(keyOf(r.subRepOf))))
    .sort((a, b) => (rolled(b) ?? -1) - (rolled(a) ?? -1) || b.orders - a.orders);
  // The TOTAL is over every row, folded or not: the fold changes how the book is
  // grouped on screen, never how big it is.
  const known = reps.map(valOf).filter((v): v is number => v != null);

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
  // Bars are scaled to the largest figure ON SCREEN, so the longest bar is the
  // row a reader can actually see rather than one hidden inside a fold.
  const shown = rowsSorted.map((r) => (opened.has(r.rep) ? valOf(r) : rolled(r)))
    .filter((v): v is number => v != null);
  const max = Math.max(1, ...shown);
  const withheld = reps.filter((r) => valOf(r) == null).length;
  const fmt = (v: number | null) => (v == null ? null : MONEY ? formatCurrency(v) : String(v));

  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      {/* 620, down from 720. Four reps across five columns, three of them
          `.num` and so collapsed to their content — the slack all landed
          between the names and the figures. */}
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(620px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${cfg.tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{cfg.title}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{cfg.sub}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>
                <th style={{ width: 34 }}>#</th><th>Rep</th>
                <th className="num">{cfg.col}</th><th className="num">Share</th><th style={{ width: '32%' }} />
              </tr></thead>
              <tbody>
                {/* NESTED, exactly as on the leaderboard tile and The team
                    table: Jillian is drawn under Alle and out of the numbering,
                    so the one relationship in the roster reads the same way
                    wherever this admin meets it. It matters most HERE, in fact —
                    this drill sorts on the tapped metric, and on devices Jillian
                    (215) outranks Alle (186), so the flat list handed her a 1st
                    place over the rep SMR actually pays for her book. Ranking is
                    unchanged for everyone else: `subRepOf` only arrives on the
                    supervisor's payload and an admin's. */}
                {rowsSorted.flatMap((parent, i) => {
                  const subs = subsOf(parent);
                  const open = opened.has(parent.rep);
                  // Collapsed, the supervisor's row carries the pair. Unfolded,
                  // it carries its own and the sub-rep stands underneath.
                  const rows: { r: RepRow; rank: number; nested: boolean; v: number | null; subs: RepRow[]; open: boolean }[] = [
                    { r: parent, rank: i + 1, nested: false, v: open ? valOf(parent) : rolled(parent), subs, open },
                  ];
                  if (open) for (const sub of subs) rows.push({ r: sub, rank: 0, nested: true, v: valOf(sub), subs: [], open: false });
                  return rows;
                }).map(({ r, rank, nested, v, subs, open }) => {
                  return (
                    <tr key={r.rep} className={nested ? 'tr-nested' : undefined} onClick={() => onPickRep(r)} style={{ cursor: 'pointer', background: r.isSelf ? 'var(--panel-2)' : undefined }}
                      title={[
                        `Open ${r.rep}'s detail`,
                        r.subRepOf ? `Sub-rep of ${r.subRepOf} — SMR pays ${r.subRepOf}, who pays ${r.rep}` : '',
                      ].filter(Boolean).join(' · ')}>
                      <td style={{ color: C.muted }}>{nested ? '' : rank}</td>
                      <td className="rep-cell" style={{ fontWeight: 700, color: C.brand }}>
                        {nested && <span className="lb-tie" aria-hidden="true" />}
                        {/* THE FOLD IS ITS OWN CONTROL. The row already opens the
                            rep's breakdown, so unfolding cannot be the row's job
                            — one target, two meanings. A caret beside the name
                            takes the click and stops it there. */}
                        {subs.length > 0 && (
                          <button type="button" className="rep-fold" aria-expanded={open}
                            title={open ? `Fold ${subs.map((x) => x.rep).join(', ')} back in` : `Show ${subs.length} sub-rep${subs.length === 1 ? '' : 's'} separately`}
                            onClick={(e) => { e.stopPropagation(); toggle(r.rep); }}>
                            {open ? '▾' : '▸'}
                          </button>
                        )}
                        {r.rep}{r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.positive }}>you</span>}
                        {/* A FIGURE THAT INCLUDES SOMEBODY ELSE SAYS SO. Folded,
                            this row is two people's work under one name; silently
                            is exactly how a number stops being trusted. */}
                        {subs.length > 0 && !open && (
                          <div className="lb-subline" title={`Includes ${subs.map((x) => x.rep).join(', ')} — click the caret to split them out`}>
                            <span className="lb-subline-el" aria-hidden="true" />
                            incl. {subs.map((x) => x.rep).join(', ')}
                          </div>
                        )}
                        {r.subRepOf && (
                          <div className="lb-subline" title={`SMR pays ${r.subRepOf}, who pays ${r.rep}`}>
                            <span className="lb-subline-el" aria-hidden="true" />
                            Sub-rep of <b>{r.subRepOf}</b>
                          </div>
                        )}
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
          </div>

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
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            Click any row for that rep's full breakdown{rowsSorted.some((r) => subsOf(r).length > 0) ? ', or the caret to unfold a sub-rep' : ''}.
          </div>
        </div>
      </div>
    </div>
    </Portal>
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
  // Kinley, Zach) carry orders in Striven but are not competing, and a
  // leaderboard that lists them reads as noise. Their own row still survives if
  // one of them is somehow the viewer, so nobody ever loses sight of their own.
  //
  // Cassie is not among them and needs no filter here: EXCLUDED_REPS drops her
  // server-side, so she never reaches `data.reps` in the first place.
  const ranked = [...(data?.reps ?? [])]
    .filter((r) => !r.standingsExcluded || r.isSelf)
    .sort((a, b) => b.orders - a.orders);
  const leader = ranked[0]?.orders ?? 0;
  const mine = ranked.find((r) => r.isSelf) ?? null;
  // Nested here too, so one relationship is drawn one way wherever it appears.
  // On every rep's login but the supervisor's this is `ranked` untouched.
  const rows = nestSubReps(ranked);
  // OFF `rows`, not off an index into `ranked` — a nested row holds no place, so
  // the viewer's own number and the size of the field it is out of both have to
  // come from the list that was actually numbered, or the stat would disagree
  // with the table three inches below it.
  const standing = rows.filter((x) => !x.nested).length;
  const myRank = mine ? (rows.find((x) => x.r.isSelf)?.rank ?? null) : null;
  const gap = mine ? leader - mine.orders : 0;
  const medal = (rank: number) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '');

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
            <Stat label="Your rank" value={`#${myRank} of ${standing}`} tint={C.brand} />
            <Stat label="Your orders" value={String(mine.orders)} />
            <Stat label={myRank === 1 ? 'Lead over 2nd' : 'Behind the leader'}
              value={myRank === 1 ? `+${mine.orders - (ranked[1]?.orders ?? 0)}` : `${gap} order${gap === 1 ? '' : 's'}`}
              tint={myRank === 1 ? C.positive : C.warning} />
            <Stat label="Your commission" value={pay(mine.commission)} tint={C.positive} />
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
              {rows.length === 0 && !loading && <tr><td colSpan={4} style={{ color: C.muted }}>No reps yet.</td></tr>}
              {rows.map(({ r, rank, nested }) => (
                <tr key={r.rep} className={nested ? 'tr-nested' : undefined} style={{ background: r.isSelf ? 'var(--panel-2)' : undefined, borderLeft: r.isSelf ? `3px solid ${C.brand}` : '3px solid transparent' }}
                  title={r.subRepOf ? `Sub-rep of ${r.subRepOf} — SMR pays ${r.subRepOf}, who pays ${r.rep}` : undefined}>
                  {/* Blank on a nested row — and no medal either: a 🥉 beside a
                      rep who is not standing in the ranking would be handing out
                      a place the numbering has just taken away. */}
                  <td style={{ fontWeight: 800, color: !nested && rank <= 3 ? C.ink : C.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {nested ? '' : <>{medal(rank)} {rank}</>}
                  </td>
                  <td className="rep-cell" style={{ fontWeight: 700, color: r.isSelf ? C.brand : C.ink }}>
                    {nested && <span className="lb-tie" aria-hidden="true" />}
                    {r.rep}
                    {r.isSelf && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.positive }}>You</span>}
                    {r.subRepOf && (
                      <div className="lb-subline" title={`SMR pays ${r.subRepOf}, who pays ${r.rep}`}>
                        <span className="lb-subline-el" aria-hidden="true" />
                        Sub-rep of <b>{r.subRepOf}</b>
                      </div>
                    )}
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
/** A row as it is DRAWN. `rank` is the position it holds ON THE BOARD, and is 0
 *  on a nested row — see nestSubReps for why a sub-rep holds none. */
type NestedRow = { r: RepRow; rank: number; nested: boolean };

/**
 * PUTS EACH SUB-REP DIRECTLY UNDER THE REP THEY WORK FOR, AND OUT OF THE
 * RANKING.
 *
 * Jillian used to land wherever her order count put her, with a note saying she
 * works under Alle. On the current book that happened to be the very next line,
 * which made the note look redundant; in any month where Christy outbooks her it
 * would have been three rows away, and the relationship then lived entirely in a
 * caption the eye had to carry down the list. Nesting says it structurally — the
 * row is indented, tied to the line above it, and cannot drift away from it
 * however the month reshuffles the board.
 *
 * THE BOARD IS THEN NUMBERED OVER WHAT IS LEFT STANDING ON IT. A nested row
 * carries no rank at all (0, which the renderers draw as a blank cell), and the
 * reps above and below it close up: Alle 1, Jillian nested, Christy 2. The
 * alternative — keeping Jillian's own 2 and leaving a hole where she used to
 * stand — was tried first and is the more literal reading of the volumes, since
 * she books 102 against Christy's 72. It was dropped by instruction, and the
 * reasoning is sound: a rank is a position IN A LIST, and Jillian is no longer
 * in this one. Numbering around a row that has been lifted out of the sequence
 * leaves a gap that reads as a missing rep rather than as a deliberate absence.
 *
 * WHAT THIS COSTS, so it is not rediscovered as a bug: the numbers no longer
 * answer "who booked the most" across the whole team — they answer it across the
 * reps SMR pays directly. Christy's 2 sits above Jillian's 102 orders on the
 * same screen. That is legible precisely because the two rows are adjacent and
 * the nested one is visibly not competing; it would not be if the nesting were
 * ever dropped while this numbering stayed.
 *
 * WHAT IS NOT TOUCHED: every figure. Jillian keeps her own orders, her own bar,
 * her own share of the total, and nothing rolls up into Alle. Order and
 * numbering are the whole of what this function does.
 *
 * `subRepOf` only ever arrives on the supervisor's payload and an admin's, so on
 * every other rep's login this returns the list exactly as it was given, ranked
 * 1..n as before.
 *
 * A sub-rep whose supervisor is NOT on the board KEEPS a real rank — Alle books
 * nothing in a month and drops off it, and a Jillian nested under a row that is
 * not there would be a branch with no trunk. She stands in the list in that
 * case, so she is numbered like anyone else standing in it.
 */
function nestSubReps(ranked: RepRow[]): NestedRow[] {
  const key = (n: string | null | undefined) => String(n ?? '').trim().toLowerCase();
  const present = new Set(ranked.map((r) => key(r.rep)));
  const nestedUnder = (boss: RepRow) => ranked
    .filter((x) => key(x.subRepOf) === key(boss.rep))
    .map((r) => ({ r, rank: 0, nested: true }));
  const out: NestedRow[] = [];
  // Counts only the rows that end up standing, which is what makes the sequence
  // consecutive: it advances where a row is pushed, not where one is read.
  let place = 0;
  for (const r of ranked) {
    // Skip it where it fell — it is emitted below its supervisor instead, and
    // takes no number with it.
    if (r.subRepOf && present.has(key(r.subRepOf))) continue;
    out.push({ r, rank: ++place, nested: false });
    out.push(...nestedUnder(r));
  }
  return out;
}

/**
 * One rep's figures AS THEY READ IN THE SELECTED PERIOD.
 *
 * The whole point is that callers stay period-agnostic: they ask for orders,
 * a vertical's commission and a total, and get the right answer whether a month
 * is selected or not. Spreading a projected row into a RepRow (as the
 * leaderboard does) works for order counts, but commission is a separate shape
 * on the payload, so the two are resolved together here rather than in three
 * places that would each have to remember the month.
 *
 * `commission` is null — not 0 — where the payload withheld it. A peer row on a
 * rep's login carries no money at all, and rendering a zero there would state
 * that nothing is owed to a colleague, which is a claim this page cannot make.
 */
function repInPeriod(r: RepRow, month: string) {
  const allTime = month === ALL_TIME;
  const m = allTime ? null : (r.byMonth ?? []).find((x) => x.month === month);
  const due = r.commissionDue ?? null;
  const cm = allTime ? null : (due?.byMonth ?? []).find((x) => x.month === month);
  return {
    orders: allTime ? r.orders : (m?.orders ?? 0),
    byVertical: allTime ? r.byVertical : (m?.byVertical ?? []),
    // VOLUME AND REVENUE, added so the team table can be read a month at a time
    // rather than only in aggregate. `null` is preserved rather than coalesced
    // to 0: the payload nulls these on a peer row, and a zero would state that a
    // colleague booked nothing instead of that the figure is withheld.
    units: allTime ? r.units : (m ? m.units : (r.units == null ? null : 0)),
    revenue: allTime ? r.revenue : (m ? m.revenue : (r.revenue == null ? null : 0)),
    accounts: allTime ? r.accounts : (m ? m.accounts : (r.accounts == null ? null : 0)),
    /** Commission OWED on this vertical/month, from the order-date rollup. Kept
     *  for `commissionOf` below, which is the only consumer left. */
    commission: due == null ? null : (allTime ? due.total : (cm?.total ?? 0)),
    // ── PAY: THE PAYOUT CYCLE, matching the Commission tab exactly ────────────
    // These three come off `commissionByCycle`, which the server lifts straight
    // from the commission payload. They used to be cut by the SALES ORDER's
    // date, which put Jillian's July at $6,646 here against $21,946 on the
    // Commission tab and lost $28,526 of hers to lines that tie to no live
    // order and so belonged to no month.
    ...(() => {
      const cyc = r.commissionByCycle ?? null;
      const c = allTime || !cyc ? null : cyc.find((x) => x.month === month);
      return {
        /** Payable / Due. */
        payable: r.payable == null ? null : (allTime ? r.payable : (c?.payable ?? 0)),
        /** Waiting. A cycle figure by nature, so it only HAS a value per cycle. */
        waiting: r.waiting == null ? null : (allTime ? r.waiting : (c?.waiting ?? 0)),
        /** The Commission column: paid plus payable for the cycle. */
        earned: r.commission == null ? null : (allTime ? r.commission : (c?.total ?? 0)),
      };
    })(),
    /** Commission due on one vertical, null where money is withheld. */
    commissionOf: (v: string): number | null => {
      if (due == null) return null;
      return (allTime ? due.byVertical : (cm?.byVertical ?? {}))[v] ?? 0;
    },
    /** Owed commission tied to no live order, so it belongs to no month. Only
     *  meaningful under a month filter, where it is the part NOT on screen. */
    undated: due?.undated ?? 0,
  };
}

function OverviewPanel({ reps, months, month, onMonth, onPickRep }: {
  reps: RepRow[]; months?: string[];
  /** CONTROLLED. The period is owned by RepsTab, because The team table answers
   *  to the same selector — see the note where it is declared. */
  month: string; onMonth: (m: string) => void;
  onPickRep: (r: RepRow) => void;
}) {
  const available = months ?? [];
  // The payload can change under the component — a rep preview swaps the whole
  // roster — so a month that no longer exists must not strand the board on an
  // empty period it cannot get out of.
  const active = month === ALL_TIME || available.includes(month) ? month : ALL_TIME;

  // Only producers are ranked — the same rule (and the same server flag) that
  // getRepOverview applies. This panel used to rank the raw roster, so house,
  // ops and departed names sat on the landing page's leaderboard while the
  // server had already dropped them: two boards, one roster, different answers.
  //
  // PROJECTED ONTO THE PERIOD FIRST, then ranked. `byMonth` carries the same
  // fields the aggregate does, so everything downstream — the bars, the
  // percentages, the drill — reads a normal RepRow and needs no notion of a
  // period at all. A rep who booked nothing in the month drops off the board
  // rather than sitting at the foot on zero: they are not last that month, they
  // are absent from it, and a rank implies a race they did not enter.
  //
  // EXCEPT A REP WHO HAS NEVER BOOKED AT ALL — the same exception the
  // Leaderboard makes, and made here for the same reason: that rule reads
  // correctly for an established producer having a quiet month and wrongly for
  // someone just added to the roster, who is not absent from the month but has
  // not started. Without it a new rep is invisible on every period, which looks
  // exactly like the roster edit having failed.
  //
  // The two boards MUST agree. They rank the same field off the same payload,
  // and a rep who appears on one and not the other is the "two boards, one
  // roster, different answers" bug the note above records fixing once already.
  const inPeriod: RepRow[] = active === ALL_TIME
    ? [...reps]
    : reps.map((r) => {
      const m = (r.byMonth ?? []).find((x) => x.month === active);
      // `r.orders` is the LIFETIME count, read before the period overwrites it.
      return { ...r, orders: m?.orders ?? 0, units: m?.units ?? null, byVertical: m?.byVertical ?? [], lifetimeOrders: r.orders };
    }).filter((r) => r.orders > 0 || r.lifetimeOrders === 0);

  const ranked = inPeriod
    .filter((r) => !r.standingsExcluded || r.isSelf)
    .sort((a, b) => b.orders - a.orders);

  // NOT `!ranked.length` any more. An empty MONTH is a real answer and must say
  // so; returning null would blank the card and leave the selector that caused
  // it unreachable, so the only way back would be a page reload.
  if (!reps.length) return null;

  // `own` is the server's word for "this row arrived unredacted" — true on every
  // row for a manager, true only on their own for a rep. Opening a peer's
  // breakdown as a rep would have shown a modal of dashes: name, order count,
  // and a column of nulls where the figures they may not see used to be.
  const canOpen = (r: RepRow) => Boolean(r.own);
  const openableCount = ranked.filter(canOpen).length;
  // The bar scale's denominator: every bar is read against the leader's — the
  // leader IN THIS PERIOD, so a month's bars use the full track rather than
  // being squashed against an all-time high nobody reached that month.
  const leader = ranked[0]?.orders ?? 0;
  const totalOrders = ranked.reduce((s, r) => s + r.orders, 0);
  const pct = (v: number) => (totalOrders ? Math.round((v / totalOrders) * 100) : 0);

  // The RANKING is `ranked`; the DRAWING ORDER is this. Every figure above is
  // computed off the ranking, so nesting cannot move a total or a percentage.
  const rows = nestSubReps(ranked);

  return (
    <BoardTile rows={rows} leader={leader} totalOrders={totalOrders} pct={pct}
      canOpen={canOpen} openableCount={openableCount} onPickRep={onPickRep}
      months={available} month={active} onMonth={onMonth} />
  );
}

/**
 * The leaderboard as a TILE, built to the same anatomy as Units by device
 * (BarList in DashboardOverview) — the card it sits beside in `.chart-pair`.
 * Matching it is the whole point: the two are one row, and a board with its own
 * head height, row rhythm and bar geometry read as two unrelated panels that
 * happened to land next to each other.
 *
 * Copied deliberately, element for element:
 *   · `height: 100%` + column flex, so the pair ends level
 *   · a 52px head, so both titles and subtitles sit on one baseline
 *   · the 22px headline figure that swaps to the hovered row's own number
 *   · rows on `minmax(0, 46%) 1fr 46px 38px` — name, bar, value, share
 *     (was 34%; widened for the full rep names, and BarList was widened with it
 *     — the two cards are one row, and a column split that matches on only one
 *     of them is worse than either width)
 *   · a `marginTop: auto` footer, which is what makes a stretched card end
 *     cleanly instead of trailing blank space
 *
 * The one thing NOT copied is the bar itself: each rep's is segmented by
 * vertical (MixBar), because a rep's mix is information a device count has no
 * equivalent of. It takes the device tile's 14px height and 4px radius so the
 * two columns of bars still line up.
 */
function BoardTile({ rows, leader, totalOrders, pct, canOpen, openableCount, onPickRep,
  months, month, onMonth }: {
  /** DRAWING ORDER, each row carrying its own rank — a sub-rep is placed under
   *  their supervisor rather than at the position their orders would put them.
   *  See nestSubReps. */
  rows: NestedRow[]; leader: number; totalOrders: number; pct: (v: number) => number;
  canOpen: (r: RepRow) => boolean; openableCount: number; onPickRep: (r: RepRow) => void;
  months: string[]; month: string; onMonth: (m: string) => void;
}) {
  // Hovering a row lifts that rep's count into the headline, the way hovering a
  // device row does. One control, read two ways.
  const [hot, setHot] = useState<number | null>(null);

  return (
    <div className="section chart-card" style={{ marginTop: 0, marginBottom: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="section-head" style={{ minHeight: 52, alignItems: 'flex-start' }}>
        <div>
          <h2 className="section-title" style={{ fontSize: 15 }}>Leaderboard</h2>
          <div className="section-sub">
            {openableCount > 1
              ? 'Reps by orders booked · click a rep for their full breakdown'
              : 'Reps by orders booked · click your own row for your full breakdown'}
          </div>
        </div>
        <MonthSelect months={months} month={month} onMonth={onMonth} />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.4, fontVariantNumeric: 'tabular-nums', color: C.ink }}>
          {(hot === null ? totalOrders : rows[hot].r.orders).toLocaleString()}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hot === null ? 'orders' : `${pct(rows[hot].r.orders)}% · ${rows[hot].r.rep}`}
        </span>
      </div>

      {/* A month with no orders is a fact, not a failure. Said in words, because
          the alternative is a card showing "0 orders" over nothing at all, which
          reads as a load that went wrong rather than as a quiet month. */}
      {rows.length === 0 && (
        <div style={{ padding: '18px 4px 22px', textAlign: 'center', fontSize: 13, color: C.muted }}>
          No orders booked in {month === ALL_TIME ? 'the book' : monthLabel(month)}.
        </div>
      )}

      <div style={{ display: 'grid', gap: 1 }}>
        {rows.map(({ r, rank, nested }, i) => {
          const on = hot === i;
          const open = canOpen(r);
          return (
            <button key={r.rep} className={`lb-row${nested ? ' is-nested' : ''}`}
              onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)}
              onFocus={() => setHot(i)} onBlur={() => setHot(null)}
              onClick={open ? () => onPickRep(r) : undefined}
              disabled={!open}
              title={[
                open ? `${r.rep}'s full breakdown` : `${r.rep}'s figures are confidential to them`,
                // The reporting line, spelled out where there is room for the
                // whole sentence rather than the badge's two words.
                r.subRepOf ? `Sub-rep of ${r.subRepOf} — SMR pays ${r.subRepOf}, who pays ${r.rep}` : '',
              ].filter(Boolean).join(' · ')}
              style={{
                // 46%, up from 34%. The names are full names now — "Alle Ann
                // Dubberley" wants about 115px at 12.5px against the ~105px a
                // 34% column left after the rank, the gaps and (on the nested
                // row) the tie, so every rep was ellipsising. The mix bar gives
                // up the difference: it is a SHAPE, and it still reads at the
                // narrower width, whereas a truncated name does not.
                display: 'grid', gridTemplateColumns: 'minmax(0, 46%) 1fr 46px 38px', gap: 10, alignItems: 'center',
                fontSize: 12.5, padding: '4px 6px', margin: '0 -6px', borderRadius: 7, width: 'calc(100% + 12px)',
                textAlign: 'left', border: 'none', cursor: open ? 'pointer' : 'default',
                background: r.isSelf
                  ? `color-mix(in srgb, ${C.brand} 12%, transparent)`
                  : on ? 'var(--panel-2)' : 'transparent',
                boxShadow: r.isSelf ? `inset 0 0 0 1px color-mix(in srgb, ${C.brand} 38%, transparent)` : 'none',
                transition: 'background-color .16s ease',
                // A disabled button greys its text by default; these rows are
                // not unavailable, only unopenable, and must stay fully legible.
                opacity: 1, color: 'inherit',
              }}>
              {/* Rank and name share the name column, so the four columns are
                  the device tile's four and the figures line up across the row. */}
              <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                {/* NOT `i + 1`. The drawn order has a nested row in it, which
                    would put a number on Jillian and take one off everybody
                    below her. `rank` is the position on the board, counted over
                    the standing rows only, and it is 0 on a nested one — drawn
                    as a blank so the cell still holds its 14px and the names
                    below stay in one column. See nestSubReps. */}
                <span style={{ flex: 'none', width: 14, fontSize: 11.5, fontWeight: 800, color: rank === 1 ? C.ink : C.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {nested ? '' : rank === 1 ? '🥇' : rank}
                </span>
                {/* THE TIE. A nested row is drawn AS a branch of the row above
                    it: the elbow starts at the parent's baseline and turns into
                    this name. It replaces the "under Alle Ann" caption that used
                    to hang beneath the name — with Jillian sitting directly
                    under Alle the relationship is in the layout, and the words
                    were repeating what the indent already said. The tag beside
                    the name keeps it unambiguous, and the row's tooltip still
                    spells the whole pay chain out. */}
                {nested && <span className="lb-tie" aria-hidden="true" />}
                <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: on ? 700 : 600, color: on ? C.ink : C.brand, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'color .16s ease' }}>{r.rep}</span>
                  {/* THE REPORTING LINE. Jillian books her own orders and keeps
                      her own row — the count is hers and nothing rolls up — but
                      SMR pays Alle, who pays Jillian, so a board that lists them
                      as two unrelated reps hides how the money reaches her.

                      Only rendered where the server sent `subRepOf`, which is
                      the supervisor's own login and an admin's. It stays off
                      every other rep's screen, so the relationship is not
                      broadcast to the team.

                      NAMED when the row could NOT be nested — Alle booked
                      nothing this month and is off the board, so there is no
                      line above to point at and the tag has to carry the name
                      itself. */}
                  {r.subRepOf && (
                    <span className="lb-subtag" title={`Sub-rep of ${r.subRepOf}`}>
                      {nested ? 'sub-rep' : `under ${r.subRepOf}`}
                    </span>
                  )}
                  {r.isSelf && <span style={{ flex: 'none', fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: C.positive }}>You</span>}
                </span>
              </span>
              <MixBar parts={r.byVertical} total={r.orders} height={14} radius={4}
                scale={leader ? r.orders / leader : 0} dim={hot !== null && !on} />
              {/* Orders only. The money column that sat here is gone: this
                  board ranks by volume, and the figure was each rep's own
                  commission — available in full on My Commission and on the
                  rep's own drill-down, so nothing is lost by dropping it. */}
              <span style={{ fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{r.orders}</span>
              <span style={{ color: on ? C.brand : C.muted, fontWeight: on ? 700 : 400, fontVariantNumeric: 'tabular-nums', textAlign: 'right', transition: 'color .16s ease' }}>
                {pct(r.orders)}%
              </span>
            </button>
          );
        })}
      </div>

      {/* Same footer shape as the device tile: what the card counts on the left,
          how concentrated it is on the right. `marginTop: auto` pins it to the
          foot, which is what lets the card stretch to its neighbour's height. */}
      <div style={{
        marginTop: 'auto', paddingTop: 10, display: 'flex', alignItems: 'baseline',
        justifyContent: 'space-between', gap: 8, fontSize: 11,
        borderTop: '1px solid var(--panel-2)', color: C.muted,
      }}>
        <span>{rows.length} rep{rows.length === 1 ? '' : 's'}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {/* THE TOP THREE ON THE BOARD, so it counts the same three rows the
              numbers 1-3 point at. Read off the drawn order it would have
              counted whoever sits in the first three LINES, which a nested row
              silently changes; `rank > 0` drops the nested rows, which hold none
              and are not competing for a place. Their orders still count toward
              the denominator, because the share is of everything on screen. */}
          {rows.length <= 1 ? '-' : (() => {
            const byRank = rows.filter((x) => x.rank > 0).sort((a, b) => a.rank - b.rank);
            const n = Math.min(3, byRank.length - 1);
            const lead = byRank.slice(0, n).reduce((s, x) => s + x.r.orders, 0);
            return <>Top {n} · <b style={{ color: C.sub, fontWeight: 700 }}>{pct(lead)}%</b></>;
          })()}
        </span>
      </div>
    </div>
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
/**
 * Orders per vertical, spelled out: `VA-182` · `TriCare-65 / PI-36`.
 *
 * Replaces MixBar in "The team". The bar drew PROPORTION, which is the one
 * thing the row could already be read for — Jillian's 99 orders next to a
 * two-tone bar still left you estimating 65 and 36 off two segment widths. It
 * also collapsed to a single solid block for the four reps working one vertical
 * (Alle Ann, Christy, Cassie, Maylon), which says nothing at all.
 *
 * MixBar itself stays: the leaderboard tile below wants a shape, and there the
 * bars are scaled against each other so the comparison is the point.
 *
 * Sorted by count, largest first, so the vertical a rep actually works leads.
 * `total` is carried for the hover title only — the counts speak for
 * themselves, but the row's own Orders figure is worth being able to check
 * against without adding a column.
 */
function VerticalCounts({ parts, total }: { parts: RepVertical[]; total: number }) {
  const shown = parts.filter((p) => p.orders > 0)
    .slice().sort((a, b) => b.orders - a.orders || a.vertical.localeCompare(b.vertical));
  if (!shown.length) return <span style={{ color: C.muted }}>-</span>;
  return (
    <span title={`${total} order${total === 1 ? '' : 's'} · ${shown.map((p) => `${p.vertical}: ${p.orders}`).join(' · ')}`}
      style={{ whiteSpace: 'nowrap', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
      {shown.map((p, i) => (
        <span key={p.vertical} style={{ color: V_C[p.vertical] || C.sub }}>
          {i > 0 && <span style={{ color: C.muted, fontWeight: 400 }}> / </span>}
          {p.vertical}-{p.orders}
        </span>
      ))}
    </span>
  );
}

function MixBar({ parts, total, height = 9, scale = 1, radius = 999, dim = false }: {
  parts: RepVertical[]; total: number; height?: number; scale?: number;
  /** Corner radius. 999 is the pill the tables use; the leaderboard tile passes
   *  4 to match the square-ended bars on Units by device beside it. */
  radius?: number;
  /** Fades the bar while a SIBLING row is hovered, so the hovered one reads. */
  dim?: boolean;
}) {
  const shown = parts.filter((p) => p.orders > 0);
  if (!shown.length || !total) return <div style={{ height, borderRadius: radius, background: 'var(--panel-2)' }} />;
  const pct = Math.max(0, Math.min(1, scale)) * 100;
  return (
    <div title={`${total} order${total === 1 ? '' : 's'} · ${shown.map((p) => `${p.vertical}: ${p.orders}`).join(' · ')}`}
      style={{ height, borderRadius: radius, overflow: 'hidden', background: 'var(--panel-2)' }}>
      {/* Outer track is the leader's length; this fill is this rep's share of
          it, and the segments inside divide THAT by vertical. */}
      <div className="mix-fill" style={{ display: 'flex', height: '100%', width: `${pct}%`, borderRadius: radius, overflow: 'hidden', opacity: dim ? 0.55 : 1, transition: 'width .35s cubic-bezier(.22,.75,.3,1), opacity .16s ease, filter .15s ease' }}>
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
        {topPay && <span>Highest commission <b style={{ color: C.ink }}>{topPay.rep}</b> <span style={{ color: C.muted }}>({pay(topPay.commission)})</span></span>}
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
  const body = (
    <>
      {/* TWO GRIDS OF FOUR CARDS BECAME ONE LINE. This was the heaviest header
          in the portal: up to eight plates stacked two deep, ~150px of a dialog
          that opens at 90vh, before a word of the breakdown the reader came for.

          The money keeps its tints and stays first, then the counts — the same
          two groups the two grids made, now read left to right instead of top to
          bottom. Nothing is dropped and nothing is reordered. Revenue and
          Accounts still come and go with the payload rather than with a role
          flag, so a rep sees neither and a manager sees both, exactly as
          before. */}
      <StatStrip items={[
        // Cents on the three pay figures; Revenue keeps whole dollars — it is
        // a board number, not something anybody is paid.
        { label: 'Commission', value: pay(rep.commission), tint: C.brand },
        { label: 'Payable / due', value: pay(rep.payable), tint: C.positive },
        { label: 'Waiting', value: pay(rep.waiting), tint: C.warning },
        showRevenue && { label: 'Revenue', value: money(rep.revenue) },
        { label: 'Orders', value: String(rep.orders) },
        { label: 'Devices', value: n(rep.units) },
        showAccounts && { label: 'Accounts', value: n(rep.accounts) },
        { label: 'Device types', value: n(rep.devices) },
      ]} />

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
      <div className="table-scroll">
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
      </div>
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

function RepModal({ rep, subs = [], onPickRep, onClose }: {
  rep: RepRow;
  /** The reps who work under this one, where the payload marked them. */
  subs?: RepRow[];
  onPickRep?: (r: RepRow) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(820px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${rep.own ? C.brand : C.muted}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{rep.rep}</div>
            {/* THE COUNTS CAME OUT. Orders, devices and accounts are all on the
                strip a few lines below — RepDetail's — so the header was
                announcing three figures the reader was about to be given
                properly, and the old bug this comment used to describe (a null
                accounts count leaving "· accounts" stranded) cannot happen in a
                line that no longer prints it. What is left is the one thing the
                strip cannot say, and only when it is true. */}
            {!rep.own && (
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>Pay is confidential</div>
            )}
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
          {/* ── WHOSE ORDERS ARE THESE ────────────────────────────────────────
              Only where this rep actually has someone under them. Three lines:
              their own book, each sub-rep's, and the pair — which is the figure
              the folded row on the drill was showing, now accounted for.

              MONEY FOLLOWS THE SAME RULE AS EVERYWHERE ELSE: a sub-rep's pay is
              confidential, so the commission column reads CONFIDENTIAL on their
              line rather than being summed into a combined figure that would
              disclose it by subtraction. Counts are shared; pay is not. */}
          {subs.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
                Split with {subs.length === 1 ? 'their sub-rep' : 'their sub-reps'}
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr>
                    <th>Rep</th><th className="num">Orders</th><th className="num">Devices</th>
                    {rep.revenue != null && <th className="num">Revenue</th>}
                    <th className="num">Commission</th>
                  </tr></thead>
                  <tbody>
                    <tr>
                      <td style={{ fontWeight: 700 }}>{rep.rep}<span style={{ color: C.muted, fontWeight: 600 }}> · own book</span></td>
                      <td className="num" style={{ fontWeight: 700 }}>{rep.orders}</td>
                      <td className="num">{n(rep.units)}</td>
                      {rep.revenue != null && <td className="num">{money(rep.revenue)}</td>}
                      <td className="num">{rep.commission == null ? <Confidential /> : pay(rep.commission)}</td>
                    </tr>
                    {subs.map((sub) => (
                      <tr key={sub.rep} className="tr-nested"
                        onClick={onPickRep ? () => onPickRep(sub) : undefined}
                        style={onPickRep ? { cursor: 'pointer' } : undefined}
                        title={onPickRep ? `Open ${sub.rep}'s own breakdown` : undefined}>
                        <td style={{ fontWeight: 700, color: C.brand }}>
                          <span className="lb-tie" aria-hidden="true" />{sub.rep}
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>{sub.orders}</td>
                        <td className="num">{n(sub.units)}</td>
                        {rep.revenue != null && <td className="num">{sub.revenue != null ? money(sub.revenue) : <Confidential />}</td>}
                        <td className="num">{sub.commission == null ? <Confidential /> : pay(sub.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="total-row">
                    <td>Together</td>
                    <td className="num">{rep.orders + subs.reduce((t, x) => t + x.orders, 0)}</td>
                    <td className="num">{rep.units == null ? '-' : n(rep.units + subs.reduce((t, x) => t + (x.units ?? 0), 0))}</td>
                    {rep.revenue != null && (
                      <td className="num">{money(rep.revenue + subs.reduce((t, x) => t + (x.revenue ?? 0), 0))}</td>
                    )}
                    {/* NO COMBINED PAY. It would be their own plus a figure the
                        row above withholds, which is the withheld number given
                        away by arithmetic. */}
                    <td className="num">-</td>
                  </tr></tfoot>
                </table>
              </div>
              {onPickRep && (
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
                  Click a sub-rep for their own orders and breakdown. The figures below are {rep.rep}'s own.
                </div>
              )}
            </div>
          )}

          <RepDetail rep={rep} />
        </div>
      </div>
    </div>
    </Portal>
  );
}
