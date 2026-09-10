import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMe } from '../strivenApi';
import { allowedViews } from './Sidebar';
import type { ViewKey } from '../CashflowApp';

/**
 * THE GLOSSARY — every term this portal puts on screen, what it means, how it
 * is calculated, and every screen it appears on.
 *
 * WRITTEN FOR THE PERSON SIGNING THE CHEQUES. Nearly every figure here is a
 * term of art with a rule behind it, and the rule is usually not the obvious
 * one: "AR Open" excludes 85% of a PI case on purpose, "Cash Received" is
 * all-time on one tab and year-to-date on another, "Bills Paid" only ever means
 * card charges. Those rules lived in code comments — the one place the people
 * reading the numbers never look.
 *
 * THE BASIS IS THE POINT. A definition tells an owner what a word means; the
 * BASIS tells them whether they can trust the number under it, and that is the
 * question actually being asked when someone opens this page. Every figure with
 * a calculation behind it shows that calculation. Where two similarly-named
 * figures compute differently — Collection Rate and A/R Health Score being the
 * live example — the two bases sit side by side and the difference is legible
 * instead of being discovered during a board meeting.
 *
 * ALPHABETICAL, GROUPED BY LETTER, WITH A JUMP BAR. A reference is entered at a
 * word, not read from the top, so the ordering has to be the one people already
 * know how to use.
 *
 * EVERY TERM CARRIES ALL ITS LOCATIONS. A term on four tabs lists four links,
 * because the second question after "what does this mean" is "where else does
 * this number appear, and is it the same number there". Where it is NOT the
 * same, the location says so.
 *
 * NAVIGATION IS THE HASH, NOT A PROP. CashflowApp already listens for
 * `hashchange` and routes through the same role gate the sidebar uses, so a
 * plain `<a href="#receivables">` is real, keyboard-navigable, role-checked
 * navigation. Locations are filtered against `allowedViews` — a rep who follows
 * a link to a company tab is bounced back by that gate, which reads as the app
 * being broken, so those links are never drawn.
 */

type Loc = {
  /** The tab to open. A real ViewKey — that is what makes the link work. */
  view: ViewKey;
  /** How the sidebar labels that tab, so the link matches what the user reads. */
  tab: string;
  /** The section within it. Named, not linked: sections carry no anchors yet. */
  section: string;
  /** Set only where the term means something DIFFERENT here. */
  differs?: string;
};

type Entry = {
  term: string;
  aka?: string[];
  cat: string;
  /** What it is, in the reader's terms. */
  def: string;
  /** HOW IT IS CALCULATED. Present only where a real calculation exists — a
   *  term with no arithmetic behind it must not be given a fake formula. */
  basis?: string;
  /** The caveat, the exclusion, or the thing that surprises people. */
  note?: string;
  locs: Loc[];
};

const CATS = ['Programmes', 'Receivables', 'Payables', 'Orders', 'Commission', 'Accounting', 'Data & status'] as const;

const GLOSSARY: Entry[] = [
  {
    term: 'Accrual vs cash', cat: 'Accounting',
    def: 'Accrual counts revenue when it is billed; cash counts it when the money actually arrives.',
    note: 'Revenue, the P&L and the cash-flow chart are ACCRUAL. Cash Received is CASH. They will not agree, and are not meant to.',
    locs: [
      { view: 'pl', tab: 'P&L', section: 'Source toggle · Income Statement' },
      { view: 'overview', tab: 'Overview', section: 'Revenue vs Expense · Cash Flow Overview' },
    ],
  },
  {
    term: 'Aging bucket', aka: ['Current', '1–30', '31–60', '61–90', '90+'], cat: 'Receivables',
    def: 'How overdue a balance is, measured in days past its due date.',
    basis: 'days past due = today − due date\nCurrent ≤ 0 · 1–30 · 31–60 · 61–90 · 90+',
    note: 'An order with no invoice has no due date and therefore no bucket — which is why the red not-invoiced rows disappear when an ageing filter is applied, rather than being filed under an age they do not have.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'AR Aging' },
      { view: 'payables', tab: 'AR / AP › Payables', section: 'AP Aging' },
      { view: 'apsheet', tab: 'AP Register', section: 'AP Aging' },
      { view: 'overview', tab: 'Overview', section: 'AR Due · AP Due' },
    ],
  },
  {
    term: 'AP Open', aka: ['payables', 'open bills'], cat: 'Payables',
    def: 'What the business still owes its vendors on bills that have been received.',
    basis: 'billed − paid − credit notes, from the AP ledger sheet',
    note: 'The AP LEDGER SHEET is the real book here, not Striven: the sheet carries 133 bills where Striven carries four. Striven’s figure is kept beside it rather than discarded.',
    locs: [
      { view: 'payables', tab: 'AR / AP › Payables', section: 'AP Open · Open Bills' },
      { view: 'apsheet', tab: 'AP Register', section: 'Bill Register · Outstanding by Vendor' },
      { view: 'overview', tab: 'Overview', section: 'AP Due' },
    ],
  },
  {
    term: 'AP Register', aka: ['AP ledger'], cat: 'Accounting',
    def: 'The vendor bill ledger, kept by hand in a Google Sheet and read directly from it.',
    note: 'Not Striven, and the more complete of the two books on the payables side.',
    locs: [{ view: 'apsheet', tab: 'AP Register', section: 'Bill Register · SUB-LEDGER SUMMARY' }],
  },
  {
    term: 'AR Open', aka: ['receivable', 'outstanding', 'open balance'], cat: 'Receivables',
    def: 'What customers still owe on invoices that have been raised. This is the headline receivable.',
    basis: 'PI      min(unpaid on invoice, 15% × order value)\nothers  unpaid on invoice, net of unapplied credit\ntotal   Σ over non-void invoices with a balance',
    note: 'On PI the 85% lien remainder is NOT counted. It settles out of an award on nobody’s timetable, so it is exposure rather than money that can be chased.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'AR Open tile · Open Invoices · AR Aging' },
      { view: 'overview', tab: 'Overview', section: 'AR Due · Receivables and Dues this month' },
      { view: 'arsheet', tab: 'AR Register', section: 'AR Receivable', differs: 'Reads the accountant’s Google Sheet, not Striven — the two books will not tie exactly.' },
    ],
  },
  {
    term: 'AR Register', cat: 'Accounting',
    def: 'The accountant’s own invoice workbook, read directly from their Google Sheet.',
    note: 'Not Striven. It will not reconcile exactly with the AR / AP tab, because they are two different books — which is what the “in Striven but not in the sheet” section exists to show.',
    locs: [{ view: 'arsheet', tab: 'AR Register', section: 'Invoice Book · in Striven but not in the sheet' }],
  },
  {
    term: 'A/R Health Score', cat: 'Receivables',
    def: 'How much of everything billed has actually turned into cash.',
    basis: 'cash received ÷ (cash received + AR open)\n≥90% Excellent · ≥75% Good · ≥60% Fair · else Low',
    note: 'NOT the same calculation as Collection Rate, despite both sounding like collection performance. This one divides by cash plus what is still owed; Collection Rate divides by revenue billed in the period. Compare the two bases before quoting either.',
    locs: [{ view: 'receivables', tab: 'AR / AP', section: 'A/R Health Score' }],
  },
  {
    term: 'Auto-PO', cat: 'Data & status',
    def: 'Raising a vendor purchase order automatically from a sales order, cloned from the most recent live PO that contained the same item.',
    note: 'Dry-run by default. Nothing is created in Striven unless it is explicitly switched to live mode.',
    locs: [{ view: 'automation', tab: 'Automation', section: 'Auto-PO' }],
  },
  {
    term: 'Auto-SO', cat: 'Data & status',
    def: 'Creating a repeat sales order for a patient due a resupply.',
    note: 'Same gate as Auto-PO: dry-run unless deliberately switched to live.',
    locs: [{ view: 'automation', tab: 'Automation', section: 'Auto-SO' }],
  },
  {
    term: 'Bills Paid', cat: 'Payables',
    def: 'Vendor bills that have been settled.',
    basis: 'Σ of the AP ledger sheet’s Debit column\n(Striven’s own figure = Σ credit-card charges only)',
    note: 'Striven’s record is CARD CHARGES ONLY — a bill paid by cheque or ACH never appears in it. That is why the totals come from the ledger sheet, which records all of them.',
    locs: [
      { view: 'payables', tab: 'AR / AP › Payables', section: 'Bills Paid' },
      { view: 'accounts', tab: 'Accounts', section: 'Bill Payments: Paid', differs: 'Same figure, reached from the accounting side.' },
    ],
  },
  {
    term: 'Case value', aka: ['order value', 'gross', 'lien exposure'], cat: 'Receivables',
    def: 'The full value of the sales order behind a PI invoice — the device price the case was written for.',
    basis: 'read from the sales order · never derived from the invoice\nlien exposure = case value − invoiced',
    note: 'Shown for context and never added into a receivable total. Real money, but not money you can invoice for today.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Open Invoices (Total Amount column)' },
      { view: 'arsheet', tab: 'AR Register', section: 'TOTAL column' },
    ],
  },
  {
    term: 'Cash Received', aka: ['collections', 'payments received'], cat: 'Receivables',
    def: 'Customer payments recorded in Striven — money actually in the door.',
    basis: 'Σ payment amount, gross\nvoided / cancelled / denied payments excluded\nincludes credits not yet applied to an invoice',
    note: 'Read the period carefully: the AR tile is ALL-TIME while the arrow beneath it compares the last two complete months, and the P&L tile is year-to-date because the payments endpoint takes no period.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Cash Received tile · Cash Received by Month', differs: 'The tile is all-time; the chart beside it is monthly.' },
      { view: 'accounts', tab: 'Accounts', section: 'Payments Received by Month · Recent Payments Received' },
      { view: 'pl', tab: 'P&L', section: 'Cash Received tile', differs: 'Year to date, not all-time.' },
      { view: 'overview', tab: 'Overview', section: 'Cash Received · Collection Rate' },
    ],
  },
  {
    term: 'Chart of accounts', aka: ['GL', 'general ledger'], cat: 'Accounting',
    def: 'Every general-ledger account, by type.',
    note: 'No running balances, and that is correct rather than missing: Striven’s API does not expose them — they exist only inside Striven’s own Report Builder — so no balance is invented here.',
    locs: [{ view: 'accounts', tab: 'Accounts', section: 'Chart of Accounts · Accounts by Type' }],
  },
  {
    term: 'Collection Rate', cat: 'Receivables',
    def: 'How much of what was billed in a period has come in as cash.',
    basis: 'cash received (period) ÷ revenue billed (period)\ncapped at 100%',
    note: 'Deliberately mixes two bases — cash over accrual — and that ratio is the point of the card. It is a DIFFERENT calculation from the A/R Health Score; see that entry.',
    locs: [{ view: 'overview', tab: 'Overview', section: 'Collection Rate' }],
  },
  {
    term: 'Commission payable', aka: ['commission due'], cat: 'Commission',
    def: 'What a rep has earned and is owed, before the payout run.',
    basis: 'the signed-off reconciliation sheet, auto-matched rows only\na rep absent from the sheet reads 0 — never their computed figure',
    note: 'Falling back to the computed figure would mix two bases in one column and make the total reconcile to nothing. A rep with no sheet row is marked “not in the reconciliation” rather than shown a bare zero.',
    locs: [
      { view: 'commission', tab: 'Commission', section: 'Payable / Due · per-rep breakdown' },
      { view: 'overview', tab: 'Overview', section: 'Commission Due' },
      { view: 'reps', tab: 'Dashboard', section: 'Commission tile' },
    ],
  },
  {
    term: 'Data sync', aka: ['cache', 'refresh', 'freshness'], cat: 'Data & status',
    def: 'How current the figures are. Base data is pulled from Striven on a six-hourly cycle and served from a cache in between.',
    note: 'Figures are not live to the second, and one or two derived datasets are rebuilt by hand rather than on the cycle — the sync panel reports the age of each.',
    locs: [{ view: 'automation', tab: 'Automation', section: 'Data sync' }],
  },
  {
    term: 'DEMO order', aka: ['test order'], cat: 'Programmes',
    def: 'A sales order raised for a demonstration or a test, not a real sale.',
    note: 'Counted in the order book — volume, value and its own DEMO vertical — so the portal matches Striven’s own list, but excluded from PO spend, commission and the rep leaderboard.',
    locs: [
      { view: 'exceptions', tab: 'Exceptions', section: 'DEMO / test sales orders' },
      { view: 'orders', tab: 'Orders', section: 'Sales Orders by Status' },
    ],
  },
  {
    term: 'DSO', aka: ['Days Sales Outstanding'], cat: 'Receivables',
    def: 'How long money sits out before it comes in — the average age of open receivables, weighted by amount.',
    basis: 'Σ(open × days overdue) ÷ Σ(open)\nover OPEN PI invoices only',
    note: 'PI only, by design. VA and TriCare pay on fixed cycles, so a DSO for them measures the cycle rather than performance.',
    locs: [{ view: 'receivables', tab: 'AR / AP', section: 'PI Days Sales Outstanding tile' }],
  },
  {
    term: 'Exception', cat: 'Data & status',
    def: 'A data anomaly worth someone’s attention — a voided invoice still carrying a balance, an order with no rep, an item with no price.',
    note: 'Each group states its own rule, including what it deliberately excludes.',
    locs: [
      { view: 'exceptions', tab: 'Exceptions', section: 'All groups' },
      { view: 'overview', tab: 'Overview', section: 'Items needing attention' },
    ],
  },
  {
    term: 'Expenses', cat: 'Accounting',
    def: 'What the business spent, on the operational view of the books.',
    basis: 'Σ vendor bill totals in the period · voided excluded\n(QuickBooks view: the posted P&L instead)',
    locs: [
      { view: 'pl', tab: 'P&L', section: 'Income Statement · Revenue vs Expenses by Month' },
      { view: 'overview', tab: 'Overview', section: 'Revenue vs Expense' },
    ],
  },
  {
    term: 'Fifteen percent advance', aka: ['15% advance', 'lien advance', 'PI advance', 'retainer'], cat: 'Receivables',
    def: 'The share of a PI order that is invoiced and collectable up front. The rest rides on the case.',
    basis: 'advance = order value × 0.15',
    note: 'The single most important rule in this portal. It is why a PI invoice total is far smaller than the order behind it, why AR Open is a fraction of the order book, and why a PI invoice at zero balance is not a settled case. Measured against the live book, 50 of 57 PI invoices sit at exactly 0.150 of their order.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Open Invoices (Invoiced column) · PI orders yet to be invoiced' },
      { view: 'arsheet', tab: 'AR Register', section: 'INVOICED column · the advance-vs-billed check' },
    ],
  },
  {
    term: 'Label', cat: 'Orders',
    def: 'A tag Striven carries on the sales order. Labels are what decide an order’s pipeline stage, and where HOLD and Waiting for Reimbursement live.',
    note: 'Not the same as Striven’s status, which only ever says In Progress or Completed. An order with no label cannot be placed past stage one and is listed for review instead of being guessed at.',
    locs: [
      { view: 'orders', tab: 'Orders', section: 'All Sales Orders (label column)' },
      { view: 'repspipeline', tab: 'PI & PIP', section: 'Orders needing review' },
      { view: 'overview', tab: 'Overview', section: 'Order status by Striven label' },
    ],
  },
  {
    term: 'Ledger open', cat: 'Receivables',
    def: 'Striven’s own unpaid balance for the invoice itself, kept beside the reported receivable.',
    basis: 'Striven open balance − unapplied credit applied to it',
    note: 'This is the figure to reconcile against Striven. Off PI it equals AR Open; on PI the two differ wherever the 15% cap bites.',
    locs: [{ view: 'receivables', tab: 'AR / AP', section: 'Open Invoices (Received column is derived from it)' }],
  },
  {
    term: 'Margin', aka: ['net', 'profit'], cat: 'Accounting',
    def: 'What is left after costs, as a share of revenue.',
    basis: 'net = revenue − expenses\nmargin = net ÷ revenue',
    note: 'Only meaningful when revenue and costs come from the same book — which is why the growth card reads the P&L rather than the order book.',
    locs: [
      { view: 'pl', tab: 'P&L', section: 'Income Statement' },
      { view: 'overview', tab: 'Overview', section: 'Cash Flow Overview (Profit · Margin)' },
      { view: 'reps', tab: 'Dashboard', section: 'Business Growth' },
    ],
  },
  {
    term: 'Not invoiced', aka: ['yet to be invoiced', 'pending invoice', 'unbilled'], cat: 'Receivables',
    def: 'A sales order that exists in Striven and has never had an invoice raised against it. Nothing on it is receivable yet.',
    basis: 'orders with zero linked invoices, cancelled and DEMO excluded\nwould add to AR = case value × 0.15  (PI)',
    note: 'Flagged in red and deliberately kept OUT of every AR total — it is not a receivable until it is raised. On the current book this is larger than the entire open receivable, which is exactly why it is shown.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'PI orders yet to be invoiced (the red panel)' },
      { view: 'receivables', tab: 'AR / AP', section: 'Open Invoices — red rows and the NOT INVOICED subtotal' },
    ],
  },
  {
    term: 'Order book', cat: 'Orders',
    def: 'Every live sales order and what it is worth.',
    basis: 'Σ order value · cancelled excluded · DEMO included',
    locs: [
      { view: 'overview', tab: 'Overview', section: 'Order book' },
      { view: 'orders', tab: 'Orders', section: 'Order Value by Type' },
    ],
  },
  {
    term: 'Payer', cat: 'Programmes',
    def: 'Who actually pays the bill: Veterans Affairs, TriCare, or — on PI — the individual law firm handling the claim.',
    note: 'Never the Striven customer, which on this book is a patient. The programme rule is taken from the VERTICAL, never from the payer text, because there are dozens of PI law firms and only one PI rule.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Open Invoices · Top Customers by Balance' },
      { view: 'overview', tab: 'Overview', section: 'AR Due (by payer)' },
      { view: 'repsorders', tab: 'Orders & Revenue', section: 'Accounts filter', differs: 'On the rep boards this is called the ACCOUNT.' },
    ],
  },
  {
    term: 'Payout cycle', aka: ['paid through'], cat: 'Commission',
    def: 'The month a commission actually leaves the bank. Everything after the configured paid-through month is payable rather than paid.',
    locs: [{ view: 'commission', tab: 'Commission', section: 'Paid / Payable / Waiting split' }],
  },
  {
    term: 'PHI masking', aka: ['PT- reference', 'patient reference'], cat: 'Data & status',
    def: 'A de-identified stand-in for a patient, e.g. PT-385. Where a name is shown it is a first INITIAL and a surname, never a full first name.',
    note: 'Minimum-necessary by design: full first names, dates of birth and addresses are never stored or cached anywhere in this portal, and access is audit-logged.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Open Invoices · Recent Payments' },
      { view: 'accounts', tab: 'Accounts', section: 'Recent Payments Received' },
      { view: 'reports', tab: 'Reports', section: 'Patient items' },
    ],
  },
  {
    term: 'PI', aka: ['Personal Injury', 'lien'], cat: 'Programmes',
    def: 'Personal Injury. The device is supplied against a lien on the patient’s legal claim, so the bill settles out of an eventual award rather than by an insurer on a cycle.',
    note: 'PI is the reason so much of this portal has a special case. Striven raises only the 15% advance as the invoice, so an invoice showing no balance means the ADVANCE is settled, not the case.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'AR Aging · Open Invoices · PI orders yet to be invoiced' },
      { view: 'arsheet', tab: 'AR Register', section: 'Invoice Book · AR Receivable' },
      { view: 'orders', tab: 'Orders', section: 'Order Value by Type · All Sales Orders' },
      { view: 'repspipeline', tab: 'PI & PIP', section: 'The PI stage board', differs: 'Here PI is a pipeline of stages, not a money basis.' },
      { view: 'commission', tab: 'Commission', section: 'Per-rep breakdown' },
    ],
  },
  {
    term: 'PIP', cat: 'Programmes',
    def: 'Personal Injury Protection. Reports as PI in the order book but settles through the patient’s own motor policy rather than a lien, so it never reaches a settlement negotiation.',
    note: 'It has its own three-stage board because its journey genuinely differs — Order received, Waiting on PIP Payment, Bill settled — against PI’s six.',
    locs: [
      { view: 'repspipeline', tab: 'PI & PIP', section: 'PIP board (beside the PI board)' },
      { view: 'commission', tab: 'Commission', section: 'Counted inside the PI vertical' },
    ],
  },
  {
    term: 'Purchase order', aka: ['PO'], cat: 'Orders',
    def: 'What the business buys from a vendor to fulfil a sales order.',
    basis: 'PO spend = Σ PO totals\ncancelled POs and POs raised for DEMO orders excluded',
    note: 'Cancelled POs are resolved from a shipped snapshot because Striven’s search endpoint omits status and fetching every detail live does not fit the request budget.',
    locs: [
      { view: 'orders', tab: 'Orders', section: 'All Purchase Orders · Top Vendors by PO Spend' },
      { view: 'vendors', tab: 'Vendors & Items', section: 'PO Spend by Vendor' },
      { view: 'payables', tab: 'AR / AP › Payables', section: 'Top Vendors by PO Spend' },
    ],
  },
  {
    term: 'Rate gap', cat: 'Commission',
    def: 'A device with no confirmed commission rate, priced from a per-programme fallback instead.',
    note: 'Counted and reported rather than hidden, so an unpriced device is visible instead of being quietly commissioned at the wrong number.',
    locs: [{ view: 'commission', tab: 'Commission', section: 'Rate gaps' }],
  },
  {
    term: 'Revenue', cat: 'Accounting',
    def: 'What the business billed, on the operational view of the books.',
    basis: 'Σ invoice totals in the period · voided excluded · ACCRUAL\n(QuickBooks view: the posted P&L instead)',
    note: 'On PI an invoice is only the 15% advance, so PI revenue here is the advance billed, not the case value written.',
    locs: [
      { view: 'pl', tab: 'P&L', section: 'Income Statement · Monthly P&L' },
      { view: 'overview', tab: 'Overview', section: 'Revenue · Revenue vs Expense' },
    ],
  },
  {
    term: 'Sales order', aka: ['SO', 'order'], cat: 'Orders',
    def: 'The record of what was sold to a patient: the devices, the programme, the rep and the value. Everything downstream links back to it.',
    note: 'On PI the sales order carries the real value of the case; the invoice raised against it carries only the advance.',
    locs: [
      { view: 'orders', tab: 'Orders', section: 'All Sales Orders · Sales Orders by Status' },
      { view: 'repsorders', tab: 'Orders & Revenue', section: 'The order table', differs: 'Scoped to the signed-in rep, with money withheld.' },
      { view: 'overview', tab: 'Overview', section: 'Order book' },
    ],
  },
  {
    term: 'Stage', cat: 'Orders',
    def: 'Where an order sits on its programme’s journey — Order received, LOP requested, Waiting for settlement, and so on.',
    note: 'Seeded from the order’s Striven LABEL and then overridable by hand. A manual move is stored in this portal and does NOT write back to Striven. PI, PIP and VA each have their own stage list.',
    locs: [
      { view: 'repspipeline', tab: 'PI & PIP', section: 'The stage columns' },
      { view: 'vapipeline', tab: 'VA Pipeline', section: 'The stage columns' },
    ],
  },
  {
    term: 'Striven payable', cat: 'Commission',
    def: 'What the portal’s own engine calculates a rep is owed, carried beside the signed-off sheet figure.',
    basis: 'Σ (units × per-device rate) across the rep’s orders',
    note: 'It disagrees with the reconciliation sheet by roughly $98k. Both are shown on purpose — a page that shows one without the other cannot explain itself.',
    locs: [{ view: 'commission', tab: 'Commission', section: 'Beside the payable total' }],
  },
  {
    term: 'Sub-ledger', cat: 'Payables',
    def: 'One vendor’s block of the AP ledger sheet — their bills, their payments and their running outstanding.',
    note: 'Payments with no invoice on the sheet to account for them are surfaced rather than netted away: obtain the bill and the row reconciles.',
    locs: [{ view: 'apsheet', tab: 'AP Register', section: 'SUB-LEDGER SUMMARY' }],
  },
  {
    term: 'System of record', cat: 'Accounting',
    def: 'QuickBooks Online. The books an accountant would close the year on.',
    note: 'It can only report on documents posted to it, and this portal posts invoices one at a time on request — so a QuickBooks figure can be missing revenue the Striven view already has.',
    locs: [
      { view: 'pl', tab: 'P&L', section: 'Source toggle' },
      { view: 'quickbooks', tab: 'QuickBooks', section: 'Connection · reconciliation' },
    ],
  },
  {
    term: 'Tracking number', cat: 'Orders',
    def: 'The carrier consignment number for a shipped device, with live status from the carrier.',
    note: 'Comes from a saved Striven report rather than the order detail, which returns the shipping method empty on every order sampled.',
    locs: [
      { view: 'tracking', tab: 'Orders › Tracking', section: 'The tracking table' },
      { view: 'automation', tab: 'Automation', section: 'Shipment Tracking' },
    ],
  },
  {
    term: 'TriCare', cat: 'Programmes',
    def: 'Military health insurance. Like VA it pays on a fixed cycle, and like VA the invoice is the receivable in full.',
    note: 'DSO is deliberately not computed for VA or TriCare: a fixed-cycle payer has no meaningful days-sales-outstanding.',
    locs: [
      { view: 'orders', tab: 'Orders', section: 'Order Value by Type' },
      { view: 'arsheet', tab: 'AR Register', section: 'Invoice Book' },
      { view: 'commission', tab: 'Commission', section: 'Per-vertical totals' },
    ],
  },
  {
    term: 'Unapplied credit', cat: 'Receivables',
    def: 'Money a customer has paid that is not yet applied to a specific invoice.',
    basis: 'netted against that customer’s open invoices, oldest due first',
    note: 'Exactly as Striven does it. PI advances always leave a residual by design, so they are excluded from the anomaly report.',
    locs: [
      { view: 'receivables', tab: 'AR / AP', section: 'Insights · netted out of AR' },
      { view: 'exceptions', tab: 'Exceptions', section: 'Unapplied customer payments' },
    ],
  },
  {
    term: 'VA', aka: ['Veterans Affairs'], cat: 'Programmes',
    def: 'Veterans Affairs. Billed to the VA and paid on a fixed cycle, so the whole invoice is the receivable and there is no lien or advance.',
    locs: [
      { view: 'vapipeline', tab: 'VA Pipeline', section: 'The VA stage board' },
      { view: 'orders', tab: 'Orders', section: 'Order Value by Type' },
      { view: 'arsheet', tab: 'AR Register', section: 'Invoice Book' },
    ],
  },
];

/** The letter a term files under. Non-letters would all collapse into one
 *  bucket, so they are given their own — none exist today, and a silent
 *  mis-file later is worse than an obvious '#'. */
const letterOf = (t: string) => {
  const c = t.trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};

/** A term's own anchor, so the suggestion list can jump to one entry rather
 *  than only to its letter. Slugged because a term carries spaces and slashes
 *  ("P&L", "A/R Health Score") and an id has to survive both. */
const termId = (t: string) => `ug-t-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** The matched run, marked in place. WHICH WORD CARRIES THE MATCH is the whole
 *  question when the hit is inside a formula or a definition rather than in the
 *  headword — "AR" finds nine entries and the reader needs to see why each one
 *  is there, not just that it is. Case-insensitive, and every occurrence. */
function hl(text: string, q: string) {
  const s = q.trim();
  if (!s) return text;
  const parts: React.ReactNode[] = [];
  const low = text.toLowerCase();
  const needle = s.toLowerCase();
  let i = 0;
  for (;;) {
    const at = low.indexOf(needle, i);
    if (at < 0) { parts.push(text.slice(i)); break; }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={at} className="ug-hl">{text.slice(at, at + s.length)}</mark>);
    i = at + s.length;
  }
  return parts;
}

export function UserGuideTab() {
  const [role, setRole] = useState<'admin' | 'rep' | null>(null);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('All');

  useEffect(() => {
    let live = true;
    // Fail closed, exactly as the router does: assume the narrower role until
    // /api/me answers, so a rep never sees a company link flash past.
    fetchMe().then((m) => { if (live) setRole(m?.role === 'admin' ? 'admin' : 'rep'); })
      .catch(() => { if (live) setRole('rep'); });
    return () => { live = false; };
  }, []);

  const allowed = useMemo(() => allowedViews(role), [role]);

  /** Terms this role can reach, unreachable locations stripped, A–Z.
   *  Sorted with `localeCompare` so "A/R" and "Aging" order the way a reader
   *  expects rather than by code point. */
  const reachable = useMemo(
    () => GLOSSARY
      .map((e) => ({ ...e, locs: e.locs.filter((l) => allowed.has(l.view)) }))
      .filter((e) => e.locs.length > 0)
      .sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' })),
    [allowed],
  );
  const hiddenCount = GLOSSARY.length - reachable.length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reachable.filter((e) =>
      (cat === 'All' || e.cat === cat) &&
      (!q
        || e.term.toLowerCase().includes(q)
        || (e.aka ?? []).some((a) => a.toLowerCase().includes(q))
        || e.def.toLowerCase().includes(q)
        || (e.basis ?? '').toLowerCase().includes(q)
        || (e.note ?? '').toLowerCase().includes(q)
        // Searching a TAB NAME finds everything on that tab — "what do the words
        // on the Commission page mean" is the likeliest way in.
        || e.locs.some((l) => l.tab.toLowerCase().includes(q) || l.section.toLowerCase().includes(q))));
  }, [reachable, query, cat]);

  /** Terms grouped under their initial, in order. Built off `shown`, so the
   *  index only ever offers letters that are actually on screen — a jump bar
   *  with dead letters in it is a broken control. */
  const groups = useMemo(() => {
    const m = new Map<string, typeof shown>();
    for (const e of shown) {
      const l = letterOf(e.term);
      m.set(l, [...(m.get(l) ?? []), e]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  const catsInUse = useMemo(() => CATS.filter((c) => reachable.some((e) => e.cat === c)), [reachable]);
  const withBasis = shown.filter((e) => e.basis).length;

  /** WHICH LETTER YOU ARE IN, so the index can mark it.
   *
   *  READ OFF SCROLL POSITION, NOT OFF THE CLICK. Marking what was clicked
   *  would be a lie the moment the reader scrolls on — they land on D, read
   *  past E and F, and the bar still says D. This asks the same question the
   *  page answers visually: which letter block is under the index bar right
   *  now. A click is then highlighted for free, because clicking scrolls.
   *
   *  It stays a display concern only: the entries are still plain `<a href>`
   *  anchors, so the browser's own scrolling, the back button and a reloaded
   *  URL all keep working exactly as they did. */
  const azRef = useRef<HTMLElement | null>(null);
  const [activeLetter, setActiveLetter] = useState('');
  useEffect(() => {
    const bar = azRef.current;
    const root = bar?.parentElement;
    if (!bar || !root) { setActiveLetter(''); return; }
    let frame = 0;
    const pick = () => {
      frame = 0;
      const heads = Array.from(root.querySelectorAll<HTMLElement>('.ug-letter'));
      if (!heads.length) { setActiveLetter(''); return; }
      // The bar is sticky, so its lower edge is the line above which a heading
      // has gone behind it. The last heading past that line is the one whose
      // terms fill the screen.
      const line = bar.getBoundingClientRect().bottom + 8;
      let cur = heads[0];
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= line) cur = h; else break;
      }
      // AT THE FOOT OF THE PAGE the last block can be too short to ever reach
      // that line — V is four terms and the scroll runs out first. Without
      // this the index would mark U while the reader is plainly looking at V.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActiveLetter((atEnd ? heads[heads.length - 1] : cur).id.replace(/^ug-/, ''));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(pick); };
    pick();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
    // `groups` is the dependency, not `shown`: filtering to one category
    // rebuilds the letter blocks, and the old ones are gone from the page.
  }, [groups]);

  /** Which entries are open, by term. Collapsed is the default: forty terms
   *  expanded is the page this replaced, and the point of collapsing is that
   *  the whole glossary fits on one screen to scan. */
  const [openTerms, setOpenTerms] = useState<Set<string>>(new Set());
  const setTermOpen = (term: string, open: boolean) => setOpenTerms((prev) => {
    if (prev.has(term) === open) return prev;          // no-op: don't re-render
    const next = new Set(prev);
    if (open) next.add(term); else next.delete(term);
    return next;
  });
  const expandAll = () => setOpenTerms(new Set(shown.map((e) => e.term)));
  const collapseAll = () => setOpenTerms(new Set());
  const openCount = shown.filter((e) => openTerms.has(e.term)).length;

  /**
   * A SEARCH OPENS WHAT IT FOUND.
   *
   * Searching "collection" and getting two closed headwords answers nothing —
   * the match may be in a definition, a formula or a tab name the reader cannot
   * see, so a collapsed hit looks like the search failed. Typing opens every
   * remaining entry; clearing the box closes them again.
   *
   * Keyed on the query STRING, not on `shown`: `shown` is a new array on every
   * render, and depending on it would re-open rows the reader had just closed.
   */
  const q = query.trim();
  useEffect(() => {
    if (!q) { setOpenTerms(new Set()); return; }
    setOpenTerms(new Set(
      reachable
        .filter((e) => (cat === 'All' || e.cat === cat))
        .filter((e) => {
          const s = q.toLowerCase();
          return e.term.toLowerCase().includes(s)
            || (e.aka ?? []).some((a) => a.toLowerCase().includes(s))
            || e.def.toLowerCase().includes(s)
            || (e.basis ?? '').toLowerCase().includes(s)
            || (e.note ?? '').toLowerCase().includes(s)
            || e.locs.some((l) => l.tab.toLowerCase().includes(s) || l.section.toLowerCase().includes(s));
        })
        .map((e) => e.term),
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  /**
   * THE SUGGESTION LIST UNDER THE BOX.
   *
   * The filtered page below already answers "what matches", but only after the
   * reader looks away from what they are typing and scrolls. This puts the
   * answer where the question is being asked, and — the point of it — says WHY
   * each entry matched: "AR" is in the headword of AR Open, in the formula of
   * Collection Rate, and in a tab name for half a dozen others, and those are
   * three different reasons to click.
   *
   * EVERY MATCH IS LISTED, not a top handful: the box is the fastest way into a
   * glossary of forty terms, and a truncated list makes the reader wonder what
   * was cut. The panel scrolls instead.
   *
   * Built from `shown`, so it obeys the category filter and the role gate for
   * free — a rep can never be offered a term the page itself would not list.
   */
  const suggestions = useMemo(() => {
    const s = q.toLowerCase();
    if (!s) return [];
    type Sug = { e: Entry; rank: number; where: string };
    const out: Sug[] = [];
    for (const e of shown) {
      const term = e.term.toLowerCase();
      // Ranked by WHERE the match is, best first: the headword beats an alias,
      // an alias beats prose. Within a rank the alphabetical order the whole
      // page is built on is preserved, since `shown` is already in it.
      if (term.startsWith(s)) { out.push({ e, rank: 0, where: '' }); continue; }
      if (term.includes(s)) { out.push({ e, rank: 1, where: '' }); continue; }
      const alias = (e.aka ?? []).find((a) => a.toLowerCase().includes(s));
      if (alias) { out.push({ e, rank: 2, where: `also called “${alias}”` }); continue; }
      if (e.def.toLowerCase().includes(s)) { out.push({ e, rank: 3, where: 'in the definition' }); continue; }
      if ((e.basis ?? '').toLowerCase().includes(s)) { out.push({ e, rank: 4, where: 'in the basis of calculation' }); continue; }
      if ((e.note ?? '').toLowerCase().includes(s)) { out.push({ e, rank: 5, where: 'in the note' }); continue; }
      const loc = e.locs.find((l) => l.tab.toLowerCase().includes(s) || l.section.toLowerCase().includes(s));
      if (loc) { out.push({ e, rank: 6, where: `on ${loc.tab}` }); continue; }
    }
    return out.sort((a, b) => a.rank - b.rank);
  }, [shown, q]);

  const [sugOpen, setSugOpen] = useState(false);
  const [sugIdx, setSugIdx] = useState(0);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // A new query is a new list: the highlight goes back to the top match rather
  // than staying on whatever row happened to be third a keystroke ago.
  useEffect(() => { setSugIdx(0); }, [q, cat]);

  /** Open the entry and take the reader to it. The row has to be OPEN before it
   *  is scrolled to, or the browser scrolls to a one-line summary and the
   *  answer the reader came for is still folded away. */
  const choose = (e: Entry) => {
    setSugOpen(false);
    setTermOpen(e.term, true);
    requestAnimationFrame(() => {
      document.getElementById(termId(e.term))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  // Clicking anywhere outside the box closes the panel. Pointer-down, not
  // click, so it closes on the way down like every other menu in the app.
  useEffect(() => {
    if (!sugOpen) return;
    const away = (ev: MouseEvent) => {
      if (!searchRef.current?.contains(ev.target as Node)) setSugOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [sugOpen]);

  // Keep the keyboard-selected row in view: with every match listed, the
  // twentieth is well below the fold of a scrolling panel.
  useEffect(() => {
    if (!sugOpen) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sugIdx, sugOpen]);

  const onSearchKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Escape') { setSugOpen(false); return; }
    if (!sugOpen || suggestions.length === 0) {
      // ArrowDown with a query but a closed panel re-opens it, which is what
      // a reader who dismissed it and changed their mind will try.
      if (ev.key === 'ArrowDown' && q) { setSugOpen(true); ev.preventDefault(); }
      return;
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setSugIdx((i) => (i + 1) % suggestions.length); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSugIdx((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (ev.key === 'Home') { ev.preventDefault(); setSugIdx(0); }
    else if (ev.key === 'End') { ev.preventDefault(); setSugIdx(suggestions.length - 1); }
    else if (ev.key === 'Enter') {
      const s = suggestions[sugIdx];
      if (s) { ev.preventDefault(); choose(s.e); }
    }
  };

  return (
    <div className="exec-deck ug" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>User Guide</h1>
          <div className="page-sub">
            Every term this portal uses, how it is calculated, and every screen it appears on ·
            {' '}{shown.length} terms · {withBasis} with a stated basis
          </div>
        </div>
        <div className="tbl-controls">
          {/* A COMBOBOX, by the book: the input owns the listbox, moves an
              `aria-activedescendant` through it, and never takes focus off the
              box — so a screen reader hears each match as it is arrowed to and
              the reader can keep typing without leaving the field. */}
          <div className="ug-search" ref={searchRef}>
            <input
              className="tbl-search" value={query}
              onChange={(e) => { setQuery(e.target.value); setSugOpen(true); }}
              onFocus={() => { if (q) setSugOpen(true); }}
              onKeyDown={onSearchKey}
              role="combobox" aria-expanded={sugOpen && !!q}
              aria-controls="ug-sug-list" aria-autocomplete="list"
              aria-activedescendant={sugOpen && suggestions[sugIdx] ? `ug-sug-${sugIdx}` : undefined}
              placeholder="Search a term, a formula, or a tab" aria-label="Search the glossary" />

            {sugOpen && q && (
              <div className="ug-sug">
                <div className="ug-sug-head">
                  {suggestions.length === 0
                    ? <>No term matches “{q}”</>
                    : <>{suggestions.length} {suggestions.length === 1 ? 'term' : 'terms'} match “{q}” · ↑↓ to move, ↵ to open</>}
                </div>
                <ul className="ug-sug-list" id="ug-sug-list" role="listbox" aria-label="Matching terms" ref={listRef}>
                  {suggestions.map((s, i) => (
                    <li
                      key={s.e.term} id={`ug-sug-${i}`} role="option" aria-selected={i === sugIdx}
                      className={`ug-sug-opt${i === sugIdx ? ' on' : ''}`}
                      onMouseEnter={() => setSugIdx(i)}
                      // Pointer-down inside the panel must not blur the input:
                      // the field keeps focus, so typing on after a click works.
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => choose(s.e)}
                    >
                      <span className="ug-sug-top">
                        <span className="ug-sug-term">{hl(s.e.term, q)}</span>
                        <span className="ug-cat">{s.e.cat}</span>
                        {s.e.basis && <span className="ug-sug-f" title="Has a stated basis of calculation">ƒ</span>}
                        {/* WHY THIS ONE MATCHED, whenever the headword does not
                            already show it — the reason is the difference
                            between a hit worth opening and one to scroll past. */}
                        {s.where && <span className="ug-sug-where">{s.where}</span>}
                      </span>
                      <span className="ug-sug-def">{hl(s.e.def, q)}</span>
                      {/* THE NAVIGATION DETAIL. Each screen the term appears on
                          is its own link out of the glossary: `href="#view"` is
                          the app's real router, the same one the entry body
                          uses, so this goes to the tab rather than merely
                          naming it. It stops the click from bubbling, or the
                          row underneath would also try to open the entry. */}
                      <span className="ug-sug-locs">
                        {s.e.locs.map((l, li) => (
                          <a
                            key={`${l.view}-${li}`} className="ug-sug-loc" href={`#${l.view}`}
                            title={`Open ${l.tab} · ${l.section}${l.differs ? ` — differs here: ${l.differs}` : ''}`}
                            onMouseDown={(ev) => ev.stopPropagation()}
                            onClick={(ev) => { ev.stopPropagation(); setSugOpen(false); }}
                          >
                            <b>{hl(l.tab, q)}</b>
                            <i>{hl(l.section, q)}</i>
                            {l.differs && <span className="ug-sug-warn" title={l.differs}>⚠</span>}
                          </a>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <select className="tbl-select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by category">
            <option value="All">All categories</option>
            {catsInUse.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* HOW TO READ THIS PAGE, as three separate instructions rather than one
          paragraph: WHY the basis matters, WHERE the two kinds of content live
          (the meaning on the row, the arithmetic inside it), and what the
          locations list adds. Three blocks because the bar is set in columns —
          one paragraph flowed across them broke a sentence mid-phrase at the
          column edge ("Collection Rate and A/R Health │ Score are two
          different..."), which reads as a rendering fault. Each column is now
          one whole instruction, so the split is the point rather than damage. */}
      <div className="ug-lead">
        <div className="ug-lead-item">
          <strong>Read the basis, not just the name.</strong> Several figures here change meaning
          between tabs — Cash Received is all-time in one place and year-to-date in another, and
          Collection Rate and A/R Health Score are two different calculations that sound like one.
        </div>
        <div className="ug-lead-item">
          {/* The two kinds of content, named and located. The reader cannot act
              on "every entry states how its number is worked out" without being
              told that the second part is behind a click. */}
          <strong>Every entry has two parts.</strong> The line on the row is what the term
          <em> means</em>. Open the row for its <em>basis of calculation</em> — the arithmetic the
          figure is actually produced by. Terms that have one are marked <b>ƒ</b>; the rest are
          definitions with no formula behind them, and say so by carrying no mark.
        </div>
        <div className="ug-lead-item">
          <strong>And where it appears.</strong> Every entry lists <em>all</em> the screens that
          use the term, so you can check the same figure elsewhere — with a ⚠ on any screen where
          that same name is worked out differently.
        </div>
      </div>

      {/* A–Z INDEX. Anchors, not state: the browser's own scroll and the back
          button both already do this correctly, and it survives a page reload.
          The expand control rides on the same bar — it governs what the letters
          jump to, so it belongs beside them rather than up in the page head. */}
      {shown.length > 0 && (
        <nav className="ug-az" aria-label="Jump to a letter" ref={azRef}>
          {groups.map(([letter, items]) => (
            /* `aria-current="true"`, not a class of our own: a screen reader
               should hear which letter is current for the same reason a sighted
               reader can see it, and the stylesheet can hang the fill off the
               attribute. */
            <a key={letter} href={`#ug-${letter}`} aria-current={letter === activeLetter ? 'true' : undefined}
              title={`${items.length} term${items.length === 1 ? '' : 's'}`}>{letter}</a>
          ))}
          <button
            type="button" className="ug-az-all"
            onClick={openCount === shown.length ? collapseAll : expandAll}
            aria-expanded={openCount === shown.length}>
            {openCount === shown.length ? 'Collapse all' : `Expand all (${shown.length})`}
          </button>
        </nav>
      )}

      {shown.length === 0 && (
        <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>
          No term matches “{query}”.
        </div>
      )}

      {groups.map(([letter, items]) => (
        <section key={letter} className="ug-letter-block">
          <h2 className="ug-letter" id={`ug-${letter}`}>{letter}</h2>
          <div className="ug-rows">
            {items.map((e) => (
              /* NATIVE <details>, NOT A DIV AND A CLICK HANDLER. It brings
                 keyboard operation, the right ARIA semantics and the browser's
                 own disclosure behaviour with it — all of which a hand-rolled
                 toggle has to reimplement and usually gets half right.
                 It is CONTROLLED: `open` comes from state and `onToggle` writes
                 the user's own click back into it, so the two never fight. That
                 is what lets Expand all and the search auto-open drive the same
                 rows the reader is clicking. */
              <details
                key={e.term}
                /* The anchor the suggestion list jumps to. */
                id={termId(e.term)}
                className="ug-row"
                open={openTerms.has(e.term)}
                onToggle={(ev) => setTermOpen(e.term, (ev.currentTarget as HTMLDetailsElement).open)}
              >
                {/* THE COLLAPSED LINE, and it still holds the three-column
                    track the page was aligned on: name, one-line meaning, and
                    what is inside. Collapsing must not cost the reader the
                    ability to scan a column — a list of forty bare headwords is
                    tidier and far less useful. */}
                <summary className="ug-sum">
                  <span className="ug-sum-term">
                    <h3 className="ug-term">{e.term}</h3>
                    <span className="ug-cat">{e.cat}</span>
                  </span>
                  {/* Clamped to one line by CSS, so every collapsed row is
                      exactly one row tall whatever the definition's length. */}
                  <span className="ug-sum-def">{e.def}</span>
                  <span className="ug-sum-meta">
                    {e.basis && <span className="ug-sum-basis" title="Has a stated basis of calculation">ƒ</span>}
                    <span className="ug-sum-n">{e.locs.length} {e.locs.length === 1 ? 'screen' : 'screens'}</span>
                  </span>
                  <span className="ug-chev" aria-hidden>▾</span>
                </summary>

                <div className="ug-body">
                  {e.aka && e.aka.length > 0 && <div className="ug-aka">also: {e.aka.join(' · ')}</div>}
                  {e.basis && (
                    <div className="ug-basis">
                      <span className="ug-basis-h">Basis of calculation</span>
                      {/* <pre>, because these are formulas laid out over lines and
                          the alignment carries meaning. */}
                      <pre className="ug-basis-body">{e.basis}</pre>
                    </div>
                  )}
                  {e.note && <p className="ug-note">{e.note}</p>}

                  <div className="ug-locs">
                    <span className="ug-locs-h">Where it appears</span>
                    <ul>
                      {e.locs.map((l, i) => (
                        <li key={`${l.view}-${i}`}>
                          <a className="ug-loc" href={`#${l.view}`}>
                            <span className="ug-loc-tab">{l.tab}</span>
                            <span className="ug-loc-sec">{l.section}</span>
                          </a>
                          {l.differs && <span className="ug-differs">⚠ {l.differs}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}

      {hiddenCount > 0 && (
        <div className="ug-hidden">
          {hiddenCount} further {hiddenCount === 1 ? 'term describes a screen' : 'terms describe screens'} your
          role does not have access to, so {hiddenCount === 1 ? 'it is' : 'they are'} not listed here.
        </div>
      )}
    </div>
  );
}
