import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, crc32, colRef, safeSheetName, xmlEscape } from '../src/cashflow/xlsx.js';

/**
 * The .xlsx writer is hand-rolled, so "it compiles" proves nothing — a
 * malformed ZIP or a bad CRC produces a file Excel refuses to open with no
 * useful error. These parse the archive back out and check it structurally.
 */

/** Dependency-free ZIP reader, for verification only. */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = [];
  for (let i = 0; i < buf.length - 30; i++) {
    if (dv.getUint32(i, true) !== 0x04034b50) continue;
    const crc = dv.getUint32(i + 14, true);
    const size = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    entries.push({ name, crc, data: buf.subarray(start, start + size) });
  }
  return entries;
}
const partText = (buf, name) => {
  const e = readZip(buf).find((x) => x.name === name);
  assert.ok(e, `part ${name} is missing`);
  return new TextDecoder().decode(e.data);
};

test('xlsx: archive contains every part Excel requires', () => {
  const buf = buildXlsx([{ name: 'Orders', rows: [['Ref', 'Value'], ['SO-1', 1299]] }]);
  const names = readZip(buf).map((e) => e.name);
  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml',
  ]) {
    assert.ok(names.includes(required), `missing ${required} — Excel will refuse the file`);
  }
});

test('xlsx: every entry CRC matches its bytes', () => {
  const buf = buildXlsx([{ name: 'A', rows: [['x', 1]] }, { name: 'B', rows: [['y', 2]] }]);
  const entries = readZip(buf);
  assert.ok(entries.length >= 6, 'expected one part per sheet plus the four fixed parts');
  for (const e of entries) {
    assert.equal(crc32(e.data), e.crc, `bad CRC on ${e.name} — the archive is corrupt`);
  }
});

test('xlsx: the archive ends with a well-formed EOCD record', () => {
  const buf = buildXlsx([{ name: 'S', rows: [['a']] }]);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocdAt = buf.length - 22;
  assert.equal(dv.getUint32(eocdAt, true), 0x06054b50, 'end-of-central-directory signature missing');
  assert.equal(dv.getUint16(eocdAt + 10, true), 5, 'EOCD must count all five parts');
});

test('xlsx: numbers stay numeric and text is escaped', () => {
  const buf = buildXlsx([{ name: 'S', rows: [['A & B <tag>', 1299.5]] }]);
  const xml = partText(buf, 'xl/worksheets/sheet1.xml');
  assert.match(xml, /<v>1299\.5<\/v>/, 'numbers must not be written as text');
  assert.match(xml, /A &amp; B &lt;tag&gt;/, 'XML special characters must be escaped');
});

test('xlsx: sheet names are sanitised to what Excel accepts', () => {
  const buf = buildXlsx([{ name: 'Orders/2026:Q[1]', rows: [['a']] }]);
  const wb = partText(buf, 'xl/workbook.xml');
  assert.doesNotMatch(wb, /name="[^"]*[:\\/?*[\]]/, 'illegal sheet-name characters must be stripped');
  assert.equal(safeSheetName('x'.repeat(50), 0).length, 31, 'names cap at 31 characters');
  assert.equal(safeSheetName('', 2), 'Sheet3', 'blank names get a fallback');
});

test('xlsx: control characters are stripped, not emitted', () => {
  const dirty = `bad${String.fromCharCode(7)}char`;
  assert.equal(xmlEscape(dirty), 'badchar');
  const xml = partText(buildXlsx([{ name: 'S', rows: [[dirty]] }]), 'xl/worksheets/sheet1.xml');
  assert.doesNotMatch(xml, /[\x00-\x08\x0B\x0C\x0E-\x1F]/, 'control chars are illegal in XML 1.0');
});

test('xlsx: column references carry Z into AA', () => {
  // Off-by-one here silently corrupts every sheet wider than 26 columns.
  assert.equal(colRef(0), 'A');
  assert.equal(colRef(25), 'Z');
  assert.equal(colRef(26), 'AA');
  assert.equal(colRef(27), 'AB');
  assert.equal(colRef(51), 'AZ');
  assert.equal(colRef(52), 'BA');
});

test('xlsx: empty cells are skipped rather than written blank', () => {
  const xml = partText(buildXlsx([{ name: 'S', rows: [['a', null, undefined, '', 0]] }]), 'xl/worksheets/sheet1.xml');
  assert.match(xml, /r="A1"/);
  assert.doesNotMatch(xml, /r="B1"/, 'null must not produce a cell');
  assert.match(xml, /r="E1"><v>0<\/v>/, 'zero is a real value and must survive');
});

test('xlsx: survives an empty workbook without producing a broken file', () => {
  const buf = buildXlsx([]);
  assert.ok(readZip(buf).some((e) => e.name === 'xl/worksheets/sheet1.xml'));
});
