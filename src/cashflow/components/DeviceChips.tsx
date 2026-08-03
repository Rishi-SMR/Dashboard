import { C, VERTICAL_COLORS as V_C } from '../chartTheme';


/**
 * Device names carry their vertical as a prefix ("VA Genesys Lumbar"), and some
 * carry a supplier code first ("SMR T/N 10 - PI TENS/NMES"). DEMO is checked
 * first and anywhere in the string, because a demo item can hide behind a code
 * ("STS 2514 - DEMO Silver-Thera ...") and must never pass as real stock.
 */
export function deviceVertical(item: string): string {
  const s = String(item || '');
  if (/\bdemo\b/i.test(s)) return 'DEMO';
  if (/\bva\b/i.test(s)) return 'VA';
  if (/\bpi\b/i.test(s)) return 'PI';
  if (/\btri.?care\b/i.test(s)) return 'TriCare';
  if (/\bdol\b/i.test(s)) return 'DOL';
  return 'Other';
}

/**
 * Strip the noise that repeats on every row: the vertical prefix (the context
 * already says PI), and any leading supplier code before a dash
 * ("SMR T/N 10 - PI TENS/NMES" → "TENS/NMES").
 */
export function shortDeviceName(item: string, vertical = deviceVertical(item)): string {
  let s = String(item || '').trim();
  const dash = s.match(/^[A-Z0-9][A-Z0-9/\s.-]{2,}?\s[–—-]\s(.+)$/);
  if (dash) s = dash[1].trim();
  s = s.replace(new RegExp(`^${vertical}\\s+`, 'i'), '').trim();
  return s || String(item || '').trim();
}

/**
 * The devices on one order, as chips instead of a comma-run.
 *
 * A wrapped list of "PI ManaRay Neck ×1, PI ManaRay Lumbar ×1, …" reads as a
 * paragraph; each device gets its own bounded chip with the quantity pinned to
 * the right, so a five-device order can be counted at a glance. The vertical is
 * carried by a colour dot rather than repeating the word on every entry.
 */
export function DeviceChips({ devices, showVertical = false }: {
  devices: { item: string; qty: number }[];
  /** Colour-dot each chip by vertical. Off inside a single-vertical view. */
  showVertical?: boolean;
}) {
  if (!devices?.length) return <span style={{ color: C.muted }}>-</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {devices.map((d, i) => {
        const v = deviceVertical(d.item);
        return (
          <span key={`${d.item}-${i}`} title={`${d.item}: ${d.qty} unit${d.qty === 1 ? '' : 's'}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
              background: 'var(--panel-2)', borderRadius: 7, padding: '2px 6px 2px 7px',
              fontSize: 12, lineHeight: 1.5, color: C.ink, whiteSpace: 'nowrap',
            }}>
            {showVertical && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: V_C[v] || C.muted, flex: 'none' }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortDeviceName(d.item, v)}</span>
            <span style={{ fontWeight: 700, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>×{d.qty}</span>
          </span>
        );
      })}
    </div>
  );
}
