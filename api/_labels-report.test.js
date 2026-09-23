// ── A LABELS REPORT IS READ WHATEVER ITS COLUMNS ARE CALLED ──────────────────
//
// Stages come from Striven labels, and labels arrive through saved reports that
// are built by hand in Striven. Two reports describing the same thing therefore
// do not agree on column names, and a report whose columns this code does not
// recognise fetches perfectly and contributes NOTHING — the quietest way there
// is for a board to go blank.
//
// THE BUG THIS CAUGHT: the PI labels report emits LINE-ITEM rows with
// `SalesOrderLabels`, while the reader only knew the VA report's `Labels`. Every
// PI order came back untagged and the whole board sat in stage 1, with no error
// anywhere and a confident-looking pipeline on screen.
//
// The identifier is the half that matters most: a row with perfect labels and
// no way to name its sales order cannot be used at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { labelRowKey, labelRowKeys, labelRowLabels } from './_striven.js';

test('the sales-order-level shape is read (the VA report)', () => {
  const row = { Number: '22', Labels: 'Paid', PatientName: 'T Wallace', Type: 'VA Order' };
  assert.equal(labelRowKey(row), '22');
  assert.deepEqual(labelRowLabels(row), ['Paid']);
});

test('the line-item shape is read (the PI report)', () => {
  const row = { SalesOrderName: 'HAlhewamdeh-PI-PEMF/RL/KNEE', SalesOrderLabels: 'Shipped, Waiting for first payment' };
  assert.equal(labelRowKey(row), 'halhewamdeh-pi-pemf/rl/knee');
  assert.deepEqual(labelRowLabels(row), ['Shipped', 'Waiting for first payment']);
});

test('every identifying column Striven might name is accepted', () => {
  for (const [field, value] of [
    ['Number', 'SO-1'], ['SalesOrderNumber', 'SO-2'], ['OrderNumber', 'SO-3'],
    ['SalesOrderName', 'SO-4'], ['Name', 'SO-5'],
  ]) {
    assert.equal(labelRowKey({ [field]: value }), value.toLowerCase(), `${field} identifies the order`);
  }
});

test('a row with no identifier yields no key, so it can never be joined to the wrong order', () => {
  // The live PI report's own shape: labels present, identifier absent on 341 of
  // its 348 rows. Guessing an owner for these would put another patient's stage
  // on an order, which is worse than the order having no stage.
  assert.equal(labelRowKey({ SalesOrderLabels: 'Delivered', ItemName: 'PI Knee Brace', Price: 999 }), '');
  assert.equal(labelRowKey({}), '');
  assert.equal(labelRowKey(null), '');
});

test('a sales-order NAME still identifies its order', () => {
  // Striven's Name is the NUMBER with a description hung off it. A report
  // carrying Name instead of Number is still joinable, but only once the
  // description is dropped — verified against the live PI report, whose one
  // named row is order number "HAlhewamdeh".
  assert.deepEqual(labelRowKeys({ SalesOrderName: 'HAlhewamdeh-PI-PEMF/RL/KNEE' }),
    ['halhewamdeh-pi-pemf/rl/knee', 'halhewamdeh']);
  // The WHOLE value is tried first, so a number that legitimately contains a
  // dash is never truncated into somebody else's order.
  assert.deepEqual(labelRowKeys({ Number: 'SO-480' }), ['so-480', 'so']);
  assert.deepEqual(labelRowKeys({ Number: '22' }), ['22']);
  assert.deepEqual(labelRowKeys({}), []);
});

test('labels split on commas and drop the blanks', () => {
  assert.deepEqual(labelRowLabels({ Labels: ' Shipped , , Delivered ' }), ['Shipped', 'Delivered']);
  assert.deepEqual(labelRowLabels({ Labels: '' }), []);
  assert.deepEqual(labelRowLabels({}), []);
});

test('the PI vocabulary this report carries maps to real stages', async () => {
  // Every label the live PI report emits, checked against the map that places
  // it. An unmapped one contributes nothing and drops its order to stage 1, so
  // the vocabulary and the map have to be checked against each other, not
  // assumed to match.
  const { PI_LABEL_STAGE, PI_STAGES, REVIEW_LABELS } = await import('./_commission-config.js');
  const FROM_REPORT = [
    'Waiting for first payment', 'Waiting for final payment', 'Shipped', 'Delivered',
    'Patient Contacted', 'Waiting for LOP', 'Unobtainable LOP', 'Attorney Denied',
    'Enter into Lienstar', 'Needs AOB', '3rd LOP Request', '1st LOP Request',
    'Case Dropped', '2nd LOP Request', 'HOLD', 'Waiting on PIP Payment',
    'Dispense', 'Hold for Settlement', 'Case Settled',
  ];
  // REVIEW_LABELS is an ARRAY of lowercased label names, not a map.
  // REVIEW_LABELS is an ARRAY of lowercased label names, not a map.
  const review = new Set(REVIEW_LABELS.map((k) => String(k).toLowerCase()));

  // Every label in the report is either a STAGE or a REVIEW entry. Nothing is
  // left over, so this is a tripwire: a label added in Striven tomorrow fails
  // here loudly instead of silently dropping its order to stage 1.
  const unmapped = FROM_REPORT.filter((l) => {
    const k = l.trim().toLowerCase();
    return !PI_LABEL_STAGE[k] && !review.has(k);
  });
  // Named rather than counted: whoever adds a label in Striven needs to see
  // which one is not handled.
  assert.deepEqual(unmapped, [], `every PI label maps to a stage or to the review queue; unmapped: ${unmapped.join(', ')}`);

  // THE FOUR PUT IN REVIEW BY INSTRUCTION, pinned so a later edit cannot
  // quietly turn one back into a stage. They describe a case that has stopped
  // or a step outside the pipeline, and a stalled order counted as progress is
  // the exact failure REVIEW_LABELS was introduced to end.
  for (const l of ['patient contacted', 'unobtainable lop', 'needs aob', 'case settled']) {
    assert.ok(review.has(l), `"${l}" belongs in the review queue`);
    assert.equal(PI_LABEL_STAGE[l], undefined, `"${l}" must carry no stage`);
  }
  // And whatever they map to must be a real stage on this board.
  for (const l of FROM_REPORT) {
    const m = PI_LABEL_STAGE[l.trim().toLowerCase()];
    for (const stage of (Array.isArray(m) ? m : m ? [m] : [])) {
      assert.ok(PI_STAGES.includes(stage), `"${l}" maps to ${stage}, which is not a PI stage`);
    }
  }
});
