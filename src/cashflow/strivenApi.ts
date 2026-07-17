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

export type PoRecent = { id: number; ref: string; vendor: string; total: number; date: string | null; status?: string };
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

export type OrderPo = { ref: string; vendor: string; value: number; status: string };
export type OrderInv = { ref: string; total: number; open: number; status: string };
export type OrderRow = { ref: string; pi: string; type: string; rep: string; payer: string; value: number; status: string; invStatus: string; pos: OrderPo[]; invoices: OrderInv[]; poValue: number; invOpen: number };
export type OrdersResult = { count: number; orders: OrderRow[]; enriched: boolean; phiMasked: boolean };
export const fetchStrivenOrders = () => get<OrdersResult>('/api/orders');
