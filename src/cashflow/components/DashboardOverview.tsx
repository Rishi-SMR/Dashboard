import { useEffect, useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { fetchOrderAnalytics, fetchPiStages, type OrderAnalytics, type PiStages, type RepRow } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { shortDeviceName } from './DeviceChips';

// Palettes below were checked with the categorical validator, not chosen by eye.
//
// TriCare was #0D9488: against the reserved gray for Unclassified it scored ΔE
// 14.8 to normal vision: under the 15 floor, i.e. two slices most people cannot
// reliably tell apart. #0F766E takes that pair to 21.6 normal / 18.1 CVD.
// Lighter teals are worse, not better (#14B8A6 collapses to 11.9): the gray sits
// mid-lightness, so separation comes from going darker.
//
// Residual, accepted: teal at this lightness tops out near 0.094 chroma in sRGB,
// so it trips the 0.1 chroma floor no matter which step is taken; and the
// Unclassified gray is deliberately low-chroma: it is a null bucket, not a
// series. Gray's 2.5:1 contrast obligates visible labels, which the legend under
// each donut supplies.
// 'Order received' was #64748B: gray reads as "no data" rather than "stage one",
// and it is a real stage with real orders in it. Violet clears the chroma floor
// and the whole strip now passes every check.
const STAGE_C: Record<string, string> = {
  'Order received': '#8B5CF6', 'Awaiting LOP': '#D97706', Dispensed: '#0A369F', Shipped: '#0891B2', Delivered: '#16A34A',
};
// The fixed categorical order, validated at CVD ΔE 10.3 / normal-vision 20.2,
// this exact sequence, not these seven colours in any arrangement. Reordering
// puts green next to pink and drops the pair to 6.1.
//
// It is never cycled: an eighth category folds into the reserved gray below.
const CAT7 = ['#DB2777', '#0891B2', '#D97706', '#0A369F', '#65A30D', '#7C3AED', '#16A34A'];
const OTHER_C = '#94A3B8';
const MAX_SLICES = 7;

/** `key` is the value this slice filters BY. Absent means the slice is not
 *  clickable: a folded "Other (12)" bucket has no single value to filter to. */
type Slice = { name: string; value: number; color: string; key?: string };

/**
 * Ranks the FULL, unfiltered dataset once and pins a hue to each leading entity
 * permanently.
 *
 * This is what lets the filters be safe. Colour follows the entity, not its
 * rank: so narrowing to one vertical changes how big the slices are without
 * repainting the survivors, and a category that filters out never hands its
 * colour to whoever moves up into its position.
 */
function pinColors(totals: Map<string, number>): Map<string, string> {
  const top = [...totals.entries()]
    // Name breaks ties, so equal values can't reshuffle hues between renders.
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, MAX_SLICES);
  return new Map(top.map(([k], i) => [k, CAT7[i]]));
}

/** Everything outside the pinned set collapses into one gray slice. */
function foldSlices(totals: Map<string, number>, pinned: Map<string, string>, otherLabel = 'Other'): Slice[] {
  const out: Slice[] = [];
  let rest = 0;
  let restCount = 0;
  for (const [name, value] of totals) {
    const color = pinned.get(name);
    if (color) out.push({ name, value, color, key: name });
    else { rest += value; restCount++; }
  }
  out.sort((x, y) => y.value - x.value);
  // No `key`: a fold of many categories has no single value to filter to.
  if (rest > 0) out.push({ name: `${otherLabel} (${restCount})`, value: rest, color: OTHER_C });
  return out;
}

/** Sums `pick` per key across orders. */
function tally<T>(rows: T[], key: (r: T) => string, pick: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + pick(r));
  }
  return m;
}

const PERIODS = [
  { k: 'all', label: 'All time' },
  { k: '7', label: 'Last 7 days' },
  { k: 'mtd', label: 'This month' },
  { k: '30', label: 'Last 30 days' },
  { k: '90', label: 'Last 90 days' },
  { k: 'ytd', label: 'This year' },
  { k: 'custom', label: 'Custom range…' },
];

/** Matches the select height so the row stays on one baseline. */
const dateBox: React.CSSProperties = {
  padding: '4px 7px', borderRadius: 7, fontSize: 12.5, fontWeight: 600,
  color: 'inherit', background: 'var(--panel)',
  border: '1px solid var(--border-strong, var(--border))', cursor: 'pointer',
  fontVariantNumeric: 'tabular-nums',
};

/** `YYYY-MM-DD` in LOCAL time: `toISOString()` would shift the date across the
 *  day boundary for anyone west of UTC, so an order booked today could land on
 *  yesterday's date in the picker. */
const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * One control in the filter bar.
 *
 * Label sits INLINE with the select rather than stacked above it. Stacking made
 * each control two lines tall, which: across three controls plus the card's
 * 22px padding: turned a filter row into a block of mostly empty card.
 */
function Field({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { k: string; label: string }[];
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none', padding: '5px 24px 5px 9px', borderRadius: 7, fontSize: 12.5, fontWeight: 600,
          color: C.ink, background: 'var(--panel)', border: '1px solid var(--border-strong, var(--border))',
          cursor: 'pointer', maxWidth: 150,
          backgroundImage: 'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
          backgroundPosition: 'right 10px top 55%, right 5px top 55%',
          backgroundSize: '5px 5px, 5px 5px', backgroundRepeat: 'no-repeat',
        }}>
        {options.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
      </select>
    </label>
  );
}

/**
 * A summary donut. The hole carries the total, so the chart answers "how much
 * altogether" and "how is it split" in one glance rather than needing a legend
 * lookup for the headline figure.
 */
function Donut({ title, sub, slices, total, fmt = (n: number) => String(n), empty, activeKey, onPick }: {
  title: string; sub?: string; slices: Slice[]; total: number;
  fmt?: (n: number) => string; empty?: string;
  /** The value currently filtered to, if this chart's dimension is filtered. */
  activeKey?: string | null;
  /** Toggles the filter. Absent means this chart is read-only. */
  onPick?: (key: string) => void;
}) {
  const live = slices.filter((s) => s.value > 0);
  // Hovering either the ring or its legend row focuses the same slice: the two
  // are one control, so the legend is a way to read the chart, not just a key.
  const [hot, setHot] = useState<number | null>(null);
  const pct = (v: number) => (total ? Math.round((v / total) * 100) : 0);
  const pickable = (s: Slice) => Boolean(onPick && s.key);
  const pick = (s: Slice) => { if (onPick && s.key) onPick(s.key); };
  return (
    // height:100% lets the grid stretch all four to the tallest, so the row has
    // one baseline instead of four ragged card bottoms.
    <div className="section chart-card" style={{ marginTop: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="section-head" style={{ minHeight: 52, alignItems: 'flex-start' }}><div>
        <h2 className="section-title" style={{ fontSize: 15 }}>{title}</h2>
        {sub && <div className="section-sub">{sub}</div>}
      </div></div>

      {live.length === 0 ? (
        // Fills the card instead of leaving the stretched remainder blank.
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '26px 4px', fontSize: 13, color: C.muted }}>
          {empty ?? 'Nothing to show yet.'}
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', height: 168 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                {/* A 2px surface-coloured ring between segments, so touching
                    fills never blend into one another at the seam. */}
                <Pie data={live} dataKey="value" nameKey="name" cx="50%" cy="50%"
                  innerRadius={52} outerRadius={76} paddingAngle={2}
                  stroke="var(--panel)" strokeWidth={2} isAnimationActive={false}
                  onMouseEnter={(_: unknown, i: number) => setHot(i)} onMouseLeave={() => setHot(null)}
                  onClick={(_: unknown, i: number) => pick(live[i])}>
                  {live.map((s, i) => {
                    // When this dimension is filtered, the chosen slice stays
                    // solid and the rest recede: the chart shows what the
                    // filter did rather than just re-rendering smaller.
                    const selected = activeKey != null && s.key === activeKey;
                    const dimmed = activeKey != null ? !selected : hot !== null && hot !== i;
                    return (
                      <Cell key={s.name} fill={s.color}
                        opacity={dimmed ? 0.24 : 1}
                        stroke={selected ? s.color : 'var(--panel)'}
                        strokeWidth={selected ? 3 : 2}
                        cursor={pickable(s) ? 'pointer' : 'default'}
                        style={{ transition: 'opacity .16s ease' }} />
                    );
                  })}
                </Pie>
                <Tooltip
                  formatter={(v: number, n: string) => [`${fmt(v)} · ${total ? Math.round((v / total) * 100) : 0}%`, n]}
                  contentStyle={{ borderRadius: 10, border: `1px solid ${C.muted}33`, fontSize: 12.5, boxShadow: '0 8px 24px rgba(20,36,58,.16)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* The hole is the headline: and on hover it becomes the readout for
                the focused slice, so the eye never leaves the ring to find the
                number it is pointing at. */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', padding: '0 46px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.4, fontVariantNumeric: 'tabular-nums', color: C.ink, transition: 'color .16s ease' }}>
                {hot === null ? fmt(total) : fmt(live[hot].value)}
              </div>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted, marginTop: 1, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hot === null ? 'total' : `${pct(live[hot].value)}% · ${live[hot].name}`}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 1, marginTop: 8 }}>
            {live.map((s, i) => {
              const on = hot === i;
              const selected = activeKey != null && s.key === activeKey;
              const can = pickable(s);
              return (
                <div key={s.name}
                  onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)}
                  {...(can ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    'aria-pressed': selected,
                    title: selected ? `Clear the ${s.name} filter` : `Filter to ${s.name}`,
                    onClick: () => pick(s),
                    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s); }
                    },
                  } : {})}
                  style={{
                    display: 'grid', gridTemplateColumns: '10px 1fr auto auto', gap: 8, alignItems: 'center',
                    fontSize: 12.5, padding: '3px 6px', margin: '0 -6px', borderRadius: 7,
                    cursor: can ? 'pointer' : 'default',
                    background: selected
                      ? `color-mix(in srgb, ${s.color} 16%, transparent)`
                      : on ? `color-mix(in srgb, ${s.color} 9%, transparent)` : 'transparent',
                    boxShadow: selected ? `inset 0 0 0 1px color-mix(in srgb, ${s.color} 45%, transparent)` : 'none',
                    opacity: activeKey != null ? (selected ? 1 : 0.45) : (hot === null || on ? 1 : 0.5),
                    transition: 'background-color .16s ease, opacity .16s ease',
                  }}>
                  {/* The swatch grows into a bar on focus: identity is never
                      carried by colour alone, and the shift confirms the hover. */}
                  <span aria-hidden="true" style={{
                    width: on ? 10 : 9, height: on ? 14 : 9, borderRadius: on ? 3 : 3,
                    background: s.color, transition: 'height .16s ease, width .16s ease',
                  }} />
                  <span style={{ color: on ? C.ink : C.sub, fontWeight: on ? 600 : 400, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'color .16s ease' }}>{s.name}</span>
                  <span style={{ fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(s.value)}</span>
                  <span style={{ color: on ? s.color : C.muted, fontWeight: on ? 700 : 400, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right', transition: 'color .16s ease' }}>
                    {pct(s.value)}%
                  </span>
                </div>
              );
            })}
          </div>

          {/* Cards in a row stretch to the tallest, so a donut with four legend
              rows sat above a block of dead space. `marginTop:auto` pins this
              strip to the bottom and spends that space on the concentration
              figure: how much of the whole the leaders actually account for,
              which is the question a part-to-whole chart invites next. */}
          <div style={{
            marginTop: 'auto', paddingTop: 10, display: 'flex', alignItems: 'baseline',
            justifyContent: 'space-between', gap: 8, fontSize: 11,
            borderTop: '1px solid var(--panel-2)', color: C.muted,
          }}>
            <span>{live.length} categor{live.length === 1 ? 'y' : 'ies'}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {live.length <= 1 ? '-' : (() => {
                const n = Math.min(3, live.length - 1);
                const lead = [...live].sort((x, y) => y.value - x.value).slice(0, n).reduce((s, x) => s + x.value, 0);
                return <>Top {n} · <b style={{ color: C.sub, fontWeight: 700 }}>{pct(lead)}%</b></>;
              })()}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The PI pipeline as a left-to-right funnel: one cell per stage in workflow
 * order, sized evenly so the sequence reads as a process rather than a ranking.
 * Empty stages stay visible: a gap in the middle of a pipeline is information.
 */
function StageStrip({ slices, unfiltered }: { slices: Slice[]; unfiltered?: boolean }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!slices.length) return null;
  return (
    <div className="section chart-card" style={{ marginTop: 0, marginBottom: 14 }}>
      <div className="section-head"><div>
        <h2 className="section-title" style={{ fontSize: 15 }}>PI pipeline</h2>
        <div className="section-sub">
          {total} Personal Injury order{total === 1 ? '' : 's'} by stage: a subset of the PI orders above. Left to right is the order of work.
        </div>
        {/* Honesty about scope: the stage store holds no dates and no rep, so
            the filters above genuinely cannot reach it. Say so rather than let
            it look filtered. */}
        {unfiltered && (
          <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: '#B45309', background: 'color-mix(in srgb, #D97706 12%, transparent)' }}>
            Not affected by the filters: current stage snapshot
          </div>
        )}
      </div></div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${slices.length}, 1fr)`, gap: 8, padding: '2px 2px 0' }}>
        {slices.map((s, i) => {
          const pct = total ? Math.round((s.value / total) * 100) : 0;
          const on = s.value > 0;
          return (
            <div key={s.name} title={`${s.name}: ${s.value} order${s.value === 1 ? '' : 's'}${on ? ` · ${pct}%` : ''}`}
              style={{
                position: 'relative', borderRadius: 10,
                background: on
                  ? `linear-gradient(180deg, color-mix(in srgb, ${s.color} 8%, transparent), color-mix(in srgb, ${s.color} 3%, transparent))`
                  : 'var(--panel-2)',
                padding: '11px 12px 12px', borderTop: `3px solid ${on ? s.color : `${s.color}44`}`,
                opacity: on ? 1 : 0.55, minWidth: 0,
              }}>
              {/* A chevron in the gutter turns five cards into one sequence. */}
              {i < slices.length - 1 && (
                <span aria-hidden="true" style={{
                  // Gutter is 8px; this centres the glyph in it.
                  position: 'absolute', right: -4, top: '50%',
                  transform: 'translate(50%, -50%) rotate(45deg)',
                  width: 7, height: 7, borderTop: `2px solid ${C.muted}`, borderRight: `2px solid ${C.muted}`,
                  opacity: .45, pointerEvents: 'none',
                }} />
              )}
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: C.muted }}>
                Stage {i + 1}
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: on ? s.color : C.muted, marginTop: 2, lineHeight: 1.3 }}>{s.name}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: on ? C.ink : C.muted, marginTop: 5, letterSpacing: -0.4, fontVariantNumeric: 'tabular-nums' }}>
                {s.value}
              </div>
              {/* Fill shows this stage's share, so the bottleneck is visible. */}
              <div style={{ height: 4, borderRadius: 999, background: 'var(--panel)', overflow: 'hidden', marginTop: 6 }}>
                <div style={{ height: '100%', width: `${pct}%`, background: s.color }} />
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{on ? `${pct}%` : 'empty'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A compact ranked list: the "top five" beside the charts. */
function TopList({ title, sub, rows, fmt }: {
  title: string; sub: string; rows: { label: string; value: number; note?: string }[]; fmt: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    // Matches the donuts: full height, and the rows sit directly under the head
    // rather than floating in a stretched card.
    <div className="section chart-card" style={{ marginTop: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="section-head" style={{ minHeight: 52, alignItems: 'flex-start' }}><div>
        <h2 className="section-title" style={{ fontSize: 15 }}>{title}</h2>
        <div className="section-sub">{sub}</div>
      </div></div>
      <div style={{ display: 'grid', gap: 7, padding: '2px 2px 0', alignContent: 'start' }}>
        {rows.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Nothing in range.</div>}
        {rows.map((r, i) => (
          <div key={r.label} className="toplist-row"
            style={{ display: 'grid', gridTemplateColumns: '22px 1fr 92px', gap: 10, alignItems: 'center', padding: '4px 6px', margin: '0 -6px', borderRadius: 8 }}>
            {/* The leader gets a solid badge; the rest are quiet outlines, so
                rank is legible without numbering every row loudly. */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 19, height: 19, borderRadius: 6, fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              background: i === 0 ? C.brand : 'var(--panel-2)', color: i === 0 ? '#fff' : C.muted,
            }}>{i + 1}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, color: C.ink, fontWeight: i === 0 ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.label}{r.note && <span style={{ color: C.muted, fontWeight: 400 }}> · {r.note}</span>}
              </span>
              <span style={{ display: 'block', height: 5, borderRadius: 999, background: 'var(--panel-2)', marginTop: 4, overflow: 'hidden' }}>
                <span style={{
                  display: 'block', height: '100%', width: `${(r.value / max) * 100}%`, borderRadius: 999,
                  background: `linear-gradient(90deg, ${C.brand}, color-mix(in srgb, ${C.brand} 62%, #7C3AED))`,
                  // Rank fades the bar, so first place reads first.
                  opacity: 1 - i * 0.13,
                }} />
              </span>
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The dashboard's summary layer: one screen that carries the gist of every other
 * tab: revenue by vertical, order status, the PI pipeline, who is producing,
 * and the leading accounts and devices.
 *
 * It reads the same identity-scoped endpoints as those tabs, so a rep sees their
 * own book summarised and a manager sees the company's. Nothing here can show a
 * figure the detail pages would withhold.
 */
export function DashboardOverview({ reps, viewAs }: { reps: RepRow[]; viewAs?: string | null }) {
  const [a, setA] = useState<OrderAnalytics | null>(null);
  const [pi, setPi] = useState<PiStages | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /** Choosing "Custom range…" prefills this month to today rather than leaving
   *  two empty boxes that silently match everything. */
  const pickPeriod = (k: string) => {
    if (k === 'custom' && !from && !to) {
      const now = new Date();
      setFrom(isoDay(new Date(now.getFullYear(), now.getMonth(), 1)));
      setTo(isoDay(now));
    }
    setPeriod(k);
  };
  const [vert, setVert] = useState('all');
  const [rep, setRep] = useState('all');
  // Set by clicking a slice. `null` means that dimension is unfiltered: these
  // have no dropdown, so the chart IS the control.
  const [status, setStatus] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);

  /** Click a slice: select it, or clear it if it is already the selection. */
  const toggle = (cur: string | null, set: (v: string | null) => void) =>
    (key: string) => set(cur === key ? null : key);

  useEffect(() => {
    let live = true;
    setA(null); setPi(null); setErr(null);
    Promise.all([fetchOrderAnalytics(viewAs), fetchPiStages(viewAs)])
      .then(([an, ps]) => { if (live) { setA(an); setPi(ps); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load the summary.'); });
    return () => { live = false; };
  }, [viewAs]);

  const allOrders = a?.orders ?? [];
  const repNames = new Set(reps.map((r) => r.rep));

  // Device revenue is apportioned across an order by unit share, so a
  // multi-device order contributes to each device proportionally rather than
  // counting its full value several times.
  const deviceRows = allOrders.flatMap((o) =>
    o.devices.map((d) => ({ item: shortDeviceName(d.item), qty: d.qty, revenue: o.revenue * (d.qty / (o.units || 1)), o })));

  // Hues are pinned from the UNFILTERED book: see pinColors. Doing this before
  // the filter is the whole point: the leaders keep their colours whatever the
  // controls are set to.
  const pinnedAccounts = useMemo(() => pinColors(tally(allOrders, (o) => o.account, (o) => o.revenue)), [a]);
  const pinnedDevices = useMemo(() => pinColors(tally(deviceRows, (d) => d.item, (d) => d.qty)), [a]);
  const pinnedStatus = useMemo(() => pinColors(tally(allOrders, (o) => o.status || 'Unknown', () => 1)), [a]);
  const pinnedReps = useMemo(() => pinColors(tally(allOrders.filter((o) => repNames.has(o.rep)), (o) => o.rep, () => 1)), [a, reps]);

  // A window rather than a single cutoff, so a custom range can close at both
  // ends. `null` means no date filtering at all.
  const win = useMemo(() => {
    const now = new Date();
    if (period === 'all') return null;
    if (period === 'custom') {
      const f = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
      // The end date is INCLUSIVE: an order stamped 14:32 on the closing day
      // belongs in the range, so the window runs to the end of that day.
      const t = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
      // Tolerate a reversed range instead of silently returning nothing.
      return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
    if (period === 'mtd') return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: Infinity };
    if (period === 'ytd') return { from: new Date(now.getFullYear(), 0, 1).getTime(), to: Infinity };
    const days = Number(period);
    return Number.isFinite(days) ? { from: now.getTime() - days * 864e5, to: Infinity } : null;
  }, [period, from, to]);

  const orders = useMemo(() => allOrders.filter((o) => {
    if (win) {
      if (!o.date) return false;               // undated can't be in a window
      const t = new Date(o.date).getTime();
      if (!Number.isFinite(t) || t < win.from || t > win.to) return false;
    }
    if (vert !== 'all' && o.vertical !== vert) return false;
    if (status && (o.status || 'Unknown') !== status) return false;
    if (account && o.account !== account) return false;
    // Device lives on the order's line items, so this asks "did this order
    // include that device", not "is this order that device".
    if (device && !o.devices.some((d) => shortDeviceName(d.item) === device)) return false;
    if (rep === '__none') return !repNames.has(o.rep);
    if (rep !== 'all') return o.rep === rep;
    return true;
  }), [a, win, vert, rep, reps, status, account, device]);

  const revenue = orders.reduce((s, o) => s + o.revenue, 0);
  const units = orders.reduce((s, o) => s + o.units, 0);

  const VERTS = ['PI', 'VA', 'TriCare', 'DEMO', 'Contract', 'DOL', 'Other'];
  const vertSlices = (pick: (o: typeof orders[number]) => number): Slice[] => VERTS.map((v) => ({
    name: v === 'Other' ? 'Unclassified' : v, color: V_C[v], key: v,
    value: orders.filter((o) => o.vertical === v).reduce((s, o) => s + pick(o), 0),
  }));
  // Orders: not revenue: so this donut can be checked straight against
  // Striven's own order-type counts (VA Order / PI Order / Tri-Care / Unclassified).
  const ordersByVertical = vertSlices(() => 1);
  const byVertical = vertSlices((o) => o.revenue);

  const byStatus = foldSlices(tally(orders, (o) => o.status || 'Unknown', () => 1), pinnedStatus, 'Other statuses');
  const byAccount = foldSlices(tally(orders, (o) => o.account, (o) => o.revenue), pinnedAccounts, 'Other vendors');

  const orderSet = new Set(orders);
  const filteredDevices = deviceRows.filter((d) => orderSet.has(d.o));
  const byDevice = foldSlices(tally(filteredDevices, (d) => d.item, (d) => d.qty), pinnedDevices, 'Other devices');

  const byStage: Slice[] = (pi?.stages ?? []).map((s) => ({ name: s.stage, value: s.count, color: STAGE_C[s.stage] ?? C.muted }));

  // The reps, PLUS everything booked to somebody else. Without that last slice
  // this donut totalled 261 while the vertical donut beside it totalled 419,
  // two charts on one screen quietly counting different things.
  const repCounts = tally(orders.filter((o) => repNames.has(o.rep)), (o) => o.rep, () => 1);
  const unattributed = orders.filter((o) => !repNames.has(o.rep)).length;
  const byRep: Slice[] = [
    ...foldSlices(repCounts, pinnedReps, 'Other reps'),
    ...(unattributed > 0 ? [{ name: 'Not a rep', value: unattributed, color: OTHER_C, key: '__none' }] : []),
  ];

  const topAccounts = [...tally(orders, (o) => o.account, (o) => o.revenue).entries()]
    .sort((x, y) => y[1] - x[1]).slice(0, 5)
    .map(([label, value]) => ({ label, value, note: `${orders.filter((o) => o.account === label).length} ord` }));

  const topDevices = (() => {
    const m = new Map<string, { revenue: number; units: number }>();
    for (const d of filteredDevices) {
      const e = m.get(d.item) ?? { revenue: 0, units: 0 };
      e.revenue += d.revenue; e.units += d.qty; m.set(d.item, e);
    }
    return [...m.entries()].filter(([, v]) => v.revenue >= 0.01).sort((x, y) => y[1].revenue - x[1].revenue).slice(0, 5)
      .map(([label, v]) => ({ label, value: v.revenue, note: `${v.units}u` }));
  })();

  if (err) return <div className="error" style={{ marginBottom: 14 }}>{err}</div>;
  if (!a || !pi) return <div className="page-sub" style={{ padding: 16 }}>Loading summary…</div>;

  const repOptions = [
    { k: 'all', label: 'All reps' },
    ...reps.map((r) => ({ k: r.rep, label: r.rep })),
    { k: '__none', label: 'Not a rep' },
  ];
  const vertOptions = [{ k: 'all', label: 'All verticals' }, ...VERTS.map((v) => ({ k: v, label: v === 'Other' ? 'Unclassified' : v }))];
  const clearAll = () => {
    setPeriod('all'); setVert('all'); setRep('all');
    setFrom(''); setTo('');
    setStatus(null); setAccount(null); setDevice(null);
  };
  const periodLabel = period === 'custom'
    ? `${from || 'earliest'} → ${to || 'latest'}`
    : (PERIODS.find((p) => p.k === period)?.label ?? period);
  const chips = [
    period !== 'all' && { label: 'Period', value: periodLabel, clear: () => { setPeriod('all'); setFrom(''); setTo(''); } },
    vert !== 'all' && { label: 'Vertical', value: vert === 'Other' ? 'Unclassified' : vert, clear: () => setVert('all') },
    rep !== 'all' && { label: 'Rep', value: rep === '__none' ? 'Not a rep' : rep, clear: () => setRep('all') },
    status && { label: 'Status', value: status, clear: () => setStatus(null) },
    account && { label: 'Vendor', value: account, clear: () => setAccount(null) },
    device && { label: 'Device', value: device, clear: () => setDevice(null) },
  ].filter(Boolean) as { label: string; value: string; clear: () => void }[];

  // Chip count, not row count: a filter that happens to match every order is
  // still an active filter and must stay visibly clearable.
  const filtered = chips.length > 0;
  // The stage store is a live snapshot of where PI orders sit today; it carries
  // no dates and no rep, so a period or rep filter cannot be applied to it.
  // Rather than show it silently unfiltered, it says so: and hides entirely
  // when the vertical filter has excluded PI.
  const showStages = (vert === 'all' || vert === 'PI') && byStage.length > 0;

  return (
    <>
      {/* One row of controls above the charts: every donut below reads the same
          filtered set, so the whole screen moves together. */}
      {/* flexDirection is set explicitly: `.chart-card` can supply a column
          direction, and a bare `display:flex` inherits it: which is what stood
          the three controls on top of one another. Padding is overridden too;
          the card's 22px is right for a chart, far too much for a control bar. */}
      <div className="section chart-card" style={{
        marginTop: 0, marginBottom: 14, padding: '9px 12px',
        display: 'flex', flexDirection: 'row', flexWrap: 'wrap',
        gap: '8px 14px', alignItems: 'center', rowGap: 8,
      }}>
        <Field label="Period" value={period} onChange={pickPeriod} options={PERIODS} />
        {period === 'custom' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              aria-label="From date" style={dateBox} />
            <span style={{ color: C.muted, fontSize: 12 }}>→</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              aria-label="To date" style={dateBox} />
          </span>
        )}
        <Field label="Vertical" value={vert} onChange={setVert} options={vertOptions} />
        <Field label="Rep" value={rep} onChange={setRep} options={repOptions} />
        {/* Chart-set filters have no dropdown, so without a chip they would be
            invisible state: you would see a filtered total with no way to tell
            what caused it. Each chip clears its own dimension. */}
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {chips.map((c) => (
              <button key={c.label} onClick={c.clear} title={`Remove the ${c.value} filter`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px',
                  borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', color: C.ink,
                  background: 'var(--panel-2)', border: '1px solid var(--border-strong, var(--border))',
                }}>
                <span style={{ color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9.5 }}>{c.label}</span>
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.value}</span>
                <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1, color: C.muted }}>×</span>
              </button>
            ))}
          </div>
        )}
        {filtered && (
          <button onClick={clearAll}
            style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', color: C.brand, background: 'var(--panel-2)', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
            Clear all
          </button>
        )}
        {/* Readout on ONE line: it was two, which set the bar's height on its
            own even when the controls were compact. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 7, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{orders.length.toLocaleString()}</span>
          {filtered && <span style={{ fontSize: 12, color: C.muted }}>of {allOrders.length.toLocaleString()}</span>}
          <span style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>orders</span>
          <span style={{ color: 'var(--border-strong, var(--border))' }}>·</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{formatCurrency(revenue)}</span>
          <span style={{ color: 'var(--border-strong, var(--border))' }}>·</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{units.toLocaleString()}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>units</span>
        </div>
      </div>

      {/* Six donuts: each a part-to-whole of the same filtered set, so they
          belong together and stretch to a common height. */}
      <div className="donut-grid">
        <Donut title="Orders by vertical" sub="Click a slice to filter · matches Striven's order types"
          slices={ordersByVertical} total={orders.length} empty="No orders in range."
          activeKey={vert === 'all' ? null : vert} onPick={(k) => setVert(vert === k ? 'all' : k)} />
        <Donut title="Revenue by vertical" sub="Order value by vertical"
          slices={byVertical} total={revenue} fmt={formatCurrency} empty="No revenue in range."
          activeKey={vert === 'all' ? null : vert} onPick={(k) => setVert(vert === k ? 'all' : k)} />
        <Donut title="Orders by status" sub={`Where the book stands · top ${MAX_SLICES} shown`}
          slices={byStatus} total={orders.length} empty="No orders in range."
          activeKey={status} onPick={toggle(status, setStatus)} />
        <Donut title="Orders by rep" sub="The same book, by who it is booked to"
          slices={byRep} total={byRep.reduce((s, x) => s + x.value, 0)} empty="No rep orders yet."
          activeKey={rep === 'all' ? null : rep} onPick={(k) => setRep(rep === k ? 'all' : k)} />
        <Donut title="Revenue by vendor" sub={`The account billed: never a patient · top ${MAX_SLICES}`}
          slices={byAccount} total={revenue} fmt={formatCurrency} empty="No revenue in range."
          activeKey={account} onPick={toggle(account, setAccount)} />
        <Donut title="Units by device" sub={`Devices dispensed · top ${MAX_SLICES} by volume`}
          slices={byDevice} total={byDevice.reduce((s, x) => s + x.value, 0)} empty="No devices in range."
          activeKey={device} onPick={toggle(device, setDevice)} />
      </div>

      {/* The pipeline is a SEQUENCE, not a composition: a donut implied its
          stages were parts of a whole and left an orphaned fifth card. A full
          width funnel reads left to right, the way the work actually flows. */}
      {showStages && <StageStrip slices={byStage} unfiltered={filtered} />}

      <div className="pair-grid">
        <TopList title="Top accounts" sub="By revenue: the vendor billed on the order, never a patient" rows={topAccounts} fmt={formatCurrency} />
        <TopList title="Top devices" sub="By revenue, apportioned across an order by unit share" rows={topDevices} fmt={formatCurrency} />
      </div>
    </>
  );
}
