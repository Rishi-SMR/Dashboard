// The reader exists for TAB NAMES: a commission workbook names each tab for its
// payout cycle and nothing inside the tab repeats the period, so losing names
// loses the month attribution. These tests build a workbook with the project's
// own writer and read it back, so the two stay in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readXlsxBuffer } from './_xlsx-read.js';
import { buildXlsx } from '../src/cashflow/xlsx.js';

const wb = (sheets) => Buffer.from(buildXlsx(sheets));

test('tab names survive the round trip — the whole point of the reader', () => {
  const out = readXlsxBuffer(wb([
    { name: '8152026', rows: [['PATIENT', 'DEVICE', 'COMMISSION'], ['Marivel Leal', 'Genesys Universal', 60.99]] },
    { name: '7152026', rows: [['PATIENT', 'DEVICE', 'COMMISSION'], ['Leo Mathews', 'Genesys Lumbar', 136.67]] },
  ]));
  assert.deepEqual(out.map((s) => s.name), ['8152026', '7152026'], 'names, in workbook order');
});

test('cells read back as written, numbers included', () => {
  const [s] = readXlsxBuffer(wb([{ name: 'T', rows: [['PATIENT', 'DEVICE', 'COMMISSION'], ['Marivel Leal', 'Genesys Universal', 60.99], ['Maria Arteaga', 'Manaray Neck', 231.82]] }]));
  assert.deepEqual(s.rows[0], ['PATIENT', 'DEVICE', 'COMMISSION']);
  assert.equal(s.rows[1][0], 'Marivel Leal');
  assert.equal(Number(s.rows[1][2]), 60.99);
  assert.equal(Number(s.rows[2][2]), 231.82);
});

// A commission workbook is text typed by people. An ampersand or a quote in a
// device name must not shift the row, because the column POSITION is what says
// which value is the money.
test('escaped text and blank cells keep their columns', () => {
  const [s] = readXlsxBuffer(wb([{ name: 'T', rows: [['A & B', '', '"quoted" <tag>', 5]] }]));
  assert.equal(s.rows[0][0], 'A & B');
  assert.equal(s.rows[0][2], '"quoted" <tag>');
  assert.equal(Number(s.rows[0][3]), 5, 'a blank cell does not shift the ones after it');
});

test('a non-zip input is refused rather than read as garbage', () => {
  assert.throws(() => readXlsxBuffer(Buffer.from('this is not a workbook')), /not a zip/i);
});

// DEFLATE, which is what Google's export actually uses. The project's own
// writer stores entries uncompressed, so without this the compressed path —
// the only one that runs in production — would never be exercised. The fixture
// is a real deflated zip built here rather than a checked-in binary.
test('reads a deflate-compressed workbook, not just a stored one', () => {
  const stored = wb([{ name: '8152026', rows: [['PATIENT', 'DEVICE', 'COMMISSION'], ['Maria Arteaga', 'Manaray Neck', 231.82]] }]);
  const recompressed = recompress(stored);
  assert.ok(recompressed.length !== stored.length, 'the fixture really is a different encoding');
  const [s] = readXlsxBuffer(recompressed);
  assert.equal(s.name, '8152026');
  assert.equal(Number(s.rows[1][2]), 231.82);
});

/** Re-emit a STORED zip with every entry deflated, to stand in for Google's. */
function recompress(buf) {
  const parts = [];
  const dir = [];
  let off = 0;
  // Walk the local headers of the stored archive the writer produced.
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const size = buf.readUInt32LE(p + 22);
    const crc = buf.readUInt32LE(p + 14);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    dir.push({ name: nameBuf, crc, comp: comp.length, size, off });
    parts.push(lh, nameBuf, comp);
    off += 30 + nameBuf.length + comp.length;
    p += 30 + nameLen + extraLen + size;
  }
  const cdStart = off;
  for (const e of dir) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.comp, 20); ch.writeUInt32LE(e.size, 24);
    ch.writeUInt16LE(e.name.length, 28); ch.writeUInt32LE(e.off, 42);
    parts.push(ch, e.name);
    off += 46 + e.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(dir.length, 8); eocd.writeUInt16LE(dir.length, 10);
  eocd.writeUInt32LE(off - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}
