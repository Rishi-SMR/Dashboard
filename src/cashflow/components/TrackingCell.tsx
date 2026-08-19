import { C } from '../chartTheme';

export type Shipment = { tn: string; carrier: { code: string; name: string; url: string } | null };

/**
 * One order's carrier tracking, as a table cell.
 *
 * SOURCE: a saved Striven report (STRIVEN_TRACKING_URL) carrying TrackingNumber
 * and ShipVia per sales order, backed by the `so_detail` cache for the orders
 * that report is not scoped to. Nothing here is inferred from the order itself.
 *
 * MOST ORDERS HAVE NONE — the field is filled by hand in Striven and about a
 * quarter of the book carries one — so the empty state is the common case and is
 * deliberately quiet: a dash, not a warning. A blank means nobody entered a
 * number, NOT that the order never shipped; the two are indistinguishable from
 * here, so the cell must not imply the second.
 *
 * SEVERAL PARCELS PER ORDER. Striven has one box for the number, so a two-parcel
 * order holds both separated by a comma. Each is its own trackable shipment and
 * gets its own row here, rather than being run together into a string that no
 * carrier would recognise.
 */
export function TrackingCell({ shipments, compact = false }: {
  shipments?: Shipment[];
  /** Drops the carrier chip, for tables that are already tight on width. */
  compact?: boolean;
}) {
  const list = (shipments ?? []).filter((s) => s?.tn);
  if (!list.length) return <span style={{ color: C.muted }}>-</span>;

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, maxWidth: '100%' }}>
      {list.map((s) => {
        const num = (
          <span style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 11.5, letterSpacing: '-0.01em', whiteSpace: 'nowrap',
          }}>{s.tn}</span>
        );
        return (
          <span key={s.tn} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {!compact && s.carrier && (
              <span style={{
                flex: 'none', fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em',
                textTransform: 'uppercase', color: C.sub, background: 'var(--panel-2)',
                borderRadius: 5, padding: '1px 5px',
              }}>{s.carrier.name}</span>
            )}
            {s.carrier?.url
              ? (
                // rel=noreferrer as well as noopener: the carrier page has no
                // business knowing which portal page a patient's shipment was
                // looked up from.
                <a href={s.carrier.url} target="_blank" rel="noopener noreferrer"
                  title={`Track ${s.tn} with ${s.carrier.name}`}
                  style={{ color: C.brand, fontWeight: 600 }}>{num}</a>
              )
              : <span title={`Tracking number ${s.tn} — Striven names no carrier and the format matches none`} style={{ color: C.sub }}>{num}</span>}
          </span>
        );
      })}
    </span>
  );
}
