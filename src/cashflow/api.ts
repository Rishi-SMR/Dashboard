// Data layer (placeholder).
//
// All previous client-specific data sources, backend endpoints and business
// logic have been stripped. Every exported function below is a stub that
// returns a minimal, type-valid empty value so the UI components that import
// from this module continue to typecheck and render. Wire these up to a real
// data source as needed.

export type MonthlyPoint = {
 month: string;
 label: string;
 income: number;
 expenses: number;
 net: number;
};

export type DashboardData = {
 netCashThisMonthLabel?: string;
 netCashLastMonthLabel?: string;
 asOf: string;
 currentCash: number;
 netCashThisMonth: number;
 netCashLastMonth: number;
 monthOverMonthChange: number;
 avgMonthlyBurn: number;
 runwayMonths: number | null;
 monthly: MonthlyPoint[];
 // Per-line KPI composition (optional).
 cashBreakdown?: { label: string; value: number }[];
 burnBreakdown?: { label: string; value: number }[];
};

export type Status = { connected: boolean; realmId: string | null; credsConfigured: boolean };

export async function fetchStatus(): Promise<Status> {
 return { connected: false, realmId: null, credsConfigured: false };
}

export async function fetchDashboard(): Promise<DashboardData> {
 return {
  asOf: '',
  currentCash: 0,
  netCashThisMonth: 0,
  netCashLastMonth: 0,
  monthOverMonthChange: 0,
  avgMonthlyBurn: 0,
  runwayMonths: null,
  monthly: [],
 };
}

export async function disconnect(): Promise<void> {
 return;
}

export type MatchType = 'strong' | 'fuzzy' | 'line' | 'none';

export type SubPattern = 'FIXED' | 'PERIODIC' | 'VARIABLE';

export type AuditRow = {
 expected: {
  name: string;
  monthly: number;
  billDay: number;
  pattern: SubPattern;
  notes?: string;
 };
 matchType: MatchType;
 bestMatchName: string | null;
 bestMatchScore: number;
 alternates: Array<{ name: string; score: number }>;
 activity: {
  txnCount: number;
  totalAmount: number;
  avgAmount: number;
  lastDate: string;
 } | null;
 lineHits: Array<{ date: string; amount: number; description: string }>;
 monthlyAmounts: number[];
 derivedMonthly: number;
 derivedBillDay: number;
 derivedPattern: SubPattern;
 hasQbData: boolean;
 usedMonthly: number;
 usedBillDay: number;
 usedPattern: SubPattern;
 usedSource: 'qb' | 'expected' | 'expected_outlier';
 outlierReason?: string;
 sampleDates: string[];
};

export type UnexpectedVendor = {
 displayName: string;
 txnCount: number;
 totalAmount: number;
 avgAmount: number;
 lastDate: string;
};

export type SubscriptionAudit = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number };
 counts: { strong: number; fuzzy: number; line: number; missing: number };
 months: string[];
 monthLabels: string[];
 rows: AuditRow[];
 unexpectedVendors: UnexpectedVendor[];
};

// --- Transactions ---
export type TillerEntity = string;
export type TillerTxn = {
 date: string;
 amount: number;
 payee: string;
 category: string;
 txnId: string;
 account: string;
 status: string;
 entity: TillerEntity;
};
export type TxnsByAccountMonth = {
 account: string;
 entity: TillerEntity;
 inQb: boolean;
 monthlyOutflow: Record<string, number>;
 monthlyInflow: Record<string, number>;
 txnCount: number;
};
export type TillerTransactionsResult = {
 fetchedAt: string;
 rowCount: number;
 accounts: TxnsByAccountMonth[];
 months: string[];
 transactions: TillerTxn[];
};
export async function fetchTillerTransactions(_opts: { refresh?: boolean } = {}): Promise<TillerTransactionsResult> {
 return { fetchedAt: '', rowCount: 0, accounts: [], months: [], transactions: [] };
}

// --- Reconciliation ---
export type ReconciledRow = {
 date: string;
 amount: number;
 sourceBank: string;
 sourceKind?: 'bank' | 'cc' | 'other';
 payee: string;
 qbCategory?: string;
 qbTxnId?: string;
 tillerTxnId?: string;
 daysDiff?: number;
 qbCategoryGroup?: 'journal' | 'capex' | 'bill-payment' | 'real-expense';
};
export type CategoryAttribution = {
 category: string;
 bankPaid: number;
 ccPaid: number;
 total: number;
 txnCount: number;
 monthly: Record<string, { bank: number; cc: number; total: number }>;
};
export type ReconciliationResult = {
 asOf: string;
 windowStart: string;
 matchDays: number;
 counts: { matched: number; bankOnly: number; transfers: number; qbOnly: number; tillerTotal: number; tillerDuplicatesDropped: number; qbTotal: number };
 totals: { matched: number; bankOnly: number; transfers: number; qbOnly: number };
 matched: ReconciledRow[];
 bankOnly: ReconciledRow[];
 transfers: ReconciledRow[];
 qbOnly: ReconciledRow[];
 categoryAttribution: CategoryAttribution[];
 attributionMonths: string[];
 warnings: string[];
};
export async function fetchReconciliation(_opts: { refresh?: boolean } = {}): Promise<ReconciliationResult> {
 return {
  asOf: '', windowStart: '', matchDays: 0,
  counts: { matched: 0, bankOnly: 0, transfers: 0, qbOnly: 0, tillerTotal: 0, tillerDuplicatesDropped: 0, qbTotal: 0 },
  totals: { matched: 0, bankOnly: 0, transfers: 0, qbOnly: 0 },
  matched: [], bankOnly: [], transfers: [], qbOnly: [],
  categoryAttribution: [], attributionMonths: [], warnings: [],
 };
}

// --- Sales by Product ---
export type ProductCustomerBreakdown = {
 customer: string;
 customerAu: string;
 customerName: string;
 qty: number;
 revenue: number;
 invoiceCount: number;
};
export type ProductMonthlyPoint = { ym: string; qty: number; revenue: number };
export type ProductRow = {
 product: string;
 itemCategory: string;
 totalQty: number;
 totalRevenue: number;
 invoiceCount: number;
 avgUnitPrice: number;
 firstSold: string;
 lastSold: string;
 uniqueCustomers: number;
 topCustomer: { name: string; au: string; share: number } | null;
 customers: ProductCustomerBreakdown[];
 monthly: ProductMonthlyPoint[];
};
export type SalesByProductResult = {
 asOf: string;
 windowStart: string;
 windowEnd: string;
 status: {
  inWindowWithLink: number;
  scraped: number;
  missingLinks: number;
  failed: number;
  failures: Array<{ token: string; error: string; lastTriedAt: string }>;
 };
 cogsMapping: {
  mappedLines: number;
  unmappedLines: number;
  unmappedLabels: string[];
 };
 totals: {
  invoiceCount: number;
  lineItemCount: number;
  totalRevenue: number;
  uniqueProducts: number;
  uniqueCustomers: number;
 };
 products: ProductRow[];
 warnings: string[];
};
export async function fetchSalesByProduct(_opts: { refresh?: boolean } = {}): Promise<SalesByProductResult> {
 return {
  asOf: '', windowStart: '', windowEnd: '',
  status: { inWindowWithLink: 0, scraped: 0, missingLinks: 0, failed: 0, failures: [] },
  cogsMapping: { mappedLines: 0, unmappedLines: 0, unmappedLabels: [] },
  totals: { invoiceCount: 0, lineItemCount: 0, totalRevenue: 0, uniqueProducts: 0, uniqueCustomers: 0 },
  products: [], warnings: [],
 };
}

export async function fetchSubscriptionAudit(_opts: { months?: number; refresh?: boolean } = {}): Promise<SubscriptionAudit> {
 return {
  cached: false, asOf: '', realmId: '', lookbackMonths: 0, since: '',
  totals: { vendors: 0, purchases: 0, bills: 0 },
  counts: { strong: 0, fuzzy: 0, line: 0, missing: 0 },
  months: [], monthLabels: [], rows: [], unexpectedVendors: [],
 };
}

export type LivePaidBy = string;
export type LiveExpenseRow = {
 category: string;
 group: 'Payroll' | 'Non-Payroll';
 accountType: string;
 paidBy: LivePaidBy;
 monthly: number[];
 perEntity: { PureX: number[]; Moysh: number[]; Other: number[] };
 total: number;
};
export type LiveExpenseDetail = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 months: string[];
 monthLabels: string[];
 rows: LiveExpenseRow[];
 totals: {
  txnsScanned: number;
  accountsScanned: number;
  paidByDetected: { PureX: number; Moysh: number; Other: number };
 };
 paymentSources: Array<{ name: string; accountType: string }>;
 classes: string[];
};

export type DetectedSub = {
 source: 'vendor' | 'line';
 vendor: string;
 monthly: number;
 billDay: number;
 weekOfMonth: 1 | 2 | 3 | 4 | 5;
 pattern: 'FIXED' | 'VARIABLE' | 'PERIODIC';
 txnCount: number;
 monthsObserved: number;
 lastSeen: string;
 firstSeen: string;
 amountStability: number;
 avgGapDays: number;
 notes: string;
 history: Array<{ date: string; amount: number; description?: string }>;
};

export type RecurringSubs = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number; mergedBuckets: number };
 subs: DetectedSub[];
};

export async function fetchRecurringSubs(_opts: { months?: number; refresh?: boolean } = {}): Promise<RecurringSubs> {
 return {
  cached: false, asOf: '', realmId: '', lookbackMonths: 0, since: '',
  totals: { vendors: 0, purchases: 0, bills: 0, mergedBuckets: 0 },
  subs: [],
 };
}

export async function fetchExpenseDetail(_opts: { months?: number; refresh?: boolean } = {}): Promise<LiveExpenseDetail> {
 return {
  cached: false, asOf: '', realmId: '', lookbackMonths: 0,
  months: [], monthLabels: [], rows: [],
  totals: { txnsScanned: 0, accountsScanned: 0, paidByDetected: { PureX: 0, Moysh: 0, Other: 0 } },
  paymentSources: [], classes: [],
 };
}

export type CashflowSource = 'live' | 'computed' | 'none';
export type CashflowStatus = 'HEALTHY' | 'TIGHT' | 'CRITICAL';
export type CashflowWeek = { label: string; start: string; end: string };
export type CashflowBreakdownItem = { label: string; amount: number; sub?: string };
export type CashflowLine = { label: string; source: CashflowSource; note?: string; values: number[]; breakdown?: CashflowBreakdownItem[]; displayOnly?: boolean };

export type ActivityTier = 'active' | 'cooling' | 'dormant' | 'churned';
export type SalesForecastBrand = {
 brand: string;
 brandSource: 'sheet' | 'derived' | 'mixed';
 monthsObserved: number;
 invoiceCount: number;
 invoicesPerActiveMonth: number;
 momentum90d: { recent: number; prior: number; deltaPct: number | null };
 paidRatio: number;
 baselineMonthly: number;
 trendSlope: number;
 r2: number;
 bounds: { lower: number; upper: number };
 clamped: boolean;
 daysSinceLastInvoice: number;
 activityTier: ActivityTier;
 recencyWeight: number;
 history: Array<{ ym: string; amount: number }>;
 forecast: Array<{ ym: string; amount: number }>;
 lagCurve: number[];
 lagSource: 'brand' | 'global';
 weeklyInflow: number[];
 totalProjectedCash: number;
 lastInvoiceDate: string;
 // Depth-analysis fields (cadence-driven model)
 cadenceDays: number;
 avgInvoiceAmount: number;
 nextExpectedDate: string;
 growthMultiplier: number;
 seasonalIndices: number[];
 hasSeasonality: boolean;
 projectedInvoices: Array<{ date: string; amount: number; ym: string; monthOfYear: number }>;
 recentInvoices: Array<{ date: string; amount: number }>;
 gapDays: number[];
};
export type SalesForecastWeek = { index: number; start: string; end: string; label: string };
export type SalesForecastTier = { name: ActivityTier; maxDays: number; weight: number };
export type YearlyHistoryPoint = {
 year: string;
 total: number;
 invoiceCount: number;
 isPartial: boolean;
 monthsObserved: number;
};
export type MonthlyHistoryPoint = { ym: string; total: number; invoiceCount: number };
export type SeasonalityPoint = { monthOfYear: number; index: number; basisYear: string };
export type ForecastMonthRow = {
 ym: string;
 forecastedSales: number;
 method: 'prior-year-x-yoy' | 'baseline-x-seasonal' | 'recent-3m-mean';
 priorYearValue: number | null;
 yoyMultiplier: number | null;
 seasonalIndex: number | null;
 clamped: 'low' | 'high' | null;
};
export type WeeklySeriesPoint = {
 weekStart: string;
 weekOfYear: number;
 total: number;
 invoiceCount: number;
 isForecast: boolean;
};
export type WeeklyAnalysis = {
 history: WeeklySeriesPoint[];
 trend: { slope: number; intercept: number; r2: number; basisWeeks: number };
 weekOfYearSeasonality: Array<{ weekOfYear: number; index: number; samples: number }>;
 forecast: WeeklySeriesPoint[];
};
export type SalesForecastResult = {
 asOf: string;
 driver: { lookbackMonths: number; forecastHorizonMonths: number; maxLagMonths: number; tiers: SalesForecastTier[] };
 // v2 multi-level total forecast
 yearlyHistory: YearlyHistoryPoint[];
 monthlyHistory: MonthlyHistoryPoint[];
 seasonality: SeasonalityPoint[];
 yoy: {
  rate: number;
  rawRate: number;
  currYearLabel: string;
  prevYearLabel: string;
  monthsCompared: number;
  currYTD: number;
  prevYTD: number;
 };
 yoyChain: Array<{
  fromYear: string;
  toYear: string;
  fromValue: number;
  toValue: number;
  monthsCompared: number;
  aligned: boolean;
  rate: number;
 }>;
 weeklyAnalysis: WeeklyAnalysis;
 monthlyForecastV2: ForecastMonthRow[];
 monthlyForecastBest: ForecastMonthRow[];
 monthlyForecastWorst: ForecastMonthRow[];
 weeklyInflowV2: number[];
 weeklyInflowBest: number[];
 weeklyInflowWorst: number[];
 totalForecastedInvoiceV2: number;
 totalProjectedCashV2: number;
 scenarioTotals: {
   base: { invoiced: number; cash: number };
   best: { invoiced: number; cash: number };
   worst: { invoiced: number; cash: number };
 };
 approvedAssumptions: {
   deseasonalizedBase: number;
   bestMultiplier: number;
   worstMultiplier: number;
   growthTrend: number;
   excisetaxNote: string;
   calibration: {
     windowMonths: number;
     contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
     deseasonalizedBase: number;
   };
 };
 // v1 per-brand details (drilldown)
 lookbackWindow: string[];
 horizonMonths: string[];
 weeks: SalesForecastWeek[];
 globalLagCurve: number[];
 brands: SalesForecastBrand[];
 churnedBrands: Array<{ brand: string; lastInvoiceDate: string; daysSinceLastInvoice: number }>;
 weeklyInflow: number[];
 monthlyForecast: Array<{ ym: string; amount: number }>;
 totalForecastedSales: number;
 totalProjectedCash: number;
 /** Share of sales $ collected the same week invoiced. */
 sameWeekRate: number;
 // 3-bucket projection (each bucket runs the same model on its own slice)
 buckets: {
  wholesale: BucketForecast;
  privateLabel: BucketForecast;
  gelato: BucketForecast;
 };
 warnings: string[];
};

export type SalesBucket = string;

export type BucketForecast = {
 bucket: SalesBucket;
 label: string;
 customerCount: number;
 yearlyHistory: YearlyHistoryPoint[];
 monthlyHistory: MonthlyHistoryPoint[];
 seasonality: SeasonalityPoint[];
 yoy: SalesForecastResult['yoy'];
 yoyChain: SalesForecastResult['yoyChain'];
 weeklyAnalysis: WeeklyAnalysis;
 monthlyForecast: ForecastMonthRow[];
 monthlyForecastBest: ForecastMonthRow[];
 monthlyForecastWorst: ForecastMonthRow[];
 weeklyInflow: number[];
 weeklyInflowBest: number[];
 weeklyInflowWorst: number[];
 weeklyGross: number[];
 scenarioTotals: {
  base: { invoiced: number; cash: number };
  best: { invoiced: number; cash: number };
  worst: { invoiced: number; cash: number };
 };
 deseasonalizedBase: number;
 baseCalibration: {
  windowMonths: number;
  contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
  deseasonalizedBase: number;
 };
};

export type CurrentMonthOverview = {
 month: { ym: string; label: string; start: string; end: string; daysInMonth: number; dayOfMonth: number; progressPct: number };
 sales: {
  projected: { base: number; best: number; worst: number };
  invoicedMtd: { gelato: number; nonGelato: number; total: number; invoiceCount: number };
 };
 ar: {
  gelato:    { projected: number; collected: number; invoiceCount: number };
  nonGelato: { projected: number; collected: number; invoiceCount: number };
 };
 openArAsOfToday: { amount: number; invoiceCount: number };
};

export type SalesWeekInvoice = {
 invoiceNumber: string;
 date: string;
 customer: string;
 amount: number;
 paid: number;
 paidDate: string;
 channel: string;
};
export type SalesWeekInvoicesResponse = {
 weekStart: string;
 weekEnd: string;
 invoiceCount: number;
 total: number;
 invoices: SalesWeekInvoice[];
};

/**
 * Placeholder for a global cache invalidation. No backend to clear.
 */
export async function invalidateAllCaches(): Promise<{ ok: boolean; cachesCleared: number }> {
 return { ok: true, cachesCleared: 0 };
}

export async function fetchSalesWeekInvoices(_weekStart: string, _bucket: SalesBucket = 'wholesale'): Promise<SalesWeekInvoicesResponse> {
 return { weekStart: '', weekEnd: '', invoiceCount: 0, total: 0, invoices: [] };
}

export async function fetchCurrentMonthOverview(): Promise<CurrentMonthOverview> {
 return {
  month: { ym: '', label: '', start: '', end: '', daysInMonth: 0, dayOfMonth: 0, progressPct: 0 },
  sales: {
   projected: { base: 0, best: 0, worst: 0 },
   invoicedMtd: { gelato: 0, nonGelato: 0, total: 0, invoiceCount: 0 },
  },
  ar: {
   gelato: { projected: 0, collected: 0, invoiceCount: 0 },
   nonGelato: { projected: 0, collected: 0, invoiceCount: 0 },
  },
  openArAsOfToday: { amount: 0, invoiceCount: 0 },
 };
}

export async function fetchSalesForecast(): Promise<SalesForecastResult> {
 return emptySalesForecastResult();
}

export type Cashflow13 = {
 cached: boolean;
 asOf: string;
 anchor: string;
 weeks: CashflowWeek[];
 openingCashWk1: number;
 openingCashSource: CashflowSource;
 bankCashWk1?: number;
 openingCashNote?: string;
 openingCashBreakdown?: CashflowBreakdownItem[];
 inflows: CashflowLine[];
 outflows: CashflowLine[];
 salesForecast: SalesForecastResult | null;
 totals: {
 inflows: number[];
 outflows: number[];
 netChange: number[];
 openingCash: number[];
 closingCash: number[];
 status: CashflowStatus[];
 };
 assumptions: {
 ccPayoffWk1: number;
 payrollPerWeek: number;
 inventoryPerWeek: number;
 otherPerWeek: number;
 };
 warnings: string[];
};

// --- Weekly forecast snapshots (Past Weeks variance view) ---
export type SnapshotLineItem = { label: string; wk1Value: number; total13w: number };
export type WeeklySnapshot = {
 monday: string;
 capturedAt: string;
 openingCash: number;
 inflows: SnapshotLineItem[];
 outflows: SnapshotLineItem[];
 totalInflowWk1: number;
 totalOutflowWk1: number;
 netChangeWk1: number;
 closingCashWk1: number;
 arProjection13wTotal: number;
 salesForecastWk1: number;
 salesForecast13wTotal: number;
};
export type InvoiceDetail = {
 invoiceNumber: string;
 customer: string;
 channel: string;
 invoiceDate: string;
 paidDate: string;
 amount: number;
 paid: number;
};
export type ForecastInvoiceRow = InvoiceDetail & {
 openAtWeekStart: number;
 projectedAmountThisWeek: number;
 status: 'paid' | 'partial' | 'unpaid';
 paidThisWeek: boolean;
};
export type WeekActuals = {
 weekStart: string;
 weekEnd: string;
 inflow: number;
 outflow: number;
 netChange: number;
 byCategory: Array<{ category: string; inflow: number; outflow: number }>;
 txnCount: number;
 arActuals: {
 gelato: { amount: number; invoiceCount: number };
 // sameWeek = invoiced & paid same week; lagged = paid now but invoiced earlier.
 nonGelato: { amount: number; invoiceCount: number; sameWeek?: number; lagged?: number };
 total: number;
 };
 salesInvoiced: {
 gelato: { amount: number; invoiceCount: number };
 nonGelato: { amount: number; invoiceCount: number };
 total: number;
 };
 arOpenAtEnd: { amount: number; invoiceCount: number };
 paidInvoices: InvoiceDetail[];
 invoicedInvoices: InvoiceDetail[];
 forecastBasisInvoices: ForecastInvoiceRow[];
};
export type WeeklySnapshotItem = {
 snapshot: WeeklySnapshot;
 actuals: WeekActuals | null;
 /** True only when Sunday of the snapshot's Wk1 has already passed. */
 weekClosed?: boolean;
};
export type WeeklySnapshotsResponse = { count: number; items: WeeklySnapshotItem[] };
export type WeeklySnapshotsResult = WeeklySnapshotsResponse;

/** Actual expenses for a week, bucketed into the budget outflow lines. */
export type WeekExpenseLines = {
 weekStart: string;
 weekEnd: string;
 byLine: {
  'Payroll': number;
  'Inventory & Raw Materials': number;
  'Software & Subscriptions': number;
  'Other Expenses': number;
 };
 total: number;
};
/** Expected AR collections for a week (by invoice terms). */
export type ExpectedInflowWeek = { gelato: number; other: number; total: number };

export type PastWeeksGridItem = {
 monday: string;
 weekEnd: string;
 weekClosed: boolean;
 snapshot: WeeklySnapshot | null;
 actuals: WeekActuals | null;
 /** Actual expenses for the week, per budget line. */
 qbExpenses: WeekExpenseLines | null;
 /** Expected AR collections for the week. */
 expectedInflow: ExpectedInflowWeek | null;
};
export type PastWeeksGridResponse = { count: number; items: PastWeeksGridItem[] };
export async function fetchPastWeeksGrid(_weeks = 13): Promise<PastWeeksGridResponse> {
 return { count: 0, items: [] };
}

export async function fetchWeeklySnapshots(): Promise<WeeklySnapshotsResponse> {
 return { count: 0, items: [] };
}

export type CpAccountLine = { name: string; balance: number; notes?: string; source: 'qb' | 'sheet' };
export type CpCreditCardLine = CpAccountLine & { minPayment: number; isPersonal: boolean };
export type CpInvoice = {
 customer: string;
 description: string;
 invoiceNumber?: string;
 issueDate: string;
 amount: number;
 dueDate?: string;
 daysOpen: number;
 bucket: '0-14' | '15-30' | '31-60' | '61-90' | '90+';
};
export type CurrentPosition = {
 cached: boolean;
 asOf: string;
 realmId: string | null;
 cash: { accounts: CpAccountLine[]; total: number; totalSource: 'qb' | 'sheet' };
 creditCards: {
 business: CpCreditCardLine[];
 personal: CpCreditCardLine[];
 businessTotal: number;
 businessMinTotal: number;
 source: 'qb' | 'sheet';
 };
 intercompany: {
 clearingBalance: number;
 clearingSource: 'qb' | 'sheet';
 expectedRemittanceWk1: number;
 accounts: CpAccountLine[];
 notes: string;
 };
 receivables: {
 external: CpInvoice[];
 intercompany: CpInvoice[];
 grossExternal: number;
 grossIntercompany: number;
 bufferPct: number;
 netCollectibleAr: number;
 arSource: 'qb' | 'sheet';
 };
 netLiquidity: {
 totalCash: number;
 creditCardDebt: number;
 purexClearing: number;
 netCollectibleAr: number;
 netWorkingCapital: number;
 };
 warnings: string[];
};

// --- Live account balances ---
export type TillerAccount = {
 accountId: string;
 name: string;
 type: string;
 balance: number;
 balanceAvailable: number | null;
 balanceLimit: number | null;
 usePct: number | null;
 currency: string;
 lastUpdated: string;
};
export type TillerBalances = {
 cached: boolean;
 fetchedAt: string;
 latestDate: string;
 sheetUrl: string;
 cashAccounts: TillerAccount[];
 creditCards: TillerAccount[];
 loans: TillerAccount[];
 investments: TillerAccount[];
 other: TillerAccount[];
 staleAccounts: TillerAccount[];
 totals: { cash: number; creditCardDebt: number; loans: number; investments: number };
};

export async function fetchTillerBalances(_opts: { refresh?: boolean } = {}): Promise<TillerBalances> {
 return {
  cached: false, fetchedAt: '', latestDate: '', sheetUrl: '',
  cashAccounts: [], creditCards: [], loans: [], investments: [], other: [], staleAccounts: [],
  totals: { cash: 0, creditCardDebt: 0, loans: 0, investments: 0 },
 };
}

// --- Side-by-side balances ---
export type QbLine = { name: string; accountType: string; subType: string | null; masks: string[]; balance: number };
export type TillerLine = {
 name: string;
 type: string;
 masks: string[];
 balance: number;
 lastUpdated: string;
 balanceAvailable: number | null;
 balanceLimit: number | null;
 usePct: number | null;
 lastStatementClose: string | null;
 lastStatementPayment: string | null;
 lastStatementStatus: string | null;
 nextPayment: string | null;
 nextClosing: string | null;
 freezeWindow: string | null;
 scheduleNotes: string | null;
};
export type LinkedBalances = {
 cached: boolean;
 fetchedAt: string;
 tillerLatestDate: string;
 sheetUrl: string;
 realmId: string | null;
 qb: {
 cashAccounts: QbLine[];
 creditCards: QbLine[];
 cashTotal: number;
 creditTotal: number;
 intercompanyExcluded: QbLine[];
 };
 tiller: {
 cashAccounts: TillerLine[];
 creditCards: TillerLine[];
 loans: TillerLine[];
 investments: TillerLine[];
 cashTotal: number;
 creditTotal: number;
 };
 warnings: string[];
};

// --- Expense detail from source (Expenses tab) ---
export type SheetExpenseCategory = string;
export type SheetCategoryMonthly = {
 months: string[];
 monthLabels: string[];
 monthlyTotals: number[];
 total: number;
 weeklyAvgL3M: number;
 entryCount: number;
};
export type SheetExpenseEntry = {
 date: string;
 description: string;
 amount: number;
 category: string;
 group: 'Payroll' | 'Non-Payroll' | 'Settlement';
};
export type SheetExpensesResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 months: string[];
 monthLabels: string[];
 byCategory: Record<string, SheetCategoryMonthly>;
 payroll: SheetCategoryMonthly;
 inventory: SheetCategoryMonthly;
 other: SheetCategoryMonthly;
 settlement: SheetCategoryMonthly;
 totalOpex: SheetCategoryMonthly;
 entries: SheetExpenseEntry[];
 categoryOrder: string[];
 groupOf: Record<string, 'Payroll' | 'Non-Payroll' | 'Settlement'>;
 warnings: string[];
};

export async function fetchSheetExpenses(_opts: { refresh?: boolean } = {}): Promise<SheetExpensesResult> {
 return {
  cached: false, fetchedAt: '', sheetUrl: '', months: [], monthLabels: [],
  byCategory: {},
  payroll: emptySheetCategoryMonthly(),
  inventory: emptySheetCategoryMonthly(),
  other: emptySheetCategoryMonthly(),
  settlement: emptySheetCategoryMonthly(),
  totalOpex: emptySheetCategoryMonthly(),
  entries: [], categoryOrder: [], groupOf: {}, warnings: [],
 };
}

// --- Mapped expenses (categories with live values) ---
export type SheetEntity = string;
export type MappedExpenseRow = {
 group: 'Payroll' | 'Non-Payroll';
 category: string;
 values: number[];
 /** Per-month PureX-paid portion. */
 purexValues?: number[];
 /** Per-month Moysh-paid portion. */
 moyshValues?: number[];
 qbSources: Array<{ name: string; total: number }>;
};
export type MappedExpensesResult = {
 cached: boolean;
 asOf: string;
 entity: SheetEntity;
 months: string[];
 monthLabels: string[];
 rows: MappedExpenseRow[];
 unmatched: Array<{ category: string; group: string; total: number }>;
};

// --- Raw P&L Report ---
export type QbPlRow = {
 depth: number;
 name: string;
 monthly: number[];
 total: number;
 kind: 'section' | 'summary' | 'detail' | 'header';
 hasChildren: boolean;
};
export type QbPlReport = {
 asOf: string;
 realmId: string;
 startDate: string;
 endDate: string;
 months: string[];
 monthLabels: string[];
 rows: QbPlRow[];
 cached?: boolean;
};

export async function fetchQbPlReport(_opts: { refresh?: boolean; method?: 'Accrual' | 'Cash' } = {}): Promise<QbPlReport & { accountingMethod?: 'Accrual' | 'Cash' }> {
 return { asOf: '', realmId: '', startDate: '', endDate: '', months: [], monthLabels: [], rows: [] };
}

// Balance Sheet
export type QbBsTotals = {
 totalAssets: number; totalLiabilities: number; totalEquity: number;
 inventory: number; accountsReceivable: number; accountsPayable: number; cashAndBank: number;
};
export type QbBalanceSheetReport = {
 asOf: string; reportAsOf: string; realmId: string;
 accountingMethod: 'Accrual' | 'Cash';
 months: string[];
 monthLabels: string[];
 totals: QbBsTotals;
 rows: Array<{
 depth: number;
 name: string;
 monthly: number[];
 amount: number;
 kind: string;
 hasChildren: boolean;
 accountName: string;
 }>;
 cached?: boolean;
};
export async function fetchQbBalanceSheet(_opts: { refresh?: boolean; method?: 'Accrual' | 'Cash' } = {}): Promise<QbBalanceSheetReport> {
 return {
  asOf: '', reportAsOf: '', realmId: '', accountingMethod: 'Cash',
  months: [], monthLabels: [],
  totals: { totalAssets: 0, totalLiabilities: 0, totalEquity: 0, inventory: 0, accountsReceivable: 0, accountsPayable: 0, cashAndBank: 0 },
  rows: [],
 };
}

// Per-account transaction drill-down
export type AccountTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 sourceBank: string;
 paidBy: string;
};
export type AccountTransactionsResult = {
 account: string;
 asOf: string;
 total: number;
 purexTotal: number;
 moyshTotal: number;
 unpaidTotal: number;
 transactions: AccountTxn[];
 cached?: boolean;
};

// Inventory purchases
export type InventoryTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 inventoryAccount: string;
 splitAccount: string;
 sourceBank: string;
 paidBy: string;
};
export type InventoryPurchasesResult = {
 asOf: string;
 months: string[];
 monthLabels: string[];
 total: number;
 purexTotal: number;
 moyshTotal: number;
 /** Deprecated - kept optional so the UI doesn't break during rollout. */
 unpaidTotal?: number;
 monthlyByPaidBy: Record<string, { purex: number; moysh: number; unpaid?: number }>;
 monthlyTotal: number[];
 monthlyPurex: number[];
 monthlyMoysh: number[];
 byAccount: Array<{ name: string; total: number; purex: number; moysh: number }>;
 byVendor: Array<{ vendor: string; total: number; purex: number; moysh: number; count: number }>;
 transactions: InventoryTxn[];
 cached?: boolean;
};
export async function fetchInventoryPurchases(_opts: { refresh?: boolean } = {}): Promise<InventoryPurchasesResult> {
 return {
  asOf: '', months: [], monthLabels: [], total: 0, purexTotal: 0, moyshTotal: 0,
  monthlyByPaidBy: {}, monthlyTotal: [], monthlyPurex: [], monthlyMoysh: [],
  byAccount: [], byVendor: [], transactions: [],
 };
}

export async function fetchAccountTransactions(account: string, _opts: { refresh?: boolean } = {}): Promise<AccountTransactionsResult> {
 return { account, asOf: '', total: 0, purexTotal: 0, moyshTotal: 0, unpaidTotal: 0, transactions: [] };
}

export async function fetchMappedExpenses(entity: SheetEntity, _opts: { months?: number; refresh?: boolean } = {}): Promise<MappedExpensesResult> {
 return { cached: false, asOf: '', entity, months: [], monthLabels: [], rows: [], unmatched: [] };
}

// --- Category overrides ---
export type CategoryOverride = {
 paidBy?: string;
 lineItem?: string;
};
export type AllCategoryOverrides = Record<string, CategoryOverride>;

export async function fetchCategoryOverrides(): Promise<AllCategoryOverrides> {
 return {};
}

// Tell every open page that a mapping changed, so they reload immediately.
function notifyOverridesChanged() {
 try { window.dispatchEvent(new Event('category-overrides-changed')); } catch { /* SSR */ }
}

export async function setCategoryOverride(_account: string, _override: CategoryOverride): Promise<AllCategoryOverrides> {
 notifyOverridesChanged();
 return {};
}

export async function clearCategoryOverride(_account: string): Promise<AllCategoryOverrides> {
 notifyOverridesChanged();
 return {};
}

export async function clearAllCategoryOverrides(): Promise<AllCategoryOverrides> {
 notifyOverridesChanged();
 return {};
}

// --- Inflow Schedule ---
export type InflowWeek = { label: string; start: string; end: string };
export type InflowRow = {
 source: string;
 category: string;
 gross: number;
 values: number[];
 note?: string;
};
export type InflowScheduleResult = {
 cached: boolean;
 fetchedAt: string;
 anchor: string;
 weeks: InflowWeek[];
 rows: InflowRow[];
 weeklyTotals: number[];
 grandTotal: number;
 warnings: string[];
};

export async function fetchInflowSchedule(_opts: { refresh?: boolean } = {}): Promise<InflowScheduleResult> {
 return { cached: false, fetchedAt: '', anchor: '', weeks: [], rows: [], weeklyTotals: [], grandTotal: 0, warnings: [] };
}

// --- Monthly OpEx ---
export type MonthlyOpexRow = {
 monthKey: string;
 monthLabel: string;
 ltDirect: number;
 purex: number;
 total: number;
 ltPct: number;
 purexPct: number;
 remitted: number;
};
export type MonthlyOpexResult = {
 cached: boolean;
 fetchedAt: string;
 rows: MonthlyOpexRow[];
 totals: { ltDirect: number; purex: number; total: number; ltPct: number; purexPct: number; remitted: number };
 averages: { ltDirect: number; purex: number; total: number; remitted: number };
 findings: string[];
 warnings: string[];
};

export async function fetchMonthlyOpex(_opts: { refresh?: boolean } = {}): Promise<MonthlyOpexResult> {
 return {
  cached: false, fetchedAt: '', rows: [],
  totals: { ltDirect: 0, purex: 0, total: 0, ltPct: 0, purexPct: 0, remitted: 0 },
  averages: { ltDirect: 0, purex: 0, total: 0, remitted: 0 },
  findings: [], warnings: [],
 };
}

// --- AR Aging ---
export type ArBucket = '0-14' | '15-30' | '31-60' | '61-90' | '90+';
export type ArAgingInvoice = {
 invoiceNumber: string;
 customer: string;
 channel: string;
 description: string;
 issueDate: string;
 amount: number;
 daysOut: number;
 bucket: ArBucket;
 status: 'Open' | 'Overdue';
 collectPct: number;
 expectedCollectionAmount: number;
 predWeek: number;
 notes: string;
};
export type ChannelSummary = {
 channel: string;
 invoiceCount: number;
 gross: number;
 share: number;
 email: string;
};

export async function setBrandEmail(_brand: string, _email: string): Promise<Record<string, string>> {
 return {};
}
export type DsoStat = {
 weightedDays: number;
 totalAmount: number;
 invoiceCount: number;
 dso: number;
};
export type CustomerConcentration = {
 totalAr: number;
 customerCount: number;
 topBrand: { name: string; ar: number; share: number } | null;
 top3Share: number;
 top5Share: number;
 top10Share: number;
 hhi: number;
 hhiTier: 'Low' | 'Moderate' | 'High';
 paretoCount: number;
 topBrands: Array<{ brand: string; ar: number; share: number; cumulativeShare: number }>;
};
export type ArAgingGroup = {
 label: string;
 netTermsDays: number;
 invoices: ArAgingInvoice[];
 totals: { grossAr: number; expectedCollectible: number; invoiceCount: number };
 bucketSummary: Record<ArBucket, number>;
 channelSummary: ChannelSummary[];
 customerConcentration: CustomerConcentration | null;
 dsoPaid: DsoStat;
 dsoOpen: DsoStat;
 dsoCombined: DsoStat;
 dso: number;
};
export type ArAgingResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 asOfDate: string;
 gelato: ArAgingGroup;
 nonGelato: ArAgingGroup;
 combined: {
 grossAr: number;
 expectedCollectible: number;
 invoiceCount: number;
 dso: number;
 dsoPaid: DsoStat;
 dsoOpen: DsoStat;
 dsoCombined: DsoStat;
 };
 warnings: string[];
};

export async function fetchArAging(_opts: { refresh?: boolean } = {}): Promise<ArAgingResult> {
 return {
  cached: false, fetchedAt: '', sheetUrl: '', asOfDate: '',
  gelato: emptyArAgingGroup(''),
  nonGelato: emptyArAgingGroup(''),
  combined: {
   grossAr: 0, expectedCollectible: 0, invoiceCount: 0, dso: 0,
   dsoPaid: emptyDso(), dsoOpen: emptyDso(), dsoCombined: emptyDso(),
  },
  warnings: [],
 };
}

// --- Settlement History ---
export type Settlement = {
 date: string;
 description: string;
 amount: number;
 daysSincePrior: number;
 cumulative: number;
};
export type SettlementHistoryResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 settlements: Settlement[];
 stats: {
 count: number;
 totalAmount: number;
 avg: number;
 median: number;
 smallest: number;
 largest: number;
 avgDaysBetween: number;
 maxGapDays: number;
 };
 derived: {
 avgMonthlySettlement: number;
 monthsCounted: number;
 requiredMonthlyOpex: number;
 cashGapPerMonth: number;
 cashGapOver13Weeks: number;
 annualizedCashDrag: number;
 };
 warnings: string[];
};

export async function fetchSettlementHistory(_opts: { refresh?: boolean } = {}): Promise<SettlementHistoryResult> {
 return {
  cached: false, fetchedAt: '', sheetUrl: '', settlements: [],
  stats: { count: 0, totalAmount: 0, avg: 0, median: 0, smallest: 0, largest: 0, avgDaysBetween: 0, maxGapDays: 0 },
  derived: { avgMonthlySettlement: 0, monthsCounted: 0, requiredMonthlyOpex: 0, cashGapPerMonth: 0, cashGapOver13Weeks: 0, annualizedCashDrag: 0 },
  warnings: [],
 };
}

// --- Intercompany clearing ---
export type PurexClearingResult = {
 cached: boolean;
 fetchedAt: string;
 sales: { i2: number; i1: number; net: number };
 expense: { total: number };
 clearing: number;
 sheetUrl: string;
 expenseSheetUrl: string;
 warnings: string[];
};

export async function fetchPurexClearing(_opts: { refresh?: boolean } = {}): Promise<PurexClearingResult> {
 return {
  cached: false, fetchedAt: '',
  sales: { i2: 0, i1: 0, net: 0 },
  expense: { total: 0 },
  clearing: 0, sheetUrl: '', expenseSheetUrl: '', warnings: [],
 };
}

// --- Gelato AR ---
export type GelatoPaymentStatus = string;
export type GelatoInvoice = {
 period: string;
 description: string;
 invoiceNumber: string;
 amount: number;
 status: string;
 comment: string;
 // Cross-referenced from the Invoice Tracker (actual collections).
 receivedAmount?: number;
 paymentStatus?: GelatoPaymentStatus;
 shortfall?: number;
};
export type GelatoArResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 totals: { openCount: number; open: number; paidCount: number; paidAmount: number; receivedOnOpen: number; underpaidCount: number };
 pendingInvoices: GelatoInvoice[];
 paidInvoices: GelatoInvoice[];
};

export async function fetchGelatoAr(_opts: { refresh?: boolean } = {}): Promise<GelatoArResult> {
 return {
  cached: false, fetchedAt: '', sheetUrl: '',
  totals: { openCount: 0, open: 0, paidCount: 0, paidAmount: 0, receivedOnOpen: 0, underpaidCount: 0 },
  pendingInvoices: [], paidInvoices: [],
 };
}

// --- AR (Accounts Receivable) ---
export type ArInvoice = { invoiceNumber: string; date: string; customer: string; amount: number; paid: number; openBalance: number; paidDate: string };
export type ArCustomer = { customer: string; openBalance: number; openInvoices: number; oldestDate: string };
export type ArResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 totals: { invoiced: number; collected: number; open: number; openInvoiceCount: number; uniqueCustomers: number };
 byCustomer: ArCustomer[];
 invoices: ArInvoice[];
};

export async function fetchArOpen(_opts: { refresh?: boolean } = {}): Promise<ArResult> {
 return {
  cached: false, fetchedAt: '', sheetUrl: '',
  totals: { invoiced: 0, collected: 0, open: 0, openInvoiceCount: 0, uniqueCustomers: 0 },
  byCustomer: [], invoices: [],
 };
}

export async function fetchLinkedBalances(_opts: { refresh?: boolean } = {}): Promise<LinkedBalances> {
 return {
  cached: false, fetchedAt: '', tillerLatestDate: '', sheetUrl: '', realmId: null,
  qb: { cashAccounts: [], creditCards: [], cashTotal: 0, creditTotal: 0, intercompanyExcluded: [] },
  tiller: { cashAccounts: [], creditCards: [], loans: [], investments: [], cashTotal: 0, creditTotal: 0 },
  warnings: [],
 };
}

export async function fetchCurrentPosition(_opts: { refresh?: boolean } = {}): Promise<CurrentPosition> {
 return {
  cached: false, asOf: '', realmId: null,
  cash: { accounts: [], total: 0, totalSource: 'qb' },
  creditCards: { business: [], personal: [], businessTotal: 0, businessMinTotal: 0, source: 'qb' },
  intercompany: { clearingBalance: 0, clearingSource: 'qb', expectedRemittanceWk1: 0, accounts: [], notes: '' },
  receivables: { external: [], intercompany: [], grossExternal: 0, grossIntercompany: 0, bufferPct: 0, netCollectibleAr: 0, arSource: 'qb' },
  netLiquidity: { totalCash: 0, creditCardDebt: 0, purexClearing: 0, netCollectibleAr: 0, netWorkingCapital: 0 },
  warnings: [],
 };
}

export type CollectionCurveSegment = { label: string; sampleCount: number; totalPaid: number; medianDays: number; cumPct: number[]; incPct: number[]; beyondPct: number };
export type CollectionCurveResult = { cached?: boolean; fetchedAt: string; weeks: number; segments: CollectionCurveSegment[] };
export async function fetchCollectionCurve(): Promise<CollectionCurveResult> {
 return { fetchedAt: '', weeks: 0, segments: [] };
}

export async function fetchCashflow13(_opts: { refresh?: boolean; direction?: 'future' | 'past' } = {}): Promise<Cashflow13> {
 return {
  cached: false, asOf: '', anchor: '', weeks: [], openingCashWk1: 0, openingCashSource: 'none',
  inflows: [], outflows: [], salesForecast: null,
  totals: { inflows: [], outflows: [], netChange: [], openingCash: [], closingCash: [], status: [] },
  assumptions: { ccPayoffWk1: 0, payrollPerWeek: 0, inventoryPerWeek: 0, otherPerWeek: 0 },
  warnings: [],
 };
}

export type SalesByChannelRow = {
 channel: string;
 group: string;
 monthly: number[];
 normalized: number[];
 total: number;
 totalNormalized: number;
 avgPerMonth: number;
 invoiceCount: number;
};

export type TopCustomer = {
 customer: string;
 channel: string;
 total: number;
 invoiceCount: number;
 monthsActive: number;
 lastInvoiceMonth: string | null;
};

export type CoolingCustomer = {
 customer: string;
 channel: string;
 prior3Total: number;
 prior3MonthsActive: number;
 last3Total: number;
 lastInvoiceMonth: string | null;
};

export type SalesByChannelResult = {
 fetchedAt: string;
 sheetUrl: string;
 months: Array<{ key: string; label: string; taxAffected: boolean }>;
 rows: SalesByChannelRow[];
 subtotals: {
 gelatoRaw: number[];
 gelatoNormalized: number[];
 othersRaw: number[];
 othersNormalized: number[];
 grandTotalNormalized: number[];
 };
 topCustomers: TopCustomer[];
 coolingCustomers: CoolingCustomer[];
};

export type ArStatusResult = {
 fetchedAt: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 collectedYtd: number;
 collectedYtdInvoiceCount: number;
 collectedThisMonth: number;
 collectedThisMonthInvoiceCount: number;
 collectedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 collectedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 ytdFromPriorYearInvoices: number;
 ytdFromPriorYearInvoiceCount: number;
 paidWithMissingDate: number;
 paidWithMissingDateCount: number;
 paidWithMissingDateSamples: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   paidDateRaw: string;
 }>;
 outstandingTotal: number;
 outstandingCount: number;
 outstandingByAge: {
   current: { amount: number; count: number };
   d31_60: { amount: number; count: number };
   d61_90: { amount: number; count: number };
   d91Plus: { amount: number; count: number };
 };
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
 }>;
};

export async function fetchArStatus(): Promise<ArStatusResult> {
 return emptyArStatusResult();
}

export type SalesStatusResult = {
 fetchedAt: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 invoicedYtd: number;
 invoicedYtdCount: number;
 invoicedThisMonth: number;
 invoicedThisMonthCount: number;
 invoicedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 invoicedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 collectedFromYtd: number;
 collectedFromYtdCount: number;
 outstandingFromYtd: number;
 outstandingFromYtdCount: number;
 topCustomersYtd: Array<{
   customer: string;
   invoicedAmount: number;
   paidAmount: number;
   outstandingAmount: number;
   invoiceCount: number;
   lastInvoiceDate: string | null;
 }>;
};

export async function fetchSalesStatus(): Promise<SalesStatusResult> {
 return {
  fetchedAt: '', year: 0, asOfDate: '', currentMonth: { ym: '', label: '' },
  invoicedYtd: 0, invoicedYtdCount: 0, invoicedThisMonth: 0, invoicedThisMonthCount: 0,
  invoicedByMonth: [], invoicedByWeekCurrentMonth: [],
  collectedFromYtd: 0, collectedFromYtdCount: 0, outstandingFromYtd: 0, outstandingFromYtdCount: 0,
  topCustomersYtd: [],
 };
}

export type GelatoArStatusResult = ArStatusResult & {
 sheetUrl: string;
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
   status: string;
 }>;
 writeOffStats: { count: number; amount: number };
};

export async function fetchGelatoArStatus(): Promise<GelatoArStatusResult> {
 return { ...emptyArStatusResult(), sheetUrl: '', topOpenInvoices: [], writeOffStats: { count: 0, amount: 0 } };
}

export type UpflowInvoiceStatus = {
 invoiceNumber: string;
 customer: string;
 invoiceAmount: number;
 outstanding: number;
 issueDate: string;
 dueDate: string;
 status: string;
 daysOverdue: number;
 lastReminderAt: string | null;
 reminderCount: number;
 dunningPlan: string | null;
 paymentLink: string | null;
 customerDirectUrl: string | null;
};
export type UpflowReminderEvent = {
 invoiceNumber: string;
 customer: string;
 sentAt: string;
 channel: string;
 template: string;
 dunningPlan: string | null;
 state: string;
 source: string;
 replyFrom: string | null;
 assignedTo: string[];
};

export type UpflowReply = {
 id: string;
 customer: string;
 customerId: string | null;
 dunningPlanId: string | null;
 invoiceNumber: string;
 replyFrom: string | null;
 receivedAt: string;
 state: string;
 daysSinceReceived: number;
 assignedTo: string[];
 looksLikeNoise: boolean;
 upflowUrl: string | null;
};

export async function assignUpflowDunningPlan(_customerId: string, _dunningPlanId: string | null): Promise<{ ok: boolean; customer: { id: string; dunningPlanId: string | null } }> {
 return { ok: true, customer: { id: '', dunningPlanId: null } };
}
export type UpflowAgingBucket = {
 bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
 invoiceCount: number;
 amount: number;
};
export type UpflowTopCustomer = {
 customerId: string;
 customer: string;
 balance: number;
 openInvoiceCount: number;
 dunningPlan: string | null;
 dunningPlanId: string | null;
 directUrl: string | null;
};
export type UpflowPayment = {
 id: string;
 externalId: string | null;
 amount: number;
 currency: string;
 validatedAt: string;
 createdAt: string;
 instrument: string;
 customer: string;
 linkedInvoiceCount: number;
};
export type UpflowUser = {
 id: string;
 firstName: string;
 lastName: string;
 email: string;
 position: string;
};
export type UpflowDashboardResult = {
 fetchedAt: string;
 connected: boolean;
 lastError: string | null;
 totals: {
   openInvoices: number;
   openAmount: number;
   overdueInvoices: number;
   overdueAmount: number;
   remindersSentToday: number;
   remindersSentLast7d: number;
   remindersSentLast30d: number;
   remindersQueued: number;
   paymentsLast30dCount: number;
   paymentsLast30dAmount: number;
   repliesPending: number;
   repliesHandled: number;
   repliesIgnoredNoise: number;
 };
 invoices: UpflowInvoiceStatus[];
 reminders: UpflowReminderEvent[];
 aging: UpflowAgingBucket[];
 topCustomers: UpflowTopCustomer[];
 allCustomersWithBalance: UpflowTopCustomer[];
 dunningPlans: Array<{ id: string; name: string; mode: string; entity: string; invoicesOnPlan: number; customersOnPlan: number; actionsFired: number }>;
 payments: UpflowPayment[];
 users: UpflowUser[];
 priorityChase: UpflowPriorityRow[];
 replies: UpflowReply[];
};

export type UpflowPriorityRow = {
 invoiceNumber: string;
 customer: string;
 customerDirectUrl: string | null;
 outstanding: number;
 daysOverdue: number;
 dunningPlan: string | null;
 lastReminderAt: string | null;
 daysSinceLastReminder: number | null;
 reasons: string[];
 score: number;
};

export async function fetchUpflowDashboard(_opts: { refresh?: boolean } = {}): Promise<UpflowDashboardResult> {
 return {
  fetchedAt: '', connected: false, lastError: null,
  totals: {
   openInvoices: 0, openAmount: 0, overdueInvoices: 0, overdueAmount: 0,
   remindersSentToday: 0, remindersSentLast7d: 0, remindersSentLast30d: 0, remindersQueued: 0,
   paymentsLast30dCount: 0, paymentsLast30dAmount: 0,
   repliesPending: 0, repliesHandled: 0, repliesIgnoredNoise: 0,
  },
  invoices: [], reminders: [], aging: [], topCustomers: [], allCustomersWithBalance: [],
  dunningPlans: [], payments: [], users: [], priorityChase: [], replies: [],
 };
}

export async function fetchSalesByChannel(_opts: { refresh?: boolean } = {}): Promise<SalesByChannelResult> {
 return {
  fetchedAt: '', sheetUrl: '', months: [], rows: [],
  subtotals: { gelatoRaw: [], gelatoNormalized: [], othersRaw: [], othersNormalized: [], grandTotalNormalized: [] },
  topCustomers: [], coolingCustomers: [],
 };
}

export type SalesByRepsYearly = {
 year: string;
 confirmed: number;
 predicted: number;
 total: number;
 invoiceCount: number;
 isPartial: boolean;
 yoyDelta: number | null;
 yoyPct: number | null;
 monthsInYearReported: number;
};
export type SalesByRepsYoyTrend = {
 currYearLabel: string;
 prevYearLabel: string;
 monthsCompared: number;
 currYTD: number;
 prevYTD: number;
 rate: number;
 rawRate: number;
};
export type SalesByRepsMonthlyMatrixRow = {
 year: string;
 monthly: number[];
 total: number;
 isPartial: boolean;
};

export type SalesByRepsRow = {
 rep: string;
 monthly: number[];
 total: number;
 invoiceCount: number;
 avgPerMonth: number;
 monthsActive: number;
 lastInvoiceMonth: string | null;
 topCustomers: Array<{ customer: string; total: number; invoiceCount: number }>;
 rawVariants: string[];
 predictedMonthly: number[];
 predictedTotal: number;
 predictedInvoiceCount: number;
 predictedFromCustomers: Array<{ customer: string; total: number; invoiceCount: number; confidence: number }>;
 yearly: SalesByRepsYearly[];
 shareOfTotalPct: number;
 grandTotal: number;
 combinedMonthly: number[];
 yoyTrend: SalesByRepsYoyTrend | null;
 monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
};
export type SalesByRepsResult = {
 fetchedAt: string;
 sourceLtFinancialsUrl: string;
 sourceCommissionSheetUrl: string;
 months: Array<{ key: string; label: string }>;
 rows: SalesByRepsRow[];
 totals: {
   monthly: number[];
   grandTotal: number;
   invoiceCount: number;
   unmappedInvoiceCount: number;
   unmappedAmount: number;
   predictedInvoiceCount: number;
   predictedAmount: number;
   coveragePct: number;
   coveragePctIncludingPredicted: number;
   yearly: SalesByRepsYearly[];
   yoyTrend: SalesByRepsYoyTrend | null;
   monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
 };
 customerRepLearned: Array<{
   customer: string;
   dominantRep: string;
   confidence: number;
   confirmedInvoiceCount: number;
 }>;
 warnings: string[];
};
export async function fetchSalesByReps(): Promise<SalesByRepsResult> {
 return {
  fetchedAt: '', sourceLtFinancialsUrl: '', sourceCommissionSheetUrl: '', months: [], rows: [],
  totals: {
   monthly: [], grandTotal: 0, invoiceCount: 0, unmappedInvoiceCount: 0, unmappedAmount: 0,
   predictedInvoiceCount: 0, predictedAmount: 0, coveragePct: 0, coveragePctIncludingPredicted: 0,
   yearly: [], yoyTrend: null, monthlyMatrix: [],
  },
  customerRepLearned: [], warnings: [],
 };
}

export type CommissionType = 'NEW' | 'OLD' | 'WHITELABEL';
export type CommissionInvoice = {
 invoiceNumber: string;
 customer: string;
 rep: string;
 repSource: 'override' | 'workbook' | 'sheet' | 'predicted' | 'unmapped';
 isPredicted: boolean;
 needsReview: boolean;
 reviewReasons: string[];
 invoiceDate: string;
 paidDate: string;
 paidMonth: string;
 invoiceAmount: number;
 shipping: number;
 tax: number;
 credit: number;
 pureXFee: number;
 netAmount: number;
 netSource: 'workbook' | 'sheet' | 'fallback';
 commissionType: CommissionType;
 typeSource: 'override' | 'workbook' | 'auto';
 businessTypeLabel: string;
 rate: number;
 commission: number;
 commissionSource: 'workbook' | 'computed';
 daysSinceLastPaid: number | null;
};
export type CommissionRepStats = {
 rep: string;
 invoiceCount: number;
 confirmedInvoiceCount: number;
 predictedInvoiceCount: number;
 totalCommission: number;
 commissionByType: { NEW: number; OLD: number; WHITELABEL: number };
 invoiceCountByType: { NEW: number; OLD: number; WHITELABEL: number };
 newBusinessAccounts: number;
 oldBusinessAccounts: number;
 monthly: Array<{ ym: string; label: string; commission: number; invoiceCount: number; newAccounts: number; oldAccounts: number }>;
 yearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean; yoyPct: number | null; yoyDelta: number | null }>;
 yoyTrend: { currYearLabel: string; prevYearLabel: string; monthsCompared: number; currYTD: number; prevYTD: number; rate: number } | null;
 topCustomers: Array<{ customer: string; commission: number; invoiceCount: number }>;
 shareOfTotalPct: number;
};
export type CommissionResult = {
 fetchedAt: string;
 rules: { newRate: number; oldRate: number; whitelabelRate: number; newOldThresholdDays: number };
 months: Array<{ ym: string; label: string }>;
 reps: CommissionRepStats[];
 totals: {
   grandTotalCommission: number;
   grandTotalInvoiceCount: number;
   commissionThisMonth: number;
   commissionLastMonth: number;
   commissionYtd: number;
   confirmedInvoiceCount: number;
   predictedInvoiceCount: number;
   skippedInvoiceCount: number;
   invoicesWithSheetDeductions: number;
   invoicesWithFallbackDeductions: number;
   totalShipping: number;
   totalTax: number;
   totalCredit: number;
   totalPureXFee: number;
   overrideInvoiceCount: number;
   needsReviewCount: number;
   unmappedRepCount: number;
   monthly: number[];
   yearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean }>;
 };
 invoices: CommissionInvoice[];
 warnings: string[];
};
export async function fetchCommission(): Promise<CommissionResult> {
 return {
  fetchedAt: '',
  rules: { newRate: 0, oldRate: 0, whitelabelRate: 0, newOldThresholdDays: 0 },
  months: [], reps: [],
  totals: {
   grandTotalCommission: 0, grandTotalInvoiceCount: 0, commissionThisMonth: 0, commissionLastMonth: 0, commissionYtd: 0,
   confirmedInvoiceCount: 0, predictedInvoiceCount: 0, skippedInvoiceCount: 0,
   invoicesWithSheetDeductions: 0, invoicesWithFallbackDeductions: 0,
   totalShipping: 0, totalTax: 0, totalCredit: 0, totalPureXFee: 0,
   overrideInvoiceCount: 0, needsReviewCount: 0, unmappedRepCount: 0,
   monthly: [], yearly: [],
  },
  invoices: [], warnings: [],
 };
}

export async function setCommissionOverride(_invoiceNumber: string, _type: CommissionType | null): Promise<{ ok: boolean }> {
 return { ok: true };
}

export async function setCommissionRepOverride(_invoiceNumber: string, _rep: string | null): Promise<{ ok: boolean }> {
 return { ok: true };
}

export type CashflowOverrides = {
 mode: 'manual' | 'auto';
 ccUtilisationByWeek: Record<string, number>;
};

export async function fetchCashflowOverrides(): Promise<CashflowOverrides> {
 return { mode: 'auto', ccUtilisationByWeek: {} };
}

export async function saveCashflowOverrides(next: CashflowOverrides): Promise<CashflowOverrides> {
 return next;
}

// Expense head overrides (display-only; does not affect the cashflow).
export type ExpenseOverride = { value: number; by: string; at: string };
export type ExpenseOverrides = Record<string, ExpenseOverride>;

export async function fetchExpenseOverrides(): Promise<ExpenseOverrides> {
 return {};
}

export async function saveExpenseOverrides(_values: Record<string, number>): Promise<ExpenseOverrides> {
 return {};
}

// AR open invoices (Projections → AR tab).
export type ArOpenInvoice = {
 invoiceNumber: string; customer: string; brand: string; issueDate: string;
 amount: number; daysOut: number; bucket: string; status: string; infusedOrigin: boolean;
};
export type ArOpenResult = {
 asOfDate: string; grossAr: number; invoiceCount: number;
 buckets: Record<string, number>; invoices: ArOpenInvoice[];
 segments: { all: number; littleTree: number; infusedOrigin: number };
};
export async function fetchArOpenInvoices(): Promise<ArOpenResult> {
 return {
  asOfDate: '', grossAr: 0, invoiceCount: 0, buckets: {}, invoices: [],
  segments: { all: 0, littleTree: 0, infusedOrigin: 0 },
 };
}

// AR collections history — month × year grid + seasonality.
export type ArCollectionsHistory = {
 asOf: string;
 years: number[];
 grid: Array<Record<number, number>>;
 yearTotals: Record<number, number>;
 seasonality: Array<{ month: number; index: number; avg: number }>;
 overallMonthlyAvg: number;
 recentMonthlyAvg: number;
 recentWeeklyAvg: number;
 lagCurve: number[];
 lagCumulative: number[];
 recoveryBands: Array<{ bucket: string; recovery: number; paid: number; writeOff: number; n: number }>;
};
export async function fetchArCollectionsHistory(): Promise<ArCollectionsHistory> {
 return {
  asOf: '', years: [], grid: [], yearTotals: {}, seasonality: [],
  overallMonthlyAvg: 0, recentMonthlyAvg: 0, recentWeeklyAvg: 0,
  lagCurve: [], lagCumulative: [], recoveryBands: [],
 };
}

// Collected detail for a date range (drill-down).
export type CollectedInvoice = { invoiceNumber: string; customer: string; channel: string; invoiceDate: string; paidDate: string; amount: number; paid: number };
export type CollectedDetail = {
 start: string; end: string;
 nonGelato: { total: number; count: number; invoices: CollectedInvoice[] };
 gelato: { total: number; count: number; invoices: CollectedInvoice[] };
 salesInvoiced?: { gelato: { amount: number; invoiceCount: number }; nonGelato: { amount: number; invoiceCount: number }; total: number };
};
export async function fetchCollectedDetail(start: string, end: string): Promise<CollectedDetail> {
 return {
  start, end,
  nonGelato: { total: 0, count: 0, invoices: [] },
  gelato: { total: 0, count: 0, invoices: [] },
 };
}

// Outflow drill-down: expense entries grouped by budget line.
export type ExpenseEntry = { date: string; description: string; amount: number; category: string; line: string };
export type ExpenseEntriesRange = {
 start: string; end: string;
 byLine: Record<string, { total: number; entries: ExpenseEntry[] }>;
 total: number;
};
export async function fetchExpenseEntries(start: string, end: string): Promise<ExpenseEntriesRange> {
 return { start, end, byLine: {}, total: 0 };
}

// Combined actual expense for a calendar month — budget basis.
export type CombinedActual = {
 month: string; isCurrentMonth: boolean; source: string;
 byLine: Record<string, number>;
 entries: ExpenseEntry[];
};
export async function fetchCombinedActual(month: string): Promise<CombinedActual> {
 return { month, isCurrentMonth: false, source: '', byLine: {}, entries: [] };
}

// AR projection methodology (Projections → AR tab).
export type ArLagCurvePoint = { lag: number; pctOfInvoiced: number };
export type ArChannelStat = {
 channel: string; sampleInvoiceCount: number; totalInvoiced: number;
 totalCollected: number; collectionRate: number; curve: ArLagCurvePoint[]; source: string;
};
export type ArPlacementRow = {
 customer: string; channel: string; invoiceNumber: string; invoiceDate: string;
 amount: number; paidAmount: number; openBalance: number; status: string;
 currentLag: number; collectibility: number; projectedCollectible: number;
 placements: Array<{ targetMonth: string; amount: number; weekIndices: number[] }>;
};
export type ArProjectionResult = {
 weeks: Array<{ index: number; start: string; end: string; label: string }>;
 arByWeek: number[];
 buckets: { overdueWk1: number; openInWindow: number; openAfterWindow: number; futureProjected: number };
 channelStats: ArChannelStat[];
 globalCurve: ArLagCurvePoint[];
 globalCollectionRate: number;
 placements: ArPlacementRow[];
 globalAvgCollectionDays: number;
 dailyRunRate: number;
 projectedCollectibilityRate: number;
 warnings: string[];
};

export async function fetchArProjection(): Promise<ArProjectionResult> {
 return {
  weeks: [], arByWeek: [],
  buckets: { overdueWk1: 0, openInWindow: 0, openAfterWindow: 0, futureProjected: 0 },
  channelStats: [], globalCurve: [], globalCollectionRate: 0, placements: [],
  globalAvgCollectionDays: 0, dailyRunRate: 0, projectedCollectibilityRate: 0, warnings: [],
 };
}

// The signed-in user's display name (set by login in sessionStorage). Used to
// attribute manual edits ("edited by …"). Falls back to the email local-part.
export function currentUserName(): string {
 try {
 const name = sessionStorage.getItem('user_name');
 if (name && name.trim()) return name.trim();
 const email = sessionStorage.getItem('user_email') || '';
 if (email) return email.split('@')[0].split(/[._]/)[0];
 } catch { /* SSR / blocked storage */ }
 return 'Unknown';
}

// Unified cashflow cell edits (inflow Sales/AR + outflow expenses).
// Key = `${rowLabel}|${weekStart}`.
export type CellEdit = { value: number; by: string; at: string; reason?: string };
export type CashflowEdits = Record<string, CellEdit>;

export async function fetchCashflowEdits(): Promise<CashflowEdits> {
 return {};
}

export async function saveCashflowEdits(_set: Record<string, number>, _clear: string[] = [], _reasons: Record<string, string> = {}): Promise<CashflowEdits> {
 // Tell every view to refresh so an edit in one place shows in the others.
 try { window.dispatchEvent(new Event('cashflow-edits-changed')); } catch { /* SSR */ }
 return {};
}

// Per-payee edits — breakdown-level overrides behind an outflow line.
// Key: `${line}::${payee}|${weekStart}`.
export type PayeeEdits = Record<string, CellEdit>;

export async function fetchPayeeEdits(): Promise<PayeeEdits> {
 return {};
}

export async function savePayeeEdits(_set: Record<string, number>, _clear: string[] = [], _reasons: Record<string, string> = {}): Promise<PayeeEdits> {
 try { window.dispatchEvent(new Event('cashflow-edits-changed')); } catch { /* SSR */ }
 return {};
}

// Manual expense heads — owner-added payees on a line (name + details).
export type ManualHead = { name: string; details: string; by: string; at: string };
export type ManualHeads = Record<string, ManualHead[]>;

export async function fetchManualHeads(): Promise<ManualHeads> {
 return {};
}

export async function saveManualHead(_line: string, _name: string, _details: string): Promise<ManualHeads> {
 return {};
}

export async function removeManualHead(_line: string, _name: string): Promise<ManualHeads> {
 return {};
}

// Sales + AR forecast overrides (display-only; does not affect the cashflow).
export type ForecastOverrides = { sales: Record<string, number>; ar: Record<string, number> };

export async function fetchForecastOverrides(): Promise<ForecastOverrides> {
 return { sales: {}, ar: {} };
}

export async function saveForecastOverrides(next: ForecastOverrides): Promise<ForecastOverrides> {
 return next;
}

export async function deleteWeeklySnapshot(_monday: string): Promise<void> {
 return;
}

// ── Copilot ──────────────────────────────────────────────────────────────────
export type CopilotNav = { view: string; tab: string; anchor: string; where: string };
export type AssistantResponse = {
 intent: string;
 title: string;
 lines: string[];
 note?: string;
 warning?: string;
 nav?: CopilotNav;
 confidence: number;
 suggestions: string[];
 asOf: string;
};

export async function askCopilot(
 _question: string,
 _user?: { name?: string; title?: string },
 _since?: string,
): Promise<AssistantResponse> {
 return { intent: '', title: '', lines: [], confidence: 0, suggestions: [], asOf: '' };
}

export type CopilotChanges = { title: string; lines: string[]; note?: string };
export async function fetchCopilotChanges(_since?: string): Promise<CopilotChanges> {
 return { title: '', lines: [] };
}

// --- Expenses grouped by category mapping ---
export type PnlExpenseAccount = { name: string; monthly: number[]; total: number };
export type PnlExpenseCategory = { category: string; monthly: number[]; total: number; accounts: PnlExpenseAccount[] };
export type PnlExpensesResult = {
  asOf: string;
  months: string[];
  monthLabels: string[];
  categories: PnlExpenseCategory[];
  mappedTotal: number;
  unmappedTotal: number;
  grandTotal: number;
};
export async function fetchPnlExpenses(_opts: { method?: 'Cash' | 'Accrual'; refresh?: boolean } = {}): Promise<PnlExpensesResult> {
 return { asOf: '', months: [], monthLabels: [], categories: [], mappedTotal: 0, unmappedTotal: 0, grandTotal: 0 };
}

// ── Internal builders for empty, type-valid placeholder values ────────────────
function emptyYoy(): SalesForecastResult['yoy'] {
 return { rate: 0, rawRate: 0, currYearLabel: '', prevYearLabel: '', monthsCompared: 0, currYTD: 0, prevYTD: 0 };
}

function emptyWeeklyAnalysis(): WeeklyAnalysis {
 return {
  history: [],
  trend: { slope: 0, intercept: 0, r2: 0, basisWeeks: 0 },
  weekOfYearSeasonality: [],
  forecast: [],
 };
}

function emptyBucketForecast(bucket: SalesBucket): BucketForecast {
 return {
  bucket, label: '', customerCount: 0,
  yearlyHistory: [], monthlyHistory: [], seasonality: [],
  yoy: emptyYoy(), yoyChain: [], weeklyAnalysis: emptyWeeklyAnalysis(),
  monthlyForecast: [], monthlyForecastBest: [], monthlyForecastWorst: [],
  weeklyInflow: [], weeklyInflowBest: [], weeklyInflowWorst: [], weeklyGross: [],
  scenarioTotals: { base: { invoiced: 0, cash: 0 }, best: { invoiced: 0, cash: 0 }, worst: { invoiced: 0, cash: 0 } },
  deseasonalizedBase: 0,
  baseCalibration: { windowMonths: 0, contributors: [], deseasonalizedBase: 0 },
 };
}

function emptySalesForecastResult(): SalesForecastResult {
 return {
  asOf: '',
  driver: { lookbackMonths: 0, forecastHorizonMonths: 0, maxLagMonths: 0, tiers: [] },
  yearlyHistory: [], monthlyHistory: [], seasonality: [],
  yoy: emptyYoy(), yoyChain: [], weeklyAnalysis: emptyWeeklyAnalysis(),
  monthlyForecastV2: [], monthlyForecastBest: [], monthlyForecastWorst: [],
  weeklyInflowV2: [], weeklyInflowBest: [], weeklyInflowWorst: [],
  totalForecastedInvoiceV2: 0, totalProjectedCashV2: 0,
  scenarioTotals: { base: { invoiced: 0, cash: 0 }, best: { invoiced: 0, cash: 0 }, worst: { invoiced: 0, cash: 0 } },
  approvedAssumptions: {
   deseasonalizedBase: 0, bestMultiplier: 0, worstMultiplier: 0, growthTrend: 0, excisetaxNote: '',
   calibration: { windowMonths: 0, contributors: [], deseasonalizedBase: 0 },
  },
  lookbackWindow: [], horizonMonths: [], weeks: [], globalLagCurve: [], brands: [], churnedBrands: [],
  weeklyInflow: [], monthlyForecast: [], totalForecastedSales: 0, totalProjectedCash: 0, sameWeekRate: 0,
  buckets: {
   wholesale: emptyBucketForecast('wholesale'),
   privateLabel: emptyBucketForecast('privateLabel'),
   gelato: emptyBucketForecast('gelato'),
  },
  warnings: [],
 };
}

function emptyDso(): DsoStat {
 return { weightedDays: 0, totalAmount: 0, invoiceCount: 0, dso: 0 };
}

function emptyArAgingGroup(label: string): ArAgingGroup {
 return {
  label, netTermsDays: 0, invoices: [],
  totals: { grossAr: 0, expectedCollectible: 0, invoiceCount: 0 },
  bucketSummary: { '0-14': 0, '15-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
  channelSummary: [], customerConcentration: null,
  dsoPaid: emptyDso(), dsoOpen: emptyDso(), dsoCombined: emptyDso(), dso: 0,
 };
}

function emptySheetCategoryMonthly(): SheetCategoryMonthly {
 return { months: [], monthLabels: [], monthlyTotals: [], total: 0, weeklyAvgL3M: 0, entryCount: 0 };
}

function emptyArStatusResult(): ArStatusResult {
 return {
  fetchedAt: '', year: 0, asOfDate: '', currentMonth: { ym: '', label: '' },
  collectedYtd: 0, collectedYtdInvoiceCount: 0, collectedThisMonth: 0, collectedThisMonthInvoiceCount: 0,
  collectedByMonth: [], collectedByWeekCurrentMonth: [],
  ytdFromPriorYearInvoices: 0, ytdFromPriorYearInvoiceCount: 0,
  paidWithMissingDate: 0, paidWithMissingDateCount: 0, paidWithMissingDateSamples: [],
  outstandingTotal: 0, outstandingCount: 0,
  outstandingByAge: {
   current: { amount: 0, count: 0 },
   d31_60: { amount: 0, count: 0 },
   d61_90: { amount: 0, count: 0 },
   d91Plus: { amount: 0, count: 0 },
  },
  topOpenInvoices: [],
 };
}
