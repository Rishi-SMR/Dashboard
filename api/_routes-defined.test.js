import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
// api/index.js and striven-server/index.js implement the same routes from the
// same imports, and blocks get copied between them. They name the parsed URL
// differently — `url` in the serverless handler, `reqUrl` in the dev server — so
// a copied block parses, passes `node --check`, serves correctly in dev, and
// throws ReferenceError in PRODUCTION ONLY. That is how /api/so/:id came to
// answer "Could not load · reqUrl is not defined" on a live sales-order drill.
//
// WHY THIS IS A STATIC TEST AND NOT A REQUEST. The obvious version — call the
// route and assert the body carries no "is not defined" — DOES NOT WORK, and it
// was written and thrown away before this. Every one of these routes answers 401
// from its session guard long before the bad identifier is evaluated, so the
// request-based test passes with the bug present. That was verified by putting
// the fault back: the request assertions stayed green and only the source scan
// went red. A test that cannot fail on the bug it names is worse than none.
//
// Reading the source is therefore the point, not a shortcut.

const FILES = {
  'api/index.js': new URL('./index.js', import.meta.url),
  'striven-server/index.js': new URL('../striven-server/index.js', import.meta.url),
};

/** Source with comments removed — this file's own prose names `reqUrl`, and a
 *  scan that counted comments would flag the explanation as the defect. */
const codeOf = (url) => {
  const raw = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Line comments, dropped a line at a time so a URL's "//" cannot be mistaken
  // for one: a comment marker only counts when it is not preceded by a colon.
  return raw.split('\n').map((line) => {
    const i = line.indexOf('//');
    return i < 0 || (i > 0 && line[i - 1] === ':') ? line : line.slice(0, i);
  }).join('\n');
};

/** Names bound anywhere in the file: declarations, imports and function params.
 *  Deliberately over-inclusive — a false negative here just misses a bug, while
 *  a false positive would fail the suite on working code. */
function boundNames(src) {
  const names = new Set();
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bimport\s*\{([^}]*)\}/g,
    /\(([^)]*)\)\s*=>/g,
    /\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const part of String(m[1]).split(',')) {
        const n = part.trim().split(/\s+as\s+|[:=]/)[0].trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
    }
  }
  return names;
}

// The URL object is what actually differs between the two files, so every read
// of it is checked. `.pathname` is included because it is the other half of the
// same object and fails the same way.
const URL_READS = /\b([A-Za-z_$][\w$]*)\.(searchParams|pathname)\b/g;

for (const [label, url] of Object.entries(FILES)) {
  test(`${label}: every URL identifier it reads is declared in the same file`, () => {
    const src = codeOf(url);
    const bound = boundNames(src);
    const missing = new Set();
    for (const m of src.matchAll(URL_READS)) if (!bound.has(m[1])) missing.add(m[1]);
    assert.deepEqual([...missing], [],
      `${label} reads ${[...missing].join(', ')} but never declares it. These two `
      + 'files name the parsed URL differently — `url` in api/index.js, `reqUrl` in '
      + 'striven-server/index.js — so this is almost certainly a block copied from '
      + 'the other without renaming it.');
  });
}

test('the two servers still disagree about the name, which is why the scan is needed', () => {
  // A standing note, not a style rule. If someone unifies the names one day this
  // test says so, and the scan above can go with it.
  assert.match(codeOf(FILES['api/index.js']), /\bconst\s+url\s*=\s*new URL\(/);
  assert.match(codeOf(FILES['striven-server/index.js']), /\bconst\s+reqUrl\s*=\s*new URL\(/);
});
