import { useMemo, useState, type ReactNode } from 'react';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, ChartCard, RankBar, AgingBar, DrillModal, StatCards } from '../chartKit';

// ─────────────────────────────────────────────────────────────────────────────
// AP Register (Sheet) — a manually-maintained accounts-payable register sourced
// from the "AP_Report_Invoices" spreadsheet (AP Report Base + AP Ledgers status).
// This is SEEDED from a sheet snapshot, not a live Striven feed, so it sits next
// to the live Payables tab rather than replacing it.
//
// HIPAA: the sheet's "Ship To" column holds patient names — deliberately EXCLUDED
// here. This tab shows vendor/financial data only (no PHI reaches the browser).
// ─────────────────────────────────────────────────────────────────────────────

type Bill = {
  no: string; vendor: string; date: string; due: string;
  total: number; status: string; aging: string; open: number;
};

// 71 bills · patient names excluded (HIPAA) · source: AP Report Base + AP Ledgers status
const BILLS: Bill[] = [
  { no: "1786", vendor: "Wholesale Medical Devices", date: "2026-03-07", due: "2026-02-08", total: 595.66, status: "Unpaid", aging: "0-30 Days", open: 595.66 },
  { no: "1787", vendor: "Wholesale Medical Devices", date: "2026-03-07", due: "2026-02-08", total: 60.0, status: "Unpaid", aging: "0-30 Days", open: 60.0 },
  { no: "1788", vendor: "Wholesale Medical Devices", date: "2026-03-07", due: "2026-02-08", total: 63.0, status: "Unpaid", aging: "0-30 Days", open: 63.0 },
  { no: "1789", vendor: "Wholesale Medical Devices", date: "2026-03-07", due: "2026-02-08", total: 48.69, status: "Unpaid", aging: "0-30 Days", open: 48.69 },
  { no: "1790", vendor: "Wholesale Medical Devices", date: "2026-03-07", due: "2026-02-08", total: 109.6, status: "Unpaid", aging: "0-30 Days", open: 109.6 },
  { no: "1491", vendor: "Wholesale Medical Devices", date: "2026-03-17", due: "2026-04-16", total: 2407.45, status: "Paid", aging: "91-120 Days", open: 0.0 },
  { no: "INV225908", vendor: "Delco Innovations (TREND)", date: "2026-04-13", due: "2026-05-13", total: 70.89, status: "Paid", aging: "61-90 Days", open: 0.0 },
  { no: "INV225913", vendor: "Delco Innovations (TREND)", date: "2026-04-13", due: "2026-05-13", total: 96.71, status: "Paid", aging: "61-90 Days", open: 0.0 },
  { no: "INV225980", vendor: "Delco Innovations (TREND)", date: "2026-04-14", due: "2026-05-14", total: 76.21, status: "Paid", aging: "61-90 Days", open: 0.0 },
  { no: "INV226149", vendor: "Delco Innovations (TREND)", date: "2026-04-16", due: "2026-05-16", total: 51.71, status: "Paid", aging: "61-90 Days", open: 0.0 },
  { no: "INV0066558", vendor: "ManaMed", date: "2026-04-17", due: "2026-05-17", total: 95.77, status: "Unpaid", aging: "61-90 Days", open: 95.77 },
  { no: "INV226316", vendor: "Delco Innovations (TREND)", date: "2026-04-20", due: "2026-05-20", total: 103.96, status: "Paid", aging: "61-90 Days", open: 0.0 },
  { no: "INV226428", vendor: "Delco Innovations (TREND)", date: "2026-04-21", due: "2026-05-21", total: 136.15, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226429", vendor: "Delco Innovations (TREND)", date: "2026-04-21", due: "2026-05-21", total: 177.01, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226531", vendor: "Delco Innovations (TREND)", date: "2026-04-22", due: "2026-05-22", total: 92.53, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226535", vendor: "Delco Innovations (TREND)", date: "2026-04-22", due: "2026-05-22", total: 50.68, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226538", vendor: "Delco Innovations (TREND)", date: "2026-04-22", due: "2026-05-22", total: 77.18, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226621", vendor: "Delco Innovations (TREND)", date: "2026-04-23", due: "2026-05-23", total: 78.71, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226823", vendor: "Delco Innovations (TREND)", date: "2026-04-27", due: "2026-05-27", total: 107.11, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226842", vendor: "Delco Innovations (TREND)", date: "2026-04-27", due: "2026-05-27", total: 50.61, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226922", vendor: "Delco Innovations (TREND)", date: "2026-04-28", due: "2026-05-28", total: 59.65, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV226999", vendor: "Delco Innovations (TREND)", date: "2026-04-29", due: "2026-05-29", total: 78.71, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV227044", vendor: "Delco Innovations (TREND)", date: "2026-04-29", due: "2026-05-29", total: 85.76, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV227128", vendor: "Delco Innovations (TREND)", date: "2026-04-30", due: "2026-05-30", total: 107.11, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV227133", vendor: "Delco Innovations (TREND)", date: "2026-04-30", due: "2026-05-30", total: 96.11, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV227482", vendor: "Delco Innovations (TREND)", date: "2026-05-06", due: "2026-06-05", total: 32.11, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV228023", vendor: "Delco Innovations (TREND)", date: "2026-05-14", due: "2026-06-13", total: 63.8, status: "Cancelled", aging: "31-60 Days", open: 0.0 },
  { no: "INV228025", vendor: "Delco Innovations (TREND)", date: "2026-05-14", due: "2026-06-13", total: 110.76, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "SMR-11", vendor: "EvoHealth Consulting", date: "2026-05-19", due: "2026-05-27", total: 450.0, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "SMR-13", vendor: "EvoHealth Consulting", date: "2026-05-19", due: "2026-06-03", total: 9375.0, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV228589", vendor: "Delco Innovations (TREND)", date: "2026-05-22", due: "2026-06-21", total: 125.69, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "INV228594", vendor: "Delco Innovations (TREND)", date: "2026-05-22", due: "2026-06-21", total: 142.06, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "INV228799", vendor: "Delco Innovations (TREND)", date: "2026-05-28", due: "2026-06-27", total: 108.84, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "INV228800", vendor: "Delco Innovations (TREND)", date: "2026-05-28", due: "2026-06-27", total: 195.01, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "SMR-16", vendor: "EvoHealth Consulting", date: "2026-06-01", due: "2026-06-16", total: 12500.0, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "SMR-15", vendor: "EvoHealth Consulting", date: "2026-06-03", due: "2026-06-18", total: 300.0, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV0072451", vendor: "ManaMed", date: "2026-06-07", due: "2026-05-08", total: 314.72, status: "Unpaid", aging: "0-30 Days", open: 314.72 },
  { no: "INV229646", vendor: "Delco Innovations (TREND)", date: "2026-06-10", due: "2026-07-10", total: 194.91, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "INV229650", vendor: "Delco Innovations (TREND)", date: "2026-06-10", due: "2026-07-10", total: 108.76, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "INV0071058", vendor: "ManaMed", date: "2026-06-16", due: "2026-07-16", total: 915.66, status: "Unpaid", aging: "0-30 Days", open: 915.66 },
  { no: "INV0071059", vendor: "ManaMed", date: "2026-06-16", due: "2026-07-16", total: 1215.66, status: "Unpaid", aging: "0-30 Days", open: 1215.66 },
  { no: "DM-29161", vendor: "Doctors Medical / A&O", date: "2026-06-17", due: "2026-07-02", total: 2631.6, status: "Unpaid", aging: "0-30 Days", open: 2631.6 },
  { no: "DM-29162", vendor: "Doctors Medical / A&O", date: "2026-06-17", due: "2026-07-02", total: 3495.87, status: "Unpaid", aging: "0-30 Days", open: 3495.87 },
  { no: "DM-29163", vendor: "Doctors Medical / A&O", date: "2026-06-17", due: "2026-07-02", total: 886.63, status: "Partially Paid", aging: "0-30 Days", open: 21.63 },
  { no: "DM-29167", vendor: "Doctors Medical / A&O", date: "2026-06-17", due: "2026-07-02", total: 2637.93, status: "Unpaid", aging: "0-30 Days", open: 2637.93 },
  { no: "DM-29170", vendor: "Doctors Medical / A&O", date: "2026-06-17", due: "2026-07-02", total: 306.63, status: "Paid without Shipping", aging: "0-30 Days", open: 0.0 },
  { no: "82895", vendor: "Hi-Dow International", date: "2026-06-18", due: "2026-06-18", total: 298.47, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "82906", vendor: "Hi-Dow International", date: "2026-06-18", due: "2026-06-18", total: 3665.86, status: "Paid", aging: "31-60 Days", open: 0.0 },
  { no: "INV0071258", vendor: "ManaMed", date: "2026-06-18", due: "2026-07-18", total: 315.66, status: "Unpaid", aging: "0-30 Days", open: 315.66 },
  { no: "INV0071262", vendor: "ManaMed", date: "2026-06-18", due: "2026-07-18", total: 320.32, status: "Unpaid", aging: "0-30 Days", open: 320.32 },
  { no: "INV0071265", vendor: "ManaMed", date: "2026-06-18", due: "2026-07-18", total: 911.65, status: "Unpaid", aging: "0-30 Days", open: 911.65 },
  { no: "INV230237", vendor: "Delco Innovations (TREND)", date: "2026-06-18", due: "2026-07-18", total: 110.14, status: "Unpaid", aging: "0-30 Days", open: 110.14 },
  { no: "DM-29178", vendor: "Doctors Medical / A&O", date: "2026-06-19", due: "2026-07-04", total: 2631.6, status: "Unpaid", aging: "0-30 Days", open: 2631.6 },
  { no: "DM-29196", vendor: "Doctors Medical / A&O", date: "2026-06-22", due: "2026-07-07", total: 1760.71, status: "Paid without Shipping", aging: "0-30 Days", open: 0.0 },
  { no: "DM-29204", vendor: "Doctors Medical / A&O", date: "2026-06-23", due: "2026-07-08", total: 895.98, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "82997", vendor: "Hi-Dow International", date: "2026-06-24", due: "2026-06-24", total: 585.62, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "DM-29213", vendor: "Doctors Medical / A&O", date: "2026-06-24", due: "2026-07-09", total: 1578.44, status: "Unpaid", aging: "0-30 Days", open: 1578.44 },
  { no: "DM-29217", vendor: "Doctors Medical / A&O", date: "2026-06-25", due: "2026-07-10", total: 1757.58, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "DM-29218", vendor: "Doctors Medical / A&O", date: "2026-06-25", due: "2026-07-10", total: 1757.58, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "83041", vendor: "Hi-Dow International", date: "2026-06-26", due: "2026-06-26", total: 298.44, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "DM-29232", vendor: "Doctors Medical / A&O", date: "2026-06-29", due: "2026-07-14", total: 894.44, status: "Unpaid", aging: "0-30 Days", open: 894.44 },
  { no: "DM-29237", vendor: "Doctors Medical / A&O", date: "2026-06-29", due: "2026-07-14", total: 1767.6, status: "Unpaid", aging: "0-30 Days", open: 1767.6 },
  { no: "83108", vendor: "Hi-Dow International", date: "2026-07-01", due: "2026-07-01", total: 299.42, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "83110", vendor: "Hi-Dow International", date: "2026-07-01", due: "2026-07-01", total: 578.58, status: "Paid", aging: "0-30 Days", open: 0.0 },
  { no: "DM-29261", vendor: "Doctors Medical / A&O", date: "2026-07-06", due: "2026-07-21", total: 897.77, status: "Unpaid", aging: "0-30 Days", open: 897.77 },
  { no: "DM-29264", vendor: "Doctors Medical / A&O", date: "2026-07-06", due: "2026-07-06", total: 1761.51, status: "Unpaid", aging: "0-30 Days", open: 1761.51 },
  { no: "DM-29265", vendor: "Doctors Medical / A&O", date: "2026-07-06", due: "2026-07-21", total: 1761.51, status: "Unpaid", aging: "0-30 Days", open: 1761.51 },
  { no: "INV0070618", vendor: "ManaMed", date: "2026-10-06", due: "2026-10-07", total: 320.38, status: "Unpaid", aging: "0-30 Days", open: 320.38 },
  { no: "INV0070755", vendor: "ManaMed", date: "2026-11-06", due: "2026-11-07", total: 320.38, status: "Unpaid", aging: "0-30 Days", open: 320.38 },
  { no: "INV0070808", vendor: "ManaMed", date: "2026-12-06", due: "2026-12-07", total: 322.02, status: "Unpaid", aging: "0-30 Days", open: 322.02 },
  { no: "INV0070822", vendor: "ManaMed", date: "2026-12-06", due: "2026-12-07", total: 311.69, status: "Unpaid", aging: "0-30 Days", open: 311.69 },
];

const PAGE_SIZE = 10;
const OPEN_STATUSES = new Set(['Unpaid', 'Partially Paid']);
const PAID_STATUSES = new Set(['Paid', 'Paid without Shipping']);

const fmtDate = (s: string) => {
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Sheet aging label → shared AgingBar bucket key.
const AGING_KEY: Record<string, string> = {
  '0-30 Days': 'd1_30', '31-60 Days': 'd31_60', '61-90 Days': 'd61_90', '91-120 Days': 'd90plus',
};

// Status → pill tone class used across the dashboard.
function statusTag(status: string): ReactNode {
  const s = status.toLowerCase();
  if (PAID_STATUSES.has(status)) return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ {status === 'Paid' ? 'Paid' : 'Paid (no ship)'}</span>;
  if (status === 'Partially Paid') return <span className="pill-tag tag-warn">Partial</span>;
  if (s.includes('cancel')) return <span className="pill-tag tag-muted">Cancelled</span>;
  return <span className="pill-tag tag-danger">Unpaid</span>;
}

type SortKey = 'date' | 'due' | 'total' | 'open';
type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] };

export function ApSheetTab() {
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState<'All' | 'open' | 'paid' | 'cancelled'>('All');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [page, setPage] = useState(1);
  const [agingMode, setAgingMode] = useState<'amount' | 'count'>('amount');
  const [drill, setDrill] = useState<Drill | null>(null);

  // Headline aggregates — all derived from the one BILLS array so every tile ties.
  const agg = useMemo(() => {
    const billed = BILLS.reduce((s, b) => s + b.total, 0);
    const paid = BILLS.filter((b) => PAID_STATUSES.has(b.status)).reduce((s, b) => s + b.total, 0);
    const paidCount = BILLS.filter((b) => PAID_STATUSES.has(b.status)).length;
    const openBills = BILLS.filter((b) => b.open > 0);
    const outstanding = openBills.reduce((s, b) => s + b.open, 0);
    const rate = paid + outstanding > 0 ? (paid / (paid + outstanding)) * 100 : 0;
    return { billed, paid, paidCount, outstanding, openCount: openBills.length, rate };
  }, []);

  // Spend by vendor (all bills) and outstanding watchlist (open only).
  const spend = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of BILLS) m.set(b.vendor, (m.get(b.vendor) || 0) + b.total);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, []);
  const watch = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of BILLS) if (b.open > 0) m.set(b.vendor, (m.get(b.vendor) || 0) + b.open);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, []);

  // Aging of open balances, mapped onto the shared 5-bucket ramp.
  const aging = useMemo(() => {
    const amt: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const cnt: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const b of BILLS) {
      if (b.open <= 0) continue;
      const k = AGING_KEY[b.aging] ?? 'current';
      amt[k] += b.open; cnt[k] += 1;
    }
    return { amt, cnt };
  }, []);

  // Status mix for the small cards.
  const statusCards = useMemo(() => {
    const order = ['Paid', 'Paid without Shipping', 'Unpaid', 'Partially Paid', 'Cancelled'];
    const m = new Map<string, number>();
    for (const b of BILLS) m.set(b.status, (m.get(b.status) || 0) + 1);
    const tone = (s: string): 'ok' | 'warn' | 'none' | 'info' =>
      PAID_STATUSES.has(s) ? 'ok' : s === 'Partially Paid' ? 'warn' : s.toLowerCase().includes('cancel') ? 'none' : 'info';
    return order.filter((s) => m.has(s)).map((s) => ({ name: s === 'Paid without Shipping' ? 'Paid (no ship)' : s, value: m.get(s) || 0, tone: tone(s) }));
  }, []);

  // Table: filter → sort → paginate.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BILLS.filter((b) => {
      const grp = OPEN_STATUSES.has(b.status) ? 'open' : PAID_STATUSES.has(b.status) ? 'paid' : 'cancelled';
      return (statusF === 'All' || grp === statusF) &&
        (!q || b.no.toLowerCase().includes(q) || b.vendor.toLowerCase().includes(q));
    });
  }, [query, statusF]);
  const sorted = useMemo(() => {
    const v = (b: Bill): number => sort.key === 'total' ? b.total : sort.key === 'open' ? b.open
      : new Date((sort.key === 'due' ? b.due : b.date) + 'T00:00:00').getTime() || 0;
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const fTotal = filtered.reduce((s, b) => s + b.total, 0);
  const fOpen = filtered.reduce((s, b) => s + b.open, 0);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // Drills.
  const vendorDrill = (name: string) => setDrill({
    title: name, sub: `${BILLS.filter((b) => b.vendor === name).length} bills on record`,
    columns: [{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Date' }, { key: 't', label: 'Total', num: true }, { key: 's', label: 'Status' }],
    rows: BILLS.filter((b) => b.vendor === name).sort((a, b) => b.total - a.total)
      .map((b) => ({ n: b.no, d: fmtDate(b.date), t: formatCurrency(b.total), s: statusTag(b.status) })),
  });
  const explainOutstanding = () => setDrill({
    title: 'Outstanding', sub: `${agg.openCount} open bills · ${formatCurrency(agg.outstanding)}`,
    columns: [{ key: 'n', label: 'Invoice' }, { key: 'v', label: 'Vendor' }, { key: 'due', label: 'Due' }, { key: 'o', label: 'Open', num: true }],
    rows: BILLS.filter((b) => b.open > 0).sort((a, b) => b.open - a.open)
      .map((b) => ({ n: b.no, v: b.vendor, due: fmtDate(b.due), o: formatCurrency(b.open) })),
  });
  const explainBilled = () => setDrill({
    title: 'Total AP Billed', sub: `${BILLS.length} bills · ${formatCurrency(agg.billed)}`,
    columns: [{ key: 'v', label: 'Vendor' }, { key: 't', label: 'Billed', num: true }],
    rows: spend.map((s) => ({ v: s.name, t: formatCurrency(s.value) })),
  });

  // CSV export — client-side, nothing leaves the browser.
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Invoice', 'Vendor', 'Date', 'Due', 'Total', 'Open', 'Status'].map(esc).join(','),
      ...sorted.map((b) => [b.no, b.vendor, b.date, b.due, b.total, b.open, b.status].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'ap-register.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>AP Register</h1>
          <div className="page-sub">
            From the AP invoice sheet · {BILLS.length} bills · patient names excluded (HIPAA)
          </div>
        </div>
      </div>

      <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <KpiR ico="doc" tint="#2563EB" label="Total AP Billed" value={agg.billed} format={formatCurrency}
          deltaText={`${BILLS.length} invoices`} foot="invoice register" onClick={explainBilled} />
        <KpiR ico="wallet" tint="#16A34A" label="Paid to Date" value={agg.paid} format={formatCurrency}
          deltaText={`${agg.paidCount} bills settled`} foot="incl. paid w/o shipping" />
        <KpiR ico="cash" tint="#DC2626" label="Outstanding" value={agg.outstanding} format={formatCurrency}
          deltaText={`${agg.openCount} open bills`} foot="unpaid + partial" onClick={explainOutstanding} />
        <KpiR ico="clip" tint="#D97706" label="Open Bills" value={agg.openCount}
          deltaText="awaiting payment" foot="from the register" onClick={explainOutstanding} />
        <KpiR ico="pie" tint="#7C3AED" label="Payment Rate" value={agg.rate} format={(n) => `${n.toFixed(1)}%`}
          deltaText="paid ÷ (paid + open)" foot="of registered $" />
      </div>

      <div className="exec-grid12">
        <ChartCard className="g12-7" title="Spend by Vendor" sub="Total billed per vendor · click a bar to drill">
          <RankBar data={spend} money colorAt={() => C.brand} onSelect={vendorDrill} />
        </ChartCard>

        <ChartCard className="g12-5" title="AP Aging" sub="Open balance by days past due"
          right={
            <div className="smr-seg" style={{ margin: 0 }}>
              <button className={agingMode === 'amount' ? 'active' : ''} onClick={() => setAgingMode('amount')}>By Amount</button>
              <button className={agingMode === 'count' ? 'active' : ''} onClick={() => setAgingMode('count')}>By Count</button>
            </div>
          }>
          <AgingBar aging={agingMode === 'amount' ? aging.amt : aging.cnt} money={agingMode === 'amount'} />
        </ChartCard>

        <ChartCard className="g12-7" title="Outstanding by Vendor" sub="Who we owe · open balances only · click to drill">
          <RankBar data={watch} money colorAt={() => C.negative} onSelect={vendorDrill} />
        </ChartCard>

        <ChartCard className="g12-5" title="Payment Status" sub={`${BILLS.length} bills by status`}>
          <StatCards data={statusCards} total={BILLS.length} />
        </ChartCard>

        <div className="section chart-card g12-12">
          <div className="section-head">
            <div><h2 className="section-title">Bill Register</h2><div className="section-sub">Every vendor bill in the sheet · no patient data</div></div>
            <div className="tbl-controls">
              <input className="tbl-search" placeholder="Search invoice / vendor" value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
              <select className="tbl-select" value={statusF} onChange={(e) => { setStatusF(e.target.value as typeof statusF); setPage(1); }}>
                <option value="All">All bills</option>
                <option value="open">Open (unpaid)</option>
                <option value="paid">Paid</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered bills" onClick={exportCsv}>⤓ CSV</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Vendor</th>
                  <th className="sortable" onClick={() => setSortKey('date')}>Date {sortInd('date')}</th>
                  <th className="sortable" onClick={() => setSortKey('due')}>Due {sortInd('due')}</th>
                  <th className="num sortable" onClick={() => setSortKey('total')}>Total {sortInd('total')}</th>
                  <th className="num sortable" onClick={() => setSortKey('open')}>Open {sortInd('open')}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => (
                  <tr key={b.no + b.date}>
                    <td><strong>{b.no}</strong></td>
                    <td>{b.vendor}</td>
                    <td>{fmtDate(b.date)}</td>
                    <td>{fmtDate(b.due)}</td>
                    <td className="num">{formatCurrency(b.total)}</td>
                    <td className={`num${b.open > 0 ? ' cell-neg' : ''}`}>{b.open > 0 ? formatCurrency(b.open) : '—'}</td>
                    <td>{statusTag(b.status)}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={7} style={{ color: C.muted }}>No bills match.</td></tr>}
                {filtered.length > 0 && (
                  <tr className="total-row">
                    <td>TOTAL</td>
                    <td>{filtered.length} bill{filtered.length === 1 ? '' : 's'}</td>
                    <td></td><td></td>
                    <td className="num">{formatCurrency(fTotal)}</td>
                    <td className="num">{formatCurrency(fOpen)}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pgn">
            <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
            <div className="pgn-pages">
              <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
              {Array.from({ length: pages }, (_, i) => i + 1).slice(0, 8).map((p) => (
                <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
              ))}
              <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
            </div>
          </div>
          <div className="section-sub" style={{ marginTop: 10 }}>
            Register snapshot from the AP sheet. The live Striven <strong>Payables</strong> tab may differ — it also
            captures recent bills not yet entered here.
          </div>
        </div>
      </div>

      {drill && <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
