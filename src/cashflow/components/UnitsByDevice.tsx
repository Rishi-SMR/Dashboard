// ── UNITS BY DEVICE ──────────────────────────────────────────────────────────
// A TABLE, in the portal's own table furniture: `.table-wrap.scroll-y` around a
// `.data-table.compact`, sticky header, `.num` columns, a `.total-row` at the
// foot, and the `sortable` / `sort-ind` header idiom the AR and AP registers
// already use. Nothing here is a new control — a table on this board should
// behave exactly like the tables on every other one.
//
// It used to draw bars (vertical columns up to ten devices, horizontal tracks
// above that). Scaled against a 29-unit leader, every tail device came out the
// same 2%-wide stub, so twelve tracks drew "small" twelve times and said
// nothing the count beside them had not already said. The room they took is
// four more columns of fact.
//
// COUNTS ONLY. No money enters this component — the props carry units and order
// counts and nothing else, so a dollar value cannot reach it even by mistake.
import { useMemo, useState } from 'react';
import type { DeviceMixRow } from '../strivenApi';

type SortKey = 'device' | 'vertical' | 'orders' | 'units' | 'per' | 'held';

export function UnitsByDevice({ rows, subtitle, onOpen }: {
  rows: DeviceMixRow[];
  subtitle?: string;
  onOpen?: () => void;
}) {
  // Opens on most units first, which is the question the card is here for.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'units', dir: -1 });

  // A NAME defaults to A-Z; a figure defaults to largest first. One shared
  // default would open the Device column at Z-A, which reads as broken rather
  // than as a choice. Same rule as the AP register's own `setSortKey`.
  const setSortKey = (key: SortKey) => setSort((s) => (s.key === key
    ? { key, dir: (s.dir * -1) as 1 | -1 }
    : { key, dir: key === 'device' || key === 'vertical' ? 1 : -1 }));
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  const perOrder = (d: DeviceMixRow) => d.units / Math.max(1, d.orders);

  // ZERO-UNIT DEVICES ARE HIDDEN, not listed as a zero: a row with no units is
  // a catalogue entry, and this is a table of what shipped.
  //
  // DEMO ROWS SORT LAST whatever the column and whichever the direction. They
  // are a footnote to the catalogue, and a sort that can float a test order
  // above a real device invites exactly the comparison this card should not
  // offer — so the demo test runs BEFORE the column comparison, never inside it.
  const data = useMemo(() => {
    const live = rows.filter((d) => d.units > 0);
    const byName = (a: DeviceMixRow, b: DeviceMixRow) => a.device.localeCompare(b.device);
    const cmp = (a: DeviceMixRow, b: DeviceMixRow) => {
      switch (sort.key) {
        case 'device': return byName(a, b) * sort.dir;
        case 'vertical': return (a.vertical || '').localeCompare(b.vertical || '') * sort.dir || byName(a, b);
        case 'orders': return (a.orders - b.orders) * sort.dir || byName(a, b);
        case 'per': return (perOrder(a) - perOrder(b)) * sort.dir || byName(a, b);
        case 'held': return (a.heldUnits - b.heldUnits) * sort.dir || byName(a, b);
        default: return (a.units - b.units) * sort.dir || byName(a, b);
      }
    };
    return [...live].sort((a, b) => (Number(a.demo ?? false) - Number(b.demo ?? false)) || cmp(a, b));
  }, [rows, sort]);

  // The leader by UNITS whatever the sorted column: under A-Z, or sorted by
  // held units, nothing else in the table would say which device leads. Real
  // devices only — a demo can never be "the leader".
  const leader = useMemo(() => data.filter((d) => !d.demo).reduce<DeviceMixRow | null>(
    (m, d) => (!m || d.units > m.units ? d : m), null), [data]);

  // THE TOTAL COUNTS REAL DEVICES ONLY, which is what the subtitle above the
  // table already reports ("N units across M devices ... plus K demo units,
  // listed separately"). A total that swept the demo rows in would contradict
  // the line directly above it.
  const live = data.filter((d) => !d.demo);
  const totalUnits = live.reduce((s, d) => s + d.units, 0);
  const totalHeld = live.reduce((s, d) => s + d.heldUnits, 0);

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
      {subtitle && <div className="ubd-head"><span className="ubd-sub">{subtitle}</span></div>}

      <div className="table-wrap scroll-y">
        <table className="data-table compact">
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSortKey('device')}>Device {sortInd('device')}</th>
              <th className="sortable" onClick={() => setSortKey('vertical')}>Programme {sortInd('vertical')}</th>
              <th className="num sortable" onClick={() => setSortKey('orders')}>Orders {sortInd('orders')}</th>
              <th className="num sortable" onClick={() => setSortKey('units')}>Units {sortInd('units')}</th>
              {/* The one figure the bars could never carry: whether a device
                  ships singly or in sets. */}
              <th className="num sortable" onClick={() => setSortKey('per')} title="Units per order: whether this device ships singly or in sets">Per order {sortInd('per')}</th>
              <th className="num sortable" onClick={() => setSortKey('held')} title="Units standing on a held order">Held {sortInd('held')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.demo ? `demo:${d.device}` : d.device}
                className={`${d.demo ? 'demo' : ''}${leader && !d.demo && d.device === leader.device ? ' lead' : ''}`}>
                <td>
                  <strong>{d.device}</strong>
                  {d.demo && <span className="ubd-demo">demo</span>}
                </td>
                <td>{d.demo ? 'DEMO / test' : (d.vertical || '—')}</td>
                <td className="num">{d.orders.toLocaleString()}</td>
                <td className="num u">{d.units.toLocaleString()}</td>
                <td className="num">{perOrder(d).toFixed(1)}</td>
                <td className={`num${d.heldUnits > 0 ? ' held' : ''}`}
                  title={d.heldUnits > 0 ? `${d.heldUnits} unit${d.heldUnits === 1 ? '' : 's'} on ${d.heldOrders || 1} held order${(d.heldOrders || 1) === 1 ? '' : 's'}` : undefined}>
                  {d.heldUnits > 0 ? d.heldUnits.toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* ORDERS AND PER-ORDER DO NOT TOTAL, so they are dashed rather
                than summed. One order can carry two devices, so adding the
                Orders column counts that order twice — a figure that would sit
                under a column of honest ones and quietly contradict the order
                book. Units and Held are per device line, so those do add up. */}
            <tr className="total-row">
              <td><strong>Total</strong></td>
              <td>{live.length} device{live.length === 1 ? '' : 's'}</td>
              <td className="num" title="Orders do not total: an order carrying two devices would be counted twice">—</td>
              <td className="num"><strong>{totalUnits.toLocaleString()}</strong></td>
              <td className="num" title="An average of per-device averages is not the fleet average">—</td>
              <td className="num">{totalHeld > 0 ? totalHeld.toLocaleString() : '—'}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {onOpen && <button className="card-link" onClick={onOpen}>Open orders</button>}
    </div>
  );
}
