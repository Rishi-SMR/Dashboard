// Lightweight, dependency-free 3D pointer-tilt for the hero KPI cards.
// Cards lean toward the cursor with a soft perspective and a moving specular
// sheen (see the .is-tilt rules in cashflow.css). It is a pure enhancement:
//   • gated to fine-pointer devices (no phones/tablets),
//   • disabled when the user prefers reduced motion,
//   • only ever writes inline `transform` + a couple of CSS vars,
// so it can never affect layout, data, or the approved resting look.
//
// One document-level listener (rAF-throttled) handles every card, including the
// ones that mount later from lazy tabs: no per-component wiring needed.

const SELECTOR = '.kpi--exec, .kpi-r, .kpi--grad';
const MAX_DEG = 5; // max tilt per axis (deg)
const LIFT = -5; // px the card rises while hovered

export function initCardTilt(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!fine.matches || reduce.matches) return;

  let active: HTMLElement | null = null;
  let frame = 0;
  let next: { el: HTMLElement; x: number; y: number } | null = null;

  const paint = () => {
    frame = 0;
    if (!next) return;
    const { el, x, y } = next;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (x - r.left) / r.width - 0.5; // -0.5 .. 0.5
    const py = (y - r.top) / r.height - 0.5;
    const ry = (px * MAX_DEG * 2).toFixed(2);
    const rx = (-py * MAX_DEG * 2).toFixed(2);
    el.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(${LIFT}px)`;
    el.style.setProperty('--mx', `${((px + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${((py + 0.5) * 100).toFixed(1)}%`);
  };

  const clear = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.transform = '';
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
    el.classList.remove('is-tilt');
  };

  document.addEventListener(
    'pointermove',
    (e) => {
      const el = e.target instanceof Element ? (e.target.closest(SELECTOR) as HTMLElement | null) : null;
      if (el !== active) {
        clear(active);
        active = el;
        if (el) el.classList.add('is-tilt');
      }
      if (!el) return;
      next = { el, x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    },
    { passive: true },
  );

  // Settle the card back when the pointer leaves the window or the tab blurs.
  document.addEventListener('mouseleave', () => { clear(active); active = null; });
  window.addEventListener('blur', () => { clear(active); active = null; });
}
