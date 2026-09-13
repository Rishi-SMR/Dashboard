/**
 * THE TRAIL BETWEEN THE USER GUIDE AND THE SCREENS IT DESCRIBES — both ways.
 *
 * The guide has always been able to send a reader OUT: every entry lists the
 * screens its term appears on, and each is a real `#view` link. Nothing brought
 * them back. A reader who followed "AR Open → AR / AP" to check a figure landed
 * on a dense finance page with no way back to the definition they were half way
 * through reading, and the browser's Back button is the wrong instrument —
 * `setView` writes the hash with `replaceState`, so the tab they came from is
 * not in history as a separate entry.
 *
 * SO THE TRAIL IS CARRIED IN THE HASH: `#receivables~ar-open` means "the AR / AP
 * tab, arrived at from the glossary entry AR Open". That has three properties
 * worth having over a piece of React state:
 *
 *   · IT SURVIVES A RELOAD, and it can be pasted to someone else.
 *   · IT CLEARS ITSELF. `setView` writes a bare `#receivables` when the reader
 *     picks a tab from the sidebar, so the breadcrumb disappears the moment they
 *     stop following the guide's thread and start navigating on their own. No
 *     code had to be written to expire it.
 *   · IT NEEDS NO PROVIDER. Any component at any depth can read it.
 *
 * TWO AFFORDANCES, ANSWERING TWO DIFFERENT QUESTIONS:
 *
 *   <GuideReturn/>  "take me back to where I was reading." Appears only when the
 *                   hash carries a trail, mounted ONCE for the whole app, so it
 *                   works on every destination without a single tab being
 *                   modified to support it.
 *   <GuideMark/>    "what does this section mean?" A standing ⓘ beside a section
 *                   heading, always pointing at that section's own entry. It is
 *                   there whether or not anyone arrived from the guide.
 *
 * THE TWO ARE DELIBERATELY NOT THE SAME CONTROL. An ⓘ that sometimes went to
 * the section's own definition and sometimes to whichever entry you happened to
 * arrive from would be unpredictable in exactly the way a reference must not be.
 * The inline mark is fixed; the return chip is the one that remembers.
 */
import { useEffect, useState } from 'react';

/** Separates the view from the trail. A literal in a fragment, reserved by no
 *  spec, and absent from every ViewKey — so splitting on it can never cut a
 *  view name in half. */
const SEP = '~';

/**
 * A TERM, REDUCED TO A SLUG. This must stay identical to `termId` in
 * UserGuideTab — that function builds the DOM id the guide scrolls to, and this
 * one builds the hash that asks it to. They are the same string by contract,
 * and `api/_guide-trail.test.js` asserts it rather than trusting the comment.
 */
export const termSlug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * WHERE THE GUIDE SENDS A READER: a tab, the entry that sent them, and — where
 * the entry names one — the SECTION within that tab.
 *
 * `#receivables~ar-open~ar-aging` reads "AR / AP, from the AR Open entry, land
 * on AR Aging". The third part is what makes the link precise: opening a tab and
 * leaving the reader at the top of a page with five charts, a KPI strip and two
 * registers on it is not "taking them to AR Aging", it is taking them to the
 * neighbourhood and pointing vaguely.
 *
 * OPTIONAL, AND MUST STAY SO. Most glossary locations name a section no screen
 * has declared an anchor for yet, and a link that scrolls nowhere is worse than
 * one that honestly just opens the tab. Omit it and the old behaviour stands.
 */
export const trailHref = (view: string, term: string, anchor?: string) =>
  `#${view}${SEP}${termSlug(term)}${anchor ? SEP + anchor : ''}`;
/** Where a reader goes back to: the guide, opened on one entry. */
export const guideHref = (term: string) => `#guide${SEP}${termSlug(term)}`;

/** The trail's two halves: which glossary entry, and which section to land on. */
export const parseTrail = (trail: string | null): { term: string; anchor: string | null } => {
  if (!trail) return { term: '', anchor: null };
  const i = trail.indexOf(SEP);
  return i === -1 ? { term: trail, anchor: null } : { term: trail.slice(0, i), anchor: trail.slice(i + 1) || null };
};

/** Splits `#view~slug` into its two halves. The view alone is still valid — an
 *  ordinary `#receivables` link carries no trail and must keep working. */
export const splitHash = (raw: string): { view: string; trail: string | null } => {
  const h = String(raw || '').replace(/^#/, '');
  const i = h.indexOf(SEP);
  return i === -1 ? { view: h, trail: null } : { view: h.slice(0, i), trail: h.slice(i + 1) || null };
};
/** The section this hash asks to land on, if any. Read by the tab that owns it —
 *  a tab with sub-tabs has to OPEN the right one before anything can scroll to
 *  it, and only that tab knows how. */
export const currentAnchor = () =>
  (typeof location === 'undefined' ? null : parseTrail(splitHash(location.hash).trail).anchor);

const currentTrail = () => (typeof location === 'undefined' ? null : splitHash(location.hash).trail);

/**
 * THE TRAIL ON THE CURRENT HASH, kept live.
 *
 * `hashchange` does NOT fire for `history.replaceState`, which is how `setView`
 * navigates — so a sidebar click would leave a stale chip on screen claiming the
 * reader had arrived from the glossary. The interval is the honest fix: there is
 * no event for what we need to observe, and a second's lag on a breadcrumb
 * disappearing is imperceptible where a breadcrumb that never disappears is a
 * lie. It is one string comparison, four times a second, for the life of the
 * page.
 */
function useTrail(): string | null {
  const [trail, setTrail] = useState<string | null>(currentTrail);
  useEffect(() => {
    const read = () => setTrail((prev) => { const now = currentTrail(); return prev === now ? prev : now; });
    window.addEventListener('hashchange', read);
    const t = setInterval(read, 250);
    return () => { window.removeEventListener('hashchange', read); clearInterval(t); };
  }, []);
  return trail;
}

/**
 * THE WAY BACK. Mounted once, in the app shell, for every tab at once.
 *
 * IT NAMES THE ENTRY rather than saying "Back". A reader who followed three
 * links needs to know which definition they are returning to, and "back to the
 * glossary" does not say. The slug is turned back into readable words here,
 * which is lossy — "AR Open" comes back as "Ar open" — so the real label is
 * supplied by the guide itself through `registerTrailLabels`, and the
 * de-slugged form is only the fallback for a hash typed by hand.
 *
 * FIXED TO THE VIEWPORT, BOTTOM LEFT. The destination is usually a long
 * scrolling page and the reader may be anywhere down it when they decide they
 * want the definition back; a chip at the top of the document would be a chip
 * they have to scroll to find. Bottom left, because bottom right is where this
 * app's drill modals and toasts appear.
 */
export function GuideReturn() {
  const trail = useTrail();
  const [hidden, setHidden] = useState<string | null>(null);
  // Dismissal is per-trail: closing the chip for "AR Open" must not suppress the
  // one that appears after the reader follows a different entry.
  useEffect(() => { if (trail && hidden && trail !== hidden) setHidden(null); }, [trail, hidden]);
  if (!trail || hidden === trail) return null;
  // The TERM half only: the anchor is where the reader landed, not what they
  // were reading, and "AR Open ar aging" is not the name of anything.
  const { term } = parseTrail(trail);
  const label = TRAIL_LABELS.get(term) ?? deSlug(term);
  return (
    <div className="guide-return" role="note">
      <a className="guide-return-link" href={`#guide${SEP}${term}`}
        title={`Back to the User Guide entry for ${label}`}>
        <span className="guide-return-i" aria-hidden>ⓘ</span>
        <span className="guide-return-txt">
          <span className="l">Back to User Guide</span>
          <span className="v">{label}</span>
        </span>
      </a>
      <button type="button" className="guide-return-x" aria-label="Dismiss" title="Dismiss"
        onClick={() => setHidden(trail)}>×</button>
    </div>
  );
}

/**
 * LANDING ON THE SECTION THE GUIDE NAMED — the arrow.
 *
 * Mounted once, in the shell, beside <GuideReturn/>. It watches the hash for an
 * anchor and finds `[data-guide-anchor="…"]` anywhere in the tree, so a section
 * becomes precisely addressable by adding ONE attribute to it — no prop
 * threading, no per-tab landing code, and no chance of a tab being wired for the
 * scroll but forgotten for the highlight.
 *
 * IT RETRIES, BECAUSE THE TARGET IS NOT THERE YET. Every tab is lazily loaded
 * and then fetches; the section the reader was sent to does not exist in the DOM
 * for anything from 50ms to two seconds after the hash changes. Polling briefly
 * for it is the honest mechanism — a MutationObserver would fire hundreds of
 * times during a dashboard's first render to answer the same question. It gives
 * up after ~6s rather than hunting forever for an anchor nobody declared.
 *
 * THE ARROW IS THE POINT, not the scroll. Scrolling alone puts the section on
 * screen and says nothing about WHY it is on screen — on a page of five similar
 * cards the reader still has to work out which one the guide meant. The marker
 * names the entry that sent them and points at the answer. It clears on the
 * first scroll or click, or after eight seconds: it is an introduction, not a
 * decoration, and it must not still be there when the reader has moved on.
 */
export function GuideLanding() {
  const trail = useTrail();
  const anchor = parseTrail(trail).anchor;
  const [landed, setLanded] = useState<string | null>(null);

  useEffect(() => {
    setLanded(null);
    if (!anchor) return;
    let done = false;
    const deadline = Date.now() + 6000;
    const tick = () => {
      if (done) return;
      const el = document.querySelector<HTMLElement>(`[data-guide-anchor="${CSS.escape(anchor)}"]`);
      if (el) {
        done = true;
        el.classList.add('is-guide-landed');
        // `center`, not `start`: a section pinned to the very top of the viewport
        // loses the heading above it that says which part of the page this is.
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setLanded(anchor);
        return;
      }
      if (Date.now() < deadline) setTimeout(tick, 120);
    };
    tick();
    return () => {
      done = true;
      document.querySelectorAll('.is-guide-landed').forEach((n) => n.classList.remove('is-guide-landed'));
    };
  }, [anchor]);

  // Clears itself: any scroll or click means the reader has taken over, and the
  // timer covers the reader who does neither. `once` on each listener, so there
  // is nothing to tear down in the common case.
  useEffect(() => {
    if (!landed) return;
    const clear = () => setLanded(null);
    const t = setTimeout(clear, 8000);
    // Registered on a delay, or the smooth scroll this effect just started would
    // fire the scroll listener and dismiss the marker before it was ever seen.
    const arm = setTimeout(() => {
      window.addEventListener('wheel', clear, { once: true, passive: true });
      window.addEventListener('touchmove', clear, { once: true, passive: true });
      window.addEventListener('click', clear, { once: true });
    }, 900);
    return () => {
      clearTimeout(t); clearTimeout(arm);
      window.removeEventListener('wheel', clear);
      window.removeEventListener('touchmove', clear);
      window.removeEventListener('click', clear);
      document.querySelectorAll('.is-guide-landed').forEach((n) => n.classList.remove('is-guide-landed'));
    };
  }, [landed]);

  if (!landed) return null;
  const { term } = parseTrail(trail);
  const label = TRAIL_LABELS.get(term) ?? deSlug(term);
  return (
    <div className="guide-land" role="status">
      <span className="guide-land-arrow" aria-hidden>▸</span>
      <span className="guide-land-txt">
        <span className="l">User Guide sent you here</span>
        <span className="v">{label}</span>
      </span>
    </div>
  );
}

/**
 * THE STANDING ⓘ beside a section heading: "what is this, in the glossary?".
 *
 * A LINK, NOT A BUTTON, and an `<a href>` at that — it navigates, so it must be
 * middle-clickable, copyable and reachable by keyboard without any of that
 * having to be reimplemented.
 *
 * `term` MUST EXIST IN THE GLOSSARY or the mark lands on a page that scrolls
 * nowhere. Nothing in the type system can check a string against an array in
 * another module, so `api/_guide-trail.test.js` checks it instead: every term passed
 * to a GuideMark anywhere in the tree is asserted to be a real headword.
 */
export function GuideMark({ term, label }: { term: string; label?: string }) {
  return (
    <a className="guide-mark" href={guideHref(term)}
      aria-label={`What does ${label ?? term} mean? Opens the User Guide`}
      title={`User Guide: ${label ?? term}`}>ⓘ</a>
  );
}

/** Slug → words, for a hash nobody's guide entry claimed. Deliberately plain:
 *  it is a fallback, and dressing it up would hide that the label is a guess. */
const deSlug = (s: string) => {
  const w = s.replace(/-/g, ' ').trim();
  return w ? w[0].toUpperCase() + w.slice(1) : w;
};

/**
 * SLUG → THE TERM AS THE GLOSSARY SPELLS IT.
 *
 * A module-level map rather than context, because the only writer is the
 * glossary (one module, one call) and the only reader is the chip, which may be
 * mounted before the guide tab has ever been opened. Context would need a
 * provider wrapping the whole app to move one string.
 */
const TRAIL_LABELS = new Map<string, string>();
export function registerTrailLabels(terms: string[]) {
  for (const t of terms) TRAIL_LABELS.set(termSlug(t), t);
}
