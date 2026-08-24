// ── SALES-ORDER REFERENCE: the constants, apart from the component ──────────
//
// WHY THIS FILE EXISTS AT ALL. These three lived in SoLink.tsx beside the
// component, and React Fast Refresh requires a module to export ONLY components
// or it cannot hot-reload it. Vite therefore invalidated SoLink.tsx on every
// edit — "Could not Fast Refresh (\"SO_REF_STYLE\" export is incompatible)" —
// and an invalidation that reaches the root makes the dev server FULL-RELOAD the
// page. Mid-click that is indistinguishable from the link being broken: the
// dialog never appears because the page went away underneath it.
//
// Splitting the constants out leaves SoLink.tsx exporting components only, so it
// Fast Refreshes cleanly and a click survives an edit.
//
// Nothing here imports React state or JSX, so it stays a plain module.
import type { CSSProperties } from 'react';
import { C } from './chartTheme';

/**
 * WHERE A SALES ORDER LIVES IN STRIVEN'S OWN UI. `{id}` is substituted.
 *
 * The tenant's own address, supplied by the owner rather than guessed — nothing
 * in this repository references the Striven web app, only the API host
 * api.striven.com, so it could not have been derived from the code.
 *
 * THE TRAILING NUMBER IS OUR `soId`, checked rather than assumed: the sample URL
 * ended /sales-orders/331, and soId 331 is SO-331 in the book (Christy Tan,
 * 14 Jul 2026, Veterans Affairs). Every `SO-<n>` reference in this portal is
 * built as `SO-${so.id}` from the same Striven id, so substitution is exact and
 * needs no lookup.
 *
 * IT IS A #HASH ROUTE. The id sits after the fragment marker, which means the
 * browser will NOT re-navigate an already-open Striven tab that differs only
 * after the '#'. Hence target="_blank" on the anchor: a fresh tab always lands
 * on the right order, where reusing one could silently show the previous one.
 *
 * Emptying this string disables the button everywhere, which is the intended
 * off switch if the tenant address ever changes.
 */
export const STRIVEN_SO_URL: string = 'https://sportsmedrecovery.striven.com/next/crm#/sales-orders/{id}';

/** The id the API needs, from a `SO-553`-style reference, when a row carries the
 *  reference but not the numeric id. Returns null rather than guessing. */
export const soIdFromRef = (ref: string | null | undefined): number | null => {
  const m = /(\d+)\s*$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
};

/**
 * WHAT AN OPENABLE SALES-ORDER REFERENCE LOOKS LIKE.
 *
 * Exported because SoLink is not the only way one is opened. The Orders tab
 * already had its own richer drill on the row — created/updated, payment term,
 * AR account, the PO chain — reached by clicking anywhere in the row, and its
 * reference cell was plain bold text that gave no hint of it. Pointing that cell
 * at this style rather than wrapping it in a SoLink keeps the richer drill AND
 * makes the reference look openable, without putting two different sales-order
 * dialogs one row apart.
 *
 * ONE DECLARATION, because "what a reference looks like" is exactly the kind of
 * detail that drifts when it is written twice: the colour and the underline
 * offset would be adjusted in one table and not the other, and the two would
 * stop reading as the same affordance.
 */
export const SO_REF_STYLE: CSSProperties = {
  background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer',
  fontWeight: 600, color: C.brand, textDecoration: 'underline',
  // A REFERENCE IS ONE TOKEN. "SO-553" was breaking after the hyphen and
  // rendering as "SO-" over "553" — two lines for six characters, in the
  // narrowest column of the table, which reads as two different things rather
  // than one order number. Browsers treat a hyphen as a legal break point, so
  // the column being tight is enough to trigger it; the cell must widen instead
  // of the number folding.
  whiteSpace: 'nowrap',
  // The underline sits off the glyphs so a reference reads as cleanly as it did
  // as plain text; it is the affordance, not decoration.
  textUnderlineOffset: 3, textDecorationThickness: 1,
  textDecorationColor: 'rgba(10,54,159,0.35)',
};
