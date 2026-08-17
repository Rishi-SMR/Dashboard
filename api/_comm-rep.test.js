// commRep() — the fold from a raw Striven "Sales Rep" value to a roster name.
//
// These are pure-function tests: no credentials, no network. They exist because
// the fold is a business rule that is invisible in the data (a reader of the
// Striven export sees "Maylon Sanders - Denise Zavala" and would reasonably
// create two reps) and the code comment asking the next editor to preserve it
// is not enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commRep, isExcludedRep } from './_striven.js';
import { REP_NAMES, STANDINGS_EXCLUDE, EXCLUDED_REPS, REP_DIRECTORY } from './_commission-config.js';

test('sub-rep: Denise Zavala is paid to Maylon Sanders', () => {
  // The form Striven actually stores.
  assert.equal(commRep('Maylon Sanders - Denise Zavala'), 'Maylon Sanders');
  // Denise on her own must ALSO fold. If Striven ever books an order to her
  // alone, it is still Maylon's order and Maylon is still the one paid.
  assert.equal(commRep('Denise Zavala'), 'Maylon Sanders');
  // Spacing and case in the source field are not stable.
  assert.equal(commRep('  denise   zavala  '), 'Maylon Sanders');
  assert.equal(commRep('DENISE ZAVALA'), 'Maylon Sanders');
  // Maylon booked directly folds to the same name, so the two never split.
  assert.equal(commRep('Maylon Sanders'), 'Maylon Sanders');
});

test('Denise is not a rep in her own right', () => {
  // A roster entry would give her her own commission row and her own
  // leaderboard line — the exact double-count the fold exists to prevent.
  assert.ok(!REP_NAMES.includes('Denise Zavala'));
  // And she must not be "handled" by hiding her from the board instead: the
  // fold is the mechanism, exclusion is not a substitute for it.
  assert.ok(!STANDINGS_EXCLUDE.includes('Denise Zavala'));
  // Whatever commRep returns for her must be a real roster name, or her orders
  // would fall into striven.unmatched and earn nobody anything.
  assert.ok(REP_NAMES.includes(commRep('Maylon Sanders - Denise Zavala')));
});

test('a person after the hyphen is not mistaken for the account', () => {
  // "House Account- Angel Santiago" puts a PERSON after the hyphen, exactly as
  // Denise's value does, but resolves the other way: Angel is his own entry.
  // This is why the folds are listed explicitly instead of prefix-stripped.
  assert.equal(commRep('House Account- Angel Santiago'), 'Angel Santiago');
  assert.equal(commRep('House Account'), 'House Account');
  // No hyphen, and a practice rather than a person.
  assert.equal(commRep('Santiago Family Chiropractic'), 'Santiago Family Chiropractic');
});

test('the original four still fold from their company-prefixed forms', () => {
  assert.equal(commRep('Maverick Medical - Alle Ann Dubberley'), 'Alle Ann');
  assert.equal(commRep('Maverick Medical- Jillian Colin'), 'Jillian');
  assert.equal(commRep('CVT Medical - Christy Tan'), 'Christy');
  assert.equal(commRep('Cassie'), 'Cassie');
  // Order matters in commRep: /christ/i would also catch "Christy Tan", so the
  // specific folds must run before any pass-through.
  assert.equal(commRep('Christy'), 'Christy');
});

// ── Hard exclusions ─────────────────────────────────────────────────────────
// Cassie and CMC (direct) are not reps and must not be considered as one
// anywhere. This is stronger than STANDINGS_EXCLUDE, and the two are easy to
// confuse — a future editor "restoring" a name to REP_NAMES would undo the
// instruction silently, because nothing else in the codebase would complain.

test('excluded names are not on the roster and hold no login', () => {
  for (const name of EXCLUDED_REPS) {
    assert.ok(!REP_NAMES.includes(name), `${name} must not be a roster entry`);
    // Being on BOTH lists is the contradiction the config comment warns about:
    // STANDINGS_EXCLUDE promises a commission row that EXCLUDED_REPS removes.
    assert.ok(!STANDINGS_EXCLUDE.includes(name), `${name} belongs to one exclusion list, not both`);
    // A directory row is a rep identity. An excluded name must not hold one, or
    // the login resolves to a repName the roster has no row for.
    const row = REP_DIRECTORY.find((d) => d.repName === name);
    assert.equal(row, undefined, `${name} must not map from any login`);
  }
});

test('the fold still resolves excluded names, so the exclusion can catch them', () => {
  // The folds are deliberately KEPT. Deleting them would let raw spellings
  // ("Maverick Medical- Cassie Wates") pass through unrecognised and land in
  // an off-roster list under her full name — excluded in name only.
  assert.ok(isExcludedRep('CMC (direct)'));
  // Case and spacing in either source are not stable.
  assert.ok(isExcludedRep('  cmc (DIRECT) '));
});

// CASSIE IS PAID AGAIN — reinstated by instruction ("include Cassie as well
// since it's there in Commission sheet"). She is a signed-off payee on the
// reconciliation sheet ($21,555.00 across 57 lines) and excluding her made the
// dashboard total disagree with the sheet it reconciles to.
//
// The fold that used to feed her name to the exclusion still has to work — it
// is now what merges her sheet spellings onto ONE payee row instead of
// splitting her money across two.
test('Cassie folds to one name and is no longer excluded', () => {
  assert.equal(commRep('Cassie'), 'Cassie');
  assert.equal(commRep('Maverick Medical- Cassie Wates'), 'Cassie');
  assert.ok(!isExcludedRep('Cassie'), 'Cassie is a payee again');
  assert.ok(!isExcludedRep(commRep('Maverick Medical- Cassie Wates')));
});

// A LOGIN NEEDS A ROSTER ROW. Her commission resolved from the reconciliation
// sheet without one, so it was easy to believe the account worked — but
// getRepOverview builds its rows from REP_NAMES, so she signed in to an empty
// My Dashboard while her own 20 orders sat in the book.
//
// This is the pairing that has to hold for ANY rep: a name that can log in must
// be on the roster. Asserted against the whole directory rather than her alone,
// so the next account provisioned without a roster row fails here rather than
// on the rep's screen.
test('every rep who can log in has a roster row', () => {
  for (const d of REP_DIRECTORY) {
    if (d.role !== 'rep' || !d.repName) continue;
    assert.ok(REP_NAMES.includes(d.repName), `${d.repName} can log in, so must be on the roster`);
    assert.ok(!isExcludedRep(d.repName), `${d.repName} can log in, so must not be excluded`);
  }
});

test('Cassie is on the roster, so her own pages have a row to render', () => {
  assert.ok(REP_NAMES.includes('Cassie'), 'on the roster');
  // Her PAY still comes from the sheet, not the engine: the reconciliation
  // merge overwrites payableTotal for every rep, so a roster row buys her
  // volume columns and a Striven comparison, never extra money.
  //
  // Her login itself is provisioned in app_config REP_DIRECTORY (the documented
  // way to add an account without a redeploy), so the hardcoded array below is
  // not where it lives and is deliberately not asserted on.
  assert.ok(!isExcludedRep('Cassie'));
});

test('the exclusion does not overreach', () => {
  // Christy is a producing rep whose name is nowhere near Cassie's, but both
  // start with "C" and an over-eager substring rule would take her out. The
  // test is equality on the folded name, not a match.
  for (const name of REP_NAMES) assert.ok(!isExcludedRep(name), `${name} is a rep and must survive`);
  assert.ok(!isExcludedRep('Christy'));
  assert.ok(!isExcludedRep(''));
  assert.ok(!isExcludedRep(null));
});

test('an unrecognised value passes through rather than vanishing', () => {
  // It lands in striven.unmatched and is surfaced, never silently dropped.
  assert.equal(commRep('Someone New'), 'Someone New');
  assert.equal(commRep(''), 'Unknown');
  assert.equal(commRep(null), 'Unknown');
  assert.equal(commRep(undefined), 'Unknown');
});
