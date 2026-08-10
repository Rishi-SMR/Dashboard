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

### The commission sheet is gone

Commission used to be reconciled against Crystal's Google Sheet workbooks. That
sheet stopped being maintained the day Striven went live, so everything it
contributed was historical, and reconciling live pay against a frozen document
produced permanent variances that meant nothing.

Removed with it: the Sheets fetch and CSV parsing, the per-period rollup, the
sheet-vs-Striven `reconcile` block, and the `MIN_MATCH_RATE` verification gate.
`COMMISSION_SHEETS` in `app_config` is no longer read.

**Commission is now computed from Striven only**, and `grandTotal` / `byProgram`
in the response ARE the computation. There is no second source to disagree with,
so there is nothing to mark verified or unverified.


### The rep roster

**The reps are `REP_NAMES`, a checked-in list.** It used to be whichever names
appeared on a sheet tab, which meant a typo there could invent a rep.

Striven spells the same person several ways (`Maverick Medical- Jillian Colin`,
`CVT Medical - Christy Tan`), so `commRep()` folds every variant onto one
canonical name and covers 100% of live rows with no `Unknown` bucket.

**Sub-reps fold into the rep who is paid.** `Maylon Sanders - Denise Zavala` is
Maylon's order: Denise is her sub-rep and Maylon is paid on it, so `commRep()`
returns `Maylon Sanders`. Denise is not a roster entry of her own.

Striven books orders under other people too (house/clinic accounts, ops staff).
They are **not** reps: such an order earns no commission and is reported in
`striven.unmatched`.

`STANDINGS_EXCLUDE` removes non-producers (Crystal's demos, Angel, Kinley, Zach)
from the **leaderboard only**. They keep their commission rows.

`EXCLUDED_REPS` is the harder rule and is **not** the same list. A name here is
not a rep in any sense: it is dropped from every roster, picker, total, drill and
remark, and **no money is reported against it anywhere**. Currently `Cassie`
(departed) and `CMC (direct)` (a direct-sales channel, not a person). Their
reconciliation-sheet rows are skipped at the reader, so Commission Due excludes
what the sheet signs off for them.

Their **orders are not deleted** — they stay in the company book and are counted
as off-roster volume, with the attribution withheld rather than the numbers. The
name is removed, not the business.

### `REP_DIRECTORY` — rep → email → role

The **only** place accounts are provisioned. There is deliberately no signup flow.

```json
[
  { "email": "admin@sportsmedrecovery.com",   "repName": null,      "role": "admin" },
  { "email": "jillian@sportsmedrecovery.com", "repName": "Jillian", "role": "rep"  }
]
```

- `repName` must match a name in the roster above exactly.
- `role: "admin"` sees every rep unredacted. Anything else is a `rep`.
- An email absent from the directory gets **least privilege**: role `rep` with no
  own row, so nothing is unlocked.

There are seven `dashboard_users` accounts, verified against the live table:
three finance/ops (`rishi@`, `crystal@`, `kevin@`) configured as admins, and one
per rep (`alle@`, `jillian@`, `christy@`, `maylon@`) configured as `rep`.

`admin@` is provisioned in `REP_DIRECTORY` but has **no `dashboard_users` row**,
so it cannot currently sign in. A directory row grants an identity, not an
account; both are needed to log in.

`cassie@` has neither, and nothing needs to be revoked: she was removed from
`REP_DIRECTORY` with her roster entry (see `EXCLUDED_REPS`), and she has no
`dashboard_users` row either — so there is no credential to disable.

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
