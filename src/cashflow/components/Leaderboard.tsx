import { useEffect, useMemo, useRef, useState } from 'react';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { AnimatedNumber } from '../chartKit';
import { fetchOrderAnalytics, type RepRow, type AnalyticsOrder } from '../strivenApi';
import { shortDeviceName } from './DeviceChips';

/**
 * The rep leaderboard: the first thing a rep sees on login.
 *
 * COUNTS ONLY — orders, units, devices. No revenue, no commission, no dollar
 * figure anywhere on this component or in the drawer it opens. That is not a
 * styling choice: the server withholds peers' money entirely, so there is
 * nothing to render even if someone added a column for it.
 *
 * RANKED ON OVERALL ORDERS. Two things in the original brief were dropped
 * because they cannot exist under that rule:
 *   · rank movement vs the previous period — an overall count has no periods to
 *     move between, and the payload carries no per-period history to derive one
 *   · a period selector — same reason; filtering by month would contradict a
 *     board that ranks on the all-time total
 * Both are a small server change away (a per-month order count per rep) if the
 * ranking basis ever changes.
 *
 * A rep may open ONLY their own row. `own` is the server's word for "this row
 * arrived unredacted": true for every row an admin sees, true only for the
 * caller's own row for a rep. Peer rows are inert — not merely unstyled.
 */

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

          <div className="lbx-drawer-h" style={{ marginTop: 16 }}>
            By device {byDevice.length > 0 && <span className="lbx-count">· {byDevice.length}</span>}
          </div>
          {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          {!orders && !err && <div style={{ fontSize: 13, color: C.muted, padding: '10px 2px' }}>Loading your devices…</div>}
          {orders && (
            <table className="data-table tbl-fit">
              <thead><tr><th>Device</th><th className="num">Units</th><th className="num">Orders</th></tr></thead>
              <tbody>
                {byDevice.length === 0 && <tr><td colSpan={3} style={{ color: C.muted }}>No devices on your orders.</td></tr>}
                {byDevice.map((d) => (
                  <tr key={d.item}><td>{d.item}</td><td className="num">{d.units}</td><td className="num">{d.orders}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="lbx-drawer-foot">🔒 Counts only. Pay is on My Commission.</div>
        </div>
      </div>
    </div>
  );
}

export function Leaderboard({ reps, viewAs }: { reps: RepRow[]; viewAs?: string | null }) {
  const [open, setOpen] = useState<RepRow | null>(null);
  const [vertFilter, setVertFilter] = useState<string>('all');
  const selfRowRef = useRef<HTMLButtonElement | null>(null);

  // Producers only, ranked on the OVERALL order count — the basis chosen for
  // this board. Ties break on name so the order cannot jitter between renders.
  const ranked = useMemo(() => [...reps]
    .filter((r) => !r.standingsExcluded || r.isSelf)
    .sort((a, b) => b.orders - a.orders || a.rep.localeCompare(b.rep)), [reps]);

  const self = ranked.find((r) => r.isSelf) ?? null;
  const selfIdx = ranked.findIndex((r) => r.isSelf);
  const leader = ranked[0]?.orders ?? 0;
  const canOpen = (r: RepRow) => Boolean(r.own);

  // Verticals actually present, for the legend and the filter tabs.
  const verticals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ranked) for (const v of r.byVertical) if (v.orders > 0) m.set(v.vertical, (m.get(v.vertical) ?? 0) + v.orders);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [ranked]);

  // The motivator: how many orders separate the signed-in rep from the rank
  // above. Only meaningful when somebody is above them.
  const ahead = selfIdx > 0 ? ranked[selfIdx - 1] : null;
  const gap = ahead && self ? ahead.orders - self.orders : 0;

  // Confetti fires ONCE per achievement, per rep, per browser. Without the
  // localStorage guard it would replay on every mount — which turns a reward
  // into noise and, worse, makes it meaningless.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!self || REDUCED) return;
    const badge = badgeFor(self.orders);
    const mark = selfIdx === 0 ? 'rank1' : badge ? `m${badge}` : null;
    if (!mark) return;
    const key = `smr.lb.${self.rep}.${mark}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch { /* private mode: celebrate, just do not remember */ }
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 2600);
    return () => clearTimeout(t);
  }, [self, selfIdx]);

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

  const podium = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const inFilter = (r: RepRow) => vertFilter === 'all' || r.byVertical.some((v) => v.vertical === vertFilter && v.orders > 0);

  const row = (r: RepRow, i: number) => {
    const rank = i + 4;
    const badge = badgeFor(r.orders);
    const isSelf = r.isSelf;
    return (
      <button key={r.rep} ref={isSelf ? selfRowRef : undefined}
        className={`lbx-row${isSelf ? ' is-self' : ''}`}
        disabled={!canOpen(r)}
        onClick={canOpen(r) ? () => setOpen(r) : undefined}
        title={canOpen(r) ? 'Open your breakdown' : `${r.rep}'s breakdown is theirs to open`}
        style={{ opacity: inFilter(r) ? 1 : 0.35 }}>
        <span className="lbx-rank">{rank}</span>
        <span className="lbx-name">
          <span className="lbx-name-t">{r.rep}</span>
          {badge && <span className="lbx-badge" title={`${badge}+ orders`}>{badge}</span>}
          {isSelf && <span className="lbx-you">You</span>}
        </span>
        <MixPill parts={r.byVertical} total={r.orders} scale={leader ? r.orders / leader : 0} />
        <span className="lbx-orders"><b>{r.orders}</b> orders</span>
      </button>
    );
  };

  return (
    <div className="section chart-card lbx" style={{ marginBottom: 0, position: 'relative' }}>
      {celebrate && <Confetti />}

      <div className="section-head" style={{ minHeight: 0, marginBottom: 8 }}>
        <div>
          <h2 className="section-title" style={{ fontSize: 15 }}>Leaderboard</h2>
          <div className="section-sub">
            By orders booked, all time.{self ? ' Tap your row for your full breakdown.' : ''}
          </div>
        </div>
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
            {ranked[1]
              ? <> <b>{self.orders - ranked[1].orders}</b> clear of {ranked[1].rep}. Hold it.</>
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
        {podium.map((r, i) => (
          <button key={r.rep} ref={r.isSelf ? selfRowRef : undefined}
            className={`lbx-pod lbx-pod-${i + 1}${r.isSelf ? ' is-self' : ''}`}
            disabled={!canOpen(r)}
            onClick={canOpen(r) ? () => setOpen(r) : undefined}
            title={canOpen(r) ? 'Open your breakdown' : `${r.rep}'s breakdown is theirs to open`}
            style={{ ['--ring' as string]: MEDAL[i].ring, ['--soft' as string]: MEDAL[i].soft, opacity: inFilter(r) ? 1 : 0.4 }}>
            <span className="lbx-pod-medal" aria-hidden="true">{MEDAL[i].glyph}</span>
            <span className="lbx-pod-rank">{MEDAL[i].label}</span>
            <span className="lbx-pod-name">
              {r.rep}
              {r.isSelf && <span className="lbx-you">You</span>}
            </span>
            <span className="lbx-pod-n">
              <AnimatedNumber value={r.orders} duration={700} format={(n) => String(Math.round(n))} />
            </span>
            <span className="lbx-pod-u">orders</span>
            {badgeFor(r.orders) && <span className="lbx-badge" title={`${badgeFor(r.orders)}+ orders`}>{badgeFor(r.orders)}</span>}
            <MixPill parts={r.byVertical} total={r.orders} scale={leader ? r.orders / leader : 0} />
          </button>
        ))}
      </div>

      {rest.length > 0 && <div className="lbx-rows">{rest.map(row)}</div>}

      {open && <OwnDrawer rep={open} viewAs={viewAs} onClose={() => setOpen(null)} />}
    </div>
  );
}
