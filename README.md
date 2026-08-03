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
| `MIN_MATCH_RATE` | number | Sheet verification threshold (default 90) |
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

### `MIN_MATCH_RATE` — the sheet verification gate

The linked Google Sheet is historical and frozen (no longer updated since Striven
adoption), so its figures are treated as unverified until reconciled. A rep is
`verified` only when their patient match rate is **at or above `MIN_MATCH_RATE`**
(default `90`) **and** they have no unresolved `bookedUnder` exceptions.

### The rep roster

**The reps are the names on the commission sheet — nothing else.** Read live from
both configured workbooks (Team + Christy, 9 tabs) and normalised by `commRep()`:

| Rep | Lines | Verticals |
| --- | --- | --- |
| Alle Ann | 106 | VA |
| Jillian | 86 | TriCare, PI |
| Cassie | 58 | TriCare |
| Christy | 30 | VA |

The sheet spells several of these inconsistently — `Alle Anne`, `Christy Tan`,
`Jillian Colin` — and `commRep()` folds every variant onto the four canonical
names, covering 100% of live rows with no `Unknown` bucket.

Striven books orders under other people too (house/clinic accounts, ops staff).
They are **not** reps: an order booked to one earns no commission and is reported
in `striven.unmatched` with the reason *"booked to someone who is not a rep on the
commission sheet"*.

### `REP_DIRECTORY` — rep → email → role

The **only** place accounts are provisioned. There is deliberately no signup flow.

```json
[
  { "email": "admin@sportsmedrecovery.com", "repName": null,     "role": "admin" },
  { "email": "cassie@sportsmedrecovery.com", "repName": "Cassie", "role": "rep"  }
]
```

- `repName` must match a name in the roster above exactly.
- `role: "admin"` sees every rep unredacted. Anything else is a `rep`.
- An email absent from the directory gets **least privilege**: role `rep` with no
  own row, so nothing is unlocked.

There are seven `dashboard_users` accounts: three finance/ops (`admin@`, `crystal@`,
`rishi@`) configured as admins, and one per rep (`alle@`, `jillian@`, `cassie@`,
`christy@`) configured as `rep`.

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

`GET /api/commission` is redacted **server-side, before serialization**:

| Viewer | Sees |
| --- | --- |
| Own row | Every financial field, plus order-by-order detail |
| Another rep's row | `rep`, `count`, `strivenOrders`, `strivenUnits`, `matchRate`, `orderCounts`, `verified`. All dollar fields `null`; `recon` withheld |
| Admin | Everything, unredacted |

Company-wide dollar aggregates (`grandTotal`, `byProgram`) are scoped to the
caller's own totals for a rep role — a company total would leak the other reps in
aggregate. No query parameter can widen this: the viewer is built from the session
alone, and a missing viewer **fails closed**.

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
18 cases covering the rate math, `hold` exclusion, `waiting` pending state,
per-rep redaction, admin access, and the verification gate.
