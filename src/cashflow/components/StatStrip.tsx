import { C } from '../chartTheme';

/**
 * The context figures at the top of a dialog, ON ONE LINE.
 *
 * WHAT THIS REPLACED, and why it is worth a shared component. Every drill-down
 * in the portal opened the same way: a grid of `Stat` cards, each a tinted plate
 * with a 11.5px uppercase label over an 18px figure, four or five across. Six
 * dialogs had their own copy of that grid and their own copy of the card.
 *
 * They cost about 74px of the first screen — plate padding, label, figure, then
 * the grid's own margin — to say four short numbers, one of which is routinely
 * the very tile that was tapped to open the dialog. On a laptop that pushed the
 * table the dialog exists for below the fold, so the reader's first action was
 * to scroll past the summary to reach the thing they asked for.
 *
 * The strip says the same figures in about 26px. Nothing is dropped: same
 * labels, same values, same tints, same order. It is only the plate, the
 * stacking and the uppercase that went — chrome that was sized for a dashboard
 * card and inherited by a dialog that had no room to spare.
 *
 * WHERE IT DOES NOT GO: page-level cards. A dashboard has the height, and there
 * the tile IS the content rather than a preamble to it. This is for dialogs.
 *
 * `tint` carries the drill's accent onto its own figure, so a modal can still be
 * tied back to the tile it came from. `tabular-nums` throughout: these sit on
 * one line and would otherwise shuffle sideways as the numbers change.
 */
export function StatStrip({ items, divider = true }: {
  items: ({ label: string; value: string; tint?: string } | false | null | undefined)[];
  /** The hairline under the strip. Off where the dialog's own next element
   *  already draws one, so the two do not stack into a double rule. */
  divider?: boolean;
}) {
  const rows = items.filter((x): x is { label: string; value: string; tint?: string } => Boolean(x));
  if (!rows.length) return null;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 14px',
      marginBottom: 12, paddingBottom: divider ? 10 : 0,
      borderBottom: divider ? '1px solid var(--border)' : undefined,
      fontSize: 12.5, color: C.muted, fontVariantNumeric: 'tabular-nums',
    }}>
      {rows.map((s) => (
        <span key={s.label}>
          <b style={{ fontSize: 14, fontWeight: 800, color: s.tint || C.ink }}>{s.value}</b>{' '}
          {/* The label reads as running text, not as a column head: lowercased,
              because "512 ORDERS · 732 DEVICES" shouts a caption. */}
          {s.label.toLowerCase()}
        </span>
      ))}
    </div>
  );
}
