# SMR design system

Typography, palette and number formatting shared by the **company dashboard**
and the **rep portal** — one bundle, one set of tokens.

## The one rule that isn't styling

A rep must never see another rep's dollars, or the company's. **This is enforced
on the server, not in CSS.** Hiding money with a class still ships the money to
the browser, where it is readable in devtools and in the network tab.

```
api/index.js              company routes (/api/pl, /api/ar, …) are admin-only
api/_commission-core.js   redactCommissionPayload() nulls other reps' figures
                          BEFORE serialization
src/cashflow/CashflowApp  allowedViews(role) — a rep cannot even route to a
                          company tab, hash included
```

There was previously a second, build-time layer: `@money` was aliased to a
throwing stub for a `SMR_AUDIENCE=rep` bundle, verified by grepping the output
for `style:"currency"`. It was removed because the rep portal legitimately shows
a rep their **own** figures — Commission, RepsTab, OrderDashboard and PiPipeline
all render dollars — so the stub would have thrown on nearly every screen. The
question moved from *which bundle did you download* to *who are you*, which the
server can actually answer.

Money formatting therefore has one home:

```ts
import { formatCurrency } from '../cashflow/format';   // components
import { formatUsd } from '../design/money';           // the definition
```

Counts, units, percentages and DSO live in `numbers.ts`, which deliberately
contains no currency function.

## Type

| Token | Use |
|---|---|
| `--font-display` | Barlow Semi Condensed 600/700 — headings, KPI labels, leaderboard names |
| `--font-body` | Inter 400/500 — body, tables, controls, unit words |
| `--font-mono` | JetBrains Mono 500 — **every** numeric value |

Classes: `.t-h1` `.t-h2` `.t-h3` `.t-lead` `.t-micro` `.t-num` `.t-kpi`
`.t-amount` `.t-unit`.

- `.t-num` sets `tabular-nums` and applies to descendants too, so a number
  nested inside still gets tabular figures. Every figure gets this, no exception.
- `.t-micro` is the 11px / 0.08em uppercase label — `TOTAL ORDERS`, `DSO (PI)`.
- `.t-amount` is mono and **never** the condensed face. Condensed digits read
  faster but less trustworthily; the board should read like a financial
  statement.
- `.t-unit` is the Inter word beside a figure (`142.0` `days`). It is a word,
  not a value.

The fluid scale runs from **768px to 1100px** and then holds. The desktop target
is a laptop, not an external monitor.

## Colour

Two briefed brand colours cannot carry text — measured against `#F8FAFC`:

| Token | Ratio | Use |
|---|---|---|
| `--accent` `#14B8A6` | 2.38:1 | fills, rules, chart marks — **never text** |
| `--accent-ink` `#0F766E` | 5.23:1 | text-safe teal |
| `--amber` `#F59E0B` | 2.05:1 | fills, marks — **never text** |
| `--amber-ink` `#B45309` | 4.80:1 | text-safe amber |
| `--danger` `#DC2626` | 4.62:1 | passes as text as briefed |
| `--ink-muted` `#52657B` | 5.72:1 | micro-labels — the AA floor case |
| `--state-hold-ink` `#64748B` | 4.55:1 | muted but still AA |

Using `--accent` on a label is the specific mistake the ink/fill split exists to
prevent.

## Motion

There is no count-up component any more — `CountUp` was removed because nothing
imported it. The rule it existed to encode still stands, so keep it in mind if
one is reintroduced: **animation is opt-in per call site.** It belongs on the
company dashboard, never in the commission portal — animated money generates
"the number moved" support messages from reps. Static, tabular and boring is
correct there, and anything animated must honour `prefers-reduced-motion`.

`chartKit.tsx` has its own count-up for KPI tiles; that is the one in use.

## Leaderboard weight animation — known limitation

Google Fonts serves **Barlow Semi Condensed as static weights only**; a
`wght@600..700` range request returns HTTP 400. `font-variation-settings`
therefore cannot interpolate it and the 600→700 change **snaps** rather than
tweening.

Both static weights are loaded, so the snap uses real faces and never synthetic
bold, and `.lb-name::after` reserves the bold width so the row does not shift.
The variable code path is already in place and activates automatically if a
variable build of the family is ever self-hosted.

To get true weight interpolation today you would have to either self-host a
variable Barlow Semi Condensed or use Inter (variable) for leaderboard names,
losing the condensed look. Worth a brand decision.
