# Design System Reference — SMR Dashboards (React Template)

> Reusable house style for the two-dashboard React front-end (formerly "Little Tree"). This document captures ONLY the design system (tokens, colors, type, components) so the shell can be re-skinned for a new client. Exact hex values are preserved verbatim. Client names/logos/data are out of scope except in Section 9 (re-skin checklist).

---

## 1. Overview

**Stack**

- **React + Vite** — multi-page build (two separate HTML entry points: `index.html` for AR, `cashflow.html` for Cashflow).
- **Recharts** — every chart in both apps (`BarChart`, `AreaChart`, `LineChart`, `ComposedChart`). No Recharts default palette is ever used; all series colors are explicit hex.
- **Leaflet** — used only for the geographic sales map (AR), never for charts.

**Two sibling dashboards, one design language**

| App | Path | Purpose | Shell entry |
|-----|------|---------|-------------|
| **AR Dashboard** | `src/ar` | Accounts Receivable / sales | `App.jsx` → `Dashboard.jsx` |
| **Cashflow Dashboard** | `src/cashflow` | CFO / cashflow / commission | `CashflowApp.tsx` |

Both are fixed-sidebar + content shells built with CSS Grid, share a forest-green-on-slate light theme, use Inter, and cross-link into each other via `sessionStorage` auth flags. They **re-implement** the same components rather than importing a shared package — the visual language is convention-enforced, not enforced by a shared token module. The two primary stylesheets are:

- `src/ar/styles.css` (~3200 lines; `:root` `--d-*` tokens at ~line 500)
- `src/cashflow/cashflow.css` (992 lines; `:root` tokens at top)

**Two color systems inside AR:** `styles.css` defines a dark "tropical resort" gate theme (splash/login/dashboard-chooser, `--*` prefix, lines 4–14) and a light professional analytics theme (`--d-*` prefix, lines 500–517). 95% of the UI lives in the light dashboard theme. Cashflow is **light-only** (`color-scheme: light`, no dark-mode query) and deliberately mirrors the AR light palette, keeping the same variable *names* so all 38 components inherit the green theme without edits.

---

## 2. Color Palette

### 2a. Shared / Brand colors (the load-bearing identity — change these to re-skin)

These hexes are identical across both apps and define the whole product.

| Hex | Label | Role / Usage |
|-----|-------|--------------|
| `#15803d` | **Forest Green — BRAND / PRIMARY** | AR `--d-accent` / Cashflow `--accent`. Active tabs, links, focus rings, primary buttons, brand logo, "audited/good/positive" language, invoiced/sales chart series, payroll chart series. |
| `#166534` | Dark Forest Green | AR `--d-accent-dark` / Cashflow `--accent-hover`. Hover states, gradient end stops, avatar gradient end. |
| `#14532d` | Green-900 | Dark accent fallback (used once in AR, e.g. `rep-scope-note`), sidebar-switch border. |
| `#dcfce7` | Soft Green-100 | AR `--d-accent-light`/`--d-success-light` / Cashflow `--accent-soft`. Accent tints, pill fills, focus glow, avatar bg. |
| `#f0fdf4` | Lightest Green-50 | AR alert-good/audited bg / Cashflow `--accent-soft-2` (active nav, zebra). |
| `#16a34a` | Green-600 | AR `--d-success` / paid chart series / aging "1–30" bucket. |
| `#f7f8fa` | Cool White (page bg) | AR `--d-bg` / Cashflow `--bg`. |
| `#ffffff` | White (surface) | AR `--d-card` / Cashflow `--panel`. Cards, inputs, sidebar, topbar, menus. |
| `#f8fafc` | Slate-50 (subtle surface) | AR panels/table-head / Cashflow `--panel-2`. |
| `#f1f5f9` | Slate-100 | Hover fills, filter tracks, neutral pills, skeleton. |
| `#e2e8f0` | Slate-200 (border) | AR `--d-border` / Cashflow `--border`. |
| `#cbd5e1` | Slate-300 (strong border) | AR `--d-border-strong` / Cashflow `--border-strong`. |
| `#0f172a` | Slate-900 (primary text) | AR `--d-text` / Cashflow `--text`. Also the universal shadow/scrim color. |
| `#475569` | Slate-600 (secondary text) | AR `--d-text-secondary` / Cashflow `--muted-strong`. |
| `#94a3b8` | Slate-400 (muted text) | AR `--d-text-muted` / Cashflow `--muted`. |
| `#64748b` | Slate-500 | Secondary muted text, chart axis labels, chevrons. |
| `#d97706` | Amber-600 (warning) | AR `--d-warning` / Cashflow `--warn` + `--chart-nonpayroll`. |
| `#fef3c7` | Amber-100 (warning tint) | AR `--d-warning-light` / Cashflow `--warn-soft`. |
| `#dc2626` | Red-600 (danger) | AR `--d-danger` / Cashflow `--danger` + Payroll chart series. |
| `#fee2e2` | Red-100 (danger tint) | AR `--d-danger-light` / Cashflow `--danger-soft`. |
| `#2563eb` | Blue-600 (info) | Cashflow `--info` / closing-cash & YoY chart series. |
| `#dbeafe` | Blue-100 (info tint) | Cashflow `--info-soft` / status-partial, grade-B, tag-line bg. |
| `#fef9c3` | Highlight Yellow | Cashflow `--highlight` / AR bucket-2 / grade-C pill bg. |
| `#bbf7d0` | Green-200 (border) | Toast/audited/rule-new border. |
| `#047857` | Emerald-700 | Success text on tags (tag-strong/tag-ok), map-link. |

### 2b. AR Dashboard — Dark Gate Theme (splash / login / chooser only)

| Hex | Label | Usage |
|-----|-------|-------|
| `#061410` | Forest Black (deepest bg) | `--bg-deep`: page bg on gate screens |
| `#0d2419` | Deep Forest | `--bg-mid` |
| `#143426` | Forest Soft | `--bg-soft` |
| `#050d09` | Near-Black Green | `.splash` background |
| `#0a0a0a` | Pure Black | `.splash.rejected` (access-denied) |
| `#0a1a12` | Ink-on-Gold Green | checkbox checkmark on gold box |
| `#f4ead5` | Cream / Parchment Ink | `--ink`: primary text (dark theme) |
| `rgba(244,234,213,0.7)` | Dim Cream | `--ink-dim`: secondary text |
| `#c9a961` | Gold | `--gold`: links hover, dots, focus, checkbox fill |
| `#d4b876` | Soft Gold | `--gold-soft`: links, eyebrows, sub-labels |
| `#1a4d33` | Emerald Green | `--green` |
| `#0a2818` | Dark Emerald | `--green-dark` |
| `#2a7a52` | Jade (btn top) | btn-primary gradient start |
| `#1f5e3e` | Pine (btn bottom) | btn-primary gradient end |
| `#2f8a5c` | Jade Hover | btn-primary:hover start |
| `#246a47` | Pine Hover | btn-primary:hover end |
| `#6abf85` | Mint | secure-tag lock icon in login footer |
| `#ffb4b4` | Soft Red | form-error text |
| `rgba(212,184,118,0.9)` | Ember Gold | floating ember radial-gradient core |

### 2c. AR Dashboard — Light Dashboard Theme (neutrals, surfaces, one-off tints)

Core neutrals/brand are in **2a**. Additional AR-specific tints:

| Hex | Label | Usage |
|-----|-------|-------|
| `#334155` | Slate-700 | review inbox FAB bg, toast body text |
| `#1e293b` | Slate-800 | FAB hover bg, review-card comment text |
| `#eef2f7` | Pale Slate | seg-count active bg |
| `#fafbfc` | Off-White | `kpi-dso.is-expanded` card bg |
| `#fbfcfe` | Cool Off-White | pay-fields panel gradient end |
| `#fdfdfb` | Warm White | chooser-card bg |
| `#f1f7f3` | Pale Green | chooser-card CTA bg |
| `#e7ede9` | Sage Border | chooser-card CTA top border |
| **Success extras** | | |
| `#ecfdf5` | Emerald-50 | map-link ("Find on map") bg |
| `#a7f3d0` | Emerald-200 | map-link border |
| `#d1fae5` | Emerald-100 | map-link hover bg |
| `#6ee7b7` | Emerald-300 | map-link hover border |
| **Aging / warning / orange ramp** | | |
| `#4d7c0f` | Lime-700 | bucket-1 (1–30) pill text |
| `#ecfccb` | Lime-100 | bucket-1 pill bg |
| `#92400e` | Amber-800 | status-open, sev-medium, warn text |
| `#fffbeb` | Amber-50 | alert-warn card bg |
| `#a16207` | Yellow-700 | bucket-2 / grade-C / cadence-slowing text |
| `#ca8a04` | Yellow-600 | pct-ok collection % |
| `#b45309` | Amber-700 | pay-note text, received chevron |
| `#f59e0b` | Amber-500 | pay-note pending dot |
| `#fbbf24` | Amber-400 | pay-select[received] border |
| `#fffaf0` | Warm Cream | pay-select[received] bg |
| `#c2410c` | Orange-700 | bucket-3 / high-risk / at-risk text |
| `#ffedd5` | Orange-100 | bucket-3 / high-risk / row-unassigned hover bg |
| `#9a3412` | Orange-800 | bucket-4 / rep-flag text |
| `#ffe4d6` | Pale Orange | bucket-4 (91–120) pill bg |
| `#fed7aa` | Orange-200 | rep-flag badge bg |
| `#fff7ed` | Orange-50 | row-unassigned row bg |
| **Danger extras** | | |
| `#b91c1c` | Red-700 | bucket-5 / grade-D / churned / pct-bad text |
| `#991b1b` | Red-800 | dash-error, audit-issue verdict text |
| `#fef2f2` | Red-50 | alert-bad / date-filter-reset / audit-issue bg |
| `#fca5a5` | Red-300 | dash-error banner border |
| `#fecaca` | Red-200 | date-filter-reset / review-error border |
| **Info / blue extras** | | |
| `#0369a1` | Sky-700 | bucket-upcoming pill text, pay-plan chevron |
| `#e0f2fe` | Sky-100 | bucket-upcoming pill / map loading bg |
| `#1e40af` | Blue-800 | status-partial text |
| `#1d4ed8` | Blue-700 | grade-B pill text |
| `#f0f9ff` | Sky-50 | pay-select[plan] bg |
| `#38bdf8` | Sky-400 | pay-select[plan] border |
| `#075985` | Sky-800 | pay-select[plan] text |
| `#0284c7` | Sky-600 | pay-fields[plan] accent strip |
| `#cfe4f5` | Powder Blue | leaflet-container map bg |
| **Purple / indigo (Private Label + wholesale/gelato channels)** | | |
| `#6366f1` | Indigo-500 | Private-Label gradient start, pills, brand-initial |
| `#8b5cf6` | Violet-500 | Private-Label gradient end |
| `#faf5ff` | Purple-50 | brand-card-private bg gradient start |
| `#e9d5ff` | Purple-200 | brand-card-private border |
| `#e0e7ff` | Indigo-100 | channel-wholesale pill bg |
| `#4338ca` | Indigo-700 | channel-wholesale pill text |
| `#fae8ff` | Fuchsia-100 | channel-gelato pill bg |
| `#86198f` | Fuchsia-800 | channel-gelato pill text |
| `#d4c5ff` | Light Violet | chooser-card-cf icon color |
| `#c9b8ff` | Pale Violet | chooser-card-cf eyebrow |
| **Scrim** | | |
| `rgba(15,23,42,0.5)` | Slate-900 Scrim | modal-overlay backdrop (blurred) |

### 2d. Cashflow Dashboard — palette (additive to shared 2a)

Core neutrals/brand/status are in **2a**. Cashflow-only additions:

| Hex | Label | Usage |
|-----|-------|-------|
| `#059669` | Emerald-600 (up/positive) | `kpi-sub.up` text (hardcoded, distinct from accent green) |
| `#e6f4ef` | Muted green | `cm-month-row:hover` fallback for `--accent-soft` |
| `#fbfdfc` | Near-white green tint | `cm-page-head` gradient end |
| `#f0fdfa` | Teal-50 tint | data-table `group-row` bg |
| `#99e6d8` | Teal border | tag-strong/tag-ok border, audit-pill tone-ok border |
| `#fde68a` | Amber-200 border | tag-fuzzy/tag-warn border, cm-rule-wl border |
| `#bfdbfe` | Blue-200 border | tag-line border, audit-pill tone-info border |
| `#1e40af` | Blue-800 text | tag-line text |
| `#fff7f7` | Pale red row tint | data-table `tr.row-none` bg |
| `#fffbeb` | Pale amber row tint | data-table `tr.row-fuzzy` bg |
| `#fafbfc` | Off-white zebra | commission table even-row bg |
| `#b45309` | Amber-700 text | cm-chip-wl / cm-refreshing / cm-rule-wl text |
| `#1e293b` | Slate-800 | cm-modal-head gradient start |
| `#991b1b` | Red-900 text | error box text, tag-none text |
| `#f1f5f9` | Slate-100 | cm-rule-chip bg, commission td border |
| `#bbf7d0` | Green-200 border | cm-rule-new border |

---

## 3. CSS Variables / Design Tokens

### 3a. AR `styles.css` — dark gate theme (`--*`)

| Token | Value | Purpose |
|-------|-------|---------|
| `--bg-deep` | `#061410` | Deepest page bg (html/body/#root, splash) |
| `--bg-mid` | `#0d2419` | Mid-layer background |
| `--bg-soft` | `#143426` | Soft surface background |
| `--ink` | `#f4ead5` | Primary text (cream/parchment) |
| `--ink-dim` | `rgba(244, 234, 213, 0.7)` | Dimmed/secondary text |
| `--gold` | `#c9a961` | Gold accent (links, dots, checkbox, focus) |
| `--gold-soft` | `#d4b876` | Soft gold (links, eyebrows, chooser icons) |
| `--green` | `#1a4d33` | Emerald green |
| `--green-dark` | `#0a2818` | Deep green |

### 3b. AR `styles.css` — light dashboard theme (`--d-*`)

| Token | Value | Purpose |
|-------|-------|---------|
| `--d-bg` | `#f7f8fa` | Page/main background (cool white) |
| `--d-card` | `#ffffff` | Card/surface/input/sidebar/topbar bg |
| `--d-border` | `#e2e8f0` | Default border/divider (slate-200) |
| `--d-border-strong` | `#cbd5e1` | Stronger/input borders (slate-300) |
| `--d-text` | `#0f172a` | Primary text/headings (slate-900) |
| `--d-text-secondary` | `#475569` | Secondary text, nav links, buttons |
| `--d-text-muted` | `#94a3b8` | Muted text, placeholders, subs |
| `--d-accent` | `#15803d` | **BRAND/PRIMARY** — active tabs, links, focus, primary buttons |
| `--d-accent-light` | `#dcfce7` | Accent tint — active/hover bg, pill fills, focus glow |
| `--d-accent-dark` | `#166534` | Dark accent — mono cells, hover, avatar gradient (fallback `#14532d` used once) |
| `--d-success` | `#16a34a` | Success accent bar/value/icon |
| `--d-success-light` | `#dcfce7` | Success tint bg (== accent-light) |
| `--d-warning` | `#d97706` | Warning accent |
| `--d-warning-light` | `#fef3c7` | Warning tint bg |
| `--d-danger` | `#dc2626` | Danger accent/buttons |
| `--d-danger-light` | `#fee2e2` | Danger tint bg |

### 3c. Cashflow `cashflow.css` (`:root`, lines 6–31)

All 21 custom props are in one `:root` block. Same hex values as AR, different token names — so components inherit the theme without edits.

| Token | Value | Purpose |
|-------|-------|---------|
| `--bg` | `#f7f8fa` | App/page/body background |
| `--panel` | `#ffffff` | Primary surface (sidebar, cards, kpi, section) |
| `--panel-2` | `#f8fafc` | Secondary surface (code, hover, table th, subtotal, default pill) |
| `--border` | `#e2e8f0` | Default 1px border |
| `--border-strong` | `#cbd5e1` | Ghost button, commission thead border |
| `--text` | `#0f172a` | Primary text (near-black slate) |
| `--muted` | `#94a3b8` | Muted/secondary text |
| `--muted-strong` | `#475569` | Stronger muted (nav, labels, th) |
| `--accent` | `#15803d` | Primary brand accent (buttons, active, links, logo, `--chart-payroll`) |
| `--accent-hover` | `#166534` | Darker green for hover + gradient end |
| `--accent-soft` | `#dcfce7` | Soft green bg (chips, avatar, modal-formula, tag-strong/ok) |
| `--accent-soft-2` | `#f0fdf4` | Lightest green bg (active nav, commission zebra) |
| `--warn` | `#d97706` | Warning amber (also `--chart-nonpayroll`) |
| `--warn-soft` | `#fef3c7` | Soft amber bg (tag-fuzzy/warn) |
| `--danger` | `#dc2626` | Danger red (down chips, errors) |
| `--danger-soft` | `#fee2e2` | Soft red bg (error box, tag-none, down chip) |
| `--info` | `#2563eb` | Info blue accent |
| `--info-soft` | `#dbeafe` | Soft blue bg (tag-line) |
| `--chart-payroll` | `#15803d` | Chart series: payroll (== accent) |
| `--chart-nonpayroll` | `#d97706` | Chart series: non-payroll (== warn) |
| `--highlight` | `#fef9c3` | Highlight yellow (row/cell emphasis) |
| `--cm-accent` | *(undefined; set inline per rep; fallback `var(--accent)` `#15803d`)* | Commission card per-rep accent (cm-kpi top bar, is-active gradient) |
| `--cm-accent-2` | *(undefined; set inline per rep; fallback `var(--accent-hover)` `#166534`)* | Commission card per-rep secondary accent (gradient end) |

> Note: several Cashflow hardcoded hexes duplicate token values by literal rather than referencing the var (e.g. `#dcfce7` == `--accent-soft`, `#15803d` == `--accent`, `#e2e8f0` == `--border`). Distinct opaque-hex count in the file: 38.

---

## 4. Semantic Colors

Status is expressed as **soft-tint background + strong text** pairs. Convention is identical across both apps.

| Role | Accent / value | Text-on-tint | Tint bg | Border (where used) |
|------|----------------|--------------|---------|---------------------|
| **Success / good / audited / positive** | `#16a34a` (AR `--d-success`), `#15803d` (brand), `#059669` (Cashflow up) | `#047857` | `#dcfce7`, `#f0fdf4` | `#bbf7d0`, `#99e6d8` |
| **Danger / bad / churned / overdue** | `#dc2626` (`--d-danger`/`--danger`) | `#b91c1c`, `#991b1b` | `#fee2e2`, `#fef2f2`, `#fff7f7` | `#fecaca`, `#fca5a5` |
| **Warning / caution / fuzzy** | `#d97706` (`--d-warning`/`--warn`) | `#92400e`, `#a16207`, `#b45309` | `#fef3c7`, `#fef9c3`, `#fffbeb` | `#fde68a`, `#fbbf24` |
| **Info / partial / line** | `#2563eb` (`--info`), `#0369a1`, `#1d4ed8` | `#1e40af`, `#075985` | `#dbeafe`, `#e0f2fe`, `#f0f9ff` | `#bfdbfe` |
| **Neutral / muted** | `#94a3b8` (muted), `#64748b` | `#475569` | `#f1f5f9`, `#f8fafc` | `#e2e8f0`, `#cbd5e1` |

**Cashflow tone-triplet system (bg / border / text):**
- success/strong `#dcfce7` / `#99e6d8` / `#047857`
- warn/fuzzy `#fef3c7` / `#fde68a` / `#92400e`
- info/line `#dbeafe` / `#bfdbfe` / `#1e40af`
- danger/none `#fee2e2` / `#fecaca` / `#991b1b`
- Row-state tints: `row-none` `#fff7f7`, `row-fuzzy` `#fffbeb`, `group-row` `#f0fdfa`

**Orange sub-channel (AR high-risk / at-risk / late buckets):** `#c2410c`, `#9a3412`, `#ffedd5`, `#ffe4d6`, `#fed7aa`, `#fff7ed`

**Purple/indigo sub-channel (AR Private-Label + wholesale/gelato):** `#6366f1`, `#8b5cf6`, `#4338ca`, `#86198f`, `#faf5ff`, `#e9d5ff`, `#e0e7ff`, `#fae8ff`

**Aging bucket heat ramp (7-step, upcoming → 120+):**

| Bucket | Text | Bg |
|--------|------|----|
| Upcoming | `#0369a1` | `#e0f2fe` |
| Current | `#15803d` | `#dcfce7` |
| 1–30 | `#4d7c0f` | `#ecfccb` |
| 31–60 | `#a16207` | `#fef9c3` |
| 61–90 | `#c2410c` | `#ffedd5` |
| 91–120 | `#9a3412` | `#ffe4d6` |
| 120+ | `#b91c1c` | `#fee2e2` |

**Shadows (universal):** slate-ink `rgba(15,23,42, x)`; green-tinted glow `rgba(21,128,61, x)` only on the "Switch" gradient button; dark-theme shadows `rgba(0,0,0, x)`.

**Focus rings:** standard green `rgba(21,128,61,0.12)`; glow `#dcfce7` (`--d-accent-light`); focus-visible outline `#15803d`.

---

## 5. Gradients (verbatim)

### AR `styles.css`

```
hero-overlay (splash vignette):
  radial-gradient(ellipse 55% 50% at center, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.1) 70%, rgba(0,0,0,0) 100%),
  linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.25) 100%)

light-shafts (sunbeams):
  linear-gradient(105deg, transparent 30%, rgba(255, 215, 130, 0.04) 38%, transparent 46%, transparent 58%, rgba(255, 215, 130, 0.03) 64%, transparent 72%)

vignette:
  radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)

ember (floating particle):
  radial-gradient(circle, rgba(212, 184, 118, 0.9), rgba(212, 184, 118, 0) 70%)

login-card::before (gold hairline shimmer):
  linear-gradient(90deg, transparent, rgba(201, 169, 97, 0.75), transparent)

login-card::after (glass sheen):
  linear-gradient(115deg, transparent 32%, rgba(244, 234, 213, 0.07) 46%, rgba(244, 234, 213, 0.16) 50%, rgba(244, 234, 213, 0.07) 54%, transparent 68%)

login-card .btn-block::after (hover light sweep):
  linear-gradient(120deg, transparent 38%, rgba(255, 255, 255, 0.22) 50%, transparent 62%)

btn-primary:            linear-gradient(180deg, #2a7a52 0%, #1f5e3e 100%)
btn-primary:hover:      linear-gradient(180deg, #2f8a5c 0%, #246a47 100%)
sidebar-switch:         linear-gradient(180deg, #15803d 0%, #166534 100%)
skeleton shimmer:       linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)
Private-Label accent:   linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)
brand-card-private:     linear-gradient(180deg, #faf5ff 0%, #ffffff 30%)
customer-avatar:        linear-gradient(135deg, var(--d-accent) 0%, var(--d-accent-dark) 100%)
pay-fields panel:       linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%)
mi-map-card:            linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)
chooser-card-icon (AR/green):  linear-gradient(135deg, rgba(42, 122, 82, 0.4), rgba(31, 94, 62, 0.25))
chooser-card-cf icon (CF/purple): linear-gradient(135deg, rgba(120, 85, 200, 0.35), rgba(80, 60, 160, 0.25))
```

### Cashflow `cashflow.css`

```
cm-kpi::before (5px top accent bar):
  linear-gradient(90deg, var(--cm-accent, var(--accent)), var(--cm-accent-2, var(--accent-hover)))

cm-kpi.is-active (card bg):
  linear-gradient(135deg, var(--cm-accent, var(--accent)), var(--cm-accent-2, var(--accent-hover)))

cm-modal-head (bg):
  linear-gradient(135deg, #1e293b, #0f172a)

commission section-title::before (accent bar):
  linear-gradient(180deg, var(--accent), var(--accent-hover))

commission total-row td (bg):
  linear-gradient(135deg, var(--accent), var(--accent-hover))

cm-page-head layer 1 (accent-green glow):
  radial-gradient(120% 140% at 0% 0%, rgba(21, 128, 61, 0.06), transparent 55%)

cm-page-head layer 2 (white→near-white):
  linear-gradient(180deg, #ffffff, #fbfdfc)
```

---

## 6. Chart Colors

**Library:** Recharts for all charts (`BarChart`, `AreaChart`, `LineChart`, `ComposedChart`). Leaflet = map only. **No chart uses a Recharts default palette** — every series/segment color is an explicit hardcoded hex. Series colors are never CSS variables; CSS vars (`var(--muted)`, `var(--border)`, `var(--panel)`) appear only for axis/grid/tooltip chrome in the Cashflow TSX charts.

### Three color-assignment patterns

1. **Label / key lookup** (dominant, for meaningful categories) — a JS object maps a domain key (aging-bucket label, expense head, brand, sales-rep, cashflow category) to a fixed hex, so a category always renders the same color regardless of order. Some add an index-based `FALLBACK` array (`FALLBACK[i % len]`) for unknown labels.
2. **Index / position** (interchangeable ranked items) — a plain array indexed by series position (e.g. per-year lines, top-6 brand stacks).
3. **Inline literal / data-conditional** — a single series (or a two-series Invoiced/Paid pair) gets its hex written directly on the mark; a few Cells pick color by a data condition.

### App-wide semantic convention (holds even where colors are duplicated)

- `#15803d` = invoiced / sales / positive
- `#16a34a` = paid
- `#2563eb` = closing-cash / current
- Aging severity ramp: `#0ea5e9`, `#16a34a`, `#84cc16`, `#eab308`, `#f97316`, `#ea580c`, `#dc2626`

### Shared / notable color arrays (exact colors)

| Array | Colors | Location |
|-------|--------|----------|
| **COLLECTION_BRANDS** *(the ONLY cross-file EXPORTED palette)* | `#15803d` Gelato, `#7c3aed` Alien Brainz, `#0ea5e9` Yacht Fuel, `#f97316` Funkd Up | `src/ar/lib/brandCollections.js:19` |
| **COLORS** (aging buckets, local) | `#0ea5e9` Current, `#16a34a` 1–30, `#84cc16` 31–60, `#eab308` 61–90, `#f97316` 91–120, `#ea580c` 121–180, `#dc2626` 180+ | `src/ar/dashboard/AgingChart.jsx:5` |
| **BUCKET_COLORS** (duplicate of aging, local) | same 7 hexes + `#94a3b8` fallback | `src/ar/dashboard/pages/Overview.jsx:781` |
| **INFLOW_COLORS** (cashflow inflow) | `#15803d`, `#22c55e`, `#14b8a6` | `Projection13WeekChart.tsx:39` |
| **OUTFLOW_COLORS** (cashflow outflow) | `#dc2626` Payroll, `#16a34a` Inventory, `#f59e0b` COGS, `#0891b2` Rent, `#64748b` Other, `#ec4899` Credit Card, `#8b5cf6` Software | `Projection13WeekChart.tsx:45` |
| **INFLOW_FALLBACK** | `#15803d`, `#22c55e`, `#14b8a6`, `#0891b2`, `#65a30d` | `Projection13WeekChart.tsx:54` |
| **OUTFLOW_FALLBACK** | `#dc2626`, `#f59e0b`, `#64748b`, `#ec4899`, `#8b5cf6`, `#0891b2` | `Projection13WeekChart.tsx:55` |
| **OPEX_HEADS** (mirrors OUTFLOW_COLORS) | `#dc2626` Payroll, `#16a34a` Inventory, `#f59e0b` COGS, `#0891b2` Rent, `#8b5cf6` Software, `#64748b` Other | `MonthlySummary.tsx:13` |
| **YEAR_COLORS** (per-year lines, older→newer) | `#94a3b8`, `#2563eb`, `#059669`, `#f59e0b`, `#8b5cf6` | `SalesForecastPage.tsx:10` |
| **palette** (top-6 brand stack, in-component) | `#15803d`, `#0891b2`, `#65a30d`, `#d97706`, `#dc2626`, `#7c3aed` | `Insights.jsx:1026` |
| **yearColors** (per-year monthly bars, in-component) | `#94a3b8`, `#a7f3d0`, `#6ee7b7`, `#22c55e`, `#15803d` | `Insights.jsx:1729` |
| **PL1_LINES** (private-label brands; same hexes as COLLECTION_BRANDS) | `#15803d` Gelato, `#7c3aed` Alien Brainz, `#0ea5e9` Yacht Fuel, `#f97316` Funkd Up | `Sales.jsx:271` |
| **REP_COLORS** (per-rep `[base, deep]` pairs; powers KPI cards, not a chart) | `#6366f1`/`#4f46e5` Manny, `#10b981`/`#059669` Dave, `#f59e0b`/`#d97706` Johan, `#f43f5e`/`#e11d48` Joe P, `#06b6d4`/`#0891b2` Ken, `#64748b`/`#475569` fallback | `Commission.tsx:14` |

### Per-chart notes

| File | Chart | Colors / rule |
|------|-------|---------------|
| `AgingChart.jsx` | BarChart, one `<Cell>` per bucket | `COLORS[label]` (label-driven). Chrome: grid `#e2e8f0`, axis `#64748b`, tooltip text `#15803d`. |
| `SalesTrendChart.jsx` | AreaChart (Invoiced + Paid stacked) | `#15803d` sales (salesGrad 0.35→0), `#16a34a` paid (paidGrad 0.3→0). Gradient stop colors == the two strokes. |
| `Projection13WeekChart.tsx` | ComposedChart (inflow Bars + outflow Bars + closing Line) | `inColorFor`/`outColorFor` look up label, fall back to `FALLBACK[i%len]`. Closing-cash Line + right axis + "This week" ref line `#2563eb`; zero ref line `#9ca3af`; grid `#e5e7eb`; axis `#6b7280`. |
| `Overview.jsx` | (1) BarChart aging + (2) AreaChart sales | `BUCKET_COLORS[label]` fallback `#94a3b8`; area `#15803d`/`#16a34a` (execSales/execPaid gradient defs). Duplicate of AgingChart + SalesTrendChart. |
| `SalesForecastPage.tsx` | (1) YoY ComposedChart + (2) seasonality ComposedChart | YoY bars `#93c5fd` (partial/YTD) else `#2563eb`; Invoices line `#f59e0b`. Seasonality bars `rgba(16,185,129,0.35)` if idx≥1 else `rgba(239,68,68,0.35)`; ref line `#9ca3af`. Year lines `YEAR_COLORS[i%len]`. Grid/axis `var(--border)`/`var(--muted)`; tooltip `var(--panel)`. |
| `MonthlySummary.tsx` | BarChart stacked by expense head | `<Bar fill={h.color}>` from `OPEX_HEADS`. Deliberately same palette as OUTFLOW_COLORS so a color = same expense head app-wide. |
| `Insights.jsx` | (1) region Bar, (2) brand stacked Bar, (3) YoY monthly Bar | Region single `#15803d`; brand stack `palette[i]` (top-6); `yearColors[i%len]` per year. `palette`/`yearColors` declared inside render (not shared). |
| `Sales.jsx` | (1) private-label stacked Bar, (2) infused-origin collections stacked Bar | (1) `PL1_LINES` (local); (2) `b.color` from shared `COLLECTION_BRANDS`. Both carry the identical 4 brand hexes; color travels with the brand object. |
| `Collections.jsx` | DSO Line, Total-AR Line, Issued-vs-Collected Bar, 180+ Line | All inline: DSO `#15803d`, Total-AR `#15803d`, Issued `#6366f1`, Collected `#14b8a6`, 180+ `#dc2626`. Grid `#e2e8f0`. |
| `CustomerProfile.jsx` | LineChart (Invoiced + Paid) | Inline `#15803d` / `#16a34a` (same Invoiced/Paid convention). |
| `KpiCard.jsx` | **Not a chart** | Zero color literals in JS; applies `kpi-${tone}` class (good/warn/bad/muted) — all coloring is CSS-driven. |
| `Commission.tsx` | **Not a chart** — colorful KPI cards + drill modal | `repColor(rep)` returns `REP_COLORS` `[base, deep]` pair → fed into `--cm-accent`/`--cm-accent-2` custom props + rep-dot gradient. Name-keyed. |

---

## 7. Typography, Spacing, Radii, Shadows

### Typography

- **Primary family:** Inter (`'Inter', -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) across both apps.
- **Monospace:** JetBrains Mono (AR) / SF Mono (Cashflow, `'SF Mono', ui-monospace, Menlo, Consolas, monospace`) — reserved for numeric/invoice cells and the KPI-modal formula.
- **Quirk:** the KPI info "i" glyph is Georgia/Times italic serif.
- **Dark/gold theme** appears only on the AR splash; dashboards are all Inter on light.

**Weight scale:** 500 = nav links, body emphasis, secondary buttons; 600 = labels, section/card headings, KPI labels; 700 = KPI values, page/modal titles, table strong rows. 400 effectively unused for chrome.

**Size scale (px):** KPI value **28** (hero number); page/topbar title 20–22; modal value 30; section/card title 14.5–15; body/nav/table 13–14; sub/caption 12–13; KPI + table + eyebrow labels 11–11.5 (uppercase); micro/brand-sub 10–10.5. Most-used: 11 / 12 / 12.5 / 13.

**Numeric treatment:** `font-variant-numeric: tabular-nums` on all values and `.num` cells. Big values get negative tracking (−0.02 to −0.025em); labels/eyebrows/th get positive tracking (0.04–0.1em) + `text-transform: uppercase`; titles use slight negative tracking (−0.01 to −0.015em).

### Spacing (≈4px base rhythm)

- Nav item gaps 2–4px; KPI grid gap 14px (AR) / 16px (Cashflow); section stacking `margin-bottom: 20px`.
- Content padding: AR `.dash-content` `26px 32px 60px`; Cashflow `.main` `20px 24px`.
- Card/section inner padding 20–22px; KPI padding `20px 22px` (AR) / `20px` (Cashflow).
- Sidebar padding ~16–20px × 12–14px; table cells 10–12px vertical / 12–16px horizontal; modal head 18–22px × 24–28px, body 20–24px.
- KPI grids responsive: AR `auto-fit minmax(220px, 1fr)`; Cashflow `repeat(4, 1fr)` → 2 → 1 at 1100/640px.
- Content width-capped: Cashflow `max-width: 1600px` centered; modals 1080–1200px.

### Radii (tiered by element size)

- Small controls (buttons, nav links, search inputs, segmented items): **6–8px**
- Cards / KPI tiles / sections: **10–14px** (AR kpi 12; Cashflow kpi/card/section 14)
- Modals: **14–16px**
- Fully round: **999px / 50%** for pills (aging buckets, chips, rep flags), status dots, avatars
- Most common: 8px, then 10px, then 6px and 12/14px

### Shadows (flat, border-first; elevation reserved for interaction/overlays)

- Resting cards: borders + almost-invisible `0 1px 2px rgba(15,23,42,0.04)` (or none)
- Hover lift on clickable KPIs: `0 6px 18px rgba(15,23,42,0.10)`; or tiny `0 1px 3px …0.04` border-glow
- Focus: 3px accent ring `0 0 0 3px var(--accent-light)` or 2px accent outline
- Overlays (only heavy shadows): modals `0 24px 60px rgba(15,23,42,0.25–0.35)`; dark drill modal `0 28px 70px …0.38`; floating back button `0 6px 18px …0.18`
- Shadow color consistently slate-ink `rgba(15,23,42, x)`; green-tinted `rgba(21,128,61, x)` only on the green "Switch" gradient button
- Cashflow specific rgba(15,23,42, x) usage: 0.04 (card/kpi/section rest), 0.10 (kpi.clickable hover), 0.14 (cm-kpi hover), 0.35 (kpi-modal), 0.38 (cm-modal); backdrops 0.45 (kpi-modal), 0.55 (cm-modal + `blur(3px)`)

---

## 8. Layout & Key Reusable Components

### Shells

- **AR** (`App.jsx` → `Dashboard.jsx`): `.dash` grid `232px 1fr`. Left = sticky full-height `.sidebar`; right = `.dash-main` (flex column) with a sticky `.topbar` (page title + logo + "updated Xs ago" + Refresh) and scrolling `.dash-content` (`26px 32px 60px`). Page switching is state-driven (`active` id → PAGES map → PageRouter), wrapped in `.page-fade` + an ErrorBoundary keyed on the active page. Global overlay modals (invoice list, customer profile, copilot) render as siblings at shell root.
- **Cashflow** (`CashflowApp.tsx`): `.shell` grid `220px minmax(0,1fr)`. Left = sticky `.sidebar`; right = `.main` (`20px 24px`). **No persistent topbar** — each view owns a `.page-head` (title + sub + action button). Sidebar = one of 5 keys → lazy-loaded "Hub". All views stay mounted, toggled with `display:none` (keep-alive) for instant switching. Floating CfoCopilot at shell root.

Both put a brand block at sidebar top, a scrollable nav (plain `<button>`s, not links) in the middle, and a footer with user chip + cross-app "Switch to…" button + Sign out. Content is organized as: page → stacked full-width `.section`/`.card` blocks → KPI grid at top, then chart cards and table cards. Secondary nav inside a view is a horizontal tab bar (Hub pattern).

### Component families

| Component | File(s) | Role |
|-----------|---------|------|
| **Sidebar** | `src/ar/dashboard/Sidebar.jsx` + `src/cashflow/components/Sidebar.tsx` | Fixed left nav: brand (logo + product name), nav (button list from a NAV/ITEMS array with `active` id + role filtering via `allowedIds`), footer (user chip + gradient "Switch" button + Sign out). Cashflow adds Refresh-All + QuickBooks-settings modal. Identity from `sessionStorage` via a duplicated `readIdentity()` helper. AR uses `.sidebar-link`/`.sidebar-nav`; Cashflow uses `.nav-item`. |
| **Topbar** | `src/ar/dashboard/Topbar.jsx` | AR-only sticky header: optional logo + page title (h1) + freshness sub-line ("Updated Xs ago", re-render every 30s) + Refresh button (spinning SVG). Cashflow's `.page-head` plays this role per view. |
| **KpiCard** | `src/ar/dashboard/KpiCard.jsx` + `src/cashflow/components/KpiCard.tsx` | Signature metric tile: uppercase micro label + big tabular value + muted sub. AR adds tone variants (`kpi-warn/bad/good/muted` → colored top accent bar via `::before` + value color) + optional corner InfoTip. Cashflow is richer: green-filled `active` selected state, period line, trend up/down coloring, "i" info glyph, portal methodology modal (formula + lazy breakdown rows). Both are keyboard-accessible buttons when clickable. |
| **Section / Card** | `cashflow.css` `.section`/`.card` + `styles.css` `.chart-card`/`.table-card` | White panel, 1px border, ~14px radius, faint shadow, ~20–22px padding. Header row (`.section-head`/`.chart-head`) = title + sub + right tools. Cashflow adds a collapsible variant. Universal container for charts + tables. |
| **Data table** | `styles.css` + `cashflow.css` `.data-table`/`.table-wrap` | `.table-wrap` overflow-x scroller, uppercase letter-spaced header on panel-2 gray (sticky in Cashflow), sortable header hover, right-aligned `tabular-nums .num` cells, `.mono` cells, row hover tint, status pills (aging buckets 1–5, rep-flag). |
| **Modal family** | `styles.css` `.modal`/`.modal-overlay`; `cashflow.css` `.kpi-modal`/`.cm-modal` | Portal overlays over blurred slate backdrop (`rgba(15,23,42,.45–.55)` + blur), pop-in animation, close X. Two flavors: light detail modals (AR `.modal`, `kpi-modal`) and dark-gradient-header drill modal (`.cm-modal` with `#1e293b`→`#0f172a` header, rep-dot, back nav). Escape-to-close + `stopPropagation` in JS. |
| **Hub** | `src/cashflow/components/CashflowHub.tsx` (+ ExpensesHub/SalesHub/ReportsHub) | Cashflow's secondary-nav pattern: owns a horizontal `.expenses-tabs` pill bar, swaps sub-views. Lazy load + keep-alive (tab mounts on first visit, stays mounted hidden). One sidebar entry fans out to multiple pages. |
| **Copilot** | `src/ar/dashboard/ArCopilot.jsx` + `src/cashflow/components/CfoCopilot.tsx` | Floating AI assistant at each shell root; can drive navigation (`onCfoNav` → switch view / hub tab). |
| **Loading + error states** | `LoadingSkeleton.jsx` + `.skel-*`/`.dash-error`/`.empty`/`.error` | Shimmer skeleton (animated gradient) for first paint, inline error banner with Retry, centered empty states. |
| **Segmented filters** | `cashflow.css` `.segmented`/`.filter-tab` + `styles.css` `.seg-filter` | Small pill-group toggles (All/Open/Closed, period selectors) sharing the accent-fill-active idiom of hub tabs. |

### Signature design patterns

- Shared forest-green system on a slate neutral ramp; two token namespaces (`--d-*` vs `--bg/--panel/--accent`), same hex values.
- Status semantics as soft-tint + strong-text pairs; aging escalates cyan→green→lime→yellow→orange→red.
- KPI card as atomic metric unit (accent bar AR / full green-fill active Cashflow).
- "Explain the number" affordance: info "i" opens a methodology modal (mono formula + line-item breakdown reconciling to the total).
- Hub tab pattern, lazy-loaded + kept alive.
- Portal + backdrop-blur pop-in modals (light detail vs dark-gradient-header drill).
- Sticky chrome; content scrolls beneath.
- Subtle functional motion: 0.12–0.25s ease transitions, page fades, shimmer skeletons, rotating refresh icon, 30s freshness re-render.
- Cross-dashboard continuity (matching "Switch" button + user chip; auth via `sessionStorage`).
- Role-based rendering (NAV filtered by `allowedIds`/role; rep-scoping of data).

**Key files to extend the system:** `src/ar/styles.css` (`:root --d-*` ~line 500, KPI ~855, tables ~957, modals ~2158) and `src/cashflow/cashflow.css` (`:root` tokens at top, shell/sidebar ~57, KPI ~229, section/table ~414/502, hub tabs ~622, cm-modal ~833).

---

## 9. How to Re-skin for a New Client

The design system is transferable; only tokens, brand assets, chart palette arrays, and client copy change. Because the two apps duplicate rather than share tokens, **every color change must be made in both stylesheets.**

### A. Swap the color scheme (the theme)

1. **AR light theme** — edit `src/ar/styles.css` `:root` `--d-*` block (~line 500). Change at minimum `--d-accent`, `--d-accent-dark`, `--d-accent-light` (currently `#15803d` / `#166534` / `#dcfce7`). Optionally re-tune status tokens `--d-success/warning/danger` + their `-light` pairs.
2. **Cashflow theme** — edit `src/cashflow/cashflow.css` `:root` block (lines 6–31). Mirror the same accent change on `--accent`, `--accent-hover`, `--accent-soft`, `--accent-soft-2`, and `--chart-payroll` (== accent). Keep the variable **names** so all 38 components inherit automatically.
3. **AR dark gate theme** (only if you keep the splash/login) — edit the `--*` block (lines 4–14): `--gold`, `--gold-soft`, `--green`, `--green-dark`, `--bg-deep/mid/soft`, `--ink`. Also update the hardcoded gate gradients/hexes: `btn-primary` (`#2a7a52`/`#1f5e3e`, hover `#2f8a5c`/`#246a47`), `sidebar-switch` (`#15803d`/`#166534`), ember `rgba(212,184,118,·)`, sunbeam `rgba(255,215,130,·)`.
4. **Hunt hardcoded literals that duplicate tokens.** Both files repeat token hexes as literals instead of `var()`. Grep both stylesheets for `#15803d`, `#166534`, `#dcfce7`, `#f0fdf4`, `#14532d` and update any that should track the new brand. Also note AR uses `rgba(21,128,61, x)` (that's `#15803d`) for focus rings/green shadows — update those RGB triplets too.

### B. Swap chart colors (not CSS-driven — code arrays)

Chart series colors are hardcoded hex in JS, never CSS vars. Update these to match the new brand:

- `src/ar/lib/brandCollections.js:19` — **COLLECTION_BRANDS** (the only exported shared palette; consumed by `Sales.jsx`).
- `src/ar/dashboard/AgingChart.jsx:5` (**COLORS**) and its duplicate `src/ar/dashboard/pages/Overview.jsx:781` (**BUCKET_COLORS**) — the 7-step aging ramp (keep both in sync).
- `src/cashflow/components/Projection13WeekChart.tsx:39/45/54/55` — **INFLOW_COLORS / OUTFLOW_COLORS / INFLOW_FALLBACK / OUTFLOW_FALLBACK**.
- `src/cashflow/components/MonthlySummary.tsx:13` — **OPEX_HEADS** (must match OUTFLOW_COLORS for cross-chart consistency).
- `src/cashflow/components/SalesForecastPage.tsx:10` — **YEAR_COLORS**.
- `src/ar/dashboard/pages/Insights.jsx:1026 / :1729` — in-component **palette** / **yearColors**.
- `src/ar/dashboard/pages/Sales.jsx:271` — **PL1_LINES** (keep same hexes as COLLECTION_BRANDS).
- `src/cashflow/components/Commission.tsx:14` — **REP_COLORS** (per-rep `[base, deep]` pairs).
- Inline literals in `Collections.jsx`, `CustomerProfile.jsx`, `SalesTrendChart.jsx` (`#15803d`/`#16a34a` Invoiced/Paid pairs) and chart chrome hexes (grid `#e2e8f0`/`#e5e7eb`, axis `#64748b`/`#6b7280`, tooltip text `#15803d`).

> Keep the semantic convention intact: brand-green = invoiced/sales/positive, `#16a34a` = paid, `#2563eb` = closing-cash. Reassign the *hexes*, not the *meanings*.

### C. Swap branding, logos, and copy (client content — genericize, don't delete components)

- **Titles/meta:** `index.html`, `cashflow.html`, `src/ar/App.jsx` (page `<title>` strings).
- **Splash/chooser/gate:** `src/ar/shell/DashboardChooser.jsx`, `src/ar/shell/SplashGate.jsx` (logo `<img>`, alt/copy, footer, login text, role model).
- **Brand assets in `/public`:** replace `LT Logo.png`, `Gelato.png`, `pure x.jpeg`, `AR.png`, `CF.png` and person photos `manny.png`, `Phill.jpg`, `Rishi.png`. `hero.jpg`, `Bot.png`, `robots.txt` are likely generic (verify). `Upflow.png` only if the new client uses Upflow.
- **Client data baked into `src/ar/lib/`:** genericize `brands.js` (private/white-label lists + prefix logic), `brandCollections.js` (Sheet IDs + brand list), `sheets.js` (Sheet export URLs), `reps.js` / `repScope.js` (rep roster + email→rep map), `vendors.js` (alias/prefix stripping), `regions.js` / `cityCoords.js` (Michigan geography), `reviewLocations.js` (audit tree + role names), `agency.js` (`lt_agency_handoffs` key).
- **UI labels + brand-split logic** in AR dashboard components/pages (Gelato/Little Tree/Pure X appear pervasively — Gelato ~645×, Little Tree ~167× across `src`) and backend `cashflow-server/src` modules (client Sheet IDs, Gelato/PureX/Moysh rules): genericize labels and entity-split logic; do **not** delete the components.

### D. Infra / config to repoint

- `vite.config.js` `/api` & `/auth` proxy target (points at the old client domain).
- `cashflow-server/src/config.ts` CORS/OAuth allowed-origins.
- `vercel.json`, `Dockerfile`, `api/index.js` comments.
- `supabase/schema.sql` header comment.

### E. Security (do before any repurposing — treat as compromised)

Rotate + delete live secrets: `cashflow-server/.env` (QBO client id/secret, Upflow keys, Supabase service key), `cashflow-server/.env.supabase-backup` (second Supabase key), `cashflow-server/.tokens.json` (live QuickBooks OAuth tokens). Revoke the QuickBooks OAuth grant for the old realm. Delete all client data dumps (`.tmp-*.json`, `.tmp-lt.csv`, `botKnowledge.json`, `.brand-emails.json` [PII], overrides, snapshots), `cashflow-server/data`+`references`, `/scripts`, `/docs` (client-specific), and both `/dist` build folders (regenerate). Keep `.env.example` as the setup template.

### Re-skin quick-checklist

1. Rotate/delete secrets + revoke OAuth; purge client data + build folders.
2. Set new brand accent in **both** `:root` blocks (`--d-accent*` in AR, `--accent*` in Cashflow) + status tokens.
3. Grep both stylesheets for literal `#15803d`/`#166534`/`#dcfce7`/`#f0fdf4` (+ `rgba(21,128,61,·)`) and update.
4. Update the gate theme tokens/gradients if the splash is kept.
5. Update all chart palette arrays (Section 9B) — keep aging ramp + Invoiced/Paid convention.
6. Replace logos/photos in `/public`; genericize `src/ar/lib/*`, shell titles, `index.html`/`cashflow.html`, chooser/splash copy, and Gelato/PureX/Moysh labels + split logic.
7. Repoint infra/config to the new domain and data sources; rebuild `dist`.