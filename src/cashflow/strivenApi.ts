// Frontend client for the SMR ⇄ Striven backend (striven-server).
// Vite proxies /api → the backend (see vite.config.js), so these are same-origin
// in dev. No credentials ever reach the browser.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error || `Request failed: ${res.status}`);
  return json as T;
}

export type StrivenStatus = { connected: boolean; company: string | null; subdomain?: string | null; reason?: string; phiMasked?: boolean };

export type SoRecent = { id: number; ref: string; type: string; rep: string; payer: string; value: number; status: string; invStatus: string; date: string | null };
export type SoPivaKey = 'PI' | 'VA' | 'TriCare' | 'Other';
export type SoStatusGroup = 'active' | 'completed' | 'cancelled';
export type SoResult = {
  // count/totalValue/piva/byType/byRep = the ORDER BOOK (cancelled + demo excluded).
  count: number; totalValue: number;
  piva: Record<SoPivaKey, { count: number; value: number }>;
  byType: { type: string; count: number; value: number }[];
  byStatus: { status: string; count: number }[];
  byRep: { rep: string; value: number }[];
  recent: SoRecent[];
  statusGroups: Record<SoStatusGroup, { count: number; value: number }>;
  liveCount: number; demoCount: number; enriched: boolean; phiMasked: boolean;
};

export type PoRecent = { id: number; ref: string; vendor: string; total: number; date: string | null; status?: string; so?: string };
export type PoResult = { count: number; totalValue: number; byVendor: { vendor: string; total: number }[]; recent: PoRecent[]; cancelledCount?: number; cancelledValue?: number; pendingCount?: number; pendingValue?: number; totalCount?: number; phiMasked: boolean };

export type Customer = { id: number; ref: string; name: string; status: string; since: string | null };
export type CustomersResult = { count: number; customers: Customer[]; phiMasked: boolean };

export type Vendor = { id: number; name: string; number: string; status: string; phone: string; terms: string };
export type VendorsResult = { count: number; vendors: Vendor[] };

export type Item = { id: number; name: string; number: string; type: string; description: string; price: number; cost: number; active: boolean };
export type ItemsResult = { count: number; items: Item[] };

export type TrendPoint = { month: string; revenue: number; expenses: number; net: number };
export type TrendsResult = { series: TrendPoint[] };

export type NamedCount = { name: string; count: number };

export type Payment = { id: number; ref: string; customer: string; date: string | null; amount: number; status: string };
export type PaymentsResult = { count: number; total: number; byMonth: { month: string; amount: number }[]; recent: Payment[]; phiMasked: boolean };

export type BillPayment = { id: number; ref: string; vendor: string; account: string; date: string | null; amount: number; status: string };
export type BillPaymentsResult = { count: number; total: number; recent: BillPayment[] };

export type Task = { id: number; title: string; type: string; status: string; date: string | null };
export type TasksResult = { count: number; byStatus: NamedCount[]; byType: NamedCount[]; recent: Task[]; phiMasked: boolean };

export type Project = { id: number; name: string; type: string; status: string; date: string | null };
export type ProjectsResult = { count: number; byStatus: NamedCount[]; recent: Project[]; phiMasked: boolean };

export type LineItem = { item: string; description: string; qty: number; unit: number; amount: number };
export type PoDetail = {
  id: number; ref: string; vendor: string; status: string; vendorStatus: string; type: string; title: string;
  poDate: string | null; promiseDate: string | null;
  requestedBy: string; contact: string; createdBy: string; createdDate: string | null;
  approvedDate: string | null; reviewedDate: string | null; acceptedBy: string; lastUpdatedBy: string;
  paymentTerm: string; account: string; dropShipCustomer: string;
  linkedSo: string; shipVia: string; lastUpdatedDate: string | null; notesLogCount: number; attachmentCount: number;
  isDropShip: boolean; isBlanket: boolean; isFixedCost: boolean; allowPartial: boolean; isRecurring: boolean; needsReview: boolean;
  total: number; lineItems: LineItem[];
};
export type SoLineItem = { item: string; description: string; qty: number; unit: number; amount: number; shipping: number; taxable: boolean; ordered: boolean | null };
export type SoDetail = {
  id: number; ref: string; customer: string; date: string | null; total: number; status: string; lineItemCount: number;
  type: string; program: string; invoiceStatus: string; rep: string; payer: string;
  orderDate: string | null; targetDate: string | null;
  createdDate: string | null; createdBy: string; lastUpdatedDate: string | null; lastUpdatedBy: string;
  paymentTerm: string; shipVia: string; trackingNumber: string; customerPONumber: string; arAccount: string;
  salesTax: string; invoiceFormat: string; isChangeOrder: boolean; isRecurring: boolean;
  notesLogCount: number; attachmentCount: number;
  lineItems: SoLineItem[]; phiMasked: boolean;
};

export type Aging = { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };

export type ArInvoice = { id: number; number: string; customer: string; customerId: number | null; payer: string; dueDate: string | null; total: number; open: number; currency: string; memo: string };
export type ArResult = { totalOpen: number; count: number; aging: Aging; invoices: ArInvoice[]; unappliedCredits?: number; voidedExcluded?: number };

export type ApBill = { id: number; number: string; vendor: string; vendorId: number | null; dueDate: string | null; total: number; open: number; currency: string };
export type ApResult = { totalOpen: number; count: number; aging: Aging; bills: ApBill[] };

export type GlAccount = { id: number; name: string; extendedName?: string; type: string; number: string; parent?: string; canPost?: boolean; reconcilable?: boolean; active: boolean };
export type AccountsResult = { count: number; accounts: GlAccount[]; balancesAvailable?: boolean; note?: string };

export type PlMonth = { month: string; revenue: number; expenses: number; net: number };
export type PlResult = {
  periodFrom: string; revenue: number; expenses: number; net: number; margin: number; cashReceived: number;
  invoiceCount: number; billCount: number; avgInvoice: number; avgBill: number;
  series: PlMonth[]; byVendor: { name: string; value: number }[]; approximate: boolean;
};

export const fetchStrivenStatus = () => get<StrivenStatus>('/api/status');
export const fetchStrivenAR = () => get<ArResult>('/api/ar');
export const fetchStrivenAP = () => get<ApResult>('/api/ap');
export const fetchStrivenAccounts = () => get<AccountsResult>('/api/accounts');
export const fetchStrivenPL = () => get<PlResult>('/api/pl');
export const fetchStrivenSO = () => get<SoResult>('/api/so');
export const fetchStrivenPO = () => get<PoResult>('/api/po');
export const fetchStrivenCustomers = () => get<CustomersResult>('/api/customers');
export const fetchStrivenVendors = () => get<VendorsResult>('/api/vendors');
export const fetchStrivenItems = () => get<ItemsResult>('/api/items');
export const fetchStrivenTrends = () => get<TrendsResult>('/api/trends');
export const fetchStrivenPODetail = (id: number) => get<PoDetail>(`/api/po/${id}`);
export const fetchStrivenSODetail = (id: number) => get<SoDetail>(`/api/so/${id}`);
export const fetchStrivenPayments = () => get<PaymentsResult>('/api/payments');
export const fetchStrivenBillPayments = () => get<BillPaymentsResult>('/api/billpayments');
export const fetchStrivenTasks = () => get<TasksResult>('/api/tasks');
export const fetchStrivenProjects = () => get<ProjectsResult>('/api/projects');

export type ExceptionGroup = { key: string; severity: 'high' | 'warn' | 'info'; title: string; count: number; value?: number; note: string; columns: string[]; rows: Record<string, string | number>[] };
export type ExceptionsResult = { totalOpen: number; groups: ExceptionGroup[]; note: string };
export const fetchStrivenExceptions = () => get<ExceptionsResult>('/api/exceptions');

// ── QuickBooks Online ──────────────────────────────────────────────────────
export type QbStatus = { connected: boolean; env: 'sandbox' | 'production'; configured?: boolean; realmId?: string; company?: string; country?: string; connectedAt?: string | null; error?: string };
export type QbCustomer = { id: string; name: string; email: string; balance: number };
export type QbCustomersResult = { count: number; customers: QbCustomer[] };
export type QbPosted = { invoiceId: string; docNumber: string; total?: number; customer?: string; at: string };
export type QbPlanLine = { name: string; qty: number; unit: number; amount: number; item: { status: 'matched' | 'create'; id?: string; qbName?: string } };
export type QbPlan = {
  so: { id: number; number: string; status: string; type: string; date: string | null; total: number };
  customer: { status: 'matched' | 'create'; name: string; id?: string; qbName?: string; email?: string; phone?: string };
  lines: QbPlanLine[];
  computedTotal: number;
  alreadyPosted: QbPosted | null;
  warnings: string[];
};
export type QbPostResult = { ok: boolean; invoice?: QbPosted; steps?: { step: string; action: string; name: string; id: string }[]; soNumber?: string; alreadyPosted?: QbPosted; message?: string };

export type QbPostedList = { count: number; posted: Record<string, QbPosted> };
export type QbReconcile = { strivenCount: number; qbCount: number; matchedCount: number; missingCount: number; missingInQb: { name: string }[] };
export type QbReconcileCustomers = QbReconcile & { matched: { name: string }[] };
export type QbCreateMissingResult = { kind: string; created: { name: string; id: string }[]; createdCount: number; failed: { name: string; error: string }[]; remaining: number; totalMissing: number };
export type QbEntityKind = 'customers' | 'vendors' | 'items';

export type QbInvoiceRow = { id: number; number: string; customer: string; date: string | null; total: number; open: number; posted: QbPosted | null };
export type QbInvoicesResult = { count: number; postedCount: number; invoices: QbInvoiceRow[] };
export type QbInvoiceDocPlan = {
  invoice: { id: number; number: string; date: string | null; dueDate: string | null; customerName: string; order: string };
  customer: { status: 'matched' | 'create'; name: string; id?: string; qbName?: string };
  lines: QbPlanLine[];
  computedTotal: number;
  alreadyPosted: QbPosted | null;
  warnings: string[];
};

export const fetchQbStatus = () => get<QbStatus>('/api/qb/status');
export const fetchQbCustomers = (q: string) => get<QbCustomersResult>(`/api/qb/customers?q=${encodeURIComponent(q)}`);
export const fetchQbPosted = () => get<QbPostedList>('/api/qb/posted');
export const fetchQbReconcileCustomers = () => get<QbReconcileCustomers>('/api/qb/reconcile-customers');
export const fetchQbReconcile = (kind: QbEntityKind) =>
  get<QbReconcile>(kind === 'customers' ? '/api/qb/reconcile-customers' : `/api/qb/reconcile-${kind}`);
const post = async <T>(path: string): Promise<T> => {
  const r = await fetch(path, { method: 'POST', headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string })?.error || `Request failed: ${r.status}`);
  return j as T;
};
export const qbCreateMissing = (kind: QbEntityKind, limit = 30) => post<QbCreateMissingResult>(`/api/qb/create-missing?kind=${kind}&limit=${limit}`);
const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string })?.error || `Request failed: ${r.status}`);
  return j as T;
};
export const qbCreateSelected = (kind: QbEntityKind, names: string[]) => postJson<QbCreateMissingResult>(`/api/qb/create-selected?kind=${kind}`, { names });
export const fetchQbInvoices = () => get<QbInvoicesResult>('/api/qb/invoices');
export const qbPrepareInvoiceDoc = (invId: number) => get<QbInvoiceDocPlan>(`/api/qb/prepare-invoice-doc?inv=${invId}`);
export const qbPostInvoiceDoc = (invId: number, force = false) => post<QbPostResult>(`/api/qb/post-invoice-doc?inv=${invId}${force ? '&force=1' : ''}`);
export const qbPrepareInvoice = (soId: number) => get<QbPlan>(`/api/qb/prepare-invoice?so=${soId}`);
export const qbPostInvoice = (soId: number, force = false) =>
  fetch(`/api/qb/post-invoice?so=${soId}${force ? '&force=1' : ''}`, { method: 'POST', headers: { Accept: 'application/json' } })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j as { error?: string })?.error || `Post failed: ${r.status}`); return j as QbPostResult; });

// ── Reports (vendor purchases, patient orders) — cancelled excluded ─────────
export type ReportVendorItem = { item: string; qty: number; cost: number; poCount: number };
export type ReportVendor = { vendor: string; poCount: number; totalCost: number; items: ReportVendorItem[] };
export type VendorItemsReport = { vendors: ReportVendor[]; count: number; generatedAt: string | null; note: string };
export type ReportPatientItem = { item: string; qty: number; value: number; soCount: number };
export type ReportPatient = { patient: string; soCount: number; totalValue: number; items: ReportPatientItem[] };
export type PatientItemsReport = { patients: ReportPatient[]; count: number; generatedAt: string | null; note: string };
export const fetchVendorItemsReport = () => get<VendorItemsReport>('/api/reports/vendor-items');
export const fetchPatientItemsReport = () => get<PatientItemsReport>('/api/reports/patient-items');

export type OrderPo = { ref: string; vendor: string; value: number; status: string };
export type OrderInv = { ref: string; total: number; open: number; status: string };
export type OrderRow = { ref: string; pi: string; type: string; rep: string; payer: string; value: number; status: string; invStatus: string; pos: OrderPo[]; invoices: OrderInv[]; poValue: number; invOpen: number };
export type OrdersResult = { count: number; orders: OrderRow[]; enriched: boolean; phiMasked: boolean };
export const fetchStrivenOrders = () => get<OrdersResult>('/api/orders');
