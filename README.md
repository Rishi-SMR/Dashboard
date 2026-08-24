# SMR Commission Portal

React SPA + Node API. `npm run dev` (Vite, :5173) and `node striven-server/index.js`
(:4747) locally; a single Vercel serverless handler (`api/index.js`) in production.

```
npm run dev     # frontend
npm test        # commission engine tests (node:test, no extra deps)
npm run build   # production bundle
```

## Commission configuration

All commission behaviour is driven by [`api/_commission-config.js`](api/_commission-config.js).
Every value there can be **overridden at runtime** from the Supabase `app_config`
table (key/value), so rates and the rep roster change without a redeploy. The
checked-in values are the fallback. Overrides are cached for 60 seconds.

| `app_config` key | Shape | Purpose |
| --- | --- | --- |
| `COMMISSION_RATES` | `{"device name": rate}` | Per-device commission rate |
| `COMMISSION_FALLBACK_RATES` | `{"VA": 425, …}` | Used only when a device has no rate |
| `ORDER_LABEL_RULES` | `{"hold": ["..."], "waiting": ["..."]}` | Regex strings matched against order status |
| `REP_DIRECTORY` | `[{email, repName, role}]` | Account provisioning |

### `COMMISSION_RATES` — the rate table

Commission is calculated **in this portal**, not in Striven. The rule is strictly:

```
commission = Σ (units × per-device rate)      # summed across the devices on an order
```

Keys are matched case-insensitively as substrings of the Striven line-item name,
and the **longest matching key wins** — so `"genesis lumbar": 650` beats a generic
`"genesis": 100` entry. Three units of VA Genesis Lumbar therefore return
**$1,950**, not the $1,275 the old flat `$425/unit` rate produced.

> **This table is a placeholder.** Only the Genesis Lumbar rate is client-confirmed.
> A device with no entry falls back to `FALLBACK_VERTICAL_RATES` (the legacy
> pre-refactor numbers) and is reported in the response's `rateGaps` array and as
> a banner in the UI, so an unpriced device is never silently mispriced.

### Which source the money comes from

The old `COMMISSION_SHEETS` feed (Crystal's frozen workbooks, the
sheet-vs-Striven `reconcile` block, `MIN_MATCH_RATE`) is gone and `app_config`
no longer reads that key. But **the engine above is not what a rep is paid.**
Three sources are layered, in this order, in `getCommission()`:

| Layer | What it sets | Where |
| --- | --- | --- |
| The engine | costs every order at `units × rate` | this file |
| `COMMISSION_RECON_SHEET_ID` | **overwrites** payable with the signed-off sheet | `getCommissionRecon()` |
| `COMMISSION_SOURCE_WORKBOOKS` | **corrects** that sheet against the books it was transcribed from | `commissionSourceIndex()` |
| `COMMISSION_WORKBOOKS` | fills rep × month cells the sheet does not cover | `getCommissionWorkbooks()` |

#### The sheet is a transcription, so it is checked

The reconciliation sheet is not a source — it is Crystal's commission workbooks
retyped with a Striven match column added, and a transcription can be wrong.
Cassie's July 2026 cycle is the case that proved it: five `L1833` brace lines
carried the `$425` combo rate instead of `$80`, and one `$425` line was missing
altogether, so the portal showed **$21,555 against a workbook that says
$20,255**. Nothing on the page could have caught that, because the sheet was the
only document being read.

`COMMISSION_SOURCE_WORKBOOKS` names those workbooks (falling back to the legacy
`COMMISSION_SHEETS` key, which already lists exactly them). Per rep × month,
`reconcileToWorkbook()` pairs each sheet line to a workbook row — on patient
*and* amount first, so a patient's combo line cannot swallow their brace line —
and then:

* **amount disagrees** → the workbook wins, on money and on device name
* **row missing from the sheet** → added, marked unmatched
* **row missing from the workbook** → *kept and counted*, never deleted; taking
  money away on a name that failed to match is the one error nobody would see

The counts land in `striven.recon.corrections` (admin-only). Across both books
the sheet agrees to the cent everywhere except that one cycle — which is what
makes the check safe to run for every rep rather than for one. **Do not "fix"
this by editing the sheet only**: the sheet is regenerated, and the check is
what keeps the next transcription honest.

Note `COMMISSION_SOURCE_WORKBOOKS` and `COMMISSION_WORKBOOKS` are different
lists. The first is the *original* of rows the sheet already carries and is read
only to check them; the second is a *substitute* for reps the sheet has no rows
for at all (Maylon). A book in the wrong list either pays a rep twice or
corrects nothing.

The sheet wins wherever it speaks, and a rep absent from it goes to **zero**,
not to their engine figure — falling back would mix two bases in one column.
`reconciled: false` marks them. The engine's number is kept beside the sheet's
as `strivenPayable` rather than discarded, because the two disagree per rep
(Maylon $4,490 signed off against $27,300 computed) and a page showing one
without the other cannot explain itself.

**Everything else on the row is derived from the winning layer's lines**, not
left on the engine's. That was the bug: `byProgram` and `waitingTotal` were
never rebuilt, so the vertical split read $238,523 under a $195,954 headline and
inverted the programme ranking, and picking a single month silently switched
basis because month rows *were* rebuilt. Both now come off the same lines as the
total, so the split sums to it by construction. Anything added to a rep row
later has to be derived there too.

### Paid, Payable, Waiting

```
grandTotal = paidTotal + payableTotal        # the whole signed-off figure
waitingTotal                                  # NOT in grandTotal
```

- **Paid** — `COMMISSION_PAID_THROUGH` names the last settled month *per
  vertical*, and matching lines become `paid`. Still in the total: paying a rep
  does not reduce what they earned. A vertical missing from that map has nothing
  marked paid, which keeps money in Payable rather than declaring it settled.
  Only `VA` is currently listed.
- **Payable / Due** — signed off and owed.
- **Waiting** — the **in-flight cycle**: a month with no payout run yet, so
  there is no signed-off figure and the engine's estimate stands in. Deliberately
  outside `grandTotal`, because it is an estimate and the total is not. A
  reconciled month therefore has *nothing* waiting, by definition.

`npm run audit` asserts every one of these against every source that produces it.


### The rep roster

**The reps are `REP_NAMES`, a checked-in list.** It used to be whichever names
appeared on a sheet tab, which meant a typo there could invent a rep.

Striven spells the same person several ways (`Maverick Medical- Jillian Colin`,
`CVT Medical - Christy Tan`), so `commRep()` folds every variant onto one
canonical name and covers 100% of live rows with no `Unknown` bucket.

**The canonical name is the rep's FULL name** — `Alle Ann Dubberley`,
`Jillian Colin`, `Christy Tan`, `Maylon Sanders`. It is an identity key, not a
label: `REP_NAMES`, `REP_DIRECTORY.repName`, `REP_SUB_REPS` and `commRep()`'s
returns all carry the same string, and `isSelf`, the blindspots and every screen
compare against it. There is no display-name layer, which is what makes a rename
a four-line change — and what makes editing only three of the four places a
silent bug, so `_comm-rep.test.js` asserts the four agree. The short forms
(`Christy`, `Jillian`, `Alle Ann`) still fold, because the sheet and the recon
file are still written that way.

**Sub-reps fold into the rep who is paid.** `Maylon Sanders - Denise Zavala` is
Maylon's order: Denise is her sub-rep and Maylon is paid on it, so `commRep()`
returns `Maylon Sanders`. Denise is not a roster entry of her own.

Striven books orders under other people too (house/clinic accounts, ops staff).
They are **not** reps: such an order earns no commission and is reported in
`striven.unmatched`.

**The roster is the five producing reps** — Alle Ann Dubberley, Jillian Colin,
Christy Tan, Maylon Sanders, Cassie. It had widened to eleven to cover every distinct Sales Rep value
in Striven, which put a house bucket (`House Account`), a practice (`Santiago
Family Chiropractic`), finance (`Crystal Chambers`) and three non-producers on
the commission table. All six were at $0 — the sheet signs off nothing for them —
so narrowing the list moved no money.

There are **three ways off the roster**, and they are not interchangeable:

| | Roster row | Commission row | Money reported | Name shown |
| --- | --- | --- | --- | --- |
| Off `REP_NAMES` | no | no | as off-roster volume | yes, in `offRoster.reps` |
| `STANDINGS_EXCLUDE` | yes | yes | yes | yes, but not ranked |
| `EXCLUDED_REPS` | no | no | **nowhere** | no |

`STANDINGS_EXCLUDE` is **empty** now: with the roster narrowed to producers, no
name is left that needs a row but not a ranking. It is kept as the mechanism for
exactly that case — re-add a name there to unrank someone while keeping them
paid. Dropping them from `REP_NAMES` instead is a different decision, because it
moves their orders to off-roster volume and zeroes the row.

`EXCLUDED_REPS` is the hardest rule: not a rep in any sense, dropped from every
roster, picker, total, drill and remark, with their reconciliation-sheet rows
skipped at the reader. Currently only `CMC (direct)`, a direct-sales channel
rather than a person. **`Cassie` is not on this list** — she was, and she is
back: a working rep with a login and current TriCare orders.

However someone leaves the roster, their **orders are not deleted**. All 79
off-roster orders stay in the company book and are counted as off-roster volume,
so every order and revenue total on every screen is unchanged. The attribution
moves; the business does not.

### `REP_DIRECTORY` — rep → email → role

The **only** place accounts are provisioned. There is deliberately no signup flow.

```json
[
  { "email": "admin@sportsmedrecovery.com",   "repName": null,      "role": "admin" },
  { "email": "jillian@sportsmedrecovery.com", "repName": "Jillian Colin", "role": "rep" }
]
```

- `repName` must match a name in the roster above exactly.
- `role: "admin"` sees every rep unredacted. Anything else is a `rep`.
- An email absent from the directory gets **least privilege**: role `rep` with no
  own row, so nothing is unlocked.

There are **eight** `dashboard_users` accounts, verified against the live table:
three finance/ops (`rishi@`, `crystal@`, `kevin@`) as admins, and one per rep
(`alle@`, `jillian@`, `christy@`, `maylon@`, `cassie@`) as `rep`.

`admin@` is provisioned in `REP_DIRECTORY` but has **no `dashboard_users` row**,
so it cannot currently sign in. A directory row grants an identity, not an
account; both are needed to log in.

> **`cassie@` is a live account.** This section previously said she had neither
> a directory row nor a login and that nothing needed revoking. Both halves were
> false when checked against the live tables. The `app_config` override carried
> her all along, and because the override wins over the checked-in list, the
> fallback could say she did not exist without anything visibly breaking — until
> the day the override is cleared or a fresh environment comes up without it.
> The checked-in `REP_DIRECTORY` now matches the live one.

> **Every login needs a directory row.** An account that authenticates but is
> absent here resolves to `{ repName: null, role: "rep" }`. That fails closed on
> company data, but a null `repName` also matches no rep row — so the person logs
> in successfully and sees an empty dashboard. Add the row when you add the login.

> **Crystal (finance, owns the workbook) is not the rep "Christy".** Different
> people, similar names. Never map `crystal@` to a `repName`.

## Access control

Identity comes from the signed, HttpOnly, `SameSite=Strict` `smr_session` cookie
(HMAC-SHA256, constant-time compare). The `smr_user` cookie is **display only** and
is never trusted as identity. `GET /api/me` returns `{ email, repName, role }`
resolved from the verified session — the role is looked up live from the directory
rather than trusted from the token, so a revoked admin loses access immediately.

**A rep is restricted to their own data: order count, unit count, and their own
commission.** Nothing about another rep reaches them — not a figure, not a name.

`GET /api/commission` and `GET /api/rep-overview` are redacted **server-side,
before serialization**:

| Viewer | Sees |
| --- | --- |
| Own row | Every financial field, plus order-by-order detail |
| Another rep's row | **Nothing — the row is absent from the payload** |
| Admin | Everything, unredacted |

> **This changed.** A peer row used to survive, stripped to operational counts
> (`rep`, `count`, `strivenOrders`, `strivenUnits`, `orderCounts`) with the money
> nulled, because team *volume* was treated as shared even where pay was not.
> That is what the leaderboard and Team Standings were built from. Peer rows are
> now **dropped** rather than blanked: a row reduced to a name and a count still
> discloses who is on the book and how much they booked. Dropping also fails
> safe — a field added to a row later cannot leak by default.
>
> Consequences: **Team Standings is gone from the rep nav** (a ranking needs
> peers), and `STANDINGS_ORDERS_ONLY` no longer has anything to govern for a rep.
> Commission is unaffected: every rep is still paid exactly as before.

### `REP_SUB_REPS` — reporting lines

`/api/rep-overview` does send peer rows, because the rep leaderboard needs a
field to rank against — a name, an order count and the per-vertical split, never
money. Reporting lines carve two exceptions out of that, both from **one**
declaration:

```json
{ "Alle Ann Dubberley": ["Jillian Colin"] }
```

| Direction | Effect |
| --- | --- |
| Looking **down** — Alle's login | Jillian's row is drawn nested directly under Alle's and out of the ranking (`nestSubReps`), and a roll-down under Alle's own name on the leaderboard opens her sub-reps' **volume** in full |
| Looking **up** — Jillian's login | Alle is absent entirely: no row, no order count, no mention of the name anywhere in the payload |

**The supervisor gets volume, never pay.** `supervised` opts a sub-rep's row out
of `lean`, so Alle sees Jillian's units, accounts, device types, verticals, last
order and per-vertical/per-month splits — the fields an ordinary peer row is
stripped of. It is deliberately *not* `own`, which is what unlocks money:
`commission`, `payable`, `waiting`, `revenue` and `commissionByCycle` stay null
on a sub-rep's row exactly as on any other peer's.

Declared once because declaring it twice is how one half gets added and the
other forgotten — and the forgotten half is a silent disclosure.
`blindspotsFor()` resolves the upward rule; `supervisorOf()` the downward one.

**Nothing rolls up.** This is not `commRep()`'s sub-rep fold: Denise Zavala has
no roster row and her orders *are* Maylon's because he is paid on them. Jillian
is a rep in her own right — own roster entry, own login, own $57,234 — who
happens to work under Alle. Alle's 185 orders and $63,025 are untouched, and a
test asserts her own counts are identical with and without the reporting line.

The tag is stamped **only for the supervisor** (and for an admin, who sees the
whole org anyway). Christy's login shows Jillian unmarked: who reports to whom
is Alle's context, not the team's.

An admin is never blinded; an admin's *view as* preview **is**, because it
resolves to a rep viewer and the point of a preview is to show what that rep
sees. `REP_BLINDSPOTS` remains as an escape hatch for a pair that is not a
reporting line. Both keys are overridable from `app_config`.

> **Rank is stamped before the filter, and that is the whole trick.** Drop Alle's
> 185 and Jillian's 99 becomes the largest row on her board — so it would call
> her 1st, print the top-of-the-board banner and burn her one-per-achievement
> confetti, all invented by the privacy filter. `rank` is computed over the whole
> producing field first, so a withheld rep leaves a **gap**: Jillian reads 2nd
> and no row claims 1st. The podium picks medals by rank, not by array position,
> and the "you are N orders behind X" line is suppressed when the rep above is
> one she cannot see.

Company-wide dollar aggregates (`grandTotal`, `byProgram`) are scoped to the
caller's own totals for a rep role — a company total would leak the other reps in
aggregate. No query parameter can widen this: the viewer is built from the session
alone, and a missing viewer **fails closed** (an unknown login matches no name, so
it receives an empty list rather than a list of locked rows).

## Order labels

| Label | Effect |
| --- | --- |
| `hold` | Costed, but **never payable**. Reported as Waiting |
| `waiting for reimbursement` | Costed, reported as **Waiting**, not payable |
| anything else | **Payable / Due** |

`hold` is tested first, so a status mentioning both is treated as held.

Both non-payable labels land in `waitingTotal`, and `heldTotal` breaks out the
held share so the UI can say *why* something is waiting. `payableTotal` is the
cheque: what the rep is actually paid on the 15th for dispensed orders.

> **This changed.** `hold` used to return $0 with no commission line. That kept
> the cheque right but erased the amount, so a rep whose month was entirely held
> (the Genesys backorder) saw nothing at all instead of a pending figure. The
> business needs both: out of the cheque, visible as Waiting.

Orders that cannot be tied to a sales order earn no commission, but are reported
in `striven.unmatched` with their vertical, device, units, value and status —
surfaced in the UI rather than silently dropped.

## Verticals

`VA` and `PI` are active. `DOL` is future and currently carries a zero column —
`soClass()` in `api/_striven.js` (and the `piva` map in `getSO`) will need a `DOL`
branch the day the first one lands. `TriCare` is legacy: retained for historical
data, not required going forward.

## Tests

`npm test` runs [`api/_commission-core.test.js`](api/_commission-core.test.js) —
cases covering the rate math, the `hold` / `waiting` split, per-rep redaction
and admin access.
