import { useEffect, useState } from 'react';
import { Portal } from './Portal';

/**
 * "Please Wait Its Loading......." — a blocking wait notice for a fetch that
 * takes long enough for the reader to wonder whether the page is broken.
 *
 * WHY THIS EXISTS AT ALL. The commission tab reads Google Sheet exports live,
 * one per configured workbook, at roughly two seconds each. That used to be a
 * single book; from the August 2026 cycle it is three, because the
 * reconciliation sheet stopped being extended and the money now comes from the
 * source workbooks (see the README). The old cue for that wait was the words
 * "Loading…" in the corner of an otherwise empty page, and on a REFRESH — when
 * the last figures are still on screen — there was no cue at all: the numbers
 * simply sat there, stale, until they changed. A reader cannot tell that from a
 * page that has finished.
 *
 * IT WAITS BEFORE IT APPEARS, and that is the whole difference between a help
 * and a nuisance. A warm cache answers in well under `delay`, so the popup
 * never renders for the loads that are already fast; flashing a modal up and
 * away on every tab switch would be worse than the silence it replaces.
 *
 * NEVER ON THE BACKGROUND POLL. The commission tab re-reads itself every two
 * minutes with `silent = true`, which deliberately does not touch the loading
 * flag — so nothing here fires for it. A popup that seized the screen every
 * other minute while someone was reading their own pay would be intolerable,
 * and this is the reason the silent path exists.
 *
 * Not dismissible: there is nothing to decide, and a Close button on a progress
 * notice reads as "cancel", which it would not do. It leaves when the fetch
 * does — including when the fetch FAILS, because the caller clears its loading
 * flag either way and the error banner underneath is the better messenger.
 */
export function WaitPopup({ active, delay = 600, message = 'Please Wait Its Loading.......' }: {
  /** The caller's in-flight flag. Everything else follows from this. */
  active: boolean;
  /** How long a fetch may run before it is worth interrupting the page for. */
  delay?: number;
  message?: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) { setShow(false); return; }
    // Re-armed from scratch on every load, so a slow fetch following a fast one
    // still gets the full grace period rather than inheriting a timer.
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);

  if (!show) return null;

  return (
    // Portalled for the same reason every other overlay here is: `position:
    // fixed` only means the viewport while no ancestor carries a transform, and
    // `.main .section` animates. See Portal.tsx.
    <Portal>
      <div
        className="wait-pop-backdrop"
        // Announced, not just drawn: a screen reader gets told the page is busy
        // rather than being handed a silent overlay it cannot see.
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="wait-pop">
          <div className="wait-pop-spinner" aria-hidden="true" />
          <div className="wait-pop-text">{message}</div>
        </div>
      </div>
    </Portal>
  );
}
