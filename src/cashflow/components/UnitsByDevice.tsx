// ── UNITS BY DEVICE ──────────────────────────────────────────────────────────
// Vertical rounded bars, one per device, count labelled above. Hatched in the
// primary tint; only the leader renders solid, so "what sells most" reads before
// any label does.
//
// COUNTS ONLY. No money enters this component — the props carry units and order
// counts and nothing else, so a dollar value cannot reach it even by mistake.
//
// SCALING. Past ~10 devices a vertical bar per device stops fitting a card and
// the labels collide, so the same component switches itself to horizontal rows
// with an internal scroll. Every behaviour (sort, tooltip, pin, hold dot) is
// written once and carries across both modes rather than being duplicated.
//
// Colours and type are the portal's own: --accent for the primary, --warn for
// the hold dot, --border for the gridlines, all from cashflow.css :root.
import { useMemo, useState } from 'react';
import type { DeviceMixRow } from '../strivenApi';

const REDUCED = typeof window !== 'undefined'
  && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Sort = 'units' | 'az';

/** Device names wrap to two lines under a vertical bar; longer ones ellipsise. */
function twoLine(name: string): [string, string] {
  const words = String(name || '').trim().split(/\s+/);
  if (words.length < 2) return [name, ''];
  // Break as near the middle as the words allow, so neither line is a stub.
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

export function UnitsByDevice({ rows, subtitle, onOpen }: {
  rows: DeviceMixRow[];
  subtitle?: string;
  onOpen?: () => void;
}) {
  const [sort, setSort] = useState<Sort>('units');
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // IDENTITY IS NAME + DEMO, never the name alone. A demo device shortens to
  // the same label as its real counterpart ("DEMO ManaRay Lumbar" → "ManaRay
  // Lumbar"), so keying rows on the name would collide two different rows into
  // one React key and make pinning one highlight the other.
  const rowId = (d: DeviceMixRow) => (d.demo ? `demo:${d.device}` : d.device);

  // ZERO-UNIT DEVICES ARE HIDDEN, not drawn as zero-height bars: a bar with no
  // height is an axis tick pretending to be data.
  //
  // DEMO ROWS SORT LAST whatever the sort is. They are a footnote to the
  // catalogue, and a sort that can float a test order above a real device
  // invites exactly the comparison this card should not offer.
  const data = useMemo(() => {
    const live = rows.filter((d) => d.units > 0);
    return [...live].sort((a, b) => (Number(a.demo ?? false) - Number(b.demo ?? false)) || (sort === 'az'
      ? a.device.localeCompare(b.device)
      : b.units - a.units || a.device.localeCompare(b.device)));
  }, [rows, sort]);

  // The leader by UNITS regardless of the active sort — it stays the solid bar
  // under A–Z too, or the highlight would move for a reason that is not about
  // the data. Real devices only: a demo can never be "the leader".
  const leader = useMemo(() => data.filter((d) => !d.demo).reduce<DeviceMixRow | null>(
    (m, d) => (!m || d.units > m.units ? d : m), null), [data]);

  const max = Math.max(1, ...data.map((d) => d.units));
  // Horizontal past 10 (a full catalogue), and past 6 on a narrow screen where
  // vertical bars would be thinner than their own labels.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const horizontal = data.length > 10 || (narrow && data.length > 6);

  const pin = (name: string) => setPinned((p) => (p === name ? null : name));
  const detail = pinned ? data.find((d) => rowId(d) === pinned) ?? null : null;

  const tip = (d: DeviceMixRow) => [
    d.device,
    d.demo ? 'DEMO / test — not sold, no commission' : d.vertical,
    `${d.units} unit${d.units === 1 ? '' : 's'}`,
    `${d.orders} order${d.orders === 1 ? '' : 's'}`,
    d.heldUnits > 0 ? `${d.heldUnits} unit${d.heldUnits === 1 ? '' : 's'} on hold` : '',
  ].filter(Boolean).join(' · ');

  if (data.length === 0) {
    return (
      <div className="ubd-empty">
        <span className="ic">◔</span>
        <b>No devices in this period</b>
        <span>No order in the selected range carries a device line.</span>
      </div>
    );
  }

  return (
    <div className="ubd">
      <div className="ubd-head">
        {subtitle && <span className="ubd-sub">{subtitle}</span>}
        {/* The portal's existing segmented control, not a new one. */}
        <span className="ins-qtabs ubd-sortr">
          <button className={`ins-qtab${sort === 'units' ? ' on' : ''}`} onClick={() => setSort('units')}>Most units</button>
          <button className={`ins-qtab${sort === 'az' ? ' on' : ''}`} onClick={() => setSort('az')}>A–Z</button>
        </span>
      </div>

      {horizontal ? (
        // ── HORIZONTAL: name left, bar and count right, scrolled ────────────
        <div className="ubd-hlist" role="list">
          {data.map((d, i) => {
            const on = pinned === rowId(d);
            return (
              <div key={rowId(d)} role="listitem"
                className={`ubd-hrow${on ? ' pinned' : ''}${pinned && !on ? ' dim' : ''}${d.demo ? ' demo' : ''}`}
                title={tip(d)} onClick={() => pin(rowId(d))}
                onMouseEnter={() => setHover(rowId(d))} onMouseLeave={() => setHover(null)}
                tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(rowId(d)); } }}>
                <span className="nm">{d.device}{d.demo && <span className="ubd-demo">demo</span>}</span>
                <span className="track">
                  <i className={leader && rowId(d) === rowId(leader) ? 'solid' : undefined}
                    style={{ width: `${Math.max(2, (d.units / max) * 100)}%`, animationDelay: REDUCED ? undefined : `${Math.min(i, 12) * 0.03}s` }} />
                  {d.heldUnits > 0 && <span className="hold" title={`${d.heldUnits} on hold`} />}
                </span>
                <span className="ct">{d.units}</span>
              </div>
            );
          })}
        </div>
      ) : (
        // ── VERTICAL: the default shape ─────────────────────────────────────
        <div className="ubd-plot">
          {/* Dashed gridlines at 0 / 50% / 100% of the max. */}
          <span className="ubd-grid" style={{ bottom: '100%' }} />
          <span className="ubd-grid" style={{ bottom: '50%' }} />
          <span className="ubd-grid" style={{ bottom: 0 }} />
          <div className="ubd-bars">
            {data.map((d, i) => {
              const on = pinned === rowId(d);
              const [l1, l2] = twoLine(d.device);
              return (
                <div key={rowId(d)}
                  className={`ubd-b${on ? ' pinned' : ''}${pinned && !on ? ' dim' : ''}${d.demo ? ' demo' : ''}`}
                  title={tip(d)} onClick={() => pin(rowId(d))}
                  onMouseEnter={() => setHover(rowId(d))} onMouseLeave={() => setHover(null)}
                  tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(rowId(d)); } }}>
                  <span className={`ct${hover === rowId(d) || on ? ' up' : ''}`}>{d.units}</span>
                  <span className={`col${leader && rowId(d) === rowId(leader) ? ' solid' : ''}`}
                    style={{ height: `${Math.max(3, (d.units / max) * 100)}%`, animationDelay: REDUCED ? undefined : `${Math.min(i, 12) * 0.04}s` }}>
                    {/* Amber dot: units on this device sit on a held order. */}
                    {d.heldUnits > 0 && <span className="hold" title={`${d.heldUnits} unit${d.heldUnits === 1 ? '' : 's'} on hold`} />}
                  </span>
                  <span className="lb"><b>{l1}</b>{l2 && <em>{l2}</em>}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pinned detail. Average units per order is the one derived figure here,
          and it is what says whether a device ships singly or in sets. */}
      {detail && (
        <div className="ubd-detail">
          <b>{detail.device}</b>
          <span className="pill">{detail.vertical}</span>
          <span>{detail.units} unit{detail.units === 1 ? '' : 's'}</span>
          <span>{detail.orders} order{detail.orders === 1 ? '' : 's'}</span>
          <span>{(detail.units / Math.max(1, detail.orders)).toFixed(1)} per order</span>
          {detail.heldUnits > 0 && (
            <span className="held">● {detail.heldUnits} on hold{detail.heldOrders ? ` · ${detail.heldOrders} order${detail.heldOrders === 1 ? '' : 's'}` : ''}</span>
          )}
          {onOpen && <button className="card-link" style={{ marginTop: 0, marginLeft: 'auto' }} onClick={onOpen}>Open orders</button>}
        </div>
      )}
    </div>
  );
}
