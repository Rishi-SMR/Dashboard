import { useEffect, useMemo, useRef, useState } from 'react';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { AnimatedNumber } from '../chartKit';
import { fetchOrderAnalytics, type RepRow, type AnalyticsOrder } from '../strivenApi';
import { shortDeviceName } from './DeviceChips';
import { Portal } from './Portal';
import { ALL_TIME, MonthSelect, monthLabel, defaultMonth } from './MonthSelect';

/**
 * The rep leaderboard: the first thing a rep sees on login.
 *
 * COUNTS ONLY — orders, units, devices. No revenue, no commission, no dollar
 * figure anywhere on this component or in the drawer it opens. That is not a
 * styling choice: the server withholds peers' money entirely, so there is
 * nothing to render even if someone added a column for it.
 *
 * RANKED ON ORDERS, by the CURRENT MONTH by default and over the whole book on
 * request. Milestone badges and the rank-1 celebration stay on the lifetime
 * figure whatever the period says — see `ranked` and the confetti effect.
 *
 * The period selector was dropped from the original brief as impossible: the
 * payload carried no per-period history, so filtering by month would have
 * contradicted a board that ranks on the all-time total. `byMonth` on the
 * rep-overview payload is the server change that note anticipated, and the
 * picker now sits in the head.
 *
 * IT OPENS ON ALL TIME, unlike the manager's board, which opens on the current
 * month. This one is a rep's own standing — the badges are lifetime milestones
 * and the podium is "where I sit" — and a part-month default would show a rank
 * nobody has earned yet on a board that reshuffles every 1st.
 *
 * MILESTONES AND CONFETTI IGNORE THE PERIOD, always. A badge says "this rep has
 * booked 150 orders"; that stays true whichever month is on screen, and taking
 * it away for looking at August would misstate what they have done. Rank-1
 * confetti fires only on the all-time board for the same reason — and because
 * its one-per-achievement localStorage guard would otherwise be spent on topping
 * a quiet month, leaving the real thing to pass in silence.
 *
 * Still dropped, and still for the original reason: rank MOVEMENT versus the
 * previous period. The payload has per-month counts but no record of where a rep
 * ranked then, and deriving it from today's roster would be a guess.
 *
 * A rep may open ONLY their own row. `own` is the server's word for "this row
 * arrived unredacted": true for every row an admin sees, true only for the
 * caller's own row for a rep. Peer rows are inert — not merely unstyled.
 */

/**
 * A row as this board ranks it: `orders` is the SELECTED PERIOD's count, and
 * `lifetimeOrders` is the all-time one the milestone badges read.
 *
 * Both are needed on the same row, which is why the period projection cannot
 * simply overwrite `orders` and be done. Keeping them apart in the type is what
 * stops a later edit from quietly badging a rep off a single month's work.
 */
type RankedRep = RepRow & { lifetimeOrders: number };

/** Orders at which a rep earns a badge. Ascending; the highest earned wins. */
const MILESTONES = [25, 50, 100, 150] as const;
const badgeFor = (orders: number) => [...MILESTONES].reverse().find((m) => orders >= m) ?? null;

/**
 * The chase line. Tone follows the DISTANCE, because one sentence cannot serve
 * both "you are 2 orders behind" and "you are 67 behind" — the first wants
 * urgency, the second wants encouragement, and a rep reading the wrong one
 * either shrugs or gives up.
 *
 * Chosen by gap size, never at random: a message that changes on every render
 * reads as noise, and the same rep should see the same line until they move.
 */
function chaseLine(gap: number, name: string, nextRank: number) {
  const o = `${gap} order${gap === 1 ? '' : 's'}`;
  if (gap <= 2) return { icon: '🔥', text: <>Just <b>{o}</b> behind <b>{name}</b> — one good day and #{nextRank} is yours.</> };
  if (gap <= 5) return { icon: '⚡', text: <><b>{o}</b> from overtaking <b>{name}</b>. That is this week's work.</> };
  if (gap <= 15) return { icon: '🎯', text: <><b>{o}</b> to take #{nextRank} off <b>{name}</b>. Well within range.</> };
  if (gap <= 40) return { icon: '📈', text: <><b>{name}</b> is <b>{o}</b> ahead. Close it steadily and #{nextRank} is on.</> };
  return { icon: '🧗', text: <>Chasing <b>{name}</b>, <b>{o}</b> to go. Every order books ground back.</> };
}

const REDUCED = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Podium tints. Not in the token set — they are medals, not brand colours. */
const MEDAL = [
  { ring: '#D4A017', soft: 'rgba(212,160,23,.14)', glyph: '🥇', label: '1st' },
  { ring: '#8E9BAE', soft: 'rgba(142,155,174,.16)', glyph: '🥈', label: '2nd' },
  { ring: '#B06B3A', soft: 'rgba(176,107,58,.14)', glyph: '🥉', label: '3rd' },
];

/** One rep's vertical split, as a segmented pill with a shared legend below. */
function MixPill({ parts, total, scale }: {
  parts: { vertical: string; orders: number }[]; total: number; scale: number;
}) {
  const shown = parts.filter((p) => p.orders > 0);
  const pct = Math.max(0, Math.min(1, scale)) * 100;
  return (
    <span className="lbx-track" aria-hidden="true">
      <span className="lbx-fill" style={{ width: `${pct}%` }}>
        {shown.map((p) => (
          <span key={p.vertical} style={{ width: `${(p.orders / (total || 1)) * 100}%`, background: V_C[p.vertical] || C.muted }} />
        ))}
      </span>
    </span>
  );
}

/** A burst of confetti. Hand-rolled: no dependency, and it self-removes. */
function Confetti() {
  const bits = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    // Deterministic spread rather than Math.random, so a re-render cannot
    // reshuffle pieces mid-flight.
    left: 4 + (i * 92) / 22,
    delay: (i % 7) * 45,
    hue: [C.brand, C.positive, '#D4A017', V_C.PI, V_C.VA][i % 5],
    drift: (i % 2 ? 1 : -1) * (8 + (i % 5) * 6),
  })), []);
  if (REDUCED) return null;
  return (
    <span className="lbx-confetti" aria-hidden="true">
      {bits.map((b, i) => (
        <span key={i} style={{
          left: `${b.left}%`, background: b.hue,
          animationDelay: `${b.delay}ms`,
          ['--drift' as string]: `${b.drift}px`,
        }} />
      ))}
    </span>
  );
}

/** Short day label for a sub-rep's last order. En-dash where there is none —
 *  the field is nulled for a peer the viewer does not supervise. */
const fmtDay = (s: string | null | undefined) =>
  (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '–');

/** One figure in the sub-rep roll-down. Value over label, so a row of them
 *  scans as a strip of numbers rather than a list of words. */
function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="lbx-substat">
      <span className="lbx-substat-v">{value}</span>
      <span className="lbx-substat-l">{label}</span>
    </span>
  );
}

/**
 * The viewer's sub-reps, rolled down INSIDE their own card on the board.
 *
 * Rendered as a sibling of the card's clickable face, not inside it: the face is
 * a <button> and a second one nested in it is invalid markup and unreachable by
 * keyboard. Both live in the card wrapper, so it reads as one box with two
 * controls — tap the card for your own breakdown, tap the strip for theirs.
 *
 * Renders nothing unless the payload marked a row `subRepOf` the viewer, which
 * the server only does for the supervisor. Every other login gets an empty list
 * and therefore no strip at all.
 *
 * VOLUME ONLY. Commission, payable, waiting and revenue are null on a sub-rep's
 * row, so there is nothing here to hide — the note at the foot says so rather
 * than leaving a reader to wonder whether pay was simply left off the design.
 */
function SubReps({ subs, open, onToggle }: { subs: RankedRep[]; open: boolean; onToggle: () => void }) {
  if (!subs.length) return null;
  return (
    <>
      <div className="lbx-podsubs">
        {/* Opens a DIALOG, so no caret: a chevron promises the panel unfolds in
            place and this one does not. `aria-haspopup` says the same thing to a
            screen reader that "view" says to everyone else. */}
        <button className="lbx-subtoggle" aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
          <span className="lbx-subtoggle-t">{subs.length} sub-rep{subs.length === 1 ? '' : 's'}</span>
          <span className="lbx-subtoggle-hint">view</span>
        </button>
      </div>
      {open && <SubRepDialog subs={subs} onClose={onToggle} />}
    </>
  );
}

/**
 * The sub-reps' detail, as a dialog.
 *
 * Reuses the `.lbx-drawer` shell the own-breakdown dialog already uses on this
 * board rather than inventing a second modal look — two dialogs one tap apart
 * that dismiss and animate differently read as two features.
 *
 * It was an inline accordion first. In a podium card a third of the board wide
 * it forced six figures into one column and pushed the ranks below it off the
 * fold; a dialog gets the full width and leaves the board where it was.
 */
function SubRepDialog({ subs, onClose }: { subs: RankedRep[]; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const total = subs.reduce((s, r) => s + r.orders, 0);
  return (
    <Portal>
      <div className="lbx-drawer-back" onClick={onClose}>
        <div className="lbx-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
          aria-label={subs.length === 1 ? `${subs[0].rep}: sub-rep detail` : 'Your sub-reps'}>
          <div className="lbx-drawer-grip" aria-hidden="true" />
          <div className="lbx-drawer-head">
            <div>
              <div className="lbx-drawer-title">
                {subs.length === 1 ? subs[0].rep : `${subs.length} sub-reps`}
              </div>
              <div className="lbx-drawer-sub">
                {subs.length === 1 ? 'Works under you' : 'Working under you'}
                {' · '}{total} order{total === 1 ? '' : 's'} in this period
              </div>
            </div>
            <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className="lbx-drawer-body">
            {subs.map((r) => (
              <div key={r.rep} className="lbx-subcard">
                {/* The name repeats in the head when there is only one sub-rep,
                    so it is dropped there — a dialog titled "Jillian" with
                    "Jillian" again beneath it is noise. */}
                {subs.length > 1 && (
                  <div className="lbx-subcard-head">
                    <span className="lbx-subcard-name">{r.rep}</span>
                    <span className="lbx-sub">works under you</span>
                  </div>
                )}
                <div className="lbx-substats">
                  <SubStat label="Orders" value={String(r.orders)} />
                  <SubStat label="Devices" value={r.units == null ? '–' : String(r.units)} />
                  <SubStat label="Accounts" value={r.accounts == null ? '–' : String(r.accounts)} />
                  <SubStat label="Types" value={r.devices == null ? '–' : String(r.devices)} />
                  <SubStat label="Verticals" value={r.verticals == null ? '–' : String(r.verticals)} />
                  <SubStat label="Last order" value={fmtDay(r.lastOrder)} />
                </div>

                {(r.byVertical ?? []).some((v) => v.orders > 0) && (
                  <>
                    <div className="lbx-drawer-h" style={{ marginTop: 16 }}>By vertical</div>
                    <div className="table-scroll">
                      <table className="data-table tbl-fit">
                        <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Units</th></tr></thead>
                        <tbody>
                          {(r.byVertical ?? []).filter((v) => v.orders > 0).map((v) => (
                            <tr key={v.vertical}>
                              <td style={{ fontWeight: 700, color: V_C[v.vertical] || C.ink }}>
                                <span className="lbx-dot" style={{ background: V_C[v.vertical] || C.muted }} />{v.vertical}
                              </td>
                              <td className="num">{v.orders}</td>
                              <td className="num">{v.units ?? '–'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* Month by month, straight off the row the server already sent
                    — no second fetch, and it cannot disagree with the figures
                    above because it is the same array they were summed from. */}
                {(r.byMonth ?? []).length > 0 && (
                  <>
                    <div className="lbx-drawer-h" style={{ marginTop: 16 }}>By month</div>
                    <div className="table-scroll">
                      <table className="data-table tbl-fit">
                        <thead><tr><th>Month</th><th className="num">Orders</th><th className="num">Units</th></tr></thead>
                        <tbody>
                          {[...(r.byMonth ?? [])].reverse().map((m) => (
                            <tr key={m.month}>
                              <td>{monthLabel(m.month)}</td>
                              <td className="num">{m.orders}</td>
                              <td className="num">{m.units ?? '–'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* THE LINE THAT KEEPS THIS HONEST. A supervisor gets volume,
                    not pay — the server nulls commission, payable, waiting and
                    revenue on a sub-rep's row exactly as on any other peer's. */}
                <div className="lbx-drawer-foot">
                  🔒 Volume only. {r.rep}&rsquo;s pay is between them and finance.
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The signed-in rep's own breakdown, as a slide-up drawer.
 *
 * Devices are not on the rep-overview payload — only a distinct COUNT — so the
 * per-device rows come from /api/order-analytics, which is already scoped to
 * the caller's own orders by the server. Fetched when the drawer opens rather
 * than on page load: most logins never open it.
 */
function OwnDrawer({ rep, viewAs, onClose }: { rep: RepRow; viewAs?: string | null; onClose: () => void }) {
  const [orders, setOrders] = useState<AnalyticsOrder[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    fetchOrderAnalytics(viewAs)
      .then((a) => { if (live) setOrders(a.orders); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load your breakdown.'); });
    return () => { live = false; };
  }, [viewAs]);

  const byDevice = useMemo(() => {
    if (!orders) return [];
    const m = new Map<string, { item: string; units: number; orders: number }>();
    for (const o of orders) {
      for (const d of o.devices) {
        const k = shortDeviceName(d.item);
        const e = m.get(k) ?? { item: k, units: 0, orders: 0 };
        e.units += d.qty; e.orders++; m.set(k, e);
      }
    }
    return [...m.values()].sort((a, b) => b.units - a.units || a.item.localeCompare(b.item));
  }, [orders]);

  const verts = rep.byVertical.filter((v) => v.orders > 0);

  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
    <div className="lbx-drawer-back" onClick={onClose}>
      <div className="lbx-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${rep.rep}: your breakdown`}>
        <div className="lbx-drawer-grip" aria-hidden="true" />
        <div className="lbx-drawer-head">
          <div>
            <div className="lbx-drawer-title">{rep.rep}</div>
            <div className="lbx-drawer-sub">
              {rep.orders} order{rep.orders === 1 ? '' : 's'}
              {rep.units != null && <> · {rep.units} unit{rep.units === 1 ? '' : 's'}</>}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="lbx-drawer-body">
          <div className="lbx-drawer-h">By vertical</div>
          <div className="table-scroll">
            <table className="data-table tbl-fit">
              <thead><tr><th>Vertical</th><th className="num">Orders</th><th className="num">Units</th></tr></thead>
              <tbody>
                {verts.length === 0 && <tr><td colSpan={3} style={{ color: C.muted }}>No orders yet.</td></tr>}
                {verts.map((v) => (
                  <tr key={v.vertical}>
                    <td style={{ fontWeight: 700, color: V_C[v.vertical] || C.ink }}>
                      <span className="lbx-dot" style={{ background: V_C[v.vertical] || C.muted }} />{v.vertical}
                    </td>
                    <td className="num">{v.orders}</td>
                    <td className="num">{v.units ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="lbx-drawer-h" style={{ marginTop: 16 }}>
            By device {byDevice.length > 0 && <span className="lbx-count">· {byDevice.length}</span>}
          </div>
          {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          {!orders && !err && <div style={{ fontSize: 13, color: C.muted, padding: '10px 2px' }}>Loading your devices…</div>}
          {orders && (
            <div className="table-scroll">
              <table className="data-table tbl-fit">
                <thead><tr><th>Device</th><th className="num">Units</th><th className="num">Orders</th></tr></thead>
                <tbody>
                  {byDevice.length === 0 && <tr><td colSpan={3} style={{ color: C.muted }}>No devices on your orders.</td></tr>}
                  {byDevice.map((d) => (
                    <tr key={d.item}><td>{d.item}</td><td className="num">{d.units}</td><td className="num">{d.orders}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="lbx-drawer-foot">🔒 Counts only. Pay is on My Commission.</div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

export function Leaderboard({ reps, months, viewAs, boardScoped }: { reps: RepRow[]; months?: string[]; viewAs?: string | null; boardScoped?: boolean }) {
  const [open, setOpen] = useState<RepRow | null>(null);
  // Collapsed by default: the board is a ranking first, and a supervisor's
  // sub-rep detail is a second question they choose to ask.
  const [subOpen, setSubOpen] = useState(false);
  const [vertFilter, setVertFilter] = useState<string>('all');
  const selfRowRef = useRef<HTMLButtonElement | null>(null);

  // THE PERIOD, and it opens on THE CURRENT MONTH.
  //
  // It used to open on all time, on the reasoning that this is the rep's own
  // standing and a lifetime board should not reshuffle every 1st. Changed by
  // instruction: the board is now read as "how am I doing this month", which is
  // the question a rep actually opens it with, and it matches the manager's
  // board rather than sitting one period behind it.
  //
  // THE BADGES ARE UNAFFECTED, and that is what makes this safe. `ranked` below
  // keeps `lifetimeOrders` alongside the scoped `orders` precisely so the
  // milestone badges and the confetti stay on the lifetime figure — an
  // achievement is not un-earned by a quiet month.
  //
  // defaultMonth() handles the 1st-of-the-month case the old comment worried
  // about: it falls back to the newest month that HAS orders rather than
  // opening on an empty board that reads as a failed load.
  const available = months ?? [];
  // `null` means "nobody has picked one", NOT "all time" — `months` arrives with
  // the payload, so a plain useState(defaultMonth(available)) would evaluate on
  // the first render, when the list is still empty, and lock the board to the
  // ALL_TIME fallback forever. Resolving on each render instead lets the default
  // settle once the months land, while any explicit choice still wins.
  const [month, setMonth] = useState<string | null>(null);
  const chosen = month ?? defaultMonth(available);
  // A month that no longer exists — the payload changes under a rep preview —
  // must not strand the board on an empty period it cannot get out of.
  const period = chosen === ALL_TIME || available.includes(chosen) ? chosen : ALL_TIME;
  const scoped = period !== ALL_TIME;

  // Producers only, ranked on the order count IN THE SELECTED PERIOD. Ties break
  // on name so the order cannot jitter between renders.
  //
  // Projected onto the period first, then ranked: `byMonth` carries the same
  // fields the aggregate does, so the bars, the vertical legend and the drill
  // all read a normal RepRow and need no notion of a period. A rep who booked
  // nothing that month drops off rather than sitting last on zero — they are
  // absent from the month, not losing it.
  //
  // WITH ONE EXCEPTION: A REP WHO HAS NEVER BOOKED AT ALL.
  //
  // The rule above was written for established producers, where "no orders this
  // month" genuinely means absent from the month. It reads differently for a rep
  // who has just been added to the roster: they are not absent from August, they
  // have not started. Dropping them makes a newly-added rep invisible on every
  // month, which is indistinguishable from the roster edit never having taken —
  // and that is exactly how Alyssa Parker read after being added.
  //
  // `lifetimeOrders` is the aggregate count and is already carried beside the
  // period count for the badges, so the two cases separate cleanly: zero this
  // month but some ever → still drops off, unchanged; zero ever → shown at zero,
  // until their first order puts them under the original rule with everyone
  // else.
  //
  // `orders` is overwritten but `lifetimeOrders` is kept beside it, because the
  // milestone badges and the confetti below MUST stay on the lifetime figure:
  // an achievement is not un-earned by a quiet month, and a board that took a
  // rep's 150-order badge away for looking at August would be lying about what
  // they have done.
  const ranked = useMemo(() => reps
    .map((r) => {
      const m = scoped ? (r.byMonth ?? []).find((x) => x.month === period) : null;
      // `rank` follows the period too: the month row carries its own, ranked
      // over the same whole field. Overwriting it here means everything
      // downstream reads one `rank` and never has to know which period it came
      // from.
      const row = scoped
        ? { ...r, orders: m?.orders ?? 0, units: m?.units ?? null, byVertical: m?.byVertical ?? [], rank: m?.rank, boardRank: m?.boardRank }
        : r;
      return { ...row, lifetimeOrders: r.orders };
    })
    .filter((r) => (!r.standingsExcluded || r.isSelf)
      && (!scoped || r.orders > 0 || r.lifetimeOrders === 0))
    .sort((a, b) => b.orders - a.orders || a.rep.localeCompare(b.rep)), [reps, period, scoped]);

  // The reps who work under the viewer. `subRepOf` is only ever set by the
  // server when the caller IS the supervisor, so this is empty on every other
  // login and the roll-down never renders for them.
  const mySubReps = useMemo(() => ranked.filter((r) => Boolean(r.subRepOf)), [ranked]);

  // A SUB-REP DOES NOT ALSO STAND ON THE BOARD. Their detail lives inside their
  // supervisor's card, and leaving the row in as well listed the same person
  // twice in one view.
  //
  // THEIR RANK IS NOT REDISTRIBUTED. `rank` comes off the server, computed over
  // the whole producing field before anything was withheld, so pulling Jillian
  // out at 2nd leaves 2nd vacant — Christy stays 3rd rather than being promoted
  // into a place she does not hold. The podium renders an unclaimed silver,
  // which is the honest way to draw a gap.
  //
  // Everything below reads `board`, not `ranked`: the chase line, the podium
  // split and the "scroll me into view" all describe what is on screen.
  const board = useMemo(() => ranked.filter((r) => !r.subRepOf), [ranked]);

  const self = board.find((r) => r.isSelf) ?? null;
  // POSITION COMES FROM `rank`, NOT FROM THE ARRAY. The server stamps `rank`
  // over the whole producing field and may then withhold a row — Jillian works
  // under Alle and does not receive Alle's row (REP_BLINDSPOTS). Reading
  // position off the array index would let that removal promote everyone below
  // it: Jillian's 99 would sit at index 0 and the board would announce her as
  // top with Alle's 185 simply absent. A withheld rep leaves a GAP in the
  // numbering instead.
  //
  // The server stamps it for the all-time board AND for each month, and the
  // projection above swaps in the month's when a period is selected — so this
  // reads one field either way. The array index survives only as the fallback
  // for a payload that predates `rank`, where the field is whole anyway.
  // WHAT THE BOARD DRAWS, and it is deliberately NOT the true field position.
  //
  // A withheld rep used to leave a hole: Jillian's board opened at 2nd with no
  // 1st, which reads as broken and says out loud that a row is missing.
  // `boardRank` is contiguous over the rows this viewer received, so the board
  // numbers what is on it.
  const rankOf = (r: RepRow, i: number) => (typeof r.boardRank === 'number' ? r.boardRank
    : typeof r.rank === 'number' ? r.rank : i + 1);
  // THE TRUE POSITION, for anything that makes a CLAIM rather than draws a list.
  // With Alle withheld, Jillian's boardRank is 1 on 102 orders while Alle sits
  // above her on 185 — drawing that is fine, congratulating her on it is the
  // portal telling her she has overtaken someone she has not.
  const trueRankOf = (r: RepRow, i: number) => (typeof r.rank === 'number' ? r.rank : rankOf(r, i));
  const selfArrIdx = board.findIndex((r) => r.isSelf);
  // 0-based, so every comparison below (`=== 0` for the leader, `> 0` for a
  // chaser) keeps reading the way it did.
  const selfIdx = self ? rankOf(self, selfArrIdx) - 1 : -1;
  const leader = board[0]?.orders ?? 0;
  const canOpen = (r: RepRow) => Boolean(r.own);

  // Verticals actually present, for the legend and the filter tabs.
  const verticals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ranked) for (const v of r.byVertical) if (v.orders > 0) m.set(v.vertical, (m.get(v.vertical) ?? 0) + v.orders);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [ranked]);

  // The motivator: how many orders separate the signed-in rep from the rank
  // above. Only meaningful when somebody is above them.
  //
  // The ARRAY index, not the rank, because this has to name a rep — and the one
  // immediately above by rank may be withheld from this viewer. Jillian is 2nd
  // and cannot see Alle at 1st, so she is first in her own array and gets no
  // chase line at all. Reading `ranked[selfIdx - 1]` would have handed her
  // `ranked[0]`, which is Jillian: "Dead level with Jillian on 99."
  const ahead = selfArrIdx > 0 ? board[selfArrIdx - 1] : null;
  const gap = ahead && self ? ahead.orders - self.orders : 0;

  // Confetti fires ONCE per achievement, per rep, per browser. Without the
  // localStorage guard it would replay on every mount — which turns a reward
  // into noise and, worse, makes it meaningless.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!self || REDUCED) return;
    // LIFETIME, and rank-1 only counts ALL TIME. Firing on a month would
    // celebrate topping a quiet August, and the localStorage key would burn the
    // one-per-achievement guard on it — so the real thing, when it came, would
    // pass in silence. A reward that can be triggered by changing a dropdown is
    // not a reward.
    const badge = badgeFor(self.lifetimeOrders);
    // TRUE RANK, NOT BOARD RANK. `selfIdx` is drawn from `boardRank`, which
    // renumbers over the rows this viewer received — with Alle withheld that
    // puts Jillian at position 1 on 102 orders while Alle leads on 185. Drawing
    // a 1 there is her board; firing the top-of-the-board celebration on it
    // would be a claim the data does not support, and the one-per-achievement
    // key would burn the real one when it finally came.
    const selfTrue = trueRankOf(self, selfArrIdx);
    const mark = (!scoped && selfTrue === 1) ? 'rank1' : badge ? `m${badge}` : null;
    if (!mark) return;
    const key = `smr.lb.${self.rep}.${mark}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch { /* private mode: celebrate, just do not remember */ }
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 2600);
    return () => clearTimeout(t);
  }, [self, selfIdx, scoped]);

  // Pin the rep's own row into view when it sits below the fold.
  useEffect(() => {
    if (!selfRowRef.current || selfIdx < 3) return;
    const el = selfRowRef.current;
    const t = setTimeout(() => {
      el.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
    }, 400);
    return () => clearTimeout(t);
  }, [selfIdx]);

  if (!ranked.length) return null;

  // SPLIT BY TRUE RANK, not by array position. With a rep withheld from this
  // viewer (REP_BLINDSPOTS) the top three by array are not the top three on the
  // board — Jillian would take the gold medal off a field Alle is missing from.
  // Ranks 1–3 make the podium and whoever holds them is shown; a withheld rank
  // leaves its medal unclaimed, which is the honest way to render a gap.
  // `board` and `mySubReps` are resolved further up, beside `self` — the chase
  // line and the scroll-into-view need them too.
  const withRank = board.map((r, i) => ({ r, rank: rankOf(r, i) }));
  const podium = withRank.filter((x) => x.rank <= 3);
  const rest = withRank.filter((x) => x.rank > 3);
  const inFilter = (r: RepRow) => vertFilter === 'all' || r.byVertical.some((v) => v.vertical === vertFilter && v.orders > 0);

  const row = ({ r, rank }: { r: RankedRep; rank: number }) => {
    // LIFETIME, like the confetti above. A milestone badge says "this rep has
    // booked 150 orders", which stays true whichever month is on screen.
    const badge = badgeFor(r.lifetimeOrders);
    const isSelf = r.isSelf;
    // THE SAME ROLL-DOWN, for a supervisor who is not in the top three. The
    // board defaults to the current month now, so whether Alle is on the podium
    // depends on the month — without this her sub-rep panel would vanish for any
    // period she did not lead, which reads as the feature being broken.
    const body = (
      <button ref={isSelf ? selfRowRef : undefined}
        className={`lbx-row${isSelf ? ' is-self' : ''}`}
        disabled={!canOpen(r)}
        onClick={canOpen(r) ? () => setOpen(r) : undefined}
        title={canOpen(r) ? 'Open your breakdown' : `${r.rep}'s breakdown is theirs to open`}
        style={{ opacity: inFilter(r) ? 1 : 0.35 }}>
        <span className="lbx-rank">{rank}</span>
        <span className="lbx-name">
          <span className="lbx-name-t">{r.rep}</span>
          {badge && <span className="lbx-badge" title={`${badge}+ orders`}>{badge}</span>}
          {/* Only ever set when the VIEWER is this rep's supervisor — see
              subRepOf on the payload. Their figures are untouched by it.
              NAMES THE SUPERVISOR: "sub-rep" alone said that somebody is above
              this rep without saying who, which left the reader with the half of
              the fact they cannot use. */}
          {r.subRepOf && <span className="lbx-sub" title={`SMR pays ${r.subRepOf}, who pays ${r.rep}`}>under {r.subRepOf}</span>}
          {isSelf && <span className="lbx-you">You</span>}
        </span>
        <MixPill parts={r.byVertical} total={r.orders} scale={leader ? r.orders / leader : 0} />
        <span className="lbx-orders"><b>{r.orders}</b> orders</span>
      </button>
    );
    if (!isSelf || !mySubReps.length) return <div key={r.rep} className="lbx-rowwrap">{body}</div>;
    return (
      <div key={r.rep} className="lbx-rowwrap has-subs">
        {body}
        <SubReps subs={mySubReps} open={subOpen} onToggle={() => setSubOpen((v) => !v)} />
      </div>
    );
  };

  return (
    <div className="section chart-card lbx" style={{ marginBottom: 0, position: 'relative' }}>
      {celebrate && <Confetti />}

      <div className="section-head" style={{ minHeight: 0, marginBottom: 8, alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 className="section-title" style={{ fontSize: 15 }}>Leaderboard</h2>
          <div className="section-sub">
            By orders booked, {scoped ? <b>{monthLabel(period)}</b> : 'all time'}.
            {self ? ' Tap your row for your full breakdown.' : ''}
            {/* SAYS WHOSE BOARD THIS IS. The positions are renumbered over the
                reps on it, so without this a 1st reads as a claim about the
                whole team. Only shown when a rep is actually withheld — on an
                admin's board, and on a rep's with nobody hidden, the two
                numberings are identical and the caveat would be noise. */}
            {boardScoped ? ' Ranked among the reps on your board.' : ''}
          </div>
        </div>
        <MonthSelect months={available} month={period} onMonth={setMonth}
          title="Rank this board on a single month, or on the whole book. Milestone badges always count all time." />
      </div>

      {/* The motivator. Placed above the board so it is the first thing read. */}
      {self && ahead && gap > 0 && (() => {
        const m = chaseLine(gap, ahead.rep, selfIdx);
        return (
          <div className="lbx-gap">
            <span className="lbx-gap-i" aria-hidden="true">{m.icon}</span>
            <span>{m.text}</span>
          </div>
        );
      })()}
      {/* Level on orders: there is no gap to close, only a tie to break. */}
      {self && ahead && gap === 0 && (
        <div className="lbx-gap">
          <span className="lbx-gap-i" aria-hidden="true">🤝</span>
          <span>Dead level with <b>{ahead.rep}</b> on <b>{self.orders}</b>. The next order takes #{selfIdx}.</span>
        </div>
      )}
      {self && selfIdx === 0 && (
        <div className="lbx-gap is-first">
          <span className="lbx-gap-i" aria-hidden="true">🏆</span>
          <span>
            Top of the board — <b>{self.orders}</b> orders.
            {/* `board`, not `ranked`: naming a rep who is not on screen — a
                sub-rep folded into this very card — would read as a phantom. */}
            {board[1]
              ? <> <b>{self.orders - board[1].orders}</b> clear of {board[1].rep}. Hold it.</>
              : <> Nobody else on the board yet.</>}
          </span>
        </div>
      )}

      {/* Vertical LEGEND + filter. The trails are multi-colour; without this
          they are decoration nobody can decode. */}
      {verticals.length > 1 && (
        <div className="lbx-legend">
          <button className={`lbx-leg${vertFilter === 'all' ? ' on' : ''}`} onClick={() => setVertFilter('all')}>All</button>
          {verticals.map((v) => (
            <button key={v} className={`lbx-leg${vertFilter === v ? ' on' : ''}`} onClick={() => setVertFilter(vertFilter === v ? 'all' : v)}>
              <span className="lbx-dot" style={{ background: V_C[v] || C.muted }} />{v}
            </button>
          ))}
        </div>
      )}

      {/* PODIUM: the top three, largest first. */}
      <div className="lbx-podium">
        {podium.map(({ r, rank }) => (
          // A WRAPPER, not a <button>. The card used to BE the button, which
          // left nowhere to put the sub-rep toggle: nesting a second button
          // inside one is invalid markup and unreachable by keyboard. The chrome
          // (border, medal ring, lift on hover) lives on this div now and the
          // clickable face is `.lbx-pod-main` inside it, so the card looks
          // identical and the toggle can sit beside it as a sibling.
          <div key={r.rep}
            className={`lbx-pod lbx-pod-${rank}${r.isSelf ? ' is-self' : ''}${canOpen(r) ? ' is-clickable' : ''}`}
            style={{ ['--ring' as string]: MEDAL[rank - 1].ring, ['--soft' as string]: MEDAL[rank - 1].soft, opacity: inFilter(r) ? 1 : 0.4 }}>
          <button ref={r.isSelf ? selfRowRef : undefined}
            className="lbx-pod-main"
            disabled={!canOpen(r)}
            onClick={canOpen(r) ? () => setOpen(r) : undefined}
            title={canOpen(r) ? 'Open your breakdown' : `${r.rep}'s breakdown is theirs to open`}>
            <span className="lbx-pod-medal" aria-hidden="true">{MEDAL[rank - 1].glyph}</span>
            <span className="lbx-pod-rank">{MEDAL[rank - 1].label}</span>
            <span className="lbx-pod-name">
              {r.rep}
              {r.subRepOf && <span className="lbx-sub" title={`SMR pays ${r.subRepOf}, who pays ${r.rep}`}>under {r.subRepOf}</span>}
              {r.isSelf && <span className="lbx-you">You</span>}
            </span>
            <span className="lbx-pod-n">
              <AnimatedNumber value={r.orders} duration={700} format={(n) => String(Math.round(n))} />
            </span>
            <span className="lbx-pod-u">orders</span>
            {badgeFor(r.lifetimeOrders) && <span className="lbx-badge" title={`${badgeFor(r.lifetimeOrders)}+ orders, all time`}>{badgeFor(r.lifetimeOrders)}</span>}
            <MixPill parts={r.byVertical} total={r.orders} scale={leader ? r.orders / leader : 0} />
          </button>
          {r.isSelf && <SubReps subs={mySubReps} open={subOpen} onToggle={() => setSubOpen((v) => !v)} />}
          </div>
        ))}
      </div>

      {rest.length > 0 && <div className="lbx-rows">{rest.map(row)}</div>}

      {open && <OwnDrawer rep={open} viewAs={viewAs} onClose={() => setOpen(null)} />}
    </div>
  );
}
