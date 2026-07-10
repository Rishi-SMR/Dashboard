/**
 * CFO Copilot guided "show me" walkthrough, performed by a little articulated
 * robot that actually WALKS (arms swing, legs step), then raises its arm and
 * TAPS the tab with its finger to open it - while the page auto-scrolls in sync
 * with the robot (scrolls up when it walks up, down when it walks down). It taps
 * the tab, the tab opens, then it walks down to the section and points at it.
 */

export type CfoNavDetail = { view: string; tab: string; anchor: string };

const EVENT = 'cfo-nav';
let runId = 0;

const TAB_LABEL: Record<string, string> = {
  // Cash Flow
  position: 'Current Position', dashboard: 'Cash Flow', cashflow13: '13-Week Plan',
  // Expenses
  monthly: 'Monthly Summary', combined: 'Expenses', mapping: 'P&L Mapping', subscriptions: 'Subscriptions',
  // Reports
  pl: 'P&L', bs: 'Balance Sheet', bank: 'Bank Transactions', cc: 'Credit Card Transactions',
  // Upflow
  overview: 'Overview', invoices: 'Invoices', customers: 'Customers', reminders: 'Reminders', replies: 'Replies', workflows: 'Workflows', payments: 'Payments', users: 'Team',
};

type Pt = { x: number; y: number };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function cfoNavigate(detail: CfoNavDetail): void {
  const my = ++runId;
  document.querySelectorAll('.cfo-fly, .cfo-fly-bubble, .cfo-ripple').forEach((n) => n.remove());
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { view: detail.view, tab: '', anchor: '' } }));
  window.setTimeout(() => { void walkthrough(detail, my).catch(() => { /* best-effort */ }); }, 240);
}

// ── The robot (built from parts so its limbs can move + tap) ─────────────────

const STYLE_ID = 'cfo-bot-style';
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .cfo-fly { position:fixed; left:0; top:0; width:60px; height:78px; z-index:100001; pointer-events:none;
               filter: drop-shadow(0 9px 14px rgba(0,0,0,.32)); will-change: transform, opacity; }
    .cfo-bot { position:absolute; inset:0; }
    .cfo-bot .ant { position:absolute; left:50%; top:0; width:3px; height:9px; margin-left:-1.5px; background:#1d4ed8; border-radius:2px; }
    .cfo-bot .ant::after { content:''; position:absolute; left:50%; top:-6px; width:8px; height:8px; margin-left:-4px; background:#22d3ee; border-radius:50%; box-shadow:0 0 7px #22d3ee; }
    .cfo-bot .head { position:absolute; left:7px; top:8px; width:46px; height:33px; background:#eef4ff; border:2px solid #1d4ed8; border-radius:12px; box-sizing:border-box; }
    .cfo-bot .screen { position:absolute; inset:5px; background:#0b1f4d; border-radius:8px; }
    .cfo-bot .eye { position:absolute; top:9px; width:8px; height:8px; border-radius:50% 50% 45% 45%; background:#34e3f2; box-shadow:0 0 6px #34e3f2; }
    .cfo-bot .eye.left { left:9px; } .cfo-bot .eye.right { right:9px; }
    .cfo-bot .arm { position:absolute; top:41px; width:8px; height:21px; background:#3b82f6; border:1.5px solid #1d4ed8; border-radius:5px; box-sizing:border-box; transform-origin:50% 4px; }
    .cfo-bot .arm.left { left:3px; } .cfo-bot .arm.right { right:3px; }
    .cfo-bot .hand { position:absolute; left:-1px; bottom:-3px; width:9px; height:9px; background:#60a5fa; border:1.5px solid #1d4ed8; border-radius:50%; box-sizing:border-box; }
    .cfo-bot .arm.right .finger { position:absolute; right:1px; bottom:-5px; width:3px; height:6px; background:#60a5fa; border-radius:2px; }
    .cfo-bot .body { position:absolute; left:13px; top:40px; width:34px; height:24px; background:#2563eb; border:2px solid #1d4ed8; border-radius:10px; box-sizing:border-box; }
    .cfo-bot .body::after { content:''; position:absolute; left:50%; top:7px; width:8px; height:8px; margin-left:-4px; background:#93c5fd; border-radius:50%; }
    .cfo-bot .leg { position:absolute; top:60px; width:10px; height:15px; background:#1d4ed8; border-radius:5px; transform-origin:50% 2px; }
    .cfo-bot .leg.left { left:18px; } .cfo-bot .leg.right { right:18px; }
    .cfo-bot .leg::after { content:''; position:absolute; left:-2px; bottom:-3px; width:13px; height:6px; background:#0e2f86; border-radius:4px; }

    .cfo-fly.cfo-walking .cfo-bot { animation: cfoBodyBob .44s ease-in-out infinite; }
    .cfo-fly.cfo-walking .arm.left  { animation: cfoSwingA .44s ease-in-out infinite; }
    .cfo-fly.cfo-walking .arm.right { animation: cfoSwingB .44s ease-in-out infinite; }
    .cfo-fly.cfo-walking .leg.left  { animation: cfoStepB .44s ease-in-out infinite; }
    .cfo-fly.cfo-walking .leg.right { animation: cfoStepA .44s ease-in-out infinite; }
    @keyframes cfoBodyBob { 0%,100%{ transform:translateY(0) } 25%,75%{ transform:translateY(-3px) } }
    @keyframes cfoSwingA { 0%,100%{ transform:rotate(32deg) }  50%{ transform:rotate(-32deg) } }
    @keyframes cfoSwingB { 0%,100%{ transform:rotate(-32deg) } 50%{ transform:rotate(32deg) } }
    @keyframes cfoStepA  { 0%,100%{ transform:rotate(26deg) }  50%{ transform:rotate(-26deg) } }
    @keyframes cfoStepB  { 0%,100%{ transform:rotate(-26deg) } 50%{ transform:rotate(26deg) } }

    /* TAP - raise the right arm and jab the finger */
    .cfo-fly.cfo-tap .arm.right { animation: cfoTapArm .72s ease-in-out; }
    @keyframes cfoTapArm { 0%{transform:rotate(-12deg)} 30%{transform:rotate(-108deg)} 48%{transform:rotate(-80deg)} 64%{transform:rotate(-104deg)} 100%{transform:rotate(-12deg)} }

    /* IDLE - friendly little wave with the right arm while standing */
    .cfo-fly:not(.cfo-walking):not(.cfo-tap) .arm.right { animation: cfoWave 1.1s ease-in-out infinite; }
    @keyframes cfoWave { 0%,100%{ transform:rotate(-12deg) } 50%{ transform:rotate(-46deg) } }

    .cfo-fly-bubble { position:fixed; left:0; top:0; z-index:100002; background:#065f46; color:#fff;
      padding:6px 11px; border-radius:12px; font-size:12.5px; font-weight:600; pointer-events:none;
      opacity:0; transition:opacity .3s ease; box-shadow:0 6px 18px rgba(0,0,0,.28); white-space:nowrap; }
    .cfo-ripple { position:fixed; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%;
      border:2px solid #10b981; background:rgba(16,185,129,.22); z-index:100000; pointer-events:none; }
  `;
  document.head.appendChild(s);
}

function makeBot(): HTMLDivElement {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'cfo-fly';
  el.innerHTML = `
    <div class="cfo-bot">
      <div class="ant"></div>
      <div class="arm left"><div class="hand"></div></div>
      <div class="arm right"><div class="hand"></div><div class="finger"></div></div>
      <div class="body"></div>
      <div class="leg left"></div>
      <div class="leg right"></div>
      <div class="head"><div class="screen"></div><div class="eye left"></div><div class="eye right"></div></div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function makeBubble(): HTMLDivElement {
  const b = document.createElement('div');
  b.className = 'cfo-fly-bubble';
  document.body.appendChild(b);
  return b;
}

// ── Motion helpers ───────────────────────────────────────────────────────────

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Smoothly scroll the window to `toY` over `dur` ms. */
function animateScroll(toY: number, dur: number): Promise<void> {
  const fromY = window.scrollY;
  if (Math.abs(toY - fromY) < 3) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, fromY + (toY - fromY) * easeInOut(t));
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Move the robot from `from` to `to` at walking pace; limbs animate via CSS. */
function walkBot(bot: HTMLDivElement, from: Pt, to: Pt, dur: number): Promise<void> {
  bot.classList.add('cfo-walking');
  return new Promise<void>((resolve) => {
    const a = bot.animate(
      [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
      { duration: dur, easing: 'linear', fill: 'forwards' },
    );
    a.onfinish = () => { bot.classList.remove('cfo-walking'); resolve(); };
  });
}

/** Walk to an element while the page auto-scrolls so the element lands at
 *  `frac` of the viewport height. Returns the robot's resting spot. */
async function walkToElement(bot: HTMLDivElement, from: Pt, el: HTMLElement, dur: number, frac: number): Promise<Pt> {
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
  const targetScrollY = Math.max(0, Math.min(maxScroll, window.scrollY + rect.top - vh * frac));
  const delta = targetScrollY - window.scrollY;
  const postTop = rect.top - delta;
  const to: Pt = {
    x: Math.max(8, Math.min(window.innerWidth - 68, rect.left + rect.width / 2 - 30)),
    y: Math.max(8, Math.min(vh - 86, postTop - 84)),
  };
  await Promise.all([animateScroll(targetScrollY, dur), walkBot(bot, from, to, dur)]);
  return to;
}

function ripple(x: number, y: number): void {
  const r = document.createElement('div');
  r.className = 'cfo-ripple';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  document.body.appendChild(r);
  r.animate([{ transform: 'scale(.25)', opacity: 0.75 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 560, easing: 'ease-out' })
    .onfinish = () => r.remove();
}

/** Play the tap gesture; fire `onTap` at the jab and ripple at `point`. */
function tapAt(bot: HTMLDivElement, point: Pt, onTap: () => void): Promise<void> {
  bot.classList.add('cfo-tap');
  return new Promise<void>((resolve) => {
    window.setTimeout(() => { ripple(point.x, point.y); onTap(); }, 320);
    window.setTimeout(() => { bot.classList.remove('cfo-tap'); resolve(); }, 760);
  });
}

function say(bubble: HTMLDivElement, at: Pt, text: string): void {
  bubble.textContent = text;
  bubble.style.transform = `translate(${Math.min(window.innerWidth - 150, at.x + 56)}px, ${Math.max(6, at.y + 8)}px)`;
  bubble.style.opacity = '1';
}

async function walkthrough(detail: CfoNavDetail, my: number): Promise<void> {
  const bot = makeBot();
  const bubble = makeBubble();
  let pos: Pt = { x: window.innerWidth - 92, y: window.innerHeight - 112 };
  bot.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  bot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, fill: 'forwards' });

  const cleanup = () => { bot.remove(); bubble.remove(); };
  const aborted = () => my !== runId;

  // STEP 1 - walk to the tab (page scrolls up to it), then tap it to open.
  const tabLabel = TAB_LABEL[detail.tab];
  const tabBtn = tabLabel
    ? ([...document.querySelectorAll('.expenses-tab')].find((b) => b.textContent?.trim() === tabLabel) as HTMLElement | undefined)
    : undefined;

  if (tabBtn) {
    pos = await walkToElement(bot, pos, tabBtn, 1750, 0.14); if (aborted()) return cleanup();
    say(bubble, pos, 'Let me open this tab');
    const tr = tabBtn.getBoundingClientRect();
    await tapAt(bot, { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 }, () => {
      tabBtn.classList.add('cfo-highlight');
      window.dispatchEvent(new CustomEvent(EVENT, { detail }));
    });
    if (aborted()) return cleanup();
    await wait(550); tabBtn.classList.remove('cfo-highlight');
    bubble.style.opacity = '0';
    await wait(550); if (aborted()) return cleanup();
  } else {
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
    await wait(700);
  }

  // STEP 2 - walk down to the section (page scrolls with it) and tap/point.
  let el: HTMLElement | null = null;
  for (let i = 0; i < 16 && !el; i++) {
    el = document.querySelector(`[data-cfo-anchor="${detail.anchor}"]`);
    if (!el) await wait(130);
  }
  if (aborted()) return cleanup();

  if (el) {
    pos = await walkToElement(bot, pos, el, 1850, 0.4); if (aborted()) return cleanup();
    const sr = el.getBoundingClientRect();
    await tapAt(bot, { x: sr.left + Math.min(70, sr.width / 2), y: sr.top + 18 }, () => {
      el!.classList.add('cfo-highlight');
    });
    if (aborted()) return cleanup();
    say(bubble, pos, 'Here it is 👇');
    await wait(2700); if (aborted()) return cleanup();
    el.classList.remove('cfo-highlight');
  }

  bubble.style.opacity = '0';
  bot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' }).onfinish = cleanup;
}

/** Subscribe to nav requests. Returns an unsubscribe fn. */
export function onCfoNav(handler: (d: CfoNavDetail) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent).detail as CfoNavDetail);
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
