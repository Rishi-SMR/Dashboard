// ── Reading an .xlsx workbook ────────────────────────────────────────────────
// The counterpart to src/cashflow/xlsx.js, which WRITES the workbooks the
// dashboard downloads. This reads one, and it exists for a single reason: a
// Google Sheet's TAB NAMES.
//
// The commission workbooks name each tab for its payout cycle ("8/15/2026"),
// and the cycle is the only thing that says which month the tab's money belongs
// to — nothing inside the sheet repeats it. Google's CSV export returns one tab
// at a time and identifies it by an opaque numeric `gid`, never by name, so a
// CSV-based reader would need every gid pinned in configuration and a config
// edit every month a tab is added. The xlsx export carries the whole workbook,
// names included, so a new tab appears on the dashboard by itself.
//
// Deliberately minimal: enough of ZIP and SpreadsheetML to read a small,
// machine-generated sheet of text and numbers. No styles, no dates, no
// formulas — a formula cell yields its cached VALUE, which is what we want.
// node:zlib is the only dependency.
import zlib from 'node:zlib';

/** Central-directory walk. Returns name → decompressed Buffer. */
function unzip(buf) {
  // The end-of-central-directory record is at the tail, after a comment of
  // unknown length, so it is found by scanning back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70_000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // The local header repeats the name and carries its own extra field, whose
    // length differs from the central one — the data starts after BOTH.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    try { out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)); }
    catch { /* a part we cannot inflate is a part we do not need */ }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');                       // last, or the others double-unescape

/** "C" → 2, "AA" → 26. Cells are sparse, so the column index has to be read. */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * @param {Buffer} buffer an .xlsx file
 * @returns {{name: string, rows: string[][]}[]} one entry per tab, in workbook
 *   order, each a dense array of rows of cell strings.
 */
export function readXlsxBuffer(buffer) {
  const files = unzip(buffer);
  const text = (k) => (files.has(k) ? files.get(k).toString('utf8') : '');

  // Shared strings: most text cells are an index into this table.
  const shared = [];
  for (const si of text('xl/sharedStrings.xml').split('<si>').slice(1)) {
    // A run-formatted string is several <t> fragments; joining them restores it.
    shared.push(unescapeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  }

  // relationship id → the sheet part it points at
  const rels = new Map();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const sheets = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet[^>]*\/>/g)) {
    const tag = m[0];
    const name = unescapeXml((/name="([^"]*)"/.exec(tag) || [])[1] ?? '');
    const rid = (/r:id="([^"]+)"/.exec(tag) || [])[1];
    const part = rid && rels.get(rid);
    if (!part) continue;
    const xml = text(`xl/${part}`);
    const rows = [];
    for (const chunk of xml.split('<row').slice(1)) {
      const cells = [];
      for (const c of chunk.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        const inline = (/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = unescapeXml(inline ?? '');
        else if (v != null) val = unescapeXml(v);
        const i = colIndex((/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1]);
        if (i >= 0) cells[i] = val; else cells.push(val);
      }
      rows.push(Array.from(cells, (v) => v ?? ''));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
