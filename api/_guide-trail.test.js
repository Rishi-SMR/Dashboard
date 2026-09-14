// THE GUIDE TRAIL — the two contracts that break silently.
//
// Both failures look identical to a user (a link that scrolls nowhere) and
// neither shows up in a type check, a build or a render, because both are
// agreements between STRINGS in two different files:
//
//   1  every `term` handed to a <GuideMark> must be a real glossary headword;
//   2  the slug in the hash must equal the slug in the DOM id the guide scrolls
//      to, so `termSlug` and `termId` have to stay the same expression.
//
// Checked by reading the sources, because there is no DOM here and no bundler —
// and because the thing being asserted IS the text of the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: the repo lives under "D:\SMR Portal" and the
// space comes back percent-encoded from a URL, so every read looked for
// "SMR%20Portal" and failed.
const SRC = fileURLToPath(new URL('../src/cashflow/', import.meta.url));
const read = (p) => readFileSync(join(SRC, p), 'utf8');

/** Every .tsx/.ts under src/cashflow, so a mark added in a new file is covered
 *  the day it is written rather than the day someone remembers this test. */
function allSources(dir = SRC, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) allSources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push({ file: p.slice(SRC.length), text: readFileSync(p, 'utf8') });
  }
  return out;
}

const guide = read('components/UserGuideTab.tsx');
/** The glossary's headwords, straight out of the source. */
const TERMS = new Set([...guide.matchAll(/^\s*term: '([^']+)'/gm)].map((m) => m[1]));

test('the glossary parsed at all', () => {
  assert.ok(TERMS.size > 20, `expected a glossary, found ${TERMS.size} terms`);
});

test('every GuideMark term is a real glossary headword', () => {
  const bad = [];
  for (const { file, text } of allSources()) {
    // <GuideMark term="..."> and guide="..." on a ChartCard. Only literals are
    // checkable; `term={expr}` is covered by the section-table test below.
    for (const m of text.matchAll(/<GuideMark\s+term="([^"]+)"/g)) {
      if (!TERMS.has(m[1])) bad.push(`${file}: <GuideMark term="${m[1]}">`);
    }
    for (const m of text.matchAll(/\sguide="([^"]+)"/g)) {
      if (!TERMS.has(m[1])) bad.push(`${file}: guide="${m[1]}"`);
    }
  }
  assert.deepEqual(bad, [], `these point at terms the glossary does not define:\n  ${bad.join('\n  ')}`);
});

test("the PI book's four sections each name a real term", () => {
  const ar = read('components/ReceivablesTab.tsx');
  const used = [...ar.matchAll(/\bguide: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(used.length, 4, 'expected one guide term per PI section');
  for (const t of used) assert.ok(TERMS.has(t), `PI section points at unknown term "${t}"`);
});

test('termSlug and the guide’s termId build the same string', () => {
  // The guide must DELEGATE rather than keep its own copy of the expression.
  // Two identical regexes in two files is the pair that drifts, and the symptom
  // is a link that lands on the right page and scrolls to nothing.
  assert.match(
    guide,
    /const termId = \(t: string\) => `ug-t-\$\{termSlug\(t\)\}`/,
    'UserGuideTab.termId must be built from guideTrail.termSlug, not a second copy of the slug regex',
  );
});

test('the guide’s outbound links carry the term, not just the tab', () => {
  // `href={`#${l.view}`}` is the old form: it opens the right tab and strands
  // the reader there with no way back to what they were reading.
  assert.ok(!/href=\{`#\$\{l\.view\}`\}/.test(guide), 'a location link still uses a bare #view and carries no trail');
  assert.equal([...guide.matchAll(/trailHref\(l\.view,/g)].length, 2, 'both location lists must use trailHref');
});

test('the router tolerates a trail on the hash', () => {
  // readHash matched the WHOLE fragment against VIEW_KEYS, so every trail link
  // ("#receivables~ar-open") silently failed to navigate.
  const app = read('CashflowApp.tsx');
  assert.match(app, /splitHash\(raw\)\.view/, 'readHash must route on the view half of the hash');
  assert.match(app, /<GuideReturn \/>/, 'the return chip must be mounted once in the shell');
});

test('splitHash separates a trail without breaking a plain view hash', async () => {
  // Exercised through the source rather than imported: guideTrail.tsx is TSX and
  // node cannot load it. The function is four lines and the cases are the ones
  // that matter — a bare hash must keep working, or every pre-existing #link on
  // the Overview tiles stops routing.
  const src = read('guideTrail.tsx');
  // THE BODY ONLY, between `=> {` and the closing `};`. The signature is the one
  // part of the declaration carrying TypeScript annotations, so lifting the body
  // past it needs no type-stripping and no rewriting of the logic under test —
  // which is the whole point: a transform elaborate enough to break is a
  // transform that can pass a broken function.
  const decl = src.slice(src.indexOf('export const splitHash'));
  const body = decl.slice(decl.indexOf('=> {') + 4, decl.indexOf('\n};'));
  const fn = new Function('raw', 'SEP', body);
  const split = (raw) => fn(raw, '~');
  assert.deepEqual(split('#receivables'), { view: 'receivables', trail: null });
  assert.deepEqual(split('receivables'), { view: 'receivables', trail: null });
  assert.deepEqual(split('#receivables~ar-open'), { view: 'receivables', trail: 'ar-open' });
  assert.deepEqual(split('#guide~fifteen-percent-advance'), { view: 'guide', trail: 'fifteen-percent-advance' });
  // A trailing separator is not a trail: it would send the guide hunting for ''.
  assert.deepEqual(split('#receivables~'), { view: 'receivables', trail: null });
  assert.deepEqual(split(''), { view: '', trail: null });
});

// ── PRECISION: the guide must land ON the section, not merely on the tab ─────
// An `anchor` in the glossary and a `data-guide-anchor` in a component are a
// third string agreement across two files, and it fails the same silent way:
// the tab opens, nothing scrolls, and the reader is left to find the section
// themselves — which is the complaint this whole mechanism exists to answer.

/** Every anchor any screen declares, however it declares it. */
function declaredAnchors() {
  const found = new Set();
  for (const { text } of allSources()) {
    for (const m of text.matchAll(/data-guide-anchor="([^"{]+)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/\sanchor="([^"]+)"/g)) found.add(m[1]);
  }
  return found;
}

test('every anchor the glossary points at is declared by a screen', () => {
  const declared = declaredAnchors();
  // The PI book's four sections are opened by ReceivablesTab's own effect rather
  // than by a static attribute — it has to press the tab before the section
  // exists in the DOM at all — so they are declared by that regex instead.
  const dynamic = /\/\^pi-\(\[1-4\]\)\$\//.test(read('components/ReceivablesTab.tsx'))
    ? ['pi-1', 'pi-2', 'pi-3', 'pi-4'] : [];
  for (const a of dynamic) declared.add(a);

  const bad = [];
  for (const m of guide.matchAll(/anchor: '([^']+)'/g)) {
    if (!declared.has(m[1])) bad.push(m[1]);
  }
  assert.deepEqual([...new Set(bad)], [],
    `the glossary links to anchors no screen declares, so these scroll nowhere:\n  ${[...new Set(bad)].join('\n  ')}`);
});

test('a PI-section anchor is what opens that section', () => {
  const ar = read('components/ReceivablesTab.tsx');
  assert.match(ar, /currentAnchor\(\)/, 'the PI book must read the anchor to open the right sub-tab');
  assert.match(ar, /\^pi-\(\[1-4\]\)\$/, 'pi-1..pi-4 are the four section anchors');
  assert.match(ar, /data-guide-anchor="pi-book"/, 'the book itself must be scrollable-to once the tab is open');
});

test('trailHref appends the anchor only when there is one', () => {
  const src = read('guideTrail.tsx');
  const decl = src.slice(src.indexOf('export const trailHref'));
  const body = decl.slice(decl.indexOf('=>') + 2, decl.indexOf(';\n'));
  const fn = new Function('view', 'term', 'anchor', 'SEP', 'termSlug', `return ${body.trim()}`);
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const href = (v, t, a) => fn(v, t, a, '~', slug);
  // Without an anchor the link is exactly what it was, so nothing that already
  // worked changes shape.
  assert.equal(href('receivables', 'AR Open'), '#receivables~ar-open');
  assert.equal(href('receivables', 'AR Open', 'ar-aging'), '#receivables~ar-open~ar-aging');
  assert.equal(href('receivables', 'Not invoiced', 'pi-3'), '#receivables~not-invoiced~pi-3');
});

test('parseTrail splits the entry from the section it landed on', () => {
  const src = read('guideTrail.tsx');
  const decl = src.slice(src.indexOf('export const parseTrail'));
  const body = decl.slice(decl.indexOf('=> {') + 4, decl.indexOf('\n};'));
  const fn = new Function('trail', 'SEP', body);
  const parse = (t) => fn(t, '~');
  assert.deepEqual(parse('ar-open'), { term: 'ar-open', anchor: null });
  assert.deepEqual(parse('ar-open~ar-aging'), { term: 'ar-open', anchor: 'ar-aging' });
  assert.deepEqual(parse('not-invoiced~pi-3'), { term: 'not-invoiced', anchor: 'pi-3' });
  // The return chip reads the term half — it must never be handed "ar-open~pi-3"
  // and try to name an entry with that.
  assert.deepEqual(parse(null), { term: '', anchor: null });
  assert.deepEqual(parse('ar-open~'), { term: 'ar-open', anchor: null });
});

test('the landing marker is mounted once in the shell', () => {
  assert.match(read('CashflowApp.tsx'), /<GuideLanding \/>/);
});

// ── THE ROUTER'S ALLOW-LIST ──────────────────────────────────────────────────
// `VIEW_KEYS` is a runtime array that has to list the whole `ViewKey` union.
// Nothing checks that: the union is a TYPE and is erased at build time, so a
// key missing from the array is not a type error, a build error, or a render
// error. `readHash` just returns null for it and the router ignores the hash.
//
// `arsheet` was missing, and the damage was invisible from the tab itself — the
// sidebar calls setView directly and never reads this list, so the AR Register
// opened perfectly. Only HASH navigation to it was dead, which is to say: the
// seven User Guide entries that link to it, and any bookmarked #arsheet URL.

const app = read('CashflowApp.tsx');
const listOf = (re) => [...(re.exec(app)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
const UNION = listOf(/export type ViewKey =([^;]+);/);
const ROUTABLE = listOf(/const VIEW_KEYS: ViewKey\[\] = \[([^\]]+)\]/);

test('the ViewKey union parsed at all', () => {
  assert.ok(UNION.length > 20, `expected the view union, found ${UNION.length}`);
  assert.ok(ROUTABLE.length > 20, `expected VIEW_KEYS, found ${ROUTABLE.length}`);
});

test('every ViewKey is routable by hash', () => {
  const missing = UNION.filter((k) => !ROUTABLE.includes(k));
  assert.deepEqual(missing, [], `in the ViewKey union but absent from VIEW_KEYS, so #${missing[0]} is ignored by the router:\n  ${missing.join('\n  ')}`);
});

test('VIEW_KEYS invents no view the union does not declare', () => {
  const extra = ROUTABLE.filter((k) => !UNION.includes(k));
  assert.deepEqual(extra, [], `routable but not a real ViewKey:\n  ${extra.join('\n  ')}`);
});

test('every screen the glossary links to is reachable by hash', () => {
  // The user-facing half of the same contract: a guide entry naming a view the
  // router will not follow is a link that does nothing when clicked.
  const targets = [...new Set([...guide.matchAll(/view: '([a-z]+)'/g)].map((m) => m[1]))];
  assert.ok(targets.length > 10, `expected glossary locations, found ${targets.length}`);
  const dead = targets.filter((v) => !ROUTABLE.includes(v));
  assert.deepEqual(dead, [], `the User Guide links to these, and the router ignores them:\n  ${dead.join('\n  ')}`);
});

test('the return chip stands down on the User Guide itself', () => {
  // `#guide~ar-open` still carries a trail, so without an explicit test on the
  // view the chip follows the reader home and offers to take them where they
  // already are — and its href equals the current hash, so it cannot even fire
  // a hashchange. Asserted on the source because there is no DOM here.
  const src = read('guideTrail.tsx');
  const fn = src.slice(src.indexOf('export function GuideReturn'), src.indexOf('export function GuideLanding'));
  assert.match(fn, /view === 'guide'/, 'GuideReturn must not render on the guide view');
});
