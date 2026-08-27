// commRep() — the fold from a raw Striven "Sales Rep" value to a roster name.
//
// These are pure-function tests: no credentials, no network. They exist because
// the fold is a business rule that is invisible in the data (a reader of the
// Striven export sees "Maylon Sanders - Denise Zavala" and would reasonably
// create two reps) and the code comment asking the next editor to preserve it
// is not enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commRep, reconRep, isExcludedRep } from './_striven.js';
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

test('the original four fold from their company-prefixed forms to FULL names', () => {
  // The roster name is the rep's full name. Striven stores these behind a
  // company prefix, and the fold both strips the prefix and settles on one
  // spelling — the sheet writes "Alle Anne", "Jillian", "Christy" and the
  // portal must not end up with two rows for one person.
  assert.equal(commRep('Maverick Medical - Alle Ann Dubberley'), 'Alle Ann Dubberley');
  assert.equal(commRep('Maverick Medical- Jillian Colin'), 'Jillian Colin');
  assert.equal(commRep('CVT Medical - Christy Tan'), 'Christy Tan');
  assert.equal(commRep('Cassie'), 'Cassie');
  // THE SHORT FORMS STILL FOLD, and this is the half that is easy to lose. The
  // sheet, the recon file and Striven itself all still carry the old spellings;
  // if a bare "Christy" stopped resolving, her orders would land in
  // striven.unmatched and earn nobody anything.
  assert.equal(commRep('Christy'), 'Christy Tan');
  assert.equal(commRep('Jillian'), 'Jillian Colin');
  assert.equal(commRep('Alle Ann'), 'Alle Ann Dubberley');
  assert.equal(commRep('Alle Anne'), 'Alle Ann Dubberley');
});

test('every name the fold produces for a rep is a name the roster carries', () => {
  // The two must agree or the rep is invisible: commRep decides who an order
  // belongs to, REP_NAMES decides who exists. A rename that touched one and not
  // the other would drop that rep's whole book into `unmatched` silently.
  for (const raw of ['Maverick Medical - Alle Ann Dubberley', 'Maverick Medical- Jillian Colin',
    'CVT Medical - Christy Tan', 'Maylon Sanders', 'Christy', 'Jillian', 'Alle Ann']) {
    // Alek Sigman and Alyssa Parker were here while they were on the roster.
    // They are Operations and are off it now, so they no longer fold to a roster
    // name — by design. Their folds still canonicalise the spelling, which the
    // test below asserts separately.
    assert.ok(REP_NAMES.includes(commRep(raw)), `${raw} folds to a roster name`);
  }
  // And every login must point at a rep who exists, for the same reason from
  // the other direction: a repName off the roster means an empty dashboard.
  for (const d of REP_DIRECTORY.filter((x) => x.repName)) {
    assert.ok(REP_NAMES.includes(d.repName), `${d.email} maps to a roster name`);
  }
});

test('the source sheet can be rewritten to full names without breaking the fold', () => {
  // THE SHEET IS BEING UPDATED to spell these reps in full. Both folds have to
  // survive that: they were written against the SHORT forms, and a fold that
  // stops recognising a name does not fail loudly — the rep's orders drop into
  // `striven.unmatched` and their commission quietly becomes nobody's.
  //
  // Every name must fold to ITSELF. That is the property that makes the rewrite
  // safe in either direction: rows already rewritten and rows not yet rewritten
  // both land on the same roster entry, so the sheet can be edited a tab at a
  // time without splitting anyone across two rows mid-way.
  for (const full of ['Alle Ann Dubberley', 'Jillian Colin', 'Christy Tan', 'Maylon Sanders']) {
    assert.equal(commRep(full), full, `commRep keeps ${full}`);
    assert.ok(REP_NAMES.includes(commRep(full)), `${full} is on the roster`);
  }
  // The reconciliation file is a SECOND source with its own alias table. If it
  // folded differently the rep would split into two rows — the very bug that
  // table was written to fix.
  for (const full of ['Alle Ann Dubberley', 'Jillian Colin', 'Christy Tan', 'Maylon Sanders']) {
    assert.equal(reconRep(full), full, `reconRep keeps ${full}`);
  }
  // And the two folds must agree on the short forms as well, for as long as any
  // un-rewritten row survives anywhere.
  for (const short of ['Alle Ann', 'Jillian', 'Christy', 'Maylon Sanders']) {
    assert.equal(reconRep(short), commRep(short), `both folds agree on ${short}`);
  }
});

test('the rename cannot swallow Crystal or Denise', () => {
  // Crystal Chambers is finance, not the rep Christy Tan, and the /christ/i test
  // runs before her own. It does not match "Crystal" — but the two names are
  // close enough that the next person to widen that pattern needs to be stopped
  // by a test rather than by a comment.
  assert.equal(commRep('Crystal Chambers'), 'Crystal Chambers');
  assert.ok(!REP_NAMES.includes('Crystal Chambers'));
  // Denise still folds to the rep who is PAID, full name or not.
  assert.equal(commRep('Maylon Sanders - Denise Zavala'), 'Maylon Sanders');
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
// THE FOLD IS WHAT MAKES THE EXCLUSION STICK. Her name reaches the code in more
// than one spelling, and excluding only the canonical one would drop her row
// while "Maverick Medical- Cassie Wates" walked straight past the filter as a
// separate payee — the removal would look done and be half done.
test('Cassie is excluded, in every spelling she arrives in', () => {
  assert.equal(commRep('Cassie'), 'Cassie');
  assert.equal(commRep('Maverick Medical- Cassie Wates'), 'Cassie');
  assert.ok(isExcludedRep('Cassie'), 'excluded by instruction');
  assert.ok(isExcludedRep(commRep('Maverick Medical- Cassie Wates')), 'and by her sheet spelling');
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

// REMOVED ON ALL THREE FRONTS, because any one left behind undoes the others:
// a roster row rebuilds her leaderboard entry, a directory row lets her sign in
// to it, and without the exclusion her $20,255 stays in every company total.
test('Cassie is off the roster, off the logins and excluded', () => {
  assert.ok(!REP_NAMES.includes('Cassie'), 'no roster row');
  assert.ok(!REP_DIRECTORY.some((d) => d.repName === 'Cassie'), 'no login');
  assert.ok(isExcludedRep('Cassie'), 'no money reported against her');
  // The app_config REP_DIRECTORY override WINS over the array above, so
  // clearing this file is not on its own enough to revoke the account — that
  // has to be done in Supabase too. Asserted here as the reminder, since this
  // file is where someone will look.
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

// Adding a rep means editing three places that must agree — REP_NAMES and the
// two fold tables. This asserts the whole roster at once rather than the two
// new names, so the NEXT person to add a rep is caught by the same test rather
// than having to remember the rule.
test('every roster name folds to itself in both tables', () => {
  for (const name of REP_NAMES) {
    assert.equal(commRep(name), name, `commRep keeps ${name}`);
    assert.equal(reconRep(name), name, `reconRep keeps ${name}`);
  }
});

// OPERATIONS ARE NOT REPS. Alek Sigman and Alyssa Parker were briefly on the
// roster because Striven's Sales Rep field named them; they were removed by
// instruction once it was clear they process orders rather than sell them.
//
// This test pins BOTH halves of that, because the two are easy to confuse and
// only one of them is about membership:
//   · they are OFF the roster, so nothing ranks or pays them, and
//   · their name folds STILL WORK, so the orders they are named on land in the
//     off-roster tail under one clean spelling instead of scattering.
// Deleting the folds along with the roster rows is the tempting wrong move; it
// would hide that volume rather than reclassify it.
test('Alek Sigman and Alyssa Parker are Operations, not roster reps', () => {
  for (const name of ['Alek Sigman', 'Alyssa Parker']) {
    assert.ok(!REP_NAMES.includes(name), `${name} is off the roster`);
    assert.equal(commRep(name), name, `commRep still canonicalises ${name}`);
    assert.equal(reconRep(name), name, `reconRep still canonicalises ${name}`);
  }
  // The group-prefixed spellings must canonicalise too, or one ops name splits
  // into two rows in the off-roster tail.
  assert.equal(commRep('Maverick Medical - Alek Sigman'), 'Alek Sigman');
  assert.equal(commRep('CVT Medical- Alyssa Parker'), 'Alyssa Parker');
});
