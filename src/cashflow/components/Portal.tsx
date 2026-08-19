import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Render children at the end of <body>, outside the component tree.
 *
 * FOR FULL-SCREEN OVERLAYS ONLY — modal backdrops and the invisible catchers
 * that close a popover on an outside click. Both rely on `position: fixed;
 * inset: 0` meaning THE VIEWPORT, and that is only true while no ancestor has a
 * transform, filter, perspective, backdrop-filter, `will-change` on any of
 * those, or `contain: paint`. Any one of them silently makes the ancestor the
 * containing block, and the overlay shrinks to that element's box: the backdrop
 * dims a band instead of the page, and content outside the box paints straight
 * over a z-index:1000 modal.
 *
 * That is not a hypothetical — it happened here. `.main .section` animates with
 * `animation-fill-mode: both`, and the keyframes ended on `translateY(0)`,
 * which is a transform and therefore a containing block that never went away.
 * The keyframes now end on `none`, which fixes that instance; portalling fixes
 * the CLASS, because the next transform someone adds to a wrapper cannot reach
 * an element that is no longer inside it.
 *
 * Only the DOM position moves. React context, state and event bubbling all
 * follow the React tree, so an onClick on the backdrop still reaches the
 * handler that rendered it.
 */
export function Portal({ children }: { children: ReactNode }) {
  // Guard for a non-DOM render pass; the app is client-only today, but a portal
  // that throws during SSR is a nasty way to find that out later.
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
