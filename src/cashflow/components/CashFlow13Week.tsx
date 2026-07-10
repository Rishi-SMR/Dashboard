import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
 fetchCashflow13, fetchCashflowOverrides, saveCashflowOverrides,
 fetchCurrentMonthOverview, fetchPastWeeksGrid,
 fetchCashflowEdits, saveCashflowEdits, currentUserName, fetchCollectedDetail, fetchExpenseEntries, fetchCombinedActual,
 type Cashflow13, type CashflowSource, type CashflowStatus, type CashflowOverrides,
 type CashflowLine, type CurrentMonthOverview, type PastWeeksGridResponse,
 type PastWeeksGridItem, type WeekActuals,
 type WeekExpenseLines, type ExpectedInflowWeek, type CashflowEdits,
 type CollectedDetail, type CollectedInvoice, type ExpenseEntriesRange, type ExpenseEntry, type CombinedActual,
 fetchPnlExpenses, type PnlExpensesResult,
} from '../api';
import { BillDrillModal } from './BillDrillModal';
import { CollapsibleSection } from './CollapsibleSection';
import InfoTip from './InfoTip.jsx';
import { formatCurrency, formatSigned } from '../format';

// Plain-language "how is this number computed" explainers, shown as a round ⓘ
// next to each inflow / outflow row (matches the AR dashboard's info buttons).
// Clean display names for the inflow rows. The server keeps its internal
// labels (used for snapshot / past-week matching + the ROW_INFO tooltip
// lookup); we only relabel what the user sees in the table.
const DISPLAY_LABELS: Record<string, string> = {
  'AR Collections (Net 97)': 'Receivable',
  'Past AR Collections (lag-curve)': 'Account Receivable',
  'Sales (this week, forecast)': 'Sales',
  'Collected from sales (this week)': 'Weekly Cash Collection',
};

const ROW_INFO: Record<string, { title: string; purpose: string; detail: string; source: string }> = {
 // --- Inflows ---
 'AR Collections (Net 97)': {
 title: 'Receivable',
 purpose: 'Batch money we expect to collect, week by week.',
 detail: 'Each pending batch invoice is placed in the week it should collect = issue date + 97 days (Net 90 + a 7-day buffer). Past-due batches land in Week 1.',
 source: 'Sales / Batches sheet (pending batch invoices).',
 },
 'Past AR Collections (lag-curve)': {
 title: 'Account Receivable',
 purpose: 'Expected weekly collections from open invoices.',
 detail: 'Every open invoice is spread across the weeks using that customer’s own historical pay-day pattern (median days-to-pay ± spread). Overdue invoices land in Week 1. Also includes the lagged share of new sales that don’t collect the same week.',
 source: 'Invoice Tracker (open invoices) + each customer’s paid-history timing.',
 },
 'Sales (this week, forecast)': {
 title: 'Sales',
 purpose: 'Gross wholesale sales we expect to invoice each week.',
 detail: 'A forward wholesale sales forecast (recent run-rate × month-of-year seasonality), spread into weeks by the real week-of-month invoicing pattern. Reference only — NOT added to cash; the cash shows as Weekly Cash Collection (same week) + Account Receivable (the rest, later).',
 source: 'Sales forecast (recent wholesale run-rate + seasonality).',
 },
 'Collected from sales (this week)': {
 title: 'Weekly Cash Collection',
 purpose: 'Same-week cash from this week’s new sales.',
 detail: 'The share of each week’s gross sales that gets paid the same week it’s invoiced (from 2024+ paid history). The rest collects later and shows in Account Receivable.',
 source: 'Sales forecast × same-week collection rate (paid history).',
 },
 // --- Outflows ---
 'Inventory & Raw Materials': {
 title: 'Inventory & Raw Materials',
 purpose: 'Weekly spend on inventory / raw materials.',
 detail: 'Last 3-month average of the QuickBooks COGS / raw-material accounts, weighted toward month-end to match real purchase timing.',
 source: 'QuickBooks expense detail (COGS / raw-material accounts).',
 },
 'Payroll': {
 title: 'Payroll',
 purpose: 'Weekly payroll outflow.',
 detail: 'Last 3-month average of the QuickBooks Payroll group, paid bi-weekly (a pay event every other week).',
 source: 'QuickBooks expense detail (Payroll group).',
 },
 'Software & Subscriptions': {
 title: 'Software & Subscriptions',
 purpose: 'Weekly software / subscription spend.',
 detail: 'Projected from the QuickBooks subscription audit (active recurring charges) as a per-week amount.',
 source: 'QuickBooks subscription audit (active recurring charges).',
 },
 'Other Expenses': {
 title: 'Other Expenses',
 purpose: 'All other weekly operating spend.',
 detail: 'Last 3-month average of every other operating-expense category (excluding payroll, inventory, subscriptions), spread across the weeks; rent lands on the 1st.',
 source: 'QuickBooks expense detail (all other categories).',
 },
 'Credit Card Payments': {
 title: 'Credit Card Payments',
 purpose: 'Scheduled credit-card bill payments, week by week.',
 detail: 'Each business card’s real statement / due-date schedule places its payment in the week it falls due. Summing those due payments per week gives this row.',
 source: 'Per-card payment schedule (Tiller credit-card due dates).',
 },
};

function srcLabel(s: CashflowSource): string {
 return s === 'live' ? 'Live' : s === 'computed' ? 'Calc' : '-';
}
function srcTone(s: CashflowSource): string {
 return s === 'live' ? 'strong' : s === 'computed' ? 'fuzzy' : 'none';
}
function statusTone(s: CashflowStatus): string {
 return s === 'HEALTHY' ? 'strong' : s === 'TIGHT' ? 'warn' : 'none';
}

type Direction = 'future' | 'past';
// Four user-facing tabs. 'budgeted' is the forward plan (direction=future);
// 'past' / 'actual' / 'variance' are three lenses on the SAME closed-week data
// (direction=past) - past = forecast+actual combined, actual = what really
// happened, variance = budget vs actual week-by-week.
type View = 'budgeted' | 'past' | 'actual' | 'variance';

export function CashFlow13Week() {
 const [view, setView] = useState<View>('budgeted');
 const direction: Direction = view === 'budgeted' ? 'future' : 'past';
 const [data, setData] = useState<Cashflow13 | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [overrides, setOverrides] = useState<CashflowOverrides | null>(null);
 const [savingOverrides, setSavingOverrides] = useState(false);
 const [editsBuffer, setEditsBuffer] = useState<Record<string, string>>({});
 // Per-cell manual edits (inflow Sales/AR + outflow expenses), persisted to
 // Supabase WITH attribution (who edited, when). Keyed by `${label}|${weekStart}`
 // so an edit sticks to its week. Shared with the Sales → Edit tab and visible
 // to the whole team. Replaces the old localStorage what-if store.
 const [cashflowEdits, setCashflowEdits] = useState<CashflowEdits>({});
 const [editingCell, setEditingCell] = useState<
   { label: string; weekIdx: number; current: number; kind?: 'inflow' } | null
 >(null);
 const [salesScenario, setSalesScenario] = useState<'worst' | 'base' | 'best'>('base');
 // Row whose breakdown modal ("what's included") is open.
 const [breakdownLine, setBreakdownLine] = useState<CashflowLine | null>(null);
 // QB-based heads behind each outflow line (cash basis + your mapping), so the
 // "what's included" modal shows the real accounts and drills to their bills.
 const [pnlExp, setPnlExp] = useState<PnlExpensesResult | null>(null);
 const [billAccount, setBillAccount] = useState<string | null>(null);
 useEffect(() => {
 const loadPnl = () => void fetchPnlExpenses({ method: 'Cash' }).then(setPnlExp).catch(() => {});
 loadPnl();
 // A mapping change (P&L Mapping tab) re-buckets the outflow heads - reload
 // the QB heads so the "what's included" drill-downs stay in sync at once.
 window.addEventListener('category-overrides-changed', loadPnl);
 return () => window.removeEventListener('category-overrides-changed', loadPnl);
 }, []);
 // Map a 13-week outflow label to its QB accounts (from pnl-expenses), matching
 // the backend's outflow heads (Payroll / COGS / Rent / Software / Other / CC).
 const qbHeadsFor = (label: string): { name: string; total: number; monthly: number[] }[] => {
 if (!pnlExp) return [];
 const cats = pnlExp.categories;
 const isCogs = (n: string) => /^cogs/i.test(n);
 const isRent = (n: string) => /rent|building lease/i.test(n);
 const isBank = (n: string) => /bank & merchant/i.test(n);
 if (/^payroll$/i.test(label)) return cats.find((c) => c.category === 'Payroll')?.accounts ?? [];
 if (/^cogs$/i.test(label)) return cats.filter((c) => isCogs(c.category)).flatMap((c) => c.accounts);
 if (/^rent$/i.test(label)) return cats.find((c) => isRent(c.category))?.accounts ?? [];
 if (/software & subscriptions/i.test(label)) return cats.find((c) => c.category === 'Software & Subscriptions')?.accounts ?? [];
 if (/credit card/i.test(label)) return cats.find((c) => isBank(c.category))?.accounts ?? [];
 if (/other expenses/i.test(label)) {
 return cats
 .filter((c) => c.category !== 'Payroll' && c.category !== 'Software & Subscriptions' && !isCogs(c.category) && !isRent(c.category) && !isBank(c.category))
 .map((c) => ({ name: c.category, total: c.total, monthly: c.monthly }));
 }
 return [];
 };
 // Future cashflow ALWAYS fetched alongside past, so the past view can use
 // LIVE Wk1 projection (latest methodology) for the in-progress current week
 // instead of the stale Monday-morning snapshot value.
 const [futureData, setFutureData] = useState<Cashflow13 | null>(null);
 const [pastGrid, setPastGrid] = useState<PastWeeksGridResponse | null>(null);

 async function load(refresh = false, silent = false, dir: Direction = direction) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const d = await fetchCashflow13({ refresh, direction: dir });
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 // Shared cashflow cell edits (server). Load once, and reload only when an edit
 // is made (here or in the Sales/AR edit tabs) - no focus/interval polling.
 useEffect(() => {
   const loadEdits = () => fetchCashflowEdits()
     .then((e) => setCashflowEdits(e ?? {}))
     .catch(() => { /* keep prior */ });
   loadEdits();
   window.addEventListener('cashflow-edits-changed', loadEdits);   // linked: edit elsewhere
   return () => { window.removeEventListener('cashflow-edits-changed', loadEdits); };
 }, []);

 // Load once per direction. Reload (silently, no spinner) ONLY when an edit is
 // saved - so a sales edit re-flows the same-week + AR here. No focus/interval
 // polling: it's a forecast, not a live ticker - use Refresh for a fresh pull.
 useEffect(() => {
 load(false, false, direction);
 if (direction === 'future') {
 fetchCashflowOverrides().then(setOverrides).catch(() => { /* silent */ });
 }
 if (direction === 'past') {
 // Past actuals + the live-future series back the past/actual/variance
 // lenses. Fetch them ONCE - toggling between budgeted and a past lens
 // shouldn't re-pull the whole variance grid every time (that's the
 // "variance keeps loading" churn). They refresh on an edit, below.
 if (!futureData) fetchCashflow13({ direction: 'future' }).then(setFutureData).catch(() => setFutureData(null));
 if (!pastGrid) fetchPastWeeksGrid(13).then(setPastGrid).catch(() => setPastGrid(null));
 }
 const onEdit = () => {
 load(false, true, direction);   // silent: sales edit → same-week + AR re-flow
 if (direction === 'past') {
 // An edit can move both the live-future series and the actuals, so
 // refresh the variance inputs too (silently).
 fetchCashflow13({ direction: 'future' }).then(setFutureData).catch(() => { /* keep prior */ });
 fetchPastWeeksGrid(13).then(setPastGrid).catch(() => { /* keep prior */ });
 }
 };
 window.addEventListener('cashflow-edits-changed', onEdit);
 // A mapping change re-buckets the outflow - silently re-pull so a newly
 // categorized head shows in the 13-week without a manual refresh.
 window.addEventListener('category-overrides-changed', onEdit);
 return () => {
 window.removeEventListener('cashflow-edits-changed', onEdit);
 window.removeEventListener('category-overrides-changed', onEdit);
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [direction]);

 function bufferedValue(weekIdx: number): string {
 const key = `WK${String(weekIdx + 1).padStart(2, '0')}`;
 if (Object.prototype.hasOwnProperty.call(editsBuffer, key)) return editsBuffer[key];
 const v = overrides?.ccUtilisationByWeek[key];
 return v ? String(v) : '';
 }

 async function commitOverrides(nextMode?: 'manual' | 'auto') {
 if (!overrides) return;
 setSavingOverrides(true);
 try {
 const mergedMap: Record<string, number> = { ...overrides.ccUtilisationByWeek };
 for (const [k, v] of Object.entries(editsBuffer)) {
 const n = Number(v.replace(/[^0-9.-]/g, ''));
 if (!Number.isFinite(n) || n === 0) delete mergedMap[k];
 else mergedMap[k] = n;
 }
 const saved = await saveCashflowOverrides({
 mode: nextMode ?? overrides.mode,
 ccUtilisationByWeek: mergedMap,
 });
 setOverrides(saved);
 setEditsBuffer({});
 await load(true); // reload 13-week with new overrides
 } catch (e) {
 console.error('saveCashflowOverrides failed', e);
 } finally {
 setSavingOverrides(false);
 }
 }

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">13-Week Cash Flow</h1>
 <div className="page-sub">Building the lender-facing 13-week schedule…</div>
 </div>
 </div>
 </>
 );
 }

 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head">
 <div><h1 className="page-title">13-Week Cash Flow</h1></div>
 </div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> open <a href="/auth/connect">/auth/connect</a> to re-authorize QuickBooks.</>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { weeks, inflows, outflows, totals, openingCashWk1, openingCashSource, assumptions, warnings } = data;

 // ── Cell edits (server-persisted in Supabase, attributed) - helpers ───────
 // ONE store for inflow Sales/AR + outflow expense edits. Key = label|weekStart
 // so an edit sticks to its week. Every edit records who made it + when, and is
 // shared with the whole team and the Sales → Edit tab.
 const editKey = (label: string, weekIdx: number) => `${label}|${weeks[weekIdx]?.start ?? weekIdx}`;
 const editEntry = (label: string, weekIdx: number): CashflowEdits[string] | undefined => cashflowEdits[editKey(label, weekIdx)];
 const editVal = (label: string, weekIdx: number): number | undefined => editEntry(label, weekIdx)?.value;
 const overrideKey = editKey;
 const effectiveOutflow = (label: string, baseVal: number, weekIdx: number): number => editVal(label, weekIdx) ?? baseVal;
 const effectiveInflow = effectiveOutflow;
 const hasOverride = (label: string, weekIdx: number) => editVal(label, weekIdx) != null;
 const forecastOvVal = editVal;
 const isInflowEditable = (_label: string) => true;   // every row is editable + saved now
 const hasAnyOverride = Object.keys(cashflowEdits).length > 0;
 // "edited by X · date" attribution string for a cell, if edited.
 const editByNote = (label: string, weekIdx: number): string | undefined => {
   const e = editEntry(label, weekIdx);
   if (!e) return undefined;
   const when = (() => { try { return new Date(e.at).toLocaleDateString(); } catch { return ''; } })();
   return `edited by ${e.by}${when ? ` · ${when}` : ''}`;
 };
 const applyEdit = (label: string, weekIdx: number, value: number, applyForward: boolean) => {
   const set: Record<string, number> = {};
   if (applyForward) { for (let i = weekIdx; i < weeks.length; i++) set[editKey(label, i)] = value; }
   else set[editKey(label, weekIdx)] = value;
   const at = new Date().toISOString();
   const me = currentUserName();
   setCashflowEdits((prev) => { const next = { ...prev }; for (const k of Object.keys(set)) next[k] = { value: set[k], by: me, at }; return next; });
   void saveCashflowEdits(set).then(setCashflowEdits).catch(() => { /* keep optimistic */ });
 };
 const clearEdit = (label: string, weekIdx: number) => {
   const key = editKey(label, weekIdx);
   setCashflowEdits((prev) => { const next = { ...prev }; delete next[key]; return next; });
   void saveCashflowEdits({}, [key]).then(setCashflowEdits).catch(() => { /* keep optimistic */ });
 };
 const clearEditRow = (label: string) => {
   const keys = weeks.map((_, i) => editKey(label, i));
   setCashflowEdits((prev) => { const next = { ...prev }; for (const k of keys) delete next[k]; return next; });
   void saveCashflowEdits({}, keys).then(setCashflowEdits).catch(() => { /* keep optimistic */ });
 };
 // Back-compat aliases - the render + modal call these names.
 const applyForecastOv = applyEdit;
 const clearForecastOv = clearEdit;
 const clearForecastOvRow = clearEditRow;

 // Recompute inflow + outflow totals + net change + closing cash with the
 // active SCENARIO (sales best/base/worst) and any what-if cell overrides
 // applied. We DON'T touch backend `totals` - that stays as live truth; these
 // "adjusted" arrays drive EVERY downstream number (TOTAL INFLOWS / OUTFLOWS /
 // NET / CLOSING / STATUS + the KPI cards) so the CFO's scenario propagates
 // consistently. Previously the sales scenario only re-coloured the TOTAL
 // INFLOWS display row while closing cash, status and KPIs stayed on the base
 // case - so "Worst case" gave false comfort. Now it flows all the way through.
 // Inflow total = backend truth + any what-if cell-override deltas on the
 // (non-display-only) inflow rows, so editing a sales / AR cell flows through
 // to TOTAL INFLOWS / NET / CLOSING / STATUS and the KPI cards.
 const adjustedInflowTotals = weeks.map((_, i) => {
   let t = totals.inflows[i] ?? 0;
   for (const line of inflows) {
     if (line.displayOnly) continue;            // reference rows aren't in cash
     const base = line.values[i] ?? 0;
     const eff = effectiveInflow(line.label, base, i);  // cell-override OR shared forecast-override
     if (eff !== base) t += eff - base;
   }
   return t;
 });
 const adjustedOutflowTotals = weeks.map((_, i) =>
   outflows.reduce((sum, line) => sum + effectiveOutflow(line.label, line.values[i] ?? 0, i), 0)
 );
 const adjustedNetChange = weeks.map((_, i) => adjustedInflowTotals[i] - adjustedOutflowTotals[i]);
 const adjustedClosingCash: number[] = [];
 {
   let running = openingCashWk1;
   for (let i = 0; i < weeks.length; i++) {
     running += adjustedNetChange[i];
     adjustedClosingCash.push(running);
   }
 }
 // ONE status definition for the whole UI, computed on the ADJUSTED position:
 // CRITICAL if closing < 1 week of (adjusted) burn, TIGHT if < 2 weeks, else
 // HEALTHY. Using the adjusted burn means cutting an outflow in a what-if also
 // relaxes the thresholds, instead of judging the new cash against the old burn.
 const adjustedWeekBurn = (adjustedOutflowTotals.reduce((s, v) => s + v, 0) || 0) / weeks.length;
 const adjustedStatus: CashflowStatus[] = adjustedClosingCash.map((c) =>
   c < adjustedWeekBurn ? 'CRITICAL' : c < adjustedWeekBurn * 2 ? 'TIGHT' : 'HEALTHY'
 );

 const peakInflowIdx = adjustedInflowTotals.indexOf(Math.max(...adjustedInflowTotals));
 const minClosing = Math.min(...adjustedClosingCash);
 const minClosingIdx = adjustedClosingCash.indexOf(minClosing);
 const adjustedInflowTotal13w = adjustedInflowTotals.reduce((s, v) => s + v, 0);
 const sum13InOut = adjustedInflowTotal13w - adjustedOutflowTotals.reduce((s, v) => s + v, 0);
 const criticalWeeks = adjustedStatus.filter((s) => s === 'CRITICAL').length;

 // ── Cell override handlers (all route to the shared server store) ─────────
 const applyOverride = applyEdit;
 const clearOverride = clearEdit;
 const clearRowOverrides = clearEditRow;
 const clearAllOverrides = () => {
   const keys = Object.keys(cashflowEdits);
   setCashflowEdits({});
   void saveCashflowEdits({}, keys).then(setCashflowEdits).catch(() => { /* keep optimistic */ });
 };

 return (
 <>
 {breakdownLine && (() => {
 const qb = qbHeadsFor(breakdownLine.label);
 const sheet = breakdownLine.breakdown ?? [];
 const useQb = qb.length > 0;
 // QB account rows drill to bills; the aggregated "Other" categories don't.
 const drillable = useQb && !/other expenses/i.test(breakdownLine.label);
 // 13-week is a forward weekly projection, so each head's per-week figure is a
 // RECENCY run-rate (last 3 completed months, like the 13-week outflow model),
 // not a flat average of the whole period - so it reflects the recent trend.
 const WPM = 52 / 12; // ~4.33 weeks per month
 const perWeek = (monthly: number[]) => {
 const recent = monthly.slice(-3).filter((v) => v !== 0); // skip empty / in-progress months
 const monthlyRunRate = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
 return monthlyRunRate / WPM;
 };
 const items: { label: string; amount: number; sub?: string }[] = useQb
 ? [...qb].sort((a, b) => perWeek(b.monthly) - perWeek(a.monthly)).map((h) => ({ label: h.name, amount: perWeek(h.monthly) }))
 : sheet.map((b) => ({ label: b.label, amount: b.amount, sub: b.sub }));
 const total = items.reduce((s, it) => s + it.amount, 0);
 return createPortal(
 <div className="cm-modal-backdrop" style={{ zIndex: 10000 }} onClick={() => setBreakdownLine(null)}>
 <div className="cm-modal" style={{ width: 'min(620px, 100%)', margin: 'auto' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
 <div className="cm-modal-head">
 <div className="cm-head-left">
 <div>
 <div className="cm-title">{breakdownLine.label}</div>
 <div className="cm-sub">
 {useQb ? 'From QuickBooks (cash basis), your mapping' : "What's included"} · {items.length} items · {useQb ? `${formatCurrency(Math.round(total))} / week` : `total ${formatCurrency(Math.round(total))}`}
 {drillable ? ' · click a row for its bills' : ''}
 </div>
 </div>
 </div>
 <button className="cm-modal-close" onClick={() => setBreakdownLine(null)} aria-label="Close">✕</button>
 </div>
 <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
 <table className="data-table">
 <thead><tr><th>Item</th><th className="num">{useQb ? 'Per week' : 'Amount'}</th></tr></thead>
 <tbody>
 {items.map((it, i) => (
 <tr
 key={i}
 style={drillable ? { cursor: 'pointer' } : undefined}
 onClick={drillable ? () => setBillAccount(it.label) : undefined}
 title={drillable ? 'Click to see every QuickBooks bill behind this amount' : undefined}
 >
 <td>
 <div style={drillable ? { color: 'var(--accent)' } : undefined}>{it.label}</div>
 {it.sub ? <div className="vendor-note">{it.sub}</div> : null}
 </td>
 <td className="num">{formatCurrency(Math.round(it.amount))}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>,
 document.body,
 );
 })()}
 {billAccount && <BillDrillModal account={billAccount} onClose={() => setBillAccount(null)} />}
 <div className="page-head">
 <div>
 <h1 className="page-title">13-Week Cash Flow {view !== 'budgeted' && <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 400 }}>· {view === 'past' ? 'Past Weeks' : view === 'actual' ? 'Actual' : 'Variance'}</span>}</h1>
 <div className="page-sub">
 {direction === 'future'
 ? <>Rolling 13-week plan · Wk 1 starts Mon <strong>{data.anchor}</strong> (auto-rolls forward each Monday) · Wk 1 opening cash <strong>{formatCurrency(openingCashWk1)}</strong></>
 : <>Trailing 13 weeks · <strong>Wk -1</strong> = most recent closed week (Mon <strong>{data.anchor}</strong>), then Wk -2, Wk -3 ... going back. Current in-progress week lives in the Budgeted tab.</>
 }
 {data.cached && ' · cached'}
 </div>
 </div>
 <div style={{ display: 'flex', gap: 8 }}>
 <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
 {([['budgeted', 'Budgeted'], ['past', 'Past'], ['actual', 'Actual'], ['variance', 'Variance']] as Array<[View, string]>).map(([key, label]) => (
 <button
 key={key}
 className={`filter-tab ${view === key ? 'active' : ''}`}
 style={{ borderRadius: 0, border: 'none' }}
 onClick={() => setView(key)}
 >
 {label}
 </button>
 ))}
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>
 </div>

 {hasAnyOverride && (
   <div style={{
     background: '#fef9c3',
     border: '1px solid #fde68a',
     borderRadius: 8,
     padding: '10px 14px',
     marginBottom: 12,
     display: 'flex',
     justifyContent: 'space-between',
     alignItems: 'center',
     gap: 12,
   }}>
     <div style={{ fontSize: 13, color: '#854d0e' }}>
       <strong>⚡ Manual edits active</strong> · {Object.keys(cashflowEdits).length} cell{Object.keys(cashflowEdits).length === 1 ? '' : 's'} edited (saved).
       Closing cash and status pills below reflect your edits, not the live forecast.
     </div>
     <button
       type="button"
       onClick={clearAllOverrides}
       style={{
         background: '#fff',
         border: '1px solid #fbbf24',
         color: '#854d0e',
         padding: '6px 12px',
         borderRadius: 6,
         fontSize: 12,
         fontWeight: 600,
         cursor: 'pointer',
       }}
     >Reset all overrides</button>
   </div>
 )}

 {warnings.length > 0 && (
 <div className="section" style={{ padding: '12px 16px', background: 'var(--warn-soft)', border: '1px solid var(--warn)' }}>
 <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warn)', marginBottom: 4 }}>DATA SOURCE WARNINGS</div>
 {warnings.map((w, i) => <div key={i} className="page-sub" style={{ fontSize: 12 }}>· {w}</div>)}
 </div>
 )}

 {/* Past Weeks layout: month overview cards on top + full week-by-week
   * cashflow table where each cell shows projected + actual + variance.
   * Built from captured Monday snapshots (proj) + live-computed actuals
   * for each closed week. This replaces the broken "run forward-projection
   * algorithm on past dates" approach which produced $0 / dashes. */}
 {/* Past / Actual / Variance: one layout, three modes, all from the
   * past-weeks grid (snapshot = budget frozen that Monday, actuals = real). */}
 {view === 'past' && (
 <PastWeeksTable mode="budget" budgetData={data} pastGrid={pastGrid} />
 )}
 {view === 'actual' && (
 <PastWeeksTable mode="actual" budgetData={data} pastGrid={pastGrid} />
 )}
 {view === 'variance' && (
 <VariancePicker budgetData={data} pastGrid={pastGrid} />
 )}

 {/* CC Utilisation editor removed - CC financing is no longer part of the 13-week plan. */}

 {/* Future-direction-only sections: KPI strip + CC editor + Weekly schedule
   * + Totals row. Past direction shows only the snapshot variance + month
   * overview above - the main cashflow projection logic is forward-looking
   * by nature (AR projection, sales forecast, opening cash), so running it
   * against a past window produces $0 / dashes that misrepresent history.
   * For past data the right artefacts are the captured Monday snapshots +
   * the actuals computed in the variance section above. */}
 {view === 'budgeted' && <>
 <div className="kpis" data-cfo-anchor="cf-kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Wk 1 Opening Cash</div>
 <div className="kpi-period">{data.anchor}</div>
 <div className="kpi-value">{formatCurrency(openingCashWk1)}</div>
 <div className="kpi-sub">From {srcLabel(openingCashSource)}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">13-Week Net</div>
 <div className="kpi-period">Inflows − Outflows</div>
 <div className="kpi-value">{formatSigned(sum13InOut)}</div>
 <div className="kpi-sub">Total inflows {formatCurrency(adjustedInflowTotal13w)}{salesScenario !== 'base' ? ` · ${salesScenario} case` : ''}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Min Closing Cash</div>
 <div className="kpi-period">Wk {minClosingIdx + 1} · {weeks[minClosingIdx].label}</div>
 <div className="kpi-value">{formatCurrency(minClosing)}</div>
 <div className="kpi-sub">{criticalWeeks > 0 ? `${criticalWeeks} CRITICAL weeks` : 'No critical weeks'}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Peak Inflow</div>
 <div className="kpi-period">Wk {peakInflowIdx + 1} · {weeks[peakInflowIdx].label}</div>
 <div className="kpi-value">{formatCurrency(adjustedInflowTotals[peakInflowIdx])}</div>
 <div className="kpi-sub">AR collections + projected sales</div>
 </div>
 </div>

 <div className="section" data-cfo-anchor="cf-schedule">
 <div className="section-head">
 <div>
 <div className="section-title">Weekly schedule</div>
 <div className="section-sub">
 Rows tagged <span className="pill-tag tag-strong">Live</span> pull from Tiller / QB / sheets. Tap the ⓘ on any row to see how it's computed.
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 260 }}>Line item</th>
 <th>Source</th>
 {weeks.map((w, i) => (
 <th key={i} className="num">
 <div style={{ fontSize: 11, fontWeight: 700 }}>{direction === 'past' ? `Wk -${i + 1}` : `Wk ${i + 1}`}</div>
 <div style={{ fontSize: 10, color: 'var(--muted)' }}>{w.label} – {w.end.slice(5).replace('-', '/')}</div>
 </th>
 ))}
 <th className="num">13-wk total</th>
 </tr>
 </thead>
 <tbody>
 {/* OPENING CASH */}
 <tr className="row-fuzzy">
 <td>
 <strong>OPENING CASH</strong>
 {data.openingCashNote && <div className="vendor-note">{data.openingCashNote}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(openingCashSource)}`}>{srcLabel(openingCashSource)}</span></td>
 {totals.openingCash.map((v, i) => (
 <td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>
 ))}
 <td className="num">-</td>
 </tr>

 {/* INFLOWS HEADER */}
 <tr>
 <td colSpan={2 + weeks.length + 1} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>
 CASH INFLOWS
 </td>
 </tr>
 {inflows.map((line, idx) => {
 const isProjectedSales = /^projected sales/i.test(line.label);
 const isDisplayOnly = !!line.displayOnly;
 const editableInflow = isInflowEditable(line.label);
 const rowHasOverride = line.values.some((_, i) => hasOverride(line.label, i) || forecastOvVal(line.label, i) != null);
 const sf = data.salesForecast;
 // Scenario swap: if this is the Projected Sales row and a non-base
 // scenario is selected, replace the row's weekly values with the
 // matching weekly-inflow array from the sales forecast.
 const rowValues = (isProjectedSales && sf && salesScenario !== 'base')
   ? (salesScenario === 'best' ? sf.weeklyInflowBest : sf.weeklyInflowWorst)
   : line.values;
 const rowTotal = rowValues.reduce((s, v, i) => s + effectiveInflow(line.label, v ?? 0, i), 0);
 const scenarioPct = salesScenario === 'best' ? '+18%' : salesScenario === 'worst' ? '-18%' : null;
 return (
 <tr key={`in-${idx}`} style={isDisplayOnly ? { opacity: 0.7, fontStyle: 'italic' } : undefined}>
 <td>
 <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
 {line.breakdown && line.breakdown.length > 0 ? (
   <button type="button" onClick={() => setBreakdownLine(line)} title="See what's included"
     className="cf-rowlabel">
     {DISPLAY_LABELS[line.label] || line.label}
   </button>
 ) : <strong>{DISPLAY_LABELS[line.label] || line.label}</strong>}
 {ROW_INFO[line.label] && (
   <InfoTip
     {...ROW_INFO[line.label]}
     style={{ position: 'static', top: 'auto', right: 'auto', display: 'inline-flex' }}
   />
 )}
 {rowHasOverride && (
   <button type="button" title="Reset overrides on this row" onClick={() => { if (editableInflow) clearForecastOvRow(line.label); else clearRowOverrides(line.label); }}
     style={{ background: 'none', border: 'none', color: 'var(--warn)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 11 }}>↺ reset row</button>
 )}
 {isDisplayOnly && (
   <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px', fontStyle: 'normal', letterSpacing: 0.3 }}>
     REFERENCE · NOT IN CASH TOTAL
   </span>
 )}
 {isProjectedSales && sf && (
   <div style={{ display: 'inline-flex', gap: 4, fontSize: 11 }}>
   {(['worst', 'base', 'best'] as const).map((sc) => (
     <button
       key={sc}
       type="button"
       onClick={() => setSalesScenario(sc)}
       style={{
         padding: '2px 8px',
         border: salesScenario === sc ? '1px solid var(--accent)' : '1px solid var(--border)',
         background: salesScenario === sc ? 'var(--accent-soft)' : 'var(--bg)',
         color: salesScenario === sc ? 'var(--accent-hover)' : 'var(--muted)',
         borderRadius: 4,
         cursor: 'pointer',
         fontWeight: salesScenario === sc ? 700 : 500,
         textTransform: 'capitalize',
       }}
     >
       {sc}
     </button>
   ))}
   </div>
 )}
 </div>
 {line.note && <div className="vendor-note" style={{ color: '#374151' }}>{isProjectedSales && scenarioPct ? `Scenario: ${salesScenario} (${scenarioPct}) · ` : ''}{line.note}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(line.source)}`}>{srcLabel(line.source)}</span></td>
 {rowValues.map((v, i) => {
   const effVal = effectiveInflow(line.label, v ?? 0, i);
   const isOver = hasOverride(line.label, i) || forecastOvVal(line.label, i) != null;
   return (
     <td
       key={i}
       className="num cf-edit-cell"
       style={{ cursor: 'pointer', background: isOver ? '#fef9c3' : undefined, position: 'relative' }}
       onClick={() => setEditingCell({ label: line.label, weekIdx: i, current: effVal, kind: editableInflow ? 'inflow' : undefined })}
       title={isOver ? `${editByNote(line.label, i) ?? 'Edited'} · was ${formatCurrency(v ?? 0)}` : 'Click to edit · saved with your name'}
     >
       {effVal ? formatCurrency(effVal) : '-'}
       {isOver && <span style={{ marginLeft: 4, color: '#a16207', fontSize: 10 }}>⚡</span>}
     </td>
   );
 })}
 <td className="num"><strong>{formatCurrency(rowTotal)}</strong></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td>TOTAL INFLOWS{salesScenario !== 'base' ? <span className="vendor-note"> · {salesScenario} case</span> : null}</td>
 <td>-</td>
 {adjustedInflowTotals.map((v, i) => (
   <td key={i} className="num">{formatCurrency(v)}</td>
 ))}
 <td className="num">{formatCurrency(adjustedInflowTotal13w)}</td>
 </tr>

 {/* OUTFLOWS HEADER */}
 <tr>
 <td colSpan={2 + weeks.length + 1} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>
 CASH OUTFLOWS
 </td>
 </tr>
 {outflows.map((line, idx) => {
 const effectiveValues = line.values.map((v, i) => effectiveOutflow(line.label, v ?? 0, i));
 const rowTotal = effectiveValues.reduce((s, v) => s + v, 0);
 const rowHasOverride = line.values.some((_, i) => hasOverride(line.label, i));
 return (
 <tr key={`out-${idx}`}>
 <td>
 <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
   {line.breakdown && line.breakdown.length > 0 ? (
     <button type="button" onClick={() => setBreakdownLine(line)} title="See what's included"
       className="cf-rowlabel">
       {DISPLAY_LABELS[line.label] || line.label}
     </button>
   ) : <strong>{DISPLAY_LABELS[line.label] || line.label}</strong>}
   {ROW_INFO[line.label] && (
     <InfoTip
       {...ROW_INFO[line.label]}
       style={{ position: 'static', top: 'auto', right: 'auto', display: 'inline-flex' }}
     />
   )}
   {rowHasOverride && (
     <button
       type="button"
       title="Reset overrides on this row"
       onClick={() => clearRowOverrides(line.label)}
       style={{ background: 'none', border: 'none', color: 'var(--warn)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 11 }}
     >↺ reset row</button>
   )}
 </div>
 {line.note && <div className="vendor-note" style={{ color: '#374151' }}>{line.note}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(line.source)}`}>{srcLabel(line.source)}</span></td>
 {line.values.map((v, i) => {
   const effVal = effectiveOutflow(line.label, v ?? 0, i);
   const isOver = hasOverride(line.label, i);
   return (
     <td
       key={i}
       className="num cf-edit-cell"
       style={{
         cursor: 'pointer',
         background: isOver ? '#fef9c3' : undefined,
         position: 'relative',
       }}
       onClick={() => setEditingCell({ label: line.label, weekIdx: i, current: effVal })}
       title={isOver ? `${editByNote(line.label, i) ?? 'Edited'} · was ${formatCurrency(v ?? 0)}` : 'Click to edit · saved with your name'}
     >
       {effVal ? formatCurrency(effVal) : '-'}
       {isOver && <span style={{ marginLeft: 4, color: '#a16207', fontSize: 10 }}>⚡</span>}
     </td>
   );
 })}
 <td className="num"><strong>{formatCurrency(rowTotal)}</strong></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td>TOTAL OUTFLOWS</td>
 <td>-</td>
 {adjustedOutflowTotals.map((v, i) => (
 <td key={i} className="num">{formatCurrency(v)}</td>
 ))}
 <td className="num">{formatCurrency(adjustedOutflowTotals.reduce((s, v) => s + v, 0))}</td>
 </tr>

 {/* NET / CLOSING / STATUS - driven by overrides if any */}
 <tr>
 <td><strong>NET CASH CHANGE</strong></td>
 <td>-</td>
 {adjustedNetChange.map((v, i) => (
 <td key={i} className="num" style={{ color: v >= 0 ? '#059669' : 'var(--danger)' }}>
 <strong>{formatSigned(v)}</strong>
 </td>
 ))}
 <td className="num"><strong>{formatSigned(adjustedNetChange.reduce((s, v) => s + v, 0))}</strong></td>
 </tr>
 <tr className="total-row">
 <td>CLOSING CASH</td>
 <td>-</td>
 {adjustedClosingCash.map((v, i) => (
 <td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>
 ))}
 <td className="num">-</td>
 </tr>
 <tr>
 <td><strong>STATUS</strong></td>
 <td>-</td>
 {adjustedStatus.map((s, i) => (
 <td key={i} className="num">
 <span className={`pill-tag tag-${statusTone(s)}`}>{s}</span>
 </td>
 ))}
 <td className="num">-</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 </>}

 {editingCell && (
   <EditOutflowModal
     label={DISPLAY_LABELS[editingCell.label] || editingCell.label}
     weekIdx={editingCell.weekIdx}
     weekLabel={`Wk ${editingCell.weekIdx + 1} · ${weeks[editingCell.weekIdx]?.label ?? ''}`}
     liveValue={[...inflows, ...outflows].find((l) => l.label === editingCell.label)?.values[editingCell.weekIdx] ?? 0}
     currentValue={editingCell.current}
     isOverridden={hasOverride(editingCell.label, editingCell.weekIdx)}
     savedNote={editByNote(editingCell.label, editingCell.weekIdx) ?? 'Saved to the server with your name — shared with the team.'}
     onSave={(value, applyForward) => {
       applyEdit(editingCell.label, editingCell.weekIdx, value, applyForward);
       setEditingCell(null);
     }}
     onClear={() => {
       clearEdit(editingCell.label, editingCell.weekIdx);
       setEditingCell(null);
     }}
     onCancel={() => setEditingCell(null)}
   />
 )}
 </>
 );
}

// ---- Edit Outflow Modal ---------------------------------------------------
function EditOutflowModal({
 label, weekIdx, weekLabel, liveValue, currentValue, isOverridden, savedNote,
 onSave, onClear, onCancel,
}: {
 label: string;
 weekIdx: number;
 weekLabel: string;
 liveValue: number;
 currentValue: number;
 isOverridden: boolean;
 savedNote?: string;
 onSave: (value: number, applyForward: boolean) => void;
 onClear: () => void;
 onCancel: () => void;
}) {
 // Two input modes - operators usually think in MONTHLY budgets, not
 // weekly drips. Weekly mode = enter the per-week dollar amount as-is.
 // Monthly mode = enter the monthly target; we divide by 4.33 to get
 // the per-week value the grid uses. Toggle stays sticky so the same
 // mode is preselected next edit (saved in localStorage).
 const WEEKS_PER_MONTH = 4.33;
 const [mode, setMode] = useState<'week' | 'month'>(() => {
   try { return (window.localStorage.getItem('cf13-edit-mode') as 'week' | 'month') || 'week'; }
   catch { return 'week'; }
 });
 useEffect(() => {
   try { window.localStorage.setItem('cf13-edit-mode', mode); } catch { /* ignore */ }
 }, [mode]);
 const [val, setVal] = useState<string>(() =>
   String(Math.round(mode === 'month' ? currentValue * WEEKS_PER_MONTH : currentValue))
 );
 const [applyFwd, setApplyFwd] = useState(true);

 // ESC to cancel for keyboard-driven users
 useEffect(() => {
   const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
   window.addEventListener('keydown', onKey);
   return () => window.removeEventListener('keydown', onKey);
 }, [onCancel]);

 const numericInput = parseFloat(val.replace(/[$,\s]/g, ''));
 const validNumber = Number.isFinite(numericInput) && numericInput >= 0;
 // Whatever the user typed → translate to per-week value (what gets saved).
 const numericVal = validNumber
   ? (mode === 'month' ? numericInput / WEEKS_PER_MONTH : numericInput)
   : 0;
 const delta = validNumber ? numericVal - currentValue : 0;
 // The "other" view of the same value - shown next to the input as context.
 const otherValue = validNumber
   ? (mode === 'month' ? numericVal : numericVal * WEEKS_PER_MONTH)
   : 0;

 return (
   <div
     onClick={onCancel}
     style={{
       position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
       backdropFilter: 'blur(4px)', zIndex: 1000,
       display: 'flex', alignItems: 'center', justifyContent: 'center',
       padding: 16,
     }}
   >
     <div
       onClick={(e) => e.stopPropagation()}
       style={{
         background: '#fff', borderRadius: 12, maxWidth: 480, width: '100%',
         padding: 22, boxShadow: '0 24px 60px rgba(15,23,42,0.3)',
         fontFamily: 'inherit',
       }}
     >
       <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
         {savedNote ? 'Edit' : 'What-if edit'} · {weekLabel}
       </div>
       <h3 style={{ margin: '4px 0 6px', fontSize: 18, fontWeight: 600 }}>{label}</h3>
       {savedNote && <div style={{ margin: '0 0 14px', fontSize: 12, color: '#059669' }}>{savedNote}</div>}

       {/* Live snapshot showing BOTH weekly and monthly equivalent of
           the current value, so the user sees the relationship before
           they edit. */}
       <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
         <div style={{ padding: '10px 12px', background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 8 }}>
           <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>This week (live)</div>
           <div style={{ fontSize: 15, fontWeight: 600 }}>${liveValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
           <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
             ≈ ${(liveValue * WEEKS_PER_MONTH).toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
           </div>
         </div>
         <div style={{ padding: '10px 12px', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8 }}>
           <div style={{ fontSize: 11, color: '#854d0e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
             New value {isOverridden && '(overridden)'}
           </div>
           <div style={{ fontSize: 15, fontWeight: 600, color: '#854d0e' }}>
             ${validNumber ? numericVal.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}/wk
           </div>
           <div style={{ fontSize: 11, color: '#854d0e', marginTop: 2 }}>
             ≈ ${validNumber ? (numericVal * WEEKS_PER_MONTH).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}/mo
           </div>
         </div>
       </div>

       {/* Mode toggle - weekly vs monthly input. Most CFOs think in
           monthly budgets, so this is the key UX hook that makes the
           edit feel intuitive. */}
       <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 3, gap: 2, marginBottom: 10 }}>
         {(['week', 'month'] as const).map((m) => (
           <button
             key={m}
             type="button"
             onClick={() => {
               // Re-seed the input so switching modes shows the equivalent value.
               const baseWeekly = validNumber ? numericVal : currentValue;
               setVal(String(Math.round(m === 'month' ? baseWeekly * WEEKS_PER_MONTH : baseWeekly)));
               setMode(m);
             }}
             style={{
               background: mode === m ? '#fff' : 'transparent',
               border: 'none', padding: '6px 14px', borderRadius: 6,
               fontSize: 12, fontWeight: 600,
               color: mode === m ? 'var(--accent)' : 'var(--muted-strong)',
               cursor: 'pointer',
               boxShadow: mode === m ? '0 1px 2px rgba(15,23,42,0.06)' : 'none',
             }}
           >Edit {m === 'week' ? 'weekly' : 'monthly'}</button>
         ))}
       </div>

       <label style={{ display: 'block', marginBottom: 10 }}>
         <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
           <span>New {mode === 'month' ? 'monthly' : 'weekly'} amount ($)</span>
           {validNumber && (
             <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
               = ${otherValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}/{mode === 'month' ? 'wk' : 'mo'}
             </span>
           )}
         </div>
         <input
           type="text"
           autoFocus
           value={val}
           onChange={(e) => setVal(e.target.value)}
           onKeyDown={(e) => { if (e.key === 'Enter' && validNumber) onSave(numericVal, applyFwd); }}
           style={{
             width: '100%', padding: '10px 12px', border: '1px solid var(--border)',
             borderRadius: 8, fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box',
           }}
         />
         {validNumber && delta !== 0 && (
           <div style={{ fontSize: 11, marginTop: 4, color: delta > 0 ? 'var(--danger)' : '#059669' }}>
             {delta > 0 ? '↑ Increase' : '↓ Decrease'} of ${Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 0 })}/wk vs current
           </div>
         )}
       </label>

       <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer', fontSize: 13 }}>
         <input type="checkbox" checked={applyFwd} onChange={(e) => setApplyFwd(e.target.checked)} />
         <span>Apply forward - push this value to all remaining weeks ({weekIdx + 1} onwards)</span>
       </label>

       <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
         <div style={{ display: 'flex', gap: 8 }}>
           {isOverridden && (
             <button
               type="button"
               onClick={onClear}
               style={{ background: '#fff', border: '1px solid var(--border)', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', color: 'var(--muted-strong)', fontSize: 13 }}
             >Clear override</button>
           )}
         </div>
         <div style={{ display: 'flex', gap: 8 }}>
           <button
             type="button"
             onClick={onCancel}
             style={{ background: '#fff', border: '1px solid var(--border)', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
           >Cancel</button>
           <button
             type="button"
             onClick={() => onSave(numericVal, applyFwd)}
             disabled={!validNumber}
             style={{
               background: validNumber ? 'var(--accent)' : 'var(--border)',
               color: '#fff', border: 'none', padding: '8px 16px',
               borderRadius: 8, cursor: validNumber ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600,
             }}
           >Save</button>
         </div>
       </div>
     </div>
   </div>
 );
}

// ---- Snapshot Variance (Past Weeks) ---------------------------------------
// Each captured Monday is a row: what we forecasted for that week's Wk1 vs.
// what actually hit the business bank accounts (computed live from Tiller).
// Weeks that haven't closed yet show "pending" for actuals.

/** Live overview for the CURRENT calendar month - mirrors the WeekVariance
 *  card design but at the month level so the user can see at a glance:
 *  what was projected for May, what's been invoiced/collected so far. */
function CurrentMonthOverviewSection({ data }: { data: CurrentMonthOverview | null }) {
 if (!data) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Current month · live projection vs reality</div>
   <div className="section-sub">Loading…</div>
   </div>
   </div>
   </div>
  );
 }
 const m = data.month;
 const salesProj = data.sales.projected.base;
 const salesActual = data.sales.invoicedMtd.total;
 const arNgProj = data.ar.nonGelato.projected;
 const arNgActual = data.ar.nonGelato.collected;
 const arGelProj = data.ar.gelato.projected;
 const arGelActual = data.ar.gelato.collected;

 function delta(fc: number, ac: number) {
  const d = ac - fc;
  const tone = d >= 0 ? '#059669' : 'var(--danger)';
  return <span style={{ color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{formatCurrency(d)}</span>;
 }
 function pctOf(ac: number, fc: number) {
  if (fc <= 0) return null;
  const p = (ac / fc) * 100;
  return <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {p.toFixed(0)}% of projected</span>;
 }
 function Card({
  title, projected, actual, actualLabel, hint,
 }: { title: string; projected: number; actual: number; actualLabel: string; hint?: string }) {
  return (
   <div style={{
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
    background: 'var(--panel, #fff)',
    flex: 1,
    minWidth: 240,
   }}>
   <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{title}</div>
   <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
    <div>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>Projected ({m.label})</div>
    <div style={{ fontSize: 18, fontWeight: 700 }}>{formatCurrency(projected)}</div>
    </div>
    <div style={{ textAlign: 'right' }}>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{actualLabel}</div>
    <div style={{ fontSize: 18, fontWeight: 700 }}>{formatCurrency(actual)}</div>
    </div>
   </div>
   <div style={{ marginTop: 8, fontSize: 12 }}>
    Δ {delta(projected, actual)}{pctOf(actual, projected)}
   </div>
   {hint && <div className="vendor-note" style={{ fontSize: 10, marginTop: 6 }}>{hint}</div>}
   </div>
  );
 }
 return (
  <div className="section">
  <div className="section-head">
  <div>
  <div className="section-title">{m.label} · live projection vs reality</div>
  <div className="section-sub">
   Day <strong>{m.dayOfMonth}</strong> of {m.daysInMonth} ({m.progressPct.toFixed(0)}% of month elapsed) · open AR <strong>{formatCurrency(data.openArAsOfToday.amount)}</strong> across {data.openArAsOfToday.invoiceCount} invoices
  </div>
  </div>
  </div>
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
   {/* Scenario range chip - small + unobtrusive */}
   <div style={{
    flexBasis: '100%',
    fontSize: 11,
    color: 'var(--muted)',
    marginBottom: -4,
   }}>
   Sales range: worst <strong>{formatCurrency(data.sales.projected.worst)}</strong> · base <strong>{formatCurrency(data.sales.projected.base)}</strong> · best <strong>{formatCurrency(data.sales.projected.best)}</strong>
   </div>
   <Card
    title="Sales projection"
    projected={salesProj}
    actual={salesActual}
    actualLabel="Invoiced MTD"
    hint={`${data.sales.invoicedMtd.invoiceCount} invoices issued so far`}
   />
   <Card
    title="AR"
    projected={arNgProj}
    actual={arNgActual}
    actualLabel="Collected MTD"
    hint={`Cash already received from already-issued invoices · ${data.ar.nonGelato.invoiceCount} invoices paid`}
   />
   <Card
    title="AR (Net 97)"
    projected={arGelProj}
    actual={arGelActual}
    actualLabel="Collected MTD"
    hint={arGelProj === 0 ? 'No Net-97 batches due to land this month' : `${data.ar.gelato.invoiceCount} invoices paid`}
   />
  </div>
  </div>
 );
}

/**
 * Past Weeks cashflow table - same row/column structure as the future
 * cashflow table (line items × weeks), but each cell shows BOTH the
 * projected value (snapshot frozen that Monday) AND the actual value
 * (live computed for that closed week) + variance.
 *
 * Columns: Wk 1 = current week (May 11 today, in progress with live data),
 * then closed weeks going backward (Wk 2 = May 4, Wk 3 = Apr 27...).
 *
 * Rows: Per inflow/outflow line item from snapshots. Per-line outflow
 * actuals aren't tracked (only total inflow/outflow is computed live), so
 * outflow cells show projected only.
 */
function PastCashflowTable({
 pastGrid, liveData, futureData, salesScenario,
}: {
 pastGrid: PastWeeksGridResponse | null;
 liveData: Cashflow13;
 futureData: Cashflow13 | null;
 salesScenario: 'worst' | 'base' | 'best';
}) {
 if (!pastGrid) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Past weeks · projection vs actual</div>
   <div className="section-sub">Loading past weeks…</div>
   </div>
   </div>
   </div>
  );
 }
 // Items already in newest-first order from the server.
 const items = pastGrid.items;
 if (items.length === 0) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Past weeks · projection vs actual</div>
   <div className="section-sub">No past weeks data.</div>
   </div>
   </div>
   </div>
  );
 }

 // Standard inflow/outflow labels (use the same set as the future cashflow so
 // the row layout is stable even for weeks without a snapshot). Falls back to
 // whatever labels exist on the snapshots we DO have.
 const standardInflowLabels = ['AR Collections (Net 97)', 'AR Collections (lag-curve)', 'Projected AR from new sales (3-bucket)', 'CC Utilisation'];

 // Historical label aliases - older snapshots used different names for what
 // are now the same lines. Map old → current so they merge into one row
 // instead of showing up twice with identical numbers.
 const LABEL_ALIASES: Record<string, string> = {
   'AR Collections (lag-curve, legacy)': 'AR Collections (lag-curve)',
 };
 const canonLabel = (l: string) => LABEL_ALIASES[l] ?? l;

 const inflowLabels: string[] = [...standardInflowLabels];
 const outflowLabels: string[] = [];
 const seenIn = new Set(standardInflowLabels);
 const seenOut = new Set<string>();
 for (const it of items) {
  if (!it.snapshot) continue;
  for (const l of it.snapshot.inflows) {
    const canon = canonLabel(l.label);
    if (!seenIn.has(canon)) { seenIn.add(canon); inflowLabels.push(canon); }
  }
  for (const l of it.snapshot.outflows) {
    const canon = canonLabel(l.label);
    if (!seenOut.has(canon)) { seenOut.add(canon); outflowLabels.push(canon); }
  }
 }
 // Fallback outflow labels from future cashflow when no snapshot in window.
 if (outflowLabels.length === 0 && futureData) {
  for (const l of futureData.outflows) { seenOut.add(l.label); outflowLabels.push(l.label); }
 }

 /** Projection for a given week's line item.
  *  - In-progress (current) week: use FUTURE direction's live Wk 1 value -
  *    reflects today's latest methodology + scenario selector, matches what
  *    the user sees in the Future tab.
  *  - Closed weeks: use snapshot.wk1Value (historical truth - what we said
  *    that Monday morning, never changes after that). */
 function projFor(it: PastWeeksGridResponse['items'][number], label: string, side: 'in' | 'out'): number | null {
  if (!it.weekClosed && futureData) {
   const liveList = side === 'in' ? futureData.inflows : futureData.outflows;
   const liveHit = liveList.find((l) => l.label === label);
   if (liveHit) {
    // Sales row honours the scenario selector to match Future tab.
    if (side === 'in' && /^projected sales/i.test(label) && futureData.salesForecast) {
     if (salesScenario === 'best')  return futureData.salesForecast.weeklyInflowBest?.[0] ?? liveHit.values[0] ?? 0;
     if (salesScenario === 'worst') return futureData.salesForecast.weeklyInflowWorst?.[0] ?? liveHit.values[0] ?? 0;
    }
    return liveHit.values[0] ?? 0;
   }
  }
  if (!it.snapshot) return null;
  const list = side === 'in' ? it.snapshot.inflows : it.snapshot.outflows;
  // Try canonical name first; fall back to any alias that maps to it
  // (lets old snapshots written under the previous label name still match).
  let hit = list.find((l) => l.label === label);
  if (!hit) {
   hit = list.find((l) => canonLabel(l.label) === label);
  }
  return hit?.wk1Value ?? 0;
 }
 void liveData;

 /** Actual amount for an inflow line label (only some are mapped). */
 function actualInflowFor(it: PastWeeksGridResponse['items'][number], label: string): number | null {
  const a = it.actuals;
  if (!a) return null;
  if (/net 97/i.test(label))      return a.arActuals?.gelato?.amount ?? 0;
  // Sales (this week) = gross invoiced (reference only).
  if (isDisplayOnlyInflow(label))  return a.salesInvoiced?.nonGelato?.amount ?? 0;
  // Past AR Collections (lag-curve) = collections from sales invoiced in EARLIER weeks.
  if (/^past ar|lag-curve/i.test(label))  return a.arActuals?.nonGelato?.lagged ?? a.arActuals?.nonGelato?.amount ?? 0;
  // Collected from sales (this week) = same-week cash.
  if (/collected from sales|^projected/i.test(label)) return a.arActuals?.nonGelato?.sameWeek ?? 0;
  // CC Util etc. have no direct actuals - return null so cell shows just projected.
  return null;
 }

 function fmt(n: number): string {
  return formatCurrency(Math.round(n));
 }
 function cell(proj: number | null, act: number | null): React.ReactNode {
  const hasProj = proj !== null && proj !== 0;
  const hasAct = act !== null && act !== 0;
  if (!hasProj && !hasAct) return <span style={{ color: 'var(--muted)' }}>-</span>;
  if (proj === null && act !== null) {
   // Closed week with no snapshot - show actual only (no clutter).
   return <div style={{ lineHeight: 1.2 }}><div style={{ fontWeight: 600 }}>{fmt(act)}</div></div>;
  }
  const p = proj ?? 0;
  if (act === null) return <div style={{ lineHeight: 1.2 }}><div>{fmt(p)}</div></div>;
  const d = act - p;
  const tone = d >= 0 ? '#059669' : 'var(--danger)';
  return (
   <div style={{ lineHeight: 1.2 }}>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>fc {fmt(p)}</div>
    <div style={{ fontWeight: 600 }}>{fmt(act)}</div>
    <div style={{ fontSize: 10, color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt(d)}</div>
   </div>
  );
 }
 function rowCell(proj: number | null, act: number | null): React.ReactNode {
  return cell(proj, act);
 }

 return (
  <CollapsibleSection
   title={`Past weeks · projection vs actual (${items.length} closed week${items.length === 1 ? '' : 's'})`}
   sub={<>Closed weeks only - "Wk -1" = the most recent Sunday, then "Wk -2", "Wk -3"... going back. Each cell shows <strong>fc</strong> (snapshot frozen that Monday, where captured) over <strong>actual</strong> (sales invoiced + AR collected in that range) over <strong>Δ</strong> (variance). The current in-progress week lives in the Budgeted tab as its Wk 1.</>}
  >
   <div className="table-wrap">
   <table className="data-table" style={{ fontSize: 12 }}>
   <thead>
   <tr>
   <th>Line item</th>
   <th>Source</th>
   {items.map((it, i) => (
    <th key={it.monday} className="num">
     <div>Wk -{i + 1}</div>
     <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{it.monday.slice(5)}</div>
    </th>
   ))}
   </tr>
   </thead>
   <tbody>
   <tr>
   <td><strong>Opening cash</strong></td>
   <td><span className="pill-tag tag-strong" style={{ fontSize: 10 }}>Live</span></td>
   {items.map((it) => (
    <td key={it.monday} className="num">{it.snapshot ? fmt(it.snapshot.openingCash) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
   ))}
   </tr>

   <tr><td colSpan={2 + items.length} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>CASH INFLOWS</td></tr>
   {inflowLabels.map((label) => (
    <tr key={`in-${label}`}>
    <td>{label}</td>
    <td><span className="pill-tag tag-fuzzy" style={{ fontSize: 10 }}>Calc</span></td>
    {items.map((it) => {
     const proj = projFor(it, label, 'in');
     const act = actualInflowFor(it, label);
     return <td key={it.monday} className="num">{cell(proj, act)}</td>;
    })}
    </tr>
   ))}
   <tr className="total-row">
   <td>TOTAL INFLOWS</td>
   <td>-</td>
   {items.map((it) => {
    // For in-progress week: use Future tab's authoritative totals[0] so
    // the number matches Future tab exactly. For closed weeks: use the
    // snapshot's totalInflowWk1 (also authoritative for that Monday).
    let proj: number | null;
    if (!it.weekClosed && futureData) proj = futureData.totals.inflows[0] ?? null;
    else if (it.snapshot) proj = it.snapshot.totalInflowWk1;
    else proj = null;
    const act = it.actuals?.inflow ?? null;
    return <td key={it.monday} className="num">{rowCell(proj, act)}</td>;
   })}
   </tr>

   <tr><td colSpan={2 + items.length} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>CASH OUTFLOWS</td></tr>
   {outflowLabels.map((label) => (
    <tr key={`out-${label}`}>
    <td>{label}</td>
    <td><span className="pill-tag tag-fuzzy" style={{ fontSize: 10 }}>Calc</span></td>
    {items.map((it) => {
     const proj = projFor(it, label, 'out');
     // Per-line outflow actuals not available - cell shows projected only.
     return <td key={it.monday} className="num">{cell(proj, null)}</td>;
    })}
    </tr>
   ))}
   <tr className="total-row">
   <td>TOTAL OUTFLOWS</td>
   <td>-</td>
   {items.map((it) => {
    // Per user: show projection only, no actual. Tiller's outflow total
    // mixes payroll/CC payments/transfers without per-line attribution,
    // so the variance signal is noisy. Projection from Future tab.
    let proj: number | null;
    if (!it.weekClosed && futureData) proj = futureData.totals.outflows[0] ?? null;
    else if (it.snapshot) proj = it.snapshot.totalOutflowWk1;
    else proj = null;
    return <td key={it.monday} className="num">{rowCell(proj, null)}</td>;
   })}
   </tr>

   <tr className="total-row">
   <td><strong>NET CHANGE</strong></td>
   <td>-</td>
   {items.map((it) => {
    // Projection only - net change actual depends on outflow actual which
    // we're hiding for now.
    let proj: number | null;
    if (!it.weekClosed && futureData) {
     proj = (futureData.totals.inflows[0] ?? 0) - (futureData.totals.outflows[0] ?? 0);
    } else if (it.snapshot) {
     proj = it.snapshot.netChangeWk1;
    } else proj = null;
    return <td key={it.monday} className="num">{rowCell(proj, null)}</td>;
   })}
   </tr>
   </tbody>
   </table>
   </div>
  </CollapsibleSection>
 );
}

// ---- Small section shells -------------------------------------------------
function LoadingSection({ title }: { title: string }) {
 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">{title}</div>
    <div className="section-sub">Loading…</div>
   </div></div>
  </div>
 );
}
function EmptySection({ title, sub }: { title: string; sub: string }) {
 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">{title}</div>
    <div className="section-sub">{sub}</div>
   </div></div>
  </div>
 );
}
// ---- actuals + budget line mapping ----------------------------------------
function actualForInflowLine(label: string, a: WeekActuals): number | null {
 if (/net 97/i.test(label)) return a.arActuals?.gelato?.amount ?? 0;
 // Sales (this week) = gross invoiced (reference only, not cash).
 if (isDisplayOnlyInflow(label)) return a.salesInvoiced?.nonGelato?.amount ?? a.salesInvoiced?.total ?? 0;
 // New sales collections = 0 in the past: every sale in an elapsed week is
 // already invoiced, so that cash is in the total collected on the AR row
 // below. Showing it separately would double-count.
 if (/collected from sales|new sales|projected/i.test(label)) return 0;
 // Past AR = ALL cash collected that week (lagged + same-week), matching the
 // by-due-date budget (which is the full collection).
 if (/past ar|lag-curve|receivable/i.test(label)) return a.arActuals?.nonGelato?.amount ?? 0;
 return null;
}
// Live-expected inflow (by invoice terms) for an inflow line.
function expectedForInflowLine(label: string, e: ExpectedInflowWeek | null): number | null {
 if (!e) return null;
 if (/net 97/i.test(label)) return e.gelato;
 if (/receivable|past ar|lag-curve/i.test(label)) return e.other;
 return null; // "Projected AR from new sales" has no live-expected schedule
}
// Actual QB expense (Cash P&L) for an outflow line.
function qbActualForOutflowLine(label: string, q: WeekExpenseLines | null): number | null {
 if (!q) return null;
 if (label === 'Payroll') return q.byLine['Payroll'];
 if (label === 'Inventory & Raw Materials') return q.byLine['Inventory & Raw Materials'];
 if (label === 'Software & Subscriptions') return q.byLine['Software & Subscriptions'];
 if (label === 'Other Expenses') return q.byLine['Other Expenses'];
 return null; // Credit Card Payments etc. aren't in the expense P&L
}

// Display-only inflow rows: shown for context, NOT summed into the cash total.
const isDisplayOnlyInflow = (label: string) => /^sales \(this week/i.test(label);
const PW_TITLES = { budget: 'Past · budgeted (elapsed weeks)', actual: 'Actual · what really happened', variance: 'Variance · actual − budgeted (per week)' };

// ---- Past weeks shared table (Past = budget, Actual = real) ---------------
// Budget: inflows = live-expected collection schedule (Net-97 + AR
// Net-90), outflows = current run-rate. Actual: inflows = AR collected + sales
// invoiced, outflows = QB per-category Cash P&L.
function PastWeeksTable({ mode, budgetData, pastGrid }: { mode: 'budget' | 'actual' | 'variance'; budgetData: Cashflow13; pastGrid: PastWeeksGridResponse | null }) {
 if (!pastGrid) return <LoadingSection title={PW_TITLES[mode]} />;
 const items = pastGrid.items;
 if (items.length === 0) return <EmptySection title={PW_TITLES[mode]} sub="No past weeks data yet." />;
 const fmt = (n: number) => formatCurrency(Math.round(n));
 const muted = (t: string) => <span style={{ color: 'var(--muted)' }}>{t}</span>;
 const TBD = <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 11 }}>entry yet to be done</span>;
 const wkByMonday = new Map(budgetData.weeks.map((w, i) => [w.start, i]));
 const outflowLabels = budgetData.outflows.map((l) => l.label);
 // Budget INFLOWS/OUTFLOWS come straight from the budgeted cashflow (direction=past),
 // aligned to each elapsed week by Monday - so Past = exactly the Budgeted calc.
 const inflowLabels = budgetData.inflows.map((l) => l.label);
 const budgetInflow = (it: PastWeeksGridItem, label: string): number | null => {
  const wi = wkByMonday.get(it.monday);
  if (wi == null) return null;
  const line = budgetData.inflows.find((l) => l.label === label);
  return line ? (line.values[wi] ?? 0) : 0;
 };
 const budgetInTotal = (it: PastWeeksGridItem): number | null => {
  const wi = wkByMonday.get(it.monday);
  return wi == null ? null : (budgetData.totals.inflows[wi] ?? 0);
 };
 const budgetOutflow = (it: PastWeeksGridItem, label: string): number | null => {
  const wi = wkByMonday.get(it.monday);
  if (wi == null) return null;
  const line = budgetData.outflows.find((l) => l.label === label);
  return line ? (line.values[wi] ?? 0) : 0;
 };
 const budgetOutTotal = (it: PastWeeksGridItem): number | null => {
  const wi = wkByMonday.get(it.monday);
  return wi == null ? null : (budgetData.totals.outflows[wi] ?? 0);
 };
 // Total actual inflow = cash actually collected. The collection already
 // splits into sameWeek (Projected AR) + lagged (Account Receivable), so
 // arActuals.total IS the row sum - do NOT add salesInvoiced (that's gross
 // invoicing, not cash, and would double-count).
 const inflowActualTotal = (it: PastWeeksGridItem): number | null =>
  it.actuals ? (it.actuals.arActuals?.total ?? 0) : null;

 // Each cell shows budget / actual / variance (actual − budget) by mode.
 // lowerBetter: for OUTFLOWS, spending less than budget is good (green).
 const oneVal = (budget: number | null, actual: number | null, lowerBetter = false): React.ReactNode => {
  if (mode === 'budget') return budget === null || budget === 0 ? muted('-') : fmt(budget);
  if (mode === 'actual') return actual === null ? TBD : actual === 0 ? muted('-') : fmt(actual);
  // variance = actual − budget
  if (actual === null) return <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 11 }}>pending</span>;
  const b = budget ?? 0;
  const d = actual - b;
  if (Math.round(d) === 0) return muted('0');
  const good = lowerBetter ? d < 0 : d > 0;
  return <span style={{ color: good ? '#059669' : 'var(--danger)', fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt(d)}</span>;
 };

 const sub = mode === 'budget'
  ? <>The <strong>budgeted forecast</strong> for each elapsed week - the SAME calculation as the Budgeted tab, applied to the weeks that have passed. Newest week on the left.</>
  : mode === 'actual'
  ? <>What really happened - inflows = AR collected + sales invoiced; outflows = actual QB expenses per category (Cash P&L). Un-pulled lines show <em>entry yet to be done</em>.</>
  : <><strong>Actual − Budgeted</strong> for each week. Inflows: <span style={{ color: '#059669' }}>green = more cash in</span>. Outflows: <span style={{ color: '#059669' }}>green = spent less than budget</span>. <span style={{ color: 'var(--danger)' }}>Red = worse than plan</span>.</>;

 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">{PW_TITLES[mode]} ({items.length} week{items.length === 1 ? '' : 's'})</div>
    <div className="section-sub">{sub}</div>
   </div></div>
   <div className="table-wrap">
    <table className="data-table" style={{ fontSize: 12 }}>
     <thead><tr>
      <th>Line item</th>
      {items.map((it, i) => (
       <th key={it.monday} className="num">
        <div>Wk -{i + 1}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{it.monday.slice(5).replace('-', '/')} – {it.weekEnd.slice(5).replace('-', '/')}</div>
       </th>
      ))}
     </tr></thead>
     <tbody>
      <tr>
       <td><strong>Opening cash</strong></td>
       {items.map((it) => <td key={it.monday} className="num">{it.snapshot ? fmt(it.snapshot.openingCash) : muted('-')}</td>)}
      </tr>
      <tr><td colSpan={1 + items.length} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>CASH INFLOWS</td></tr>
      {inflowLabels.map((label) => (
       <tr key={`in-${label}`} style={isDisplayOnlyInflow(label) ? { opacity: 0.7, fontStyle: 'italic' } : undefined}>
        <td>{DISPLAY_LABELS[label] || label}{isDisplayOnlyInflow(label) && <span style={{ fontStyle: 'normal', fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginLeft: 6, border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>REF</span>}</td>
        {items.map((it) => <td key={it.monday} className="num">{oneVal(budgetInflow(it, label), it.actuals ? actualForInflowLine(label, it.actuals) : null)}</td>)}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL INFLOWS</td>
       {items.map((it) => <td key={it.monday} className="num">{oneVal(budgetInTotal(it), inflowActualTotal(it))}</td>)}
      </tr>
      <tr><td colSpan={1 + items.length} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>CASH OUTFLOWS</td></tr>
      {outflowLabels.map((label) => (
       <tr key={`out-${label}`}>
        <td>{label}</td>
        {items.map((it) => <td key={it.monday} className="num">{oneVal(budgetOutflow(it, label), qbActualForOutflowLine(label, it.qbExpenses), true)}</td>)}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL OUTFLOWS</td>
       {items.map((it) => <td key={it.monday} className="num">{oneVal(budgetOutTotal(it), it.qbExpenses ? it.qbExpenses.total : null, true)}</td>)}
      </tr>
      <tr className="total-row">
       <td><strong>NET CHANGE</strong></td>
       {items.map((it) => {
        const wi = wkByMonday.get(it.monday);
        const budNet = wi == null ? null : (budgetData.totals.netChange[wi] ?? 0);
        const ai = inflowActualTotal(it);
        const actNet = (ai != null && it.qbExpenses) ? ai - it.qbExpenses.total : null;
        return <td key={it.monday} className="num">{oneVal(budNet, actNet)}</td>;
       })}
      </tr>
     </tbody>
    </table>
   </div>
   {mode === 'actual' && <div className="vendor-note" style={{ marginTop: 8 }}>Outflows = QB Cash-basis P&L per category. Credit-card payments aren't in the expense P&L, so that line stays pending here.</div>}
  </div>
 );
}

// ---- Variance: budget vs actual for one period (week or month) ------------
// Pick ONE period; budget AND actual are both for it. Actual = real collected
// invoices in that calendar period (month = full month, matching the AR page).
// Click a head (AR / Net-97) to drill into exactly which invoices made it up.
const VAR_MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
function VariancePicker({ budgetData, pastGrid }: { budgetData: Cashflow13; pastGrid: PastWeeksGridResponse | null }) {
 const [mode, setMode] = useState<'week' | 'month'>('week');
 const [idx, setIdx] = useState(0);
 const [detail, setDetail] = useState<CollectedDetail | null>(null);
 const [expenses, setExpenses] = useState<ExpenseEntriesRange | null>(null);
 const [combined, setCombined] = useState<CombinedActual | null>(null);
 const [loadingDetail, setLoadingDetail] = useState(false);
 const [modal, setModal] = useState<{ title: string; invoices?: CollectedInvoice[]; expenses?: ExpenseEntry[] } | null>(null);

 const items = pastGrid?.items ?? [];
 const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${VAR_MN[Number(m) - 1] ?? m} ${y}`; };
 const periods: Array<{ label: string; sub: string; items: PastWeeksGridItem[] }> = mode === 'week'
  ? items.map((it, i) => ({ label: `Wk -${i + 1}`, sub: `${it.monday.slice(5).replace('-', '/')} – ${it.weekEnd.slice(5).replace('-', '/')}`, items: [it] }))
  : (() => {
     const byYm = new Map<string, PastWeeksGridItem[]>();
     for (const it of items) { const ym = it.monday.slice(0, 7); const a = byYm.get(ym) ?? []; a.push(it); byYm.set(ym, a); }
     return [...byYm.entries()].map(([ym, its]) => ({ label: monthLabel(ym), sub: `${its.length} closed week${its.length === 1 ? '' : 's'}`, items: its }));
    })();
 const sel = periods.length ? (periods[Math.min(idx, periods.length - 1)] ?? periods[0]) : null;

 // The calendar date range for the selected period. Month = 1st of month →
 // min(today, month-end), so the current month shows month-to-date (matches the
 // AR collections page), not just the complete Mon-Sun weeks.
 const now = new Date();
 const todayStr = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
 let periodStart = '', periodEnd = '';
 if (sel) {
  if (mode === 'week') { periodStart = sel.items[0].monday; periodEnd = sel.items[0].weekEnd; }
  else {
   const ym = sel.items[0].monday.slice(0, 7); const [y, m] = ym.split('-').map(Number);
   periodStart = `${ym}-01`;
   const last = `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
   periodEnd = last < todayStr ? last : todayStr;
  }
 }

 // Month-mode outflow = the QB actual for the month (combinedActual). The
 // CURRENT month keeps settling in QB, so the actual fills in over time.
 const selMonth = sel && mode === 'month' ? sel.items[0].monday.slice(0, 7) : '';
 useEffect(() => {
  if (!periodStart || !periodEnd) { setDetail(null); setExpenses(null); setCombined(null); return; }
  let alive = true;
  let retried = false;
  // silent=true keeps the existing numbers on screen while refetching, and a
  // transient failure (e.g. a cold current-month QB pull) does NOT blank them.
  const run = (silent: boolean) => {
   if (!silent) setLoadingDetail(true);
   Promise.all([
    fetchCollectedDetail(periodStart, periodEnd),
    fetchExpenseEntries(periodStart, periodEnd),
    selMonth ? fetchCombinedActual(selMonth) : Promise.resolve(null),
   ])
    .then(([d, e, c]) => { if (!alive) return; setDetail(d); setExpenses(e); setCombined(c); setLoadingDetail(false); })
    .catch(() => {
     if (!alive) return;
     setLoadingDetail(false);
     // Retry once after a transient hiccup so the actual isn't stranded as
     // "pending" (the current-month P&L pull can fail cold, then succeed).
     if (!retried) { retried = true; window.setTimeout(() => { if (alive) run(true); }, 1800); }
    });
  };
  run(false);
  // The current (in-progress) month keeps settling - refetch when the user
  // returns to the tab so new QB entries flow in ("aate jaega"), no polling.
  const onFocus = () => run(true);
  window.addEventListener('focus', onFocus);
  return () => { alive = false; window.removeEventListener('focus', onFocus); };
 }, [periodStart, periodEnd, selMonth]);

 if (!pastGrid) return <LoadingSection title="Variance" />;
 if (items.length === 0 || !sel) return <EmptySection title="Variance" sub="No past weeks data yet." />;

 const fmt = (n: number) => formatCurrency(Math.round(n));
 const muted = (t: string) => <span style={{ color: 'var(--muted)' }}>{t}</span>;
 const inPeriod = (s: string) => s >= periodStart && s <= periodEnd;

 // BUDGET: sum the past-cashflow weeks that fall COMPLETELY inside the period.
 const budgetWk = budgetData.weeks.map((w, i) => ({ w, i })).filter(({ w }) => w.start >= periodStart && w.end <= periodEnd);
 const sumBIn = (lbl: string) => { const line = budgetData.inflows.find((l) => l.label === lbl); return line ? budgetWk.reduce((s, x) => s + (line.values[x.i] ?? 0), 0) : 0; };
 const sumBOut = (lbl: string) => { const line = budgetData.outflows.find((l) => l.label === lbl); return line ? budgetWk.reduce((s, x) => s + (line.values[x.i] ?? 0), 0) : 0; };
 const bInTotal = budgetWk.reduce((s, x) => s + (budgetData.totals.inflows[x.i] ?? 0), 0);
 const bOutTotal = budgetWk.reduce((s, x) => s + (budgetData.totals.outflows[x.i] ?? 0), 0);
 // Total outflows EXCLUDING Credit Card Payments (dropped from the Variance), so
 // the displayed lines still add up to the shown total.
 const bOutTotalEx = bOutTotal - sumBOut('Credit Card Payments');

 // ACTUAL inflow: the REAL collected invoices in the calendar period (by paid
 // date). AR + Net-97 come straight from that detail; outflows from the closed
 // weeks' QB expenses.
 const gridItems = items.filter((it) => it.monday >= periodStart && it.weekEnd <= periodEnd);
 const actualIn = (lbl: string): number | null => {
  if (!detail) return null;
  if (/net 97/i.test(lbl)) return detail.gelato.total;
  // Sales REF line: gross sales invoiced over the FULL period (incl. the
  // in-progress week), straight from the collected-detail's salesInvoiced - so it
  // matches the month-to-date sales on the KPI/AR page. Falls back to summing the
  // closed weeks only if an older backend hasn't sent salesInvoiced yet.
  if (isDisplayOnlyInflow(lbl)) {
   if (detail.salesInvoiced) return detail.salesInvoiced.nonGelato.amount;
   let any = false, t = 0; for (const it of gridItems) if (it.actuals) { any = true; t += actualForInflowLine(lbl, it.actuals) ?? 0; } return any ? t : null;
  }
  // Weekly Cash Collection (same-week): show "pending" - its cash is already
  // inside the Account Receivable actual below, so we don't double-count it here;
  // null renders as "pending" rather than a separate number.
  if (/collected from sales|weekly cash|new sales/i.test(lbl)) return null;
  // Account Receivable = the full collected (includes same-week), so the
  // inflow total stays correct.
  if (/past ar|account receivable|lag-curve/i.test(lbl)) return detail.nonGelato.total;
  return null;
 };
 const aInTotal = detail ? +(detail.nonGelato.total + detail.gelato.total).toFixed(2) : null;
 // ACTUAL outflow. MONTH mode → deduped Combined = the budget's exact basis
 // (settled months) / live sheet (current month). WEEK mode → live sheet by
 // week (Combined isn't available below month granularity).
 const actualOut = (lbl: string): number | null => {
  if (lbl === 'Credit Card Payments') return null;   // not in these sources
  if (mode === 'month') return combined ? (combined.byLine[lbl] ?? 0) : null;
  return expenses ? (expenses.byLine[lbl]?.total ?? 0) : null;
 };
 const aOutTotal = mode === 'month'
  ? (combined ? +Object.values(combined.byLine).reduce((s, v) => s + v, 0).toFixed(2) : null)
  : (expenses ? expenses.total : null);

 // Drill-down: inflow lines → collected invoices; outflow lines → expense entries.
 const drillInflow = (lbl: string): CollectedInvoice[] | null => {
  if (!detail) return null;
  if (/net 97/i.test(lbl)) return detail.gelato.invoices;
  if (/total inflows/i.test(lbl)) return [...detail.nonGelato.invoices, ...detail.gelato.invoices];
  if (/past ar|account receivable|lag-curve/i.test(lbl)) return detail.nonGelato.invoices;
  return null;
 };
 const drillOutflow = (lbl: string): ExpenseEntry[] | null => {
  if (mode === 'month') {
   // Settled-month Combined has no transaction list; current-month sheet entries do.
   if (!combined || combined.entries.length === 0) return null;
   if (/total outflows/i.test(lbl)) return combined.entries;
   return combined.entries.filter((e) => e.line === lbl);
  }
  if (!expenses) return null;
  if (/total outflows/i.test(lbl)) return Object.values(expenses.byLine).flatMap((v) => v.entries);
  return expenses.byLine[lbl]?.entries ?? null;
 };

 type RowDef = { label: string; budget: number | null; actual: number | null; lowerBetter?: boolean; head?: 'in' | 'out'; strong?: boolean };
 const rows: RowDef[] = [];
 rows.push({ label: 'CASH INFLOWS', budget: null, actual: null, head: 'in' });
 for (const lbl of budgetData.inflows.map((l) => l.label)) rows.push({ label: lbl, budget: sumBIn(lbl), actual: actualIn(lbl) });
 rows.push({ label: 'Total inflows', budget: bInTotal, actual: aInTotal, strong: true });
 rows.push({ label: 'CASH OUTFLOWS', budget: null, actual: null, head: 'out' });
 for (const lbl of budgetData.outflows.map((l) => l.label)) {
  // Credit Card Payments has no comparable actual here (CC payoffs aren't a P&L
  // expense), so it only ever showed "pending" - drop it from the Variance.
  if (/credit card payment/i.test(lbl)) continue;
  rows.push({ label: lbl, budget: sumBOut(lbl), actual: actualOut(lbl), lowerBetter: true });
 }
 rows.push({ label: 'Total outflows', budget: bOutTotalEx, actual: aOutTotal, lowerBetter: true, strong: true });
 const actNet = (aInTotal != null && aOutTotal != null) ? aInTotal - aOutTotal : null;
 rows.push({ label: 'NET CHANGE', budget: bInTotal - bOutTotalEx, actual: actNet, strong: true });

 const deltaCell = (budget: number | null, actual: number | null, lowerBetter = false): React.ReactNode => {
  if (budget === null && actual === null) return muted('-');
  const b = budget ?? 0;
  if (actual === null) return loadingDetail ? muted('…') : <span className="vendor-note" style={{ fontStyle: 'italic' }}>pending</span>;
  const d = actual - b;
  const good = lowerBetter ? d <= 0 : d >= 0;
  const tone = good ? '#059669' : 'var(--danger)';
  // % of the DIFFERENCE vs budget (how far actual is from budget), not actual/budget.
  const pct = b !== 0 ? Math.round((d / b) * 100) : null;
  return <span style={{ color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt(d)}{pct !== null ? ` · ${pct >= 0 ? '+' : ''}${pct}%` : ''}</span>;
 };
 const toggleBtn = (m: 'week' | 'month', txt: string) => (
  <button onClick={() => { setMode(m); setIdx(0); }} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: mode === m ? 700 : 500, background: mode === m ? 'var(--accent, #047857)' : 'transparent', color: mode === m ? '#fff' : 'var(--muted)' }}>{txt}</button>
 );
 const periodTxt = mode === 'month' ? `${periodStart.slice(5).replace('-', '/')}–${periodEnd.slice(5).replace('-', '/')}` : sel.sub;

 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">Variance · budget vs actual</div>
    <div className="section-sub">Pick a <strong>{mode}</strong> — budget AND actual are both for it. Actual = real collected invoices in that period (month = full month-to-date, matches the AR page). <strong>Click a green-underlined line</strong> to see exactly which invoices made it up.</div>
   </div></div>
   <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
    <div style={{ display: 'inline-flex', background: 'var(--surface, #f1f5f9)', borderRadius: 10, padding: 3, gap: 2 }}>
     {toggleBtn('week', 'Week')}
     {toggleBtn('month', 'Month')}
    </div>
    <label style={{ fontSize: 13 }}>{mode === 'week' ? 'Week' : 'Month'}:{' '}
     <select value={Math.min(idx, periods.length - 1)} onChange={(e) => setIdx(Number(e.target.value))} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}>
      {periods.map((p, i) => <option key={i} value={i}>{p.label}{p.sub ? ` · ${p.sub}` : ''}</option>)}
     </select>
    </label>
    {loadingDetail && <span style={{ fontSize: 12, color: 'var(--muted)' }}>loading actuals…</span>}
   </div>
   {mode === 'month' && combined && (
    <div className="vendor-note" style={{ marginBottom: 8 }}>
     Outflow actual = <strong>QuickBooks</strong> · {combined.source}
     {combined.isCurrentMonth && <span style={{ color: 'var(--danger)' }}> · current month is partial (QB cash-basis settles after month-end).</span>}
    </div>
   )}
   <div className="table-wrap">
    <table className="data-table" style={{ fontSize: 12 }}>
     <thead><tr>
      <th>Line item</th>
      <th className="num">Budget<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{sel.label}</div></th>
      <th className="num">Actual<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{periodTxt}</div></th>
      <th className="num">Variance</th>
     </tr></thead>
     <tbody>
      {rows.map((r, i) => {
       if (r.head) return <tr key={i}><td colSpan={4} style={{ background: r.head === 'in' ? 'var(--accent-soft)' : 'var(--danger-soft)', fontWeight: 700, color: r.head === 'in' ? '#059669' : 'var(--danger)' }}>{r.label}</td></tr>;
       const inv = drillInflow(r.label);
       const exp = drillOutflow(r.label);
       const n = (inv && inv.length) || (exp && exp.length) || 0;
       const canDrill = n > 0;
       const open = () => {
        const title = `${DISPLAY_LABELS[r.label] || r.label} · ${sel.label}`;
        if (inv && inv.length) setModal({ title: `${title} (collected)`, invoices: inv });
        else if (exp && exp.length) setModal({ title: `${title} (paid)`, expenses: exp });
       };
       return (
        <tr key={i} className={r.strong ? 'total-row' : undefined} style={{ ...(isDisplayOnlyInflow(r.label) ? { opacity: 0.7, fontStyle: 'italic' } : {}), ...(canDrill ? { cursor: 'pointer' } : {}) }}
         onClick={canDrill ? open : undefined}>
         <td>
          {r.strong ? <strong>{DISPLAY_LABELS[r.label] || r.label}</strong> : (DISPLAY_LABELS[r.label] || r.label)}
          {isDisplayOnlyInflow(r.label) && <span style={{ fontStyle: 'normal', fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginLeft: 6, border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>REF</span>}
          {canDrill && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent-hover, #047857)', borderBottom: '1px solid currentColor' }}>{n} {inv && inv.length ? 'invoices' : 'entries'} →</span>}
         </td>
         <td className="num">{r.budget === null || r.budget === 0 ? muted('-') : fmt(r.budget)}</td>
         <td className="num">{r.actual === null ? (loadingDetail ? muted('…') : <span className="vendor-note" style={{ fontStyle: 'italic' }}>pending</span>) : (r.actual === 0 ? muted('-') : fmt(r.actual))}</td>
         <td className="num">{deltaCell(r.budget, r.actual, r.lowerBetter)}</td>
        </tr>
       );
      })}
     </tbody>
    </table>
   </div>
   {modal && createPortal(
    modal.expenses
     ? <ExpenseModal title={modal.title} entries={modal.expenses} onClose={() => setModal(null)} />
     : <CollectedModal title={modal.title} invoices={modal.invoices ?? []} onClose={() => setModal(null)} />,
    document.body)}
  </div>
 );
}

// Drill-down modal: the actual invoices collected (paid) in the selected period.
function CollectedModal({ title, invoices, onClose }: { title: string; invoices: CollectedInvoice[]; onClose: () => void }) {
 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 const total = invoices.reduce((s, i) => s + i.paid, 0);
 return (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
   <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg, #fff)', borderRadius: 12, maxWidth: 920, width: '100%', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
     <div><strong style={{ fontSize: 16 }}>{title}</strong> <span style={{ color: 'var(--muted)' }}>· {invoices.length} invoices · {fmt0(total)}</span></div>
     <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--muted)' }}>×</button>
    </div>
    <div style={{ overflow: 'auto', padding: '0 4px' }}>
     <table className="data-table">
      <thead><tr><th style={{ minWidth: 220 }}>Customer</th><th>Invoice</th><th>Invoiced</th><th>Paid on</th><th className="num">Amount</th></tr></thead>
      <tbody>
       {invoices.slice(0, 500).map((inv, i) => (
        <tr key={`${inv.invoiceNumber}-${i}`}>
         <td>{inv.customer}</td>
         <td>{inv.invoiceNumber}</td>
         <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{inv.invoiceDate}</td>
         <td style={{ whiteSpace: 'nowrap' }}>{inv.paidDate}</td>
         <td className="num"><strong>{fmt0(inv.paid)}</strong></td>
        </tr>
       ))}
      </tbody>
     </table>
    </div>
   </div>
  </div>
 );
}

// Drill-down modal: the actual paid expense entries in the period (sheet).
function ExpenseModal({ title, entries, onClose }: { title: string; entries: ExpenseEntry[]; onClose: () => void }) {
 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 const total = entries.reduce((s, e) => s + e.amount, 0);
 const sorted = [...entries].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || b.amount - a.amount);
 return (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
   <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg, #fff)', borderRadius: 12, maxWidth: 900, width: '100%', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
     <div><strong style={{ fontSize: 16 }}>{title}</strong> <span style={{ color: 'var(--muted)' }}>· {entries.length} entries · {fmt0(total)}</span></div>
     <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--muted)' }}>×</button>
    </div>
    <div style={{ overflow: 'auto', padding: '0 4px' }}>
     <table className="data-table">
      <thead><tr><th>Paid on</th><th style={{ minWidth: 260 }}>Description</th><th>Category</th><th className="num">Amount</th></tr></thead>
      <tbody>
       {sorted.slice(0, 500).map((e, i) => (
        <tr key={`${e.description}-${i}`}>
         <td style={{ whiteSpace: 'nowrap', color: e.date ? undefined : 'var(--muted)' }}>{e.date || '—'}</td>
         <td>{e.description}</td>
         <td style={{ color: 'var(--muted)', fontSize: 11 }}>{e.category}</td>
         <td className="num"><strong>{fmt0(e.amount)}</strong></td>
        </tr>
       ))}
      </tbody>
     </table>
    </div>
   </div>
  </div>
 );
}
