/**
 * .xlsx writing — pure logic, no DOM, no dependency.
 *
 * Plain JavaScript on purpose: the tests import this file directly, so they run
 * against the exact code the app ships rather than a transpiled copy. The
 * browser-facing wrappers (download, print) live in export.ts.
 *
 * An .xlsx is a ZIP of XML parts. Using the "store" method (no compression)
 * means the only tricky part is a CRC32, which is ~15 lines.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
const u32 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** ZIP archive, store method. `entries` is [{ name, data: Uint8Array }]. */
export function zipStore(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = cat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0), name, e.data,
    ]);
    locals.push(local);
    central.push(cat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }

  const cd = cat(central);
  const eocd = cat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return cat([...locals, cd, eocd]);
}

export const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0; leaving them in produces a
    // file Excel refuses to open with no useful error.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

/** 0 -> A, 25 -> Z, 26 -> AA. Getting this wrong past column Z corrupts the sheet. */
export function colRef(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/** Excel rejects : \ / ? * [ ] in a sheet name, and anything over 31 chars. */
export const safeSheetName = (s, i) =>
  (String(s || '').replace(/[:\\/?*[\]]/g, '-').slice(0, 31)) || `Sheet${i + 1}`;

function sheetXml(rows) {
  const body = (rows || []).map((row, r) => {
    const cells = (row || []).map((v, c) => {
      if (v == null || v === '') return '';
      const ref = `${colRef(c)}${r + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      // inlineStr keeps everything in the sheet — no sharedStrings part needed.
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${body}</sheetData></worksheet>`;
}

/** `sheets` is [{ name, rows: Cell[][] }]. Returns the .xlsx bytes. */
export function buildXlsx(sheets) {
  const enc = new TextEncoder();
  const list = sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = list.map((s, i) => safeSheetName(s.name, i));

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';

  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) })),
  ]);
}
