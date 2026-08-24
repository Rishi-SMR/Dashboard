# Source layout

Two parallel SPAs built into one Vite project:

```
src/
├── ar/                       ← AR Dashboard (mounts at /)
│   ├── main.jsx              entry script  (referenced by /index.html)
│   ├── App.jsx               router: chooser → login → AR dashboard
│   ├── styles.css            AR + shell styles (one big file on purpose)
│   │
│   ├── shell/                landing UI shared by both dashboards
│   │   ├── DashboardChooser.jsx   "Welcome back" + 2-card picker
│   │   ├── SplashGate.jsx         login gate (AR + Cashflow both use)
│   │   └── Embers.jsx             ambient ember particles
│   │
│   ├── dashboard/            AR dashboard tree (flat — no charts/tables/
│   │                          subfolders because there are only a few of each)
│   │   ├── Dashboard.jsx          top-level shell (sidebar + topbar + page)
│   │   ├── Sidebar.jsx, Topbar.jsx, KpiCard.jsx
│   │   ├── CustomerProfile.jsx    drill-in modal
│   │   ├── CustomerReviewList.jsx
│   │   ├── InvoiceListModal.jsx
│   │   ├── MichiganMap.jsx        Leaflet sales map
│   │   ├── AgingChart.jsx         (was charts/AgingChart.jsx)
│   │   ├── SalesTrendChart.jsx    (was charts/SalesTrendChart.jsx)
│   │   ├── InvoiceTable.jsx       (was tables/InvoiceTable.jsx)
│   │   ├── CustomerTable.jsx      (was tables/CustomerTable.jsx)
│   │   └── pages/                 one component per top-level page
│   │       ├── Overview.jsx       hero KPIs + alerts + top defaulters
│   │       ├── Collections.jsx    9-tab LT/Gelato A/R deep view
│   │       ├── Customers.jsx      brand → customer → invoice drill
│   │       ├── Sales.jsx          concentration, seasonality, geography
│   │       ├── ActionList.jsx, Insights.jsx, ReorderCadence.jsx, …
│   │
│   └── lib/                  pure utilities + the one hook  (React-free
│                              where possible — usable from node scripts)
│       ├── sheets.js              live 3-sheet fetch + normalise
│       ├── vendors.js             vendor canonicalization
│       ├── brands.js, scope.js    private-label filter + AR scope
│       ├── fuzzy.js               token-aware similarity scoring
│       ├── reps.js, regions.js    sales-rep + Michigan region maps
│       ├── cityCoords.js          city → lat/lon for the map
│       ├── format.js, csv.jsx     display + export helpers
│       ├── metrics.js             aging buckets, DSO, etc.
│       ├── navigation.jsx         global modal / customer-profile routing
│       ├── upflow.js              AR ↔ Upflow customer-match bridge
│       └── useSheets.js           the one React hook (lived in hooks/
│                                   before — folded in to flatten the tree)
│
└── cashflow/                 ← Cashflow Dashboard (mounts at /cashflow.html)
    ├── main.tsx              entry  (referenced by /cashflow.html)
    ├── CashflowApp.tsx       auth gate + Dashboard shell
    ├── cashflow.css          scoped to /cashflow.html — no AR conflict
    ├── api.ts                HTTP client for the cashflow Express backend
    ├── format.ts             number / month / signed formatters
    ├── components/           ~38 hub + page components
    │   ├── CashflowHub.tsx, ExpensesHub.tsx, ReportsHub.tsx
    │   ├── SalesArHub.tsx, Commission.tsx, Upflow.tsx
    │   ├── ArAging.tsx, ArStatus.tsx, CashFlow13Week.tsx, …
    │   └── (each page is one component)
    └── data/                 static reference data
        ├── subscriptions.ts, purexExpenses.ts, moyshExpenses.ts
        └── combinedExpenses.ts
```

## Design rules

- **Self-contained apps** — nothing in `cashflow/` imports from `ar/`
  or vice-versa. Either folder can be ripped out without touching the
  other.
- **`shell/` lives under `ar/`** because the AR shell IS the entry
  point for both dashboards — `cfovaani.com/` lands on the chooser
  and routes to whichever app the user picks. Cashflow has no separate
  splash / login of its own.
- **Flat is good** — only `dashboard/pages/` is its own subfolder
  (5+ files, one per top-level page). Everything else lives next to
  its peers. Subfolders with 1–2 files just add noise.
- **`lib/` is React-free pure JS** so it can be reused or unit-tested
  from Node (`scripts/verify-numbers.mjs` imports from here).

## Cross-app interactions

One explicit bridge: `src/ar/lib/upflow.js` calls the Cashflow
backend's `/api/upflow` endpoint so the AR Action List can deep-link
to Upflow customer pages. Same-origin (production) or via Vite proxy
(dev) — no direct module import between the two apps.
