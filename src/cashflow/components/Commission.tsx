import { useEffect, useRef, useState } from 'react';
import { printToPdf } from '../export';
import { fetchCommission, fetchMe, type Me, type CommissionResult, type StrivenCommRep, type StrivenOrderLine } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';
import { isKevinLogin } from '../viewProfile';
import { Portal } from './Portal';
import { StatStrip } from './StatStrip';

const PROG_C: Record<string, string> = { TriCare: '#0D9488', PI: '#0A369F', VA: '#16A34A', DOL: '#7C3AED' };
// REP_C (the per-rep bar palette) went with the sparkbar column — it coloured
// nothing else. PROG_C stays: the vertical tiles and the drill panels use it.

// A dollar field is `null` when it belongs to another rep: the server strips it
// before serialization, so there is nothing here to un-hide. Render the absence
// honestly rather than as $0, which would read as "earned nothing".
/**
 * CENTS, on this tab, on every figure.
 *
 * The rest of the portal rounds to whole dollars, which is right for a board:
 * "$1,339,961" is a scale, and ".00" on it is noise. This page is not a board.
 * It is what a rep is paid, and it is checked line by line against Crystal's
 * reconciliation sheet — the one place in the app where a cent has to tie out.
 *
 * ROUNDING WAS ALSO MAKING THE COLUMNS LIE. The rates are not whole dollars
 * (TriCare falls back to 369.78, and Maylon's workbook signs off $2,489.86), so
 * a column of rounded rows did not add up to its own rounded total — each row
 * lost up to half a dollar and the footer lost the sum of all of them. Whoever
 * checked the arithmetic found it off by a few dollars with nothing on screen
 * to explain the gap.
 *
 * TWO DECIMALS ALWAYS, not "cents only where they exist". A money column is
 * read down, and $650 beside $2,489.86 breaks the decimal alignment that makes
 * it readable — `.num` is tabular-nums precisely so the digits line up.
 */
const money = (v: number | null | undefined) => (v == null ? '-' : formatCurrency(v, true));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const monthLabel = (m: string) => {
  if (!m || m === 'unknown') return 'Undated';
  const [y, mo] = m.split('-');
  const N = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${N[+mo] || mo} ${y}`;
};
// The sales-order date on a commission line. The same "Sep 4, 2026" shape the
// AR/AP registers use, so a date means the same thing wherever it is read.
// A line that ties to no Striven order genuinely has no date; '-' says so
// rather than borrowing the payout cycle's.
const orderDate = (s: string | null | undefined) => {
  if (!s) return '-';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
/** The payout run that settles a month: the 15th of the month after it. This is
 *  the rule the reconciliation sheet's own cycle names follow ("Payable 15 Aug
 *  26" pays July), so the page states the date rather than leaving a reader to
 *  work out when they are paid. */
const payRunFor = (month: string) => {
  const [y, mo] = month.split('-').map(Number);
  const d = new Date(y, mo, 15);                 // mo is 1-based, so this is the NEXT month
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
// A rep sees their own dollars in full and only ORDER COUNTS for everyone else,
// the redaction happens server-side, so another rep's pay never reaches the
// browser. Admins see everything. No patient names anywhere.
export function CommissionTab() {
  const [data, setData] = useState<CommissionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  // WHICH MONTH IS ON SCREEN. `null` means the reader has not chosen one, which
  // is NOT the same as choosing All — see the derivation below.
  const [monthPick, setMonthPick] = useState<string | null>(null);
  const [repSel, setRepSel] = useState<StrivenCommRep | null>(null);
  const [drill, setDrill] = useState<null | 'total' | 'TriCare' | 'VA' | 'PI'>(null);
  const [peer, setPeer] = useState<StrivenCommRep | null>(null);
  const [viewAs, setViewAs] = useState<string | null>(null);   // admin preview only
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false, as: string | null = viewAs) {
    if (!silent) { setLoading(true); setError(null); }
    // A page load and the Refresh button re-read the reconciliation SHEET; the
    // silent 2-minute poll serves the server's cache. So editing the sheet and
    // reloading always shows the new figure, without every open tab re-fetching
    // Google on a timer. See getCommissionFor() for the reasoning.
    try { setData(await fetchCommission(as, !silent)); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load commission.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(false, viewAs); const r = setInterval(() => load(true, viewAs), 120_000); return () => clearInterval(r); }, [viewAs]);
  // THE LOGIN DECIDES, NOT THE PROFILE — see the note in RepsTab. The view
  // profile is browser-wide localStorage, so keying on it meant one preview of
  // Kevin's board stripped the picker from every other admin who later signed
  // in on that machine.
  const isKevin = isKevinLogin(me?.email);
  // KEVIN'S BOARD IS KEVIN'S BOARD. The rep-preview picker is a finance/ops
  // tool, and on the owner view it only muddies whose figures are on screen —
  // so it is not offered, and any preview left running from Crystal's view is
  // dropped on the way in rather than persisting into a board that no longer
  // shows a way out of it. Switching back to Crystal restores the picker.
  useEffect(() => { if (isKevin && viewAs) setViewAs(null); }, [isKevin, viewAs]);
  // Identity decides what the payload already CONTAINS: it is not a client-side
  // filter. The server redacted before this ever reached the browser.
  useEffect(() => { fetchMe().then(setMe).catch(() => setMe(null)); }, []);

  const isAdmin = me?.role === 'admin' && !viewAs;
  // While previewing, `myRep` is the previewed rep: the server has already
  // redacted to exactly what that person would receive.
  const myRep = viewAs ?? me?.repName ?? null;
  const s = data?.striven;
  // ── THE PAGE OPENS ON THE PREVIOUS MONTH ───────────────────────────────────
  // Commission is earned and paid monthly, so "which month" is the question
  // this page exists to answer. It used to default to All, which is a lifetime
  // running total — a figure nobody is paid and which only grows, so it says
  // nothing about whether a month was good.
  //
  // THE PREVIOUS CALENDAR MONTH, not the current one, and this is the payout
  // rule rather than a UI preference: a month's commission is settled and made
  // visible to reps by the 15th of the month after it. The current month is
  // still being booked, so opening on it would show a rep a part-formed figure
  // as if it were their pay.
  //
  // DERIVED, not defaulted in an effect: an effect would render one frame with
  // no month selected before correcting itself, and would fight the reader's
  // own choice every time the 2-minute poll returns.
  const months = s?.months ?? [];
  const prevMonth = (() => {
    const d = new Date();
    d.setDate(1);                 // the 31st of a 31-day month would skip a 30-day one
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  // Falls back to the newest month the payload actually has. That covers a
  // brand-new tenant, a previewed rep who booked nothing last month, and the
  // gap before the first order of a month lands.
  const defaultMonth = months.some((m) => m.month === prevMonth) ? prevMonth : (months[0]?.month ?? 'all');
  // A pick that no longer exists in the payload (the previewed rep has no
  // orders that month) falls back rather than silently showing an empty board
  // with a month name on it.
  const pickIsReal = monthPick === 'all' || months.some((m) => m.month === monthPick);
  const month = monthPick && pickIsReal ? monthPick : defaultMonth;
  const sel = month === 'all' ? null : months.find((m) => m.month === month) ?? null;
  const allReps: StrivenCommRep[] = sel ? sel.reps : (s?.byRep ?? []);
  // PRODUCERS ONLY, from the server's `roster` — the same four names the Reps
  // dashboard lists. `roster` is empty for a rep (it is an admin control and a
  // bare list of names is peer disclosure), and a rep's payload is already
  // their own row alone, so this is a no-op on their view.
  const rosterSet = new Set(data?.roster ?? []);
  const reps = rosterSet.size ? allReps.filter((r) => rosterSet.has(r.rep)) : allReps;
  // `trimmed` (rows.length !== allReps.length) is gone: it existed only to pick
  // between re-summing the rendered rows and trusting a server aggregate, and
  // every total re-sums the rows now, so there is no branch left for it to
  // choose. Keeping it would preserve the fork that caused the bug below.
  const own = myRep ? reps.find((r) => r.rep === myRep) ?? null : null;
  // `maxRep` (the sparkbar's scale) went with the bar column it scaled.

  // Totals for the scope on screen, summed off the rendered rows so the footer
  // can never drift from the table.
  //
  // These used to be SEEDED with the off-roster figures, because an "Off roster"
  // row carried them in the table. That row is gone, so seeding them here left
  // the Total reading 376 orders / 517 units above four rows summing to
  // 374 / 516 — a total with no rows behind it. Starts from zero now.
  const vt = reps.reduce((a, r) => ({
    TriCare: a.TriCare + num(r.nTricare), VA: a.VA + num(r.nVa), PI: a.PI + num(r.nPi),
    orders: a.orders + num(r.orders), units: a.units + num(r.units),
  }), { TriCare: 0, VA: 0, PI: 0, orders: 0, units: 0 });
  // The SERVER aggregates describe the whole book. Whenever this page shows
  // less than that — a month, or a trimmed roster — they stop describing what is
  // on screen, so nothing reads them. Re-summing the rendered rows is the rule
  // `vt` above already follows: the headline cannot disagree with the table
  // beneath it, whatever the scope.
  const sumOf = (pick: (r: StrivenCommRep) => number | null | undefined) =>
    reps.reduce((a, r) => a + num(pick(r)), 0);

  // EVERY TOTAL IS SUMMED FROM THE RENDERED ROWS. No exceptions, and that is the
  // fix: the rule above was applied only on the `trimmed` branch, so with a
  // MONTH selected the server's all-time aggregates were used instead.
  //
  // Payable and Waiting were the two that showed it. On "Jul 2026 · by rep" the
  // five rows summed to $75,320 payable and $0 waiting, while the Total line
  // read $133,729 and $28,768 — the whole book's figures, printed under a month
  // heading, and $28,768 of Waiting against five rows that all said $0.
  //
  // The counts (`vt`) never had the bug because they were always re-summed.
  // Deriving the money the same way makes the footer equal the table by
  // construction rather than by the two happening to agree.
  const canSeeMoney = Boolean(own) || isAdmin;
  const m0 = (v: number) => (canSeeMoney ? v : null);
  const bp = {
    TriCare: m0(sumOf((r) => r.tricare)),
    VA: m0(sumOf((r) => r.va)),
    PI: m0(sumOf((r) => r.pi)),
  };
  const total = m0(sumOf((r) => r.total));
  const payableSum = m0(sumOf((r) => r.payableTotal));
  const waitingSum = m0(sumOf((r) => r.waitingTotal));
  const paidSum = m0(sumOf((r) => r.paidTotal));

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
              dashboard reachable from the sidebar and from Reps. Removed: this
              tab is commission only. */}
          {/* `roster` is the producing reps, from the server's one shared rule.
              This used to map over `data.reps`, the raw commission rows, so the
              picker offered House Account, Santiago Family Chiropractic and
              every departed name — people the Reps section had already dropped
              and whose "view" is not a thing to preview. */}
          {/* NOT on Kevin's board — see the effect above. */}
          {me?.role === 'admin' && !isKevin && (
            <ViewAs reps={data?.roster ?? []} value={viewAs} onChange={setViewAs} />
          )}
          {<button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>}
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && !s?.available && !loading && (
        <div className="section"><div className="page-sub" style={{ padding: 16 }}>
          No Striven order data loaded yet: the commission engine needs the sales-order cache. Try Refresh, or open the Orders tab first.
        </div></div>
      )}

      {viewAs && (
        <div className="qb-flash warn" style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>👁 Previewing exactly what <b>{viewAs}</b> sees. The server has already stripped every other rep's pay from this response: this is not a client-side filter.</span>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setViewAs(null)}>Exit preview</button>
        </div>
      )}

      {data && s?.available && myRep && <AccessNote who={myRep} />}

      {data && s?.available && (
        <>
          {/* Commission state and the headline tiles, SIDE BY SIDE. They answer
              one question between them — what is owed, and where it came from —
              and each was half-empty across a full row on its own, especially
              now that empty verticals no longer take a tile. */}
          <div className="comm-head-pair">
          {/* Payable/Due vs Waiting: the caller's own state, or the producing
              reps for an admin. Straight off the shared sums now — these three
              carried the same all-time-under-a-month-heading bug the footer did,
              because they only re-summed on the `trimmed` branch. */}
          <StateSplit
            who={own ? own.rep : (isAdmin ? 'All reps' : null)}
            payable={payableSum}
            waiting={waitingSum}
            // Already out the door. Shown beside the other two rather than
            // folded into either: dropping it into Payable would say a rep is
            // owed money they have had, and leaving it out entirely would make
            // their total shrink on payday.
            paid={paidSum}
            paidThrough={s.paidThrough}
            scope={sel ? monthLabel(sel.month) : 'All months'}
            // Why a month reads the way it does. A settled month's figure is
            // the payout run's, not this portal's arithmetic; an unsettled one
            // has no payable figure at all yet, and saying so is the difference
            // between "you are owed nothing" and "it has not been run".
            note={sel
              ? (sel.reconciled === false
                ? `${monthLabel(sel.month)} is still being booked. Commission settles in the ${payRunFor(sel.month)} payout run, so nothing is payable yet — what is shown is earned and pending.`
                : `Signed off in the ${payRunFor(sel.month)} payout run, from the reconciliation sheet.`)
              : undefined}
            // The money above IS month-scoped: `own` comes from the selected
            // month's rep rows. These two counts are NOT — the server reports
            // held and $0-value orders for the whole book only, because both
            // are excluded before an order ever reaches a month bucket. So they
            // show on All months and are withheld on a month, rather than being
            // printed inside a month card while describing the book.
            held={sel ? undefined : s.heldOrders}
            zeroValue={sel ? undefined : s.zeroValueOrders}
          />

          {/* Only verticals the caller ACTUALLY has orders in. A rep working VA
              alone was reading "$0 · 0% OF TOTAL · 0 orders" twice over, for
              programmes they do not touch — three tiles to carry one figure.
              The column count follows the tiles so the row still fills. */}
          {(() => {
            const progs = [
              { key: 'TriCare' as const, ico: 'shield' as const, tint: PROG_C.TriCare, label: 'TriCare', value: bp.TriCare, orders: vt.TriCare, note: 'legacy vertical' },
              { key: 'VA' as const, ico: 'clip' as const, tint: PROG_C.VA, label: 'VA', value: bp.VA, orders: vt.VA, note: 'units × device rate' },
              { key: 'PI' as const, ico: 'trend' as const, tint: PROG_C.PI, label: 'Personal Injury', value: bp.PI, orders: vt.PI, note: 'units × device rate' },
            ].filter((p) => p.orders > 0);
            return (
              // SHAPE FOLLOWS THE COUNT. This strip sits in half a row beside a
              // taller card, so a single row of short tiles left an obvious band
              // of nothing beneath it. Two tiles stack full-width instead —
              // `gridAutoRows: 1fr` then splits the column's height between
              // them, so they end level with the card and the shape reads as
              // deliberate. Three or four still go two-up, where the row is
              // already full.
              <div className="kpi-r-strip" style={{
                display: 'grid', gap: 14, height: '100%',
                gridTemplateColumns: progs.length + 1 <= 2 ? '1fr' : 'repeat(auto-fit, minmax(190px, 1fr))',
                gridAutoRows: '1fr',
              }}>
                <KpiR ico="cash" tint={C.brand} label={sel ? monthLabel(sel.month) : 'Total commission'} value={total} format={money}
                  foot={`${vt.orders} orders · ${vt.units} units · tap for detail`} deltaText={sel ? 'selected month' : 'all months'}
                  onClick={() => setDrill(drill === 'total' ? null : 'total')} />
                {progs.map((p) => (
                  <KpiR key={p.key} ico={p.ico} tint={p.tint} label={p.label} value={p.value} format={money}
                    foot={`${p.orders} orders · ${p.note}`} deltaText={pct(p.value, total)}
                    onClick={() => setDrill(drill === p.key ? null : p.key)} />
                ))}
              </div>
            );
          })()}
          </div>

          {drill && <KpiDrill
            // Same rule as the table heading below: named for the signed-in rep,
            // "by rep" only where there is more than one to be by.
            title={`${drill === 'total' ? 'Total commission' : drill === 'PI' ? 'Personal Injury' : drill}: ${!isAdmin && myRep ? myRep : 'by rep'}${sel ? ` · ${monthLabel(sel.month)}` : ''}`}
            sub={!isAdmin && myRep ? 'Your figures for this period.' : 'Dollar figures appear only for your own row.'}
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
            {/* Months first, newest first, because one of them is always the
                selection. 'All' has moved to the END: it is the wider view you
                step out to, not the place you start. */}
            {months.map((m) => (
              <button key={m.month} className="btn ghost" style={segStyle(month === m.month)} onClick={() => setMonthPick(m.month)}>
                {monthLabel(m.month)}
              </button>
            ))}
            <button className="btn ghost" style={segStyle(month === 'all')} onClick={() => setMonthPick('all')}
              title="Every month added together — a running lifetime total, not a pay period">
              All months
            </button>
          </div>

          <div className="section chart-card">
            <div className="section-head"><div>
              {/* Named for whoever is signed in. "by rep" is right for a manager
                  looking at four of them; for a rep the table holds ONE row —
                  their own — so the heading says whose it is. `myRep` follows a
                  "view as" preview, so it names the previewed rep, not the
                  admin doing the previewing. */}
              <h2 className="section-title">
                {sel ? monthLabel(sel.month) : 'All months'} · {!isAdmin && myRep ? myRep : 'by rep'}
              </h2>
              <div className="section-sub">
                {!isAdmin && myRep
                  // The old copy promised "order counts for every rep", which
                  // stopped being true when peer rows left this payload.
                  ? <>Your commission, month by month. Tap the row for the order-by-order figure.</>
                  : <>Order counts are shown for every rep; commission is shown for your own row only.{' '}Tap your row for the order-by-order figure.</>}
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
                  {/* PAID, and it had to be added the moment July was marked
                      settled. Without it the columns read "$0 payable · $0
                      waiting · $17,975 commission" and the money simply went
                      missing between the first figure and the last — the reader
                      is left to work out that a zero here means SETTLED rather
                      than EARNED NOTHING, which is the one distinction this
                      table exists to make. `paidTotal` has always been on the
                      payload; only the column was missing. */}
                  <th className="num" title="Already paid out. Part of Commission, and deliberately not part of Payable / Due — a rep is not owed money they have had.">Paid</th>
                  <th className="num">Payable / Due</th><th className="num">Waiting</th>
                  <th className="num">Commission</th>
                  {/* The 18% sparkbar column is gone. It was scaled to the top
                      rep, so with Alle Ann at $63,025 and Maylon at $4,490 the
                      bottom of the table rendered as a stub — and the table is
                      already sorted by that same figure, so the bar restated
                      the row order and took a fifth of the width to do it. */}
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
                          {/* WHY THIS ROW READS $0. The server takes a rep the
                              reconciliation sheet does not name to zero rather
                              than falling back to the engine's own figure —
                              mixing the two bases in one column would make the
                              total reconcile to nothing. It has always sent
                              `reconciled: false` to say so, and no client has
                              ever read it, so the row showed a bare $0 that
                              states "earned nothing" while meaning "not in the
                              sheet these figures come from".

                              Only drawn where there IS money to explain away:
                              a rep with no orders and no pay is not a puzzle,
                              and flagging every empty row would bury the one
                              that matters. */}
                          {r.reconciled === false && num(r.orders) > 0 && (
                            <span className="cm-unrecon" title={`${r.rep} has ${num(r.orders)} orders in Striven but no rows in the reconciliation sheet, so nothing here is signed off. Their commission is paid from a workbook source — see COMMISSION_WORKBOOKS.`}>
                              not in the sheet
                            </span>
                          )}
                        </td>
                        <OrderCountCells t={num(r.nTricare)} v={num(r.nVa)} p={num(r.nPi)} />
                        <td className="num">{num(r.orders)}</td>
                        <td className="num">{num(r.units)}</td>
                        {/* Muted, not green: paid money is settled history, and
                            colouring it like the owed column would have two
                            figures competing to be the one that matters. */}
                        <td className="num" style={{ color: C.muted, fontWeight: 700 }}>{money(r.paidTotal)}</td>
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
                      </tr>
                    );
                  })}
                  {/* The "Off roster" row rendered here — orders booked to
                      someone who is not a rep, carried so the columns tied to
                      the order book. Removed on request; the totals below no
                      longer include it, so this table now describes the reps
                      above and nothing else. */}
                </tbody>
                {reps.length > 0 && (
                  <tfoot><tr className="total-row">
                    <td /><td>Total</td>
                    <td className="num">{vt.TriCare}</td><td className="num">{vt.VA}</td><td className="num">{vt.PI}</td>
                    <td className="num">{vt.orders}</td><td className="num">{vt.units}</td>
                    {/* Same population as the Commission cell beside it. */}
                    {/* The two cells that showed the bug: under "Jul 2026" they
                        printed the whole book's $133,729 and $28,768 over five
                        rows summing to $75,320 and $0. Same sums as the card
                        above now, so the two cannot drift apart either. */}
                    {/* `paidSum` was already computed for the card above and
                        simply had no column to land in down here — so the foot
                        summed to a Total the three columns beside it could not
                        account for the moment anything was paid. */}
                    <td className="num" style={{ color: C.muted, fontWeight: 700 }}>{money(paidSum)}</td>
                    <td className="num" style={{ color: C.positive, fontWeight: 700 }}>{money(payableSum)}</td>
                    <td className="num" style={{ color: C.warning, fontWeight: 700 }}>{money(waitingSum)}</td>
                    <td className="num" style={{ fontWeight: 800 }}>{money(total)}</td>
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
                  <b>{data.striven.commissionedOrders} of {data.striven.bookOrders}</b> orders that tie to device lines: a rep can hold real orders and still earn $0 where that link is missing.
                </>
              )}
            </div>
          </div>

          {/* The "No sales order" panel rendered here. It listed orders the
              engine could not tie to a sales order — not commissioned, but real
              volume — so the gap between this page and the order book was
              visible rather than silent. Removed on request.
              `striven.unmatched` and `unmatchedValue` are still computed and
              still returned by /api/commission; nothing is dropped server-side,
              so this is a one-line restore if the reconciliation is wanted back. */}

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
// narrow: a rep-role session passing the same parameter is ignored.
function ViewAs({ reps, value, onChange }: { reps: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const names = [...new Set(reps)].filter(Boolean);
  if (!names.length) return null;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
      View as
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}
        style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
        {/* Same control, same wording as the Reps dashboard's "View as": the
            unrestricted view named for the person who owns it. */}
        <option value="">Crystal Chambers (everything)</option>
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
        <b style={{ color: C.ink }}>You are signed in as {who}.</b> Your own row: highlighted below: shows your commission,
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
  // 560, not the 760 default. Three rows — TriCare, VA, PI — across five
  // columns; the extra 200px went to the Vertical column and pushed the figures
  // away from the names they belong to.
  return (
    <Modal title={rep.rep} accent={C.muted} sub="Order volume by vertical" onClose={onClose} width={560}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--panel-2)', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontSize: 13, color: C.sub }}>
        <span style={{ fontSize: 15, lineHeight: 1.2 }}>🔒</span>
        <div><b style={{ color: C.ink }}>{rep.rep}'s commission is confidential.</b> You can see their order volume, not their pay: the dollar figures were removed on the server before this page loaded.</div>
      </div>

      <StatStrip items={[
        { label: 'Orders', value: String(num(rep.orders)), tint: C.brand },
        { label: 'Units', value: String(num(rep.units)) },
        // The withheld figure is NOT dropped from the strip. A modal that simply
        // omitted commission would read as a rep with none; naming it and saying
        // "Confidential" is the boundary stated, which is what this dialog is
        // for. The lock panel above says why.
        { label: 'Commission', value: 'Confidential', tint: C.sub },
      ]} />

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Orders by vertical</div>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Share</th><th style={{ width: '34%' }} /></tr></thead>
          <tbody>
            {rows.map(([name, n, u, c]) => (
              <tr key={name}>
                <td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: c, marginRight: 8 }} />{name}</td>
                <td className="num" style={{ fontWeight: 700 }}>{n || '-'}</td>
                <td className="num">{u || '-'}</td>
                <td className="num">{tot > 0 && n > 0 ? `${Math.round((n / tot) * 100)}%` : '-'}</td>
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
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
        🔒 No patient names. Order counts are operational data and are shared across the team; commission is not.
      </div>
    </Modal>
  );
}

const pct = (n: number | null | undefined, total: number | null | undefined) =>
  (n != null && total != null && total > 0 ? `${Math.round((n / total) * 100)}% of total` : '-');

// Order counts are non-financial and survive redaction, so every rep can see how
// much volume every other rep booked in each vertical: just not their pay.
function OrderCountCells({ t, v, p }: { t: number; v: number; p: number }) {
  const cell = (n: number, key: string) => (
    <td key={key} className="num" style={{ color: n ? C.ink : C.muted, fontWeight: n ? 700 : 400 }}>{n || '-'}</td>
  );
  return <>{cell(t, 't')}{cell(v, 'v')}{cell(p, 'p')}</>;
}

// Paid / Payable-Due / Waiting.
//
// TOTAL IS PAID + PAYABLE, and Waiting sits OUTSIDE it. That is the server's
// own rule (striven.grandTotal), and this card used to add all three, so it
// printed a Total $29,507 above the headline on the same screen. Waiting is the
// in-flight payout cycle — a month with no run yet, estimated from the order
// book rather than signed off — so adding it to a signed-off total would mix an
// estimate into the figure the business pays on.
function StateSplit({ payable, waiting, held, zeroValue, who, scope, note, paid, paidThrough }: { payable?: number | null; waiting?: number | null; held?: number; zeroValue?: number; who?: string | null; scope?: string; note?: string; paid?: number | null; paidThrough?: Record<string, string> }) {
  if (payable == null && waiting == null) return null;
  const p = payable ?? 0, w = waiting ?? 0, d = paid ?? 0, tot = p + d;
  // Which programmes are settled, and through when — so "Paid" is a statement
  // with a date on it rather than a number the reader has to take on trust.
  const through = Object.entries(paidThrough ?? {})
    .map(([v, m]) => `${v} through ${monthLabel(m)}`).join(', ');
  return (
    // No bottom margin: it sits in .comm-head-pair now, and that grid owns the
    // gap. Its own margin would have stacked a second one under the card.
    <div className="section chart-card" style={{ marginBottom: 0 }}>
      <div className="section-head"><div>
        {/* The period is part of the heading, not decoration: this card opens
            on a month now, so a figure with no period on it would read as the
            lifetime total it used to be. */}
        <h2 className="section-title">
          {who ? `${who}: commission state` : 'Commission state'}
          {scope && <span style={{ fontWeight: 600, color: C.muted }}> · {scope}</span>}
        </h2>
        <div className="section-sub">
          {note && <div style={{ marginBottom: 4 }}>{note}</div>}
          Paid has already gone out — still counted in the total, no longer owed{through ? ` (${through})` : ''}.
          {' '}Payable/Due is signed off and owed. Total is Paid + Payable: the whole signed-off figure.
          {w ? ' Waiting is the current cycle, which has no payout run yet — estimated from the order book, not signed off, and NOT in the total.' : ''}
          {held ? ` ${held} order${held === 1 ? '' : 's'} on hold are not payable.` : ''}
          {zeroValue ? ` ${zeroValue} order${zeroValue === 1 ? '' : 's'} with $0 order value earn no commission and are excluded too.` : ''}
        </div>
      </div></div>
      {/* Paid leads: it is the settled half of the story and reads left-to-right
          as money moving — paid, then due, then still waiting, then the sum. */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${d > 0 ? 4 : 3}, 1fr)`, gap: 12, padding: '4px 2px 2px' }}>
        {d > 0 && <Stat label="Paid" value={money(d)} tint={C.muted} />}
        <Stat label="Payable / Due" value={money(p)} tint={C.positive} />
        {/* Not "waiting for reimbursement" any more — that named a label on an
            order, and this figure is now the unsettled CYCLE. */}
        <Stat label="Waiting · current cycle" value={money(w)} tint={C.warning} />
        <Stat label="Total" value={money(tot)} tint={C.brand} />
      </div>
      {/* The bar is the TOTAL broken down, so only what the total contains is in
          it. Waiting used to take a third segment, which drew it as a share of
          a figure it is not part of. */}
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', margin: '12px 2px 2px' }}
        title={`Paid ${money(d)} · Payable ${money(p)}${w ? ` · Waiting ${money(w)}, outside the total` : ''}`}>
        {d > 0 && <div style={{ width: `${(d / (tot || 1)) * 100}%`, background: C.muted }} />}
        {p > 0 && <div style={{ width: `${(p / (tot || 1)) * 100}%`, background: C.positive }} />}
      </div>
    </div>
  );
}

// VerticalBar lived here — a stacked share bar for reps whose dollars were
// withheld, so a "Confidential" row still said something about their mix. It
// had one call site, the sparkbar column above, and went with it. Note it was
// already unreachable: peer rows are DROPPED for a rep now rather than blanked
// (see redactCommissionPayload), so no row with a null total ever renders.

// UnmatchedTable lived here — the "No sales order" panel. It went with the
// section above; the data behind it is untouched on the server.

// Modal shell: backdrop + card, closes on Esc / backdrop click.
// `width` is opt-in. The default 760px was sized for the six-column drill; the
// tables that now hold four columns rattle around inside it, so they ask for
// something narrower rather than every modal shrinking.
function Modal({ title, sub, accent, onClose, children, width = 760 }: {
  title: string; sub?: string; accent?: string; onClose: () => void;
  children: React.ReactNode; width?: number;
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: `min(${width}px, 100%)`, maxHeight: '90vh', overflowY: 'auto', overflowX: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${accent || C.brand}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '14px 16px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.ink, wordBreak: 'break-word' }}>{title}</div>
            {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>
        <div style={{ padding: '12px 16px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>{children}</div>
      </div>
    </div>
    </Portal>
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
  // sent, and peers' lines and money are stripped there before serialization,
  // so a rep can never produce a PDF of anyone else's commission, and this
  // needs no extra fetch or permission check of its own.
  const sheetRef = useRef<HTMLDivElement>(null);

  // The order count came out of the subtitle: the strip below states it, and the
  // two sat four lines apart saying the same number. The TOTAL stays — the strip
  // carries Payable and Waiting, which do not add up to it.
  return (
    <Modal title={rep.rep} sub={`Final commission ${money(rep.total)} · ${num(rep.units)} units`} onClose={onClose}>
      <div ref={sheetRef}>
      {/* Statement header: only on paper, where the modal's own title bar and
          the surrounding page are gone. */}
      <div className="print-only" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{rep.rep}: commission statement</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          Sports Med Recovery · generated {new Date().toLocaleDateString()} · commission = units × per-device rate
        </div>
      </div>

      {/* PRINTS TOO — this block is inside `sheetRef`, so it is the figure line
          on the PDF statement as well as in the dialog. That is fine on paper:
          the print stylesheet already strips the plate's background (browsers
          drop backgrounds unless told not to), so the cards were printing as
          bare stacked text and the strip prints as one line of it. */}
      <StatStrip items={[
        { label: 'Payable / Due', value: money(rep.payableTotal), tint: C.positive },
        { label: 'Waiting', value: money(rep.waitingTotal), tint: C.warning },
        { label: 'Orders', value: String(num(rep.orders)) },
        { label: 'Per order', value: money(cpo) },
      ]} />

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
            {/* "N orders" was wrong the moment a bonus could sit in this table:
                it is a line, and counting it as an order overstates the book by
                one against every other order count on the page. */}
            Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>
              · {(() => {
                const b = lines.filter((l) => l.bonus).length;
                const o = lines.length - b;
                return `${o} order${o === 1 ? '' : 's'}${b ? ` · ${b} bonus` : ''}`;
              })()}
            </span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              {/* Patient surname, not the sales order number: reps keep their own
                  record of orders and cannot reconcile an SO ref against it.
                  Order value is gone too, per the same review: it is company
                  money and not the rep's to see. */}
              <thead><tr>
                <th>Order date</th>
                <th>Patient</th><th>Device</th><th>Vertical</th><th className="num">Units</th>
                <th className="num">Commission</th><th>State</th>
              </tr></thead>
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={i}>
                    {/* WHEN THE ORDER WAS RAISED, beside the patient, because a
                        surname alone does not identify a line for a rep who has
                        sold to the same patient twice. Blank on a row that ties to
                        no Striven order — see the note under the table. */}
                    <td style={{ whiteSpace: 'nowrap', color: ln.date ? C.sub : C.muted, fontSize: 12.5 }}>
                      {orderDate(ln.date)}
                    </td>
                    {/* Falls back to the SO ref when the report cache has no
                        patient row, so the line is never unidentifiable.

                        A BONUS HAS NO PATIENT, and that is not a gap to fill: it
                        is a flat payment, not a device sold to somebody. Falling
                        through to `ln.ref || 'no SO'` here would print "no SO"
                        against it and state a missing record that was never
                        expected to exist. */}
                    <td style={{ fontWeight: 600, color: ln.patient ? C.ink : C.muted }}>
                      {ln.bonus ? '—' : (ln.patient || ln.ref || 'no SO')}
                    </td>
                    <td style={{ color: C.sub, fontSize: 12.5 }}>
                      {ln.bonus
                        ? <span className="cm-bonus">Bonus</span>
                        : (ln.item || '-')}
                    </td>
                    {/* NO VERTICAL ON A BONUS. It is a flat payment, not a
                        device sold into a programme, so naming one beside it
                        claims a categorisation the payment does not have.

                        HIDDEN, NOT REMOVED — and the difference is load-bearing.
                        `prog` is what isPaidLine() reads to decide whether a
                        line falls before its vertical's paid-through month, so
                        stripping it server-side would leave the bonus with no
                        vertical to look up, no paid-through to compare against,
                        and it would read Payable forever however many runs went
                        out. It also keeps the by-vertical figures above summing
                        to the rep's total, which they would stop doing if this
                        one line belonged to nothing. */}
                    <td style={{ color: ln.bonus ? C.muted : undefined }}>{ln.bonus ? '—' : ln.prog}</td>
                    <td className="num">{ln.units}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(ln.comm, true)}</td>
                    {/* The remark rides the EXISTING rightmost column rather than
                        adding one. An unmatched row is still paid — the sheet is
                        the base — so this reports the missing Striven match, it
                        does not withhold the line. */}
                    <td>
                      {/* PAID BEATS UNMATCHED. A missing Striven tie is a remark
                          about how a row was evidenced; once the money has gone
                          out, what it is doing now is the more useful fact, and
                          "Unmatched" beside a settled line reads as a problem
                          with a payment that already cleared. */}
                      {ln.state === 'paid'
                        ? <span style={{ color: C.muted, fontWeight: 600 }}>Paid</span>
                        : ln.unmatched
                          ? <span style={{ color: C.warning, fontWeight: 600, whiteSpace: 'nowrap' }}>Unmatched from Striven</span>
                          : ln.state === 'waiting'
                            ? <span style={{ color: C.warning, fontWeight: 600 }}>Waiting</span>
                            : <span style={{ color: C.positive, fontWeight: 600 }}>Payable</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 Patient shown as first initial + surname, on your own orders only. Commission = units × per-device rate — except a <b>Bonus</b>, which is a flat amount tied to no order, no patient and no programme. A bonus still counts toward the totals above, under the programme it was paid against. Orders on hold are excluded and do not appear here.
            {' '}The date is when the <b>sales order</b> was raised, not the payout cycle — it reads “-” on a row the sheet could not tie to a Striven order.
          </div>
        </>
      )}
      </div>

      {/* Download sits outside the printed region, so the button itself never
          appears in the PDF. */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.muted}22` }}>
        <button className="btn ghost" onClick={() => printToPdf(sheetRef.current)}
          title="Open the print dialog: choose “Save as PDF” for a statement of your own commission">
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
  // `sum` (share denominator) and `maxO` (bar scale) went with the two columns
  // they existed for. Ranking still uses the raw value, so row order is unchanged.
  // Narrow: four columns and at most a handful of reps. At the default 760px
  // the figures sat marooned at opposite edges of the card.
  return (
    <Modal title={title} sub={sub} accent={accent} onClose={onClose} width={460}>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr>
            <th style={{ width: 28 }}>#</th><th>Rep</th><th className="num">Orders</th>
            <th className="num">Commission</th>
          </tr></thead>
          <tbody>
            {sorted.length === 0 && <tr><td colSpan={4} style={{ color: C.muted }}>No data.</td></tr>}
            {sorted.map((r, i) => (
              <tr key={r.name}>
                <td style={{ color: C.muted }}>{i + 1}</td>
                <td style={{ fontWeight: 700 }}>{r.name}</td>
                <td className="num" style={{ fontWeight: 700 }}>{r.orders || '-'}</td>
                <td className="num" style={{ fontWeight: 800 }}>{money(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
