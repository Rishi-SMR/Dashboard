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

/** `labels` are the Striven tags that DECIDE the order's stage — `status` is
 *  only Striven's In Progress / Completed. Empty where Striven has tagged
 *  nothing: the labels report covers the PI/PIP book, not the whole catalogue. */
export type SoRecent = { id: number; ref: string; type: string; rep: string; payer: string; value: number; status: string; invStatus: string; date: string | null; labels?: string[];
  /** First INITIAL + surname, never a full first name. Empty where the labels
   *  report has no row for the order. */
  patient?: string };
/** getSO() emits a bucket per soClass(), which includes DEMO and Contract — the
 *  type listed only four and was silently narrower than the payload. */
export type SoPivaKey = 'PI' | 'VA' | 'TriCare' | 'DEMO' | 'Contract' | 'Other';
export type SoStatusGroup = 'active' | 'completed' | 'cancelled';
export type SoResult = {
  // count/totalValue/piva/byType/byRep = the ORDER BOOK: cancelled excluded,
  // DEMO INCLUDED. The comment used to claim demo was excluded too; getSO()
  // stopped filtering it out (it was hiding 27 orders worth $17,369) and this
  // was not updated. `demoCount` carries how many of them there are.
  count: number; totalValue: number;
  piva: Record<SoPivaKey, { count: number; value: number }>;
  byType: { type: string; count: number; value: number }[];
  byStatus: { status: string; count: number }[];
  byRep: { rep: string; count: number; value: number; units: number }[];
  recent: SoRecent[];
  statusGroups: Record<SoStatusGroup, { count: number; value: number }>;
  liveCount: number; demoCount: number; enriched: boolean; phiMasked: boolean;
};

export type PoRecent = { id: number; ref: string; vendor: string; total: number; date: string | null; status?: string; so?: string };
/** `demoCount` / `demoValue` are POs raised against a DEMO sales order. They are
 *  excluded from every other figure here — a PO bought for a demonstration is
 *  not vendor spend — and reported so the exclusion can be stated rather than
 *  looking like a shrinking book. A PO with no sales order behind it is NOT
 *  demo: nothing identifies it as one, so it stays counted. */
export type PoResult = { count: number; totalValue: number; byVendor: { vendor: string; total: number }[]; recent: PoRecent[]; cancelledCount?: number; cancelledValue?: number; pendingCount?: number; pendingValue?: number; demoCount?: number; demoValue?: number; totalCount?: number; phiMasked: boolean };

export type Customer = { id: number; ref: string; name: string; status: string; since: string | null };
export type CustomersResult = { count: number; customers: Customer[]; phiMasked: boolean };

export type Vendor = { id: number; name: string; number: string; status: string; phone: string; terms: string };
export type VendorsResult = { count: number; vendors: Vendor[] };

export type Item = { id: number; name: string; number: string; type: string; description: string; price: number; cost: number; active: boolean };
export type ItemsResult = { count: number; items: Item[] };

/** `invoices`/`bills` are the COUNTS behind that month's amounts, so a count
 *  shown beside a figure always describes the same period the figure does. */
export type TrendPoint = { month: string; revenue: number; expenses: number; net: number; invoices?: number; bills?: number };
export type TrendsResult = { series: TrendPoint[] };

export type Payment = { id: number; ref: string; customer: string; date: string | null; amount: number; status: string };
/** `count` at the top level is every payment ever taken; the per-month `count`
 *  is what belongs beside a period-scoped total. */
export type PaymentsResult = { count: number; total: number; byMonth: { month: string; amount: number; count?: number }[]; recent: Payment[]; phiMasked: boolean };

export type BillPayment = { id: number; ref: string; vendor: string; account: string; date: string | null; amount: number; status: string };
export type BillPaymentsResult = { count: number; total: number; recent: BillPayment[] };


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

/** AP REGISTER — vendor bills from the "AP Ledgers" tab of the AP workbook, NOT
 *  from Striven. It will not reconcile with Payables: different book, kept by
 *  hand. The workbook's top "Total Outstanding" cell is deliberately NOT read:
 *  it is hand-typed and stale. Outstanding comes from the Outstanding column,
 *  cross-checked per vendor against the sheet's own block subtotals. */
export type ApLedgerBill = {
  no: string; subLedger: string; date: string; due: string;
  /** What COUNTS toward the payable: signed, so a credit note nets, and ZERO on
   *  a cancelled bill. Sum this and the answer is right without special-casing. */
  total: number;
  /** What the document says, regardless of whether it counts. Differs from
   *  `total` only on a cancelled bill, which prints at face value but adds nothing. */
  faceValue: number;
  /** Which side of the creditors ledger the row sits on, and whether it stands.
   *  A credit note is a DEBIT: it takes value back off the account. Carried
   *  explicitly because neither a credit note nor a cancelled bill can be told
   *  apart from an unpaid one by its status alone. */
  kind: 'bill' | 'credit-note' | 'cancelled';
  status: string; terms: string; dueDays: number; aging: string; open: number;
};
export type ApLedgerGroup = {
  subLedger: string; bills: number; billed: number; open: number; openBills: number; oldestDays: number; terms: string;
  /** Credit notes inside this block. Their amount is netted out of `billed`
   *  but NOT out of the sheet's Outstanding column, so it is exactly the gap
   *  between `billed - paid` and `open` — which lets an explained difference be
   *  labelled instead of flagged as unreconciled. */
  creditNotes: number; creditNoteAmount: number;
  /** What the sheet records as PAID to this vendor, from the Debit column,
   *  across `paymentRows` rows. `paidGap` is how far that sits from what the
   *  bills imply was settled (billed - outstanding) — they disagree on four of
   *  six vendors, so both are carried rather than one chosen silently. */
  paidRecorded: number; paymentRows: number; paidGap: number;
  /** The sheet's own "Total Outstanding" row for this vendor block, and how far
   *  it sits from what the rows beneath it add to. `null` = no subtotal row to
   *  check against, which is different from one that checks out. */
  sheetOpen: number | null; openGap: number | null;
};
/** One payment out of the ledger's DEBIT column. The sheet gives a payment row
 *  no invoice number — that absence is what marks it as a payment rather than a
 *  bill — and no bank account, so a vendor, a date and an amount is the whole of
 *  what exists. */
export type ApLedgerPayment = { subLedger: string; date: string; amount: number };
export type ApLedger = {
  ok: boolean; configured: boolean; note?: string;
  bills: ApLedgerBill[]; payments?: ApLedgerPayment[]; subLedgers: ApLedgerGroup[];
  totals?: {
    bills: number; billed: number; open: number; openBills: number;
    creditNotes: number; creditNoteAmount: number;
    cancelled: number; cancelledAmount: number;
    paidRecorded: number; paymentRows: number; paidImplied: number;
    blocksChecked: number; blocksMatched: number; blockOpenTotal: number;
    blockMismatches: { subLedger: string; rows: number; sheet: number; gap: number }[];
  };
  droppedHeaderRows?: number; fetchedAt?: string;
};
export const fetchApLedger = () => get<ApLedger>('/api/ap-ledger');

/** AR REGISTER — the invoice book behind the AR tab.
 *
 *  Striven supplies the BOOK (which invoices exist, what is still open); the
 *  accountant's Sales_Activity_Report sheet supplies the DETAIL (invoice date,
 *  patient, PO memo, GL account). Driven off Striven deliberately, so an invoice
 *  the sheet has not caught up with shows as a row missing its detail rather
 *  than silently shrinking the total — `inSheet: false` is that row.
 *
 *  ADMIN ONLY: every row names a patient. The name is reduced to initial +
 *  surname server-side before serialization; the full name never leaves the API. */
export type ArRegisterInvoice = {
  no: string; date: string; dueDate: string;
  patient: string; payer: string; memo: string; gl: string;
  /** The PROGRAMME that billed it — PI / VA / TriCare. An invoice carries no
   *  vertical of its own; the server joins it to the sales order behind it, and
   *  falls back to the patient. Empty when neither join reaches it. */
  vertical?: string;
  /** Face value, what has been settled, and what is still outstanding. `open` is
   *  NET of unapplied customer credits — the same rule the AR tab reports on. */
  total: number; paid: number; open: number;
  /** What is expected to be RECEIVED, as against `total` which is what was
   *  billed. PI settles out of a lien at 15% of face value; every other
   *  programme is expected in full. Computed server-side so the rule lives in
   *  one place — see arExpectedFor() in _commission-config.js. */
  arExpected?: number;
  /** Which rule produced `arExpected`: 'pi-15' | 'billed'. */
  arBasis?: string;
  /** How `paid` was actually settled. `cashPaid + creditApplied + open === total`
   *  on every row: cash banked against this invoice, an unapplied customer
   *  credit covering the rest, and what is still owed. */
  cashPaid: number; creditApplied: number;
  /** `credited` = settled by an unapplied customer credit rather than by a
   *  payment against this invoice. `zero-value` billed nothing at all. */
  status: 'open' | 'paid' | 'credited' | 'zero-value';
  /** False when Striven has this invoice but the sheet does not. */
  inSheet: boolean;
  /** Present only when the sheet disagrees with Striven on the amount. */
  sheetAmount: number | null; variance: number | null;
};
export type ArRegister = {
  ok: boolean; configured: boolean; note?: string;
  invoices: ArRegisterInvoice[];
  byMonth: { month: string; invoices: number; billed: number }[];
  aging: Record<string, number>;
  totals?: {
    invoices: number; billed: number; outstanding: number; openInvoices: number;
    /** Register-wide expected receipt, `arDiscount` is what the PI rule takes
     *  off `billed`, and `arDiscounted` counts the rows it applied to. Summed
     *  from the same per-row figures the table renders. */
    arExpected?: number; arDiscount?: number; arDiscounted?: number;
    collected: number; collectedInvoices: number;
    credited: number; creditedAmount: number; unappliedCredits: number;
    /** `cashCollected + creditCollected === collected`, by construction. */
    cashCollected: number; creditCollected: number;
    collectionRate: number; zeroValue: number;
    sheetRows: number; missingFromSheet: number; missingAmount: number;
    variances: number; varianceAmount: number;
    apRowsExcluded: number; apAmountExcluded: number;
  };
  fetchedAt?: string;
};
export const fetchArRegister = () => get<ArRegister>('/api/ar-register');

/** UNITS BY DEVICE — counts only, no money. `heldUnits`/`heldOrders` come from
 *  the Striven HOLD label, which is the only place a hold survives: the
 *  commission engine drops a held order entirely, so it reports none.
 *  Admin-only server-side; a rep receives an empty list. */
export type DeviceMixRow = { device: string; vertical: string; units: number; orders: number; heldUnits: number; heldOrders: number;
  /** Units and orders per calendar month ('2026-07'), so the board can scope
   *  this to a period. Orders the `so` cache has no date for appear in NO month,
   *  so the months can sum to less than `units` — the difference is undated
   *  work, never a month's figure quietly absorbing it. */
  byMonth?: Record<string, { units: number; orders: number }>;
  /** A DEMO / test order's device line, from the `report_demo_items` cache.
   *  Kept as its own row rather than folded into the real device: 25 real units
   *  plus 2 demo units is a number that is neither. */
  demo?: boolean };
export type DeviceMix = { ok: boolean; scoped: boolean; devices: DeviceMixRow[];
  demoUnits?: number; demoDevices?: number; demoOrders?: number };
export const fetchDeviceMix = (as?: string | null) =>
  get<DeviceMix>(`/api/device-mix${as ? `?as=${encodeURIComponent(as)}` : ''}`);
export const fetchStrivenPO = () => get<PoResult>('/api/po');
export const fetchStrivenCustomers = () => get<CustomersResult>('/api/customers');
export const fetchStrivenVendors = () => get<VendorsResult>('/api/vendors');
export const fetchStrivenItems = () => get<ItemsResult>('/api/items');
export const fetchStrivenTrends = () => get<TrendsResult>('/api/trends');
export const fetchStrivenPODetail = (id: number) => get<PoDetail>(`/api/po/${id}`);
export const fetchStrivenSODetail = (id: number) => get<SoDetail>(`/api/so/${id}`);
export const fetchStrivenPayments = () => get<PaymentsResult>('/api/payments');
export const fetchStrivenBillPayments = () => get<BillPaymentsResult>('/api/billpayments');

export type ExceptionGroup = { key: string; severity: 'high' | 'warn' | 'info'; title: string; count: number; value?: number; note: string; columns: string[]; rows: Record<string, string | number>[] };
export type ExceptionsResult = { totalOpen: number; groups: ExceptionGroup[]; note: string };
export const fetchStrivenExceptions = () => get<ExceptionsResult>('/api/exceptions');

// ── QuickBooks Online ──────────────────────────────────────────────────────
export type QbStatus = { connected: boolean; env: 'sandbox' | 'production'; configured?: boolean; realmId?: string; company?: string; country?: string; connectedAt?: string | null; error?: string };
export type QbPosted = { invoiceId: string; docNumber: string; total?: number; customer?: string; at: string };
export type QbPostResult = { ok: boolean; invoice?: QbPosted; steps?: { step: string; action: string; name: string; id: string }[]; soNumber?: string; alreadyPosted?: QbPosted; message?: string };

/** For customers, `missingInQb[].name` carries a PT-<id> REFERENCE (phi=true), not a patient name.
 *  For vendors, `missingInQb[].ref` (VN-<id>) is a display alias: `name` (the real vendor name) is still what QB stores. */
export type QbReconcile = { strivenCount: number; qbCount: number; matchedCount: number; missingCount: number; missingInQb: { name: string; ref?: string }[]; phi?: boolean };
export type QbCreateMissingResult = { kind: string; created: { name: string; id: string }[]; createdCount: number; failed: { name: string; error: string }[]; remaining: number; totalMissing: number };
export type QbEntityKind = 'customers' | 'vendors' | 'items';

/** `customer` is a PT-<id> REFERENCE, never a patient name (PHI stays server-side). */
export type QbInvoiceRow = { id: number; number: string; customer: string; date: string | null; total: number; open: number; posted: QbPosted | null };
export type QbInvoicesResult = { count: number; postedCount: number; invoices: QbInvoiceRow[] };
export type QbPlanLine = { name: string; qty: number; unit: number; amount: number; item: { status: 'matched' | 'create'; id?: string; qbName?: string } };
export type QbInvoiceDocPlan = {
  invoice: { id: number; number: string; date: string | null; dueDate: string | null; customerRef: string; order: string };
  customer: { status: 'matched' | 'create'; ref: string; id?: string };
  lines: QbPlanLine[];
  computedTotal: number;
  alreadyPosted: QbPosted | null;
  warnings: string[];
};

export const fetchQbStatus = () => get<QbStatus>('/api/qb/status');
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

// ── Reports (vendor purchases, patient orders): cancelled excluded ─────────
export type ReportVendorItem = { item: string; qty: number; cost: number; poCount: number };
export type ReportVendor = { vendor: string; poCount: number; totalCost: number; items: ReportVendorItem[] };
export type VendorItemsReport = { vendors: ReportVendor[]; count: number; generatedAt: string | null; note: string };
export type ReportPatientItem = { item: string; qty: number; value: number; soCount: number };
/** Patients are identified ONLY by a reference (PT-<Striven customer id>): names are PHI and are never sent to the browser. */
export type ReportPatient = { ref: string; soCount: number; totalValue: number; items: ReportPatientItem[] };
// SO-wise row (client SOW): one per sales order. `ref` = the shared patient
// reference (273/316-style); `lastName` = minimum-necessary PHI; `incomplete` =
// detail fetch failed so it's a flagged placeholder, not dropped.
export type ReportOrder = { soId: number; so: string; ref: string; custRef?: string; lastName: string; program: string; date: string | null; value: number; items: { item: string; qty: number; value: number }[]; incomplete?: boolean };
export type PatientItemsReport = { patients: ReportPatient[]; orders?: ReportOrder[]; count: number; orderCount?: number; generatedAt: string | null; note: string };
export const fetchVendorItemsReport = () => get<VendorItemsReport>('/api/reports/vendor-items');
export const fetchPatientItemsReport = () => get<PatientItemsReport>('/api/reports/patient-items');

// ── Auto-PO (Sales Order → vendor Purchase Order) ────────────────────────────
/** One recent sales order the user can raise a PO for. `ref` is id-based (SO-<id>);
 *  patient names never reach the browser. `testy` = passes the pilot demo/test gate. */
export type AutoPoCandidate = { soId: number; ref: string; date: string | null; kind: string; testy: boolean; hasPo: boolean };
export type AutoPoCandidatesResult = { ok: boolean; mode: 'dry' | 'live'; demoOnly: boolean; candidates: AutoPoCandidate[] };
/** SO→PO run result, GROUPED BY VENDOR: `pos` = one PO per vendor (all its items);
 *  `unmatched` = items with no vendor. In dry mode `poId` is null. */
export type AutoPoPoItem = { itemName: string; qty: number; unit?: number | null };
export type AutoPoPoGroup = { poId: number | null; vendor: string; vendorEmail?: string; items: AutoPoPoItem[]; dryRun?: boolean };
export type AutoPoUnmatched = { itemId?: number | null; itemName: string; qty: number; reason?: string };
export type AutoPoEntry = { at: string; soId: number; type: string; mode: 'dry' | 'live'; pos: AutoPoPoGroup[]; unmatched: AutoPoUnmatched[]; skipped?: string };
export type AutoPoRunResult = { ok: boolean; mode: 'dry' | 'live'; demoOnly?: boolean; note?: string; processed?: AutoPoEntry[]; checkpoint?: number };

/** Instant preview: order items GROUPED BY reports-vendor; `pending` = items with
 *  no reports match (usually still resolve from a prior PO at generate time). */
export type AutoPoPreview = {
  ok: boolean; soId: number; ref: string; type: string; testy: boolean; demoOnly: boolean;
  orderDate: string | null; lineCount: number;
  vendorGroups: { vendor: string; items: AutoPoPoItem[] }[];
  pending: AutoPoPoItem[];
};
export type AutoPoPdf = { ok: boolean; poId: number; filename: string; size: number; pdfBase64: string };
export type AutoPoEmailResult = { ok: boolean; poId?: number; to?: string; id?: string | null; error?: string };

export const fetchAutoPoCandidates = () => get<AutoPoCandidatesResult>('/api/auto-po?action=candidates');
export const fetchAutoPoPreview = (soId: number) => get<AutoPoPreview>(`/api/auto-po?action=preview&so=${soId}`);
export const fetchAutoPoPdf = (poId: number) => get<AutoPoPdf>(`/api/auto-po?action=pdf&po=${poId}`);
/** Render the email that WOULD be sent (subject + HTML body + resolved vendor email) without sending. */
export type AutoPoEmailPreview = { ok: boolean; poId: number; subject: string; vendor: string; vendorEmail: string; html: string };
export const fetchAutoPoEmailPreview = (poId: number) => get<AutoPoEmailPreview>(`/api/auto-po?action=email-preview&po=${poId}`);
/** POs already created for a sales order: so an already-processed order still shows its delivery step. */
export type AutoPoSoPos = { ok: boolean; soId: number; pos: AutoPoPoGroup[] };
export const fetchAutoPoSoPos = (soId: number) => get<AutoPoSoPos>(`/api/auto-po?action=so-pos&so=${soId}`);
export const autoPoSendEmail = (poId: number, to: string, subject?: string, body?: string) =>
  get<AutoPoEmailResult>(`/api/auto-po?action=email&po=${poId}&to=${encodeURIComponent(to)}${subject ? `&subject=${encodeURIComponent(subject)}` : ''}${body ? `&body=${encodeURIComponent(body)}` : ''}`);
/** Actually create the vendor PO(s) in Striven for one SO (live). Demo-gated server-side. */
export const autoPoRaise = (soId: number) => get<AutoPoRunResult>(`/api/auto-po?so=${soId}&mode=live`);

// ── Auto-SO (recurring resupply) ─────────────────────────────────────────────
/** READ-ONLY resupply candidate: a patient's most recent order + how long ago it
 *  was, so staff can see who's due and draft a repeat. `lastName` is minimum-
 *  necessary PHI (authorized); creates nothing. */
export type AutoSoItem = { item: string; qty: number };
export type AutoSoCandidate = { patient: string; lastName: string; program: string; orderCount: number; lastSo: string; lastSoId: number; lastDate: string | null; daysSince: number | null; due: boolean; items: AutoSoItem[]; value: number };
export type AutoSoResult = { ok: boolean; ready: boolean; note?: string; dueDays?: number; count?: number; dueCount?: number; demoOnly?: boolean; generatedAt?: string | null; candidates: AutoSoCandidate[] };
export const fetchAutoSoCandidates = () => get<AutoSoResult>('/api/auto-so?action=candidates');
/** Dry preview of the resupply SO that WOULD be created (no write). */
export type AutoSoPreview = { ok: boolean; mode: 'dry'; demoOnly: boolean; testy: boolean; templateSo: string; customerId: number | null; type: string; itemCount: number; items: { itemName: string; qty: number }[] };
export const fetchAutoSoPreview = (soId: number) => get<AutoSoPreview>(`/api/auto-so?action=preview&so=${soId}`);
/** Create the resupply SO in Striven (live). Demo-gated + idempotent server-side. */
export type AutoSoEntry = { at: string; templateSoId: number; mode: string; testy: boolean; ref: string; skipped?: string; dryRun?: boolean; itemCount?: number; createdSoId?: number | null };
export type AutoSoRunResult = { ok: boolean; mode: 'dry' | 'live'; demoOnly?: boolean; processed?: AutoSoEntry[]; createdSoId?: number | null };
/** Create the resupply SO (live). */
export const autoSoCreate = (soId: number) => get<AutoSoRunResult>(`/api/auto-so?so=${soId}&mode=live`);

// ── Shipment tracking (vendor tracking # → live carrier status via Shippo) ──
export type TrackingEntry = {
  id: string; patient: string; vendor: string; tn: string; addedAt: string | null;
  carrier: string; carrierName: string; trackingUrl: string;
  status: string; statusRaw: string; detail: string; eta: string | null; statusUpdatedAt: string | null; location: string; lookupError: string | null;
};
export type TrackingResult = { ok: boolean; configured: boolean; count: number; entries: TrackingEntry[] };
export const fetchTracking = () => get<TrackingResult>('/api/tracking?action=list');

// ── Commission (accrual from Crystal's commission workbook sheets) ──
export type CommissionLine = { ref: string; device: string; prog: 'TriCare' | 'VA' | 'PI'; comm: number; status: 'same' | 'diff' | 'none'; under: string | null };
export type CommissionRecon = {
  same: number; diff: number; none: number;
  commSame: number; commDiff: number; commNone: number;
  bookedUnder: { rep: string; count: number }[];
  lines: CommissionLine[];
};
/** Orders booked per vertical. Non-financial, so it survives redaction and is
 *  visible for EVERY rep: the one part of another rep's row a rep may see. */
export type OrderCounts = { TriCare: number; VA: number; PI: number; DOL: number };
export type CommissionRep = {
  rep: string;
  // Dollar fields are `null` when the row belongs to another rep: the server
  // redacts them before serialization, so there is nothing to hide client-side.
  tricare: number | null; pi: number | null; va: number | null; total: number | null;
  payableTotal: number | null;   // fillable + reimbursed → payable/due
  waitingTotal: number | null;   // waiting for reimbursement → pending
  count: number;
  // CFO reconciliation vs Striven order attribution
  strivenOrders: number; strivenUnits: number; strivenValue: number | null;
  commPerOrder: number | null; pctOfValue: number | null;
  matchRate: number | null;
  recon: CommissionRecon | null;  // financial → own row only
  orderCounts: OrderCounts;
  verified: boolean;              // sheet figures reconcile → authoritative
  redacted?: boolean;
  flag: 'no-striven' | 'high-ratio' | 'attribution' | null;
};
export type CommissionPeriodRep = { rep: string; tricare: number | null; va: number | null; pi: number | null; total: number | null; count: number; redacted?: boolean };
export type CommissionPeriod = { workbook: string; gid: string; label: string; key: string; lines: number; total: number; reps: CommissionPeriodRep[] };
export type ReconcileRep = { rep: string; sheet: number | null; striven: number | null; sheetProg: { TriCare: number; VA: number; PI: number } | null; strivenProg: { TriCare: number; VA: number; PI: number } | null; sheetProgLines?: { TriCare: number; VA: number; PI: number }; strivenProgOrders?: { TriCare: number; VA: number; PI: number }; lines: number; orders: number; matchRate: number | null; diff: number | null; onSheet: boolean; inStriven: boolean; redacted?: boolean };
export type CommissionReconcile = { reps: ReconcileRep[]; totals: { sheet: number | null; striven: number | null; diff: number | null } };
// Commission computed FROM Striven (rate card): sheet-shaped (monthly + program).
/** Commission state for one order, from the label rules. `hold` never appears: *  held orders are excluded from the calculation and produce no line. */
/** `paid` is money that has already gone out — still the rep's, still in their
 *  total, no longer owed. Which months count as paid is COMMISSION_PAID_THROUGH,
 *  per vertical, on the server. */
export type CommState = 'payable' | 'waiting' | 'paid';
/** `patient` is the SURNAME only, and only on the rep's own orders: the one
 *  place PHI is deliberately surfaced, so a rep can reconcile a line against
 *  their own records. Empty when the report cache has no row for the order. */
export type StrivenOrderLine = { ref: string; patient?: string; item: string; prog: 'TriCare' | 'VA' | 'PI' | 'DOL'; value: number; units: number; comm: number; state: CommState;
  /** When the SALES ORDER was raised — not the payout cycle. null on a row that
   *  ties to no live Striven order, which has no date to show. */
  date?: string | null;
  /** Set when the reconciliation sheet could not tie this row to a Striven
   *  record. The line is still paid; the remark says the match is missing. */
  unmatched?: boolean };
/** nTricare/nVa/nPi are ORDERS per vertical; uTricare/… are units per vertical. */
/** Volume fields (`orders`, `units`, `nTricare`/`nVa`/`nPi`) are the FULL order
 *  book from Striven. `commOrders`/`commUnits` are the subset the commission was
 *  actually computed on: the two differ wherever an order could not be tied to
 *  device lines, which is why a rep can show real orders against $0. */
export type StrivenCommRep = {
  commOrders?: number; commUnits?: number;
  rep: string; tricare: number | null; va: number | null; pi: number | null; total: number | null;
  payableTotal: number | null; waitingTotal: number | null;
  /** Already paid out. Part of `total`, deliberately NOT part of `payableTotal`
   *  — a rep is not owed money they have already had. */
  paidTotal?: number | null;
  orders: number; units: number; value: number | null;
  nTricare?: number; nVa?: number; nPi?: number; uTricare?: number; uVa?: number; uPi?: number;
  lines?: StrivenOrderLine[]; redacted?: boolean;
};
/** A month here is a PAYOUT CYCLE: the commission the 15th-of-next-month run
 *  signed off for that month, straight off the reconciliation sheet. Volume
 *  (`orders`, `units`) still comes from the order book — a different question
 *  from what is owed, and deliberately not conflated with it.
 *
 *  `reconciled` false means the month has no payout run yet: it is still being
 *  booked, nothing in it is payable, and its earnings sit in `waitingTotal`. */
export type StrivenCommMonth = { month: string; total: number | null; TriCare: number | null; VA: number | null; PI: number | null; orders: number; units: number; value: number | null; oTriCare?: number; oVA?: number; oPI?: number; payableTotal?: number | null; waitingTotal?: number | null; paidTotal?: number | null; reconciled?: boolean; reps: StrivenCommRep[] };
export type StrivenCommission = {
  available: boolean; grandTotal: number | null;
  payableTotal?: number | null; waitingTotal?: number | null; heldOrders?: number;
  /** Commission already paid out, and the per-vertical cut-off that decided it
   *  (vertical → last paid month, inclusive). */
  paidTotal?: number | null; paidThrough?: Record<string, string>;
  zeroValueOrders?: number;                              // $0 order value → earns nothing
  byProgram: { TriCare: number | null; VA: number | null; PI: number | null };
  byProgramOrders?: { TriCare: number; VA: number; PI: number };
  months: StrivenCommMonth[]; byRep: StrivenCommRep[];
  /** Orders the commission engine could price, and the full book it sits in. */
  commissionedOrders?: number; bookOrders?: number;
  /** Volume booked to someone off the rep roster. Rendered as its own row so
   *  the table's columns tie to the order book instead of falling short. */
  offRoster?: {
    orders: number; units: number; value: number;
    nTricare: number; nVa: number; nPi: number; reps: string[];
  };
  rateGaps?: string[];                                   // devices priced off the fallback
  unmatched?: UnmatchedOrder[];                          // no sales order → not commissioned
  unmatchedValue?: number;
  rateCard: { program: string; note: string; exact: boolean }[];
};
/** An order with no usable sales order. It earns no commission, but the vertical
 *  and volume are real, so they are reported rather than dropped. */
export type UnmatchedOrder = {
  soId: string; ref: string; prog: string; rep: string | null;
  item: string; itemCount: number; units: number; value: number;
  status: string; reason: string;
};
export type CommissionResult = {
  ok: boolean; configured?: boolean; note?: string;
  grandTotal: number | null; byProgram: { TriCare: number | null; PI: number | null; VA: number | null };
  byProgramCount?: { TriCare: number; PI: number; VA: number };
  payableTotal?: number | null; waitingTotal?: number | null; heldOrders?: number;
  minMatchRate?: number;
  scopedToRep?: string | null;      // set when the payload was scoped to one rep
  reps: CommissionRep[]; periods: CommissionPeriod[]; periodCount: number; itemCount: number;
  /** Producing reps — the names the admin "View as" picker offers, matching the
   *  Reps section. Empty for a rep: it is an admin control, and a list of names
   *  is peer disclosure. */
  roster?: string[];
  sheetsRead: number; sheetsConfigured: number; errors: string[];
  sources: { label: string; url: string }[]; striven?: StrivenCommission; reconcile?: CommissionReconcile;
};
/** `as` is an ADMIN-ONLY preview of one rep's view. It can only narrow what the
 *  server returns: a rep-role session passing it is ignored. */
/** `fresh` forces a re-read of the reconciliation sheet rather than serving the
 *  server's cached copy. Pass it on a page load and on an explicit Refresh, so
 *  an edit to the sheet is on screen as soon as someone reloads; leave it off
 *  for the background poll, which would otherwise re-fetch Google every two
 *  minutes per open tab to catch an edit nobody made. */
export const fetchCommission = (as?: string | null, fresh = false) => {
  const q = new URLSearchParams();
  if (as) q.set('as', as);
  if (fresh) q.set('fresh', '1');
  return get<CommissionResult>(`/api/commission${q.toString() ? `?${q}` : ''}`);
};

// ── Order analytics (revenue / accounts / devices) ──────────────────────────
/** One PHI-safe row per order. `account` is the PAYER: Veterans Affairs,
 *  TriCare, or the PI law firm: never the Striven customer, which is a patient. */
export type AnalyticsDevice = { item: string; qty: number };
export type AnalyticsOrder = {
  ref: string; soId: string; date: string | null;
  /** Mirrors soClass(): one bucket per Striven sales order type. */
  vertical: 'PI' | 'VA' | 'DOL' | 'TriCare' | 'DEMO' | 'Contract' | 'Other';
  account: string; rep: string;
  /** Patient SURNAME only — never a first name. How a rep recognises the order,
   *  since "SO-476" means nothing to them. Empty when the report cache has no
   *  row for this SO yet. */
  patient: string;
  revenue: number; units: number; devices: AnalyticsDevice[];
  status: string; invStatus: string;
  /** Carrier tracking number(s) from Striven, as the RAW string it holds —
   *  which is a comma-separated list when an order shipped in more than one
   *  parcel. Use `shipments` to render; this is for search and exports.
   *  EMPTY ON MOST ORDERS, so every reader has to handle the blank case. Not
   *  redacted for a rep: it is operational, not financial. */
  tracking?: string;
  /** One entry per parcel. `carrier` comes from Striven's own Ship Via, falling
   *  back to the number's format, and carries a deep link to that carrier's
   *  tracking page. Null when neither names a carrier — the number still shows,
   *  unlinked, rather than pointing at a guess. */
  shipments?: { tn: string; carrier: { code: string; name: string; url: string } | null }[];
  /** Striven's own "Ship Via" text on the order, e.g. "UPS" / "Fed Ex". */
  shipVia?: string;
  daysSinceUpdate: number | null;   // interim ageing proxy
  ageDays: number | null;
};
export type OrderAnalytics = {
  ok: boolean; scopedToRep: string | null; verticals: string[];
  orders: AnalyticsOrder[]; generatedAt: string;
  /** Cancelled orders are dropped from every figure, but reported so the
   *  exclusion is visible rather than a silent gap against Striven's count. */
  excludedCancelled?: number; excludedCancelledValue?: number;
};
export const fetchOrderAnalytics = (as?: string | null) =>
  get<OrderAnalytics>(`/api/order-analytics${as ? `?as=${encodeURIComponent(as)}` : ''}`);

// ── Saved dashboard views ────────────────────────────────────────────────────
/** A named filter set, stored per signed-in user. */
export type DashFilters = { preset: string; from: string; to: string; vert: string };
export type SavedView = { id: string; name: string; filters: DashFilters; savedAt: string };
export const fetchViews = () => get<{ ok: boolean; views: SavedView[] }>('/api/views');
export const saveView = (name: string, filters: DashFilters) =>
  postJson<{ ok: boolean; views: SavedView[]; error?: string }>('/api/views', { name, filters });
export const deleteView = (id: string) =>
  postJson<{ ok: boolean; views: SavedView[]; error?: string }>('/api/views', { delete: id });

// ── Rep overview ─────────────────────────────────────────────────────────────
/** Money fields are `null` on another rep's row: stripped server-side. Counts
 *  always survive, so volume is shared across the team but pay is not. */
export type RepVertical = { vertical: string; orders: number; units: number | null; revenue: number | null };
export type RepRow = {
  rep: string; isSelf: boolean; own: boolean;
  /** House/ops/departed names: they carry orders but are not ranked. */
  standingsExcluded?: boolean;
  /** Position on the all-time board by order count, 1-based, stamped over the
   *  WHOLE producing field BEFORE any row is withheld. A viewer who may not see
   *  a rep (REP_BLINDSPOTS) therefore gets a gap in the numbering rather than
   *  everyone below being promoted: Jillian reads 2nd with no 1st on screen,
   *  instead of being told she leads a board Alle is missing from. */
  rank?: number;
  /** POSITION ON THIS VIEWER'S BOARD — contiguous over the rows they actually
   *  receive, so a withheld rep does not leave a hole in the numbering. Draw
   *  this. Never make a CLAIM about standing from it: with a rep withheld it can
   *  say 1st for someone who is 2nd. `rank` above is the truth. */
  boardRank?: number;
  /** Set to the supervisor's name when this rep works under the VIEWER — so
   *  Alle's login can mark Jillian's row as hers. Display only: the row carries
   *  no more than any other peer's, and nothing rolls up into the supervisor's
   *  own figures. Null for everyone else, including on other reps' logins, so
   *  the reporting line is not broadcast to the rest of the team. */
  subRepOf?: string | null;
  /** `orders` is the one metric always shared: it drives Team Standings.
   *  units/accounts/devices are null for other reps when STANDINGS_ORDERS_ONLY. */
  /** Distinct payers billed: the law firm on a PI order, Veterans Affairs on a
   *  VA order, TriCare on a Tri-Care order. Blank payers are not counted. */
  orders: number; units: number | null; accounts: number | null; devices: number | null;
  /** How many verticals this rep has orders in. */
  verticals: number | null;
  lastOrder: string | null;
  byVertical: RepVertical[];
  /** The same row cut by calendar month ('2026-08'), oldest first, for the
   *  leaderboard's period selector. Only months this rep booked in appear.
   *  Derived from the same orders the aggregate counts, so a month can never
   *  disagree with the total it sums into. `units` follows the same redaction
   *  as the aggregate — null on a peer row under STANDINGS_ORDERS_ONLY. */
  /** `rank` here is the position IN THAT MONTH, stamped over the whole
   *  producing field just as the row-level one is — so a period selector cannot
   *  fall back to array position and promote a rep over a row the viewer was
   *  not sent. Only months the rep booked in carry one. */
  byMonth?: { month: string; orders: number; units: number | null; revenue: number | null; accounts: number | null; rank?: number; boardRank?: number; byVertical: RepVertical[] }[];
  /** COMMISSION DUE — signed-off and not yet paid — split by vertical and by
   *  month. Cut by the SALES ORDER's date so it shares a basis with the order
   *  counts beside it; `undated` is the part that ties to no live order and so
   *  belongs to no month, reported rather than absorbed. Money, so it is null
   *  on a peer row exactly as `commission` is. */
  commissionDue?: {
    total: number; undated: number;
    /** Paid commission that ties to no live order, so it belongs to no month. */
    paidUndated?: number;
    byVertical: Record<string, number>;
    /** `total` is OWED. `paid` has already gone out and `earned` is the two
     *  together — the month equivalent of the row's `commission`, which is why
     *  a month view can show Commission and Payable on the same basis. */
    byMonth: { month: string; total: number; paid?: number; earned?: number; byVertical: Record<string, number> }[];
  } | null;
  /** PAY, BY PAYOUT CYCLE — the exact rows the Commission tab renders, so the
   *  two pages report the same figure for the same month. Cut by the cycle the
   *  money goes out in, NOT by the sales order's date: the same lines bucketed
   *  by order date gave Jillian $6,646 for July against the Commission tab's
   *  $21,946, and stranded $28,526 of hers in no month at all. `null` on a peer
   *  row, exactly as the aggregates below are. */
  commissionByCycle?: { month: string; paid: number; payable: number; waiting: number; total: number }[] | null;
  revenue: number | null; commission: number | null; payable: number | null; waiting: number | null;
  matchRate: number | null; verified: boolean;
};
export type RepOverview = {
  ok: boolean; role: 'admin' | 'rep'; me: string | null; verticals: string[];
  /** Every month the shown book touches ('2026-04' … ), oldest first. Built from
   *  the rows, so it never offers a period with nothing to rank. */
  months?: string[];
  reps: RepRow[];
  /** A producing rep was withheld from this viewer, so `boardRank` is a
   *  renumbering of what they can see and not the true field position. */
  boardScoped?: boolean;
  /** All four figures describe the same set of orders: the rep-attributed book. */
  teamTotals: { reps: number; orders: number; units: number | null; accounts: number | null; revenue: number | null; commission: number | null };
  /** The same totals cut by month, for the team table's period selector. Needed
   *  on the server rather than summed on the client because `accounts` is a
   *  DISTINCT payer count — two reps billing one law firm are one payer, and
   *  adding their row figures counts it twice. Commission is not here: money
   *  sums cleanly, so the footer adds the rendered rows. */
  teamByMonth?: { month: string; orders: number; units: number; revenue: number | null; accounts: number | null }[];
  /** Orders booked in Striven to someone who is not a rep. Reported separately so
   *  the gap against the full order book is explained rather than puzzling. */
  /** The rest of the book: booked to someone off the rep roster. `units` is
   *  what reconciles the Devices KPI against Orders & Revenue. */
  unattributed: { orders: number; revenue: number; units: number } | null;
  /** Whole-book totals, matching Orders & Revenue exactly. Admin only: a rep
   *  must not be able to derive the company book by subtracting their own row. */
  bookTotals: { orders: number; units: number; revenue: number; accounts: number } | null;
  bookOrders: number | null;
  excludedCancelled: number;
};
export const fetchRepOverview = (as?: string | null) =>
  get<RepOverview>(`/api/rep-overview${as ? `?as=${encodeURIComponent(as)}` : ''}`);

// ── PI stage pipeline ────────────────────────────────────────────────────────
/**
 * A stage name. Deliberately a plain string, not a union: the names come from
 * the server (PI_STAGES / PIP_STAGES) and the two pipelines have DIFFERENT
 * lists, so a fixed union here could only ever be wrong for one of them. The
 * union that used to live here had already drifted from the real stages.
 */
export type PiStageName = string;
/** The three pipelines this payload carries. PI and PIP split the PI vertical
 *  between them; VA is a vertical of its own, so the three books are disjoint
 *  and no order appears on two boards. */
export type PiBoard = 'PI' | 'PIP' | 'VA';
export type PiStageOrder = AnalyticsOrder & {
  /** Its CURRENT position: one stage, the furthest its labels reach. */
  stage: PiStageName;
  /** Every stage this order is listed under — one entry per stage its labels
   *  attest to. "Shipped, Waiting for first payment" appears at both, so an
   *  order can show on more than one card. Rows that are not label-driven have
   *  a single entry equal to `stage`. */
  stages?: PiStageName[];
  /** The exact labels Striven has on this order, in Striven's own wording. */
  labels?: string[];
  /** Labels on this order that no stage map recognises — a DEFECT. They
   *  contribute nothing, so the order falls back to stage 1 and reads as brand
   *  new, silently. Mapping the label is the fix. */
  unknown?: string[];
  /** Known EXCEPTION labels (HOLD, Attorney Denied, Case Dropped). The order has
   *  stopped rather than progressed, so these carry no stage by design; the
   *  order is a stalled case to chase, not a mapping bug. */
  flagged?: string[];
  /** Which board this order belongs to. */
  pipeline?: PiBoard;
  /** Where the stage came from, most authoritative first:
   *  'labels'  — derived from this order's Striven labels. NOT movable from the
   *              portal: the label is re-read on every load and would overwrite
   *              any move, so the UI offers no dropdown for these.
   *  'striven' — the mirrored Stage custom field
   *  'portal'  — moved by hand here
   *  'default' — nothing known; it sits in stage 1 */
  source?: 'labels' | 'striven' | 'portal' | 'default';
  stageSince: string | null;
  daysInStage: number | null;
  /** true when ageing falls back to the order date because the order has never
   *  been moved: measured ageing only starts at the first transition. */
  estimated: boolean;
  movedBy: string | null;
  history: { stage: string; at: string; by: string }[];
};
/** `count` is every order LISTED at this stage and OVERLAPS with other stages,
 *  so counts (and revenue/units with them) do not sum to the board total.
 *  `current` counts only orders whose current position is this stage, so those
 *  DO sum to the total — use it for anything expressing a share of the whole. */
export type PiStageBucket = { stage: PiStageName; count: number; current?: number; revenue: number; units: number; oldestDays: number; avgDays: number };
export type PiStages = {
  ok: boolean; scopedToRep: string | null; canEdit: boolean;
  stageNames: PiStageName[]; stages: PiStageBucket[]; orders: PiStageOrder[];
  /** PIP is a SEPARATE pipeline: it never reaches Lienstar, so it has its own
   *  stage list (no LOP, no settlement). Empty until the PIP order type exists
   *  in Striven, so the UI can render it unconditionally. */
  pipStageNames?: PiStageName[]; pipStages?: PiStageBucket[]; pipOrders?: PiStageOrder[];
  /** VA is a SEPARATE pipeline too, off the VA vertical rather than a label: no
   *  attorney, no lien, no settlement, and — unlike PI — a terminal 'Paid'
   *  stage, because that is where most of the VA book sits. */
  vaStageNames?: PiStageName[]; vaStages?: PiStageBucket[]; vaOrders?: PiStageOrder[];
  /** REVIEW QUEUE — orders whose labels place them in no stage, across every
   *  board, and the distinct labels behind them. Two reasons: 'flagged' (a
   *  known exception — HOLD, Attorney Denied, Case Dropped) and 'unknown' (a
   *  label nobody has mapped yet). ADMIN ONLY: acting on either means editing
   *  Striven, which is Crystal's call, so this is always empty for a rep. */
  reviewOrders?: PiStageOrder[];
  reviewLabels?: { label: string; reason: 'flagged' | 'unknown'; count: number; boards: PiBoard[] }[];
  trackedCount: number; autoFromTracking: boolean;
};
export const fetchPiStages = (as?: string | null) =>
  get<PiStages>(`/api/pi-stages${as ? `?as=${encodeURIComponent(as)}` : ''}`);
export const setPiStage = (soId: string, stage: PiStageName) =>
  postJson<{ ok: boolean; unchanged?: boolean; error?: string }>('/api/pi-stages', { soId, stage });

/** Who the signed-in caller is. Resolved server-side from the verified session
 *: never from a cookie the browser could set. */
export type Me = { email: string | null; repName: string | null; role: 'rep' | 'admin' };
export const fetchMe = () => get<Me>('/api/me');
/** Add a tracking row. Last name goes in the POST body (never the URL). */
export const trackingAdd = (e: { patient: string; vendor: string; carrier: string; tn: string }) => postJson<{ ok: boolean; id?: string; error?: string }>('/api/tracking?action=add', e);
export const trackingRemove = (id: string) => get<{ ok: boolean }>(`/api/tracking?action=remove&id=${encodeURIComponent(id)}`);

export type OrderPo = { ref: string; vendor: string; value: number; status: string };
export type OrderInv = { ref: string; total: number; open: number; status: string };
export type OrderRow = { ref: string; pi: string; type: string; rep: string; payer: string; value: number; lastName: string; item: string; itemCount: number; status: string; invStatus: string; pos: OrderPo[]; invoices: OrderInv[]; poValue: number; invOpen: number };
export type OrdersResult = { count: number; orders: OrderRow[]; enriched: boolean; phiMasked: boolean };
export const fetchStrivenOrders = () => get<OrdersResult>('/api/orders');
