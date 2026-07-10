import { useEffect, useMemo, useState } from 'react';
import {
 fetchMappedExpenses, fetchAccountTransactions, fetchInventoryPurchases, fetchPnlExpenses,
 type MappedExpensesResult, type SheetEntity, type AccountTxn,
 type InventoryPurchasesResult, type InventoryTxn, type PnlExpensesResult,
} from '../api';
import { formatCurrency } from '../format';

// The combined view is driven by the P&L mapping (QB cash basis): each
// category's qbSources are the exact QB accounts mapped, so the per-account
// bill drill-down (account-transactions) lines up with the row totals.
function pnlToMapped(pnl: PnlExpensesResult): MappedExpensesResult {
 return {
  cached: false,
  asOf: pnl.asOf,
  entity: 'Combined',
  months: pnl.months,
  monthLabels: pnl.monthLabels,
  rows: pnl.categories
   .filter((c) => c.category !== 'Uncategorized')
   .map((c) => ({
    group: /payroll/i.test(c.category) ? 'Payroll' : 'Non-Payroll',
    category: c.category,
    values: c.monthly,
    qbSources: c.accounts.map((a) => ({ name: a.name, total: a.total })),
   })),
  unmatched: [],
 };
}

type Group = 'all' | 'Payroll' | 'Non-Payroll';

type Props = {
 entity: SheetEntity;
 title: string;
 subtitle: string;
 totalLabel: string;
};

type RowDrill = {
 loading: boolean;
 transactions: AccountTxn[];
 total: number;
 monthlyTotal: Record<string, number>;
};

export function MappedExpensesPage({ entity, title, subtitle, totalLabel }: Props) {
 const [data, setData] = useState<MappedExpensesResult | null>(null);
 const [inventory, setInventory] = useState<InventoryPurchasesResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [group, setGroup] = useState<Group>('all');
 const [showSources, setShowSources] = useState(false);
 const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
 const [drill, setDrill] = useState<Record<string, RowDrill>>({});

 async function loadDrillForCategory(category: string, qbSources: Array<{ name: string }>) {
 // Already cached?
 if (drill[category] && !drill[category].loading) return;
 setDrill((d) => ({
 ...d,
 [category]: { loading: true, transactions: [], total: 0, monthlyTotal: {} },
 }));
 try {
 // Special path: Inventory & Raw Materials → use the dedicated inventory
 // purchases endpoint so the transactions match the row totals exactly.
 if (inventory && /^inventory\s*&\s*raw materials$/i.test(category)) {
 const filtered: InventoryTxn[] = inventory.transactions;
 // Adapt InventoryTxn → AccountTxn shape (memo + sourceBank kept; type narrowed).
 const adapted: AccountTxn[] = filtered.map((t) => ({
 txnId: t.txnId,
 txnType: t.txnType,
 date: t.date,
 vendor: t.vendor,
 memo: t.memo ?? t.inventoryAccount,
 amount: t.amount,
 sourceBank: t.sourceBank,
 paidBy: t.paidBy,
 }));
 // Aggregate totals, month by month.
 let tot = 0;
 const mt: Record<string, number> = {};
 for (const t of adapted) {
 const ym = t.date.slice(0, 7);
 mt[ym] = (mt[ym] ?? 0) + t.amount;
 tot += t.amount;
 }
 setDrill((d) => ({
 ...d,
 [category]: { loading: false, transactions: adapted, total: tot, monthlyTotal: mt },
 }));
 return;
 }

 // Default path: fetch per-QB-account transactions in parallel.
 const results = await Promise.all(qbSources.map((s) => fetchAccountTransactions(s.name).catch(() => null)));
 const allTxns: AccountTxn[] = [];
 let tot = 0;
 for (const r of results) {
 if (!r) continue;
 allTxns.push(...r.transactions);
 tot += r.total;
 }
 allTxns.sort((a, b) => b.date.localeCompare(a.date));
 // Build month-by-month totals.
 const monthlyTotal: Record<string, number> = {};
 for (const t of allTxns) {
 const ym = t.date.slice(0, 7);
 monthlyTotal[ym] = (monthlyTotal[ym] ?? 0) + t.amount;
 }
 setDrill((d) => ({
 ...d,
 [category]: {
 loading: false,
 transactions: allTxns,
 total: tot,
 monthlyTotal,
 },
 }));
 } catch (e) {
 setDrill((d) => ({
 ...d,
 [category]: { loading: false, transactions: [], total: 0, monthlyTotal: {} },
 }));
 }
 }

 function toggleRow(category: string, qbSources: Array<{ name: string; total: number }>) {
 if (expandedCategory === category) {
 setExpandedCategory(null);
 return;
 }
 setExpandedCategory(category);
 void loadDrillForCategory(category, qbSources);
 }

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 // Fetch the mapped expenses first - render the page as soon as that's
 // ready so we don't block on the (potentially slow) inventory call.
 try {
 const mapped = entity === 'Combined'
 ? pnlToMapped(await fetchPnlExpenses({ method: 'Cash', refresh }))
 : await fetchMappedExpenses(entity, { refresh });
 setData(mapped);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 // Inventory loads in the background - once it arrives, the Inventory &
 // Raw Materials row's values + drill-down get filled in.
 fetchInventoryPurchases({ refresh })
 .then((inv) => setInventory(inv))
 .catch(() => { /* silently ignore - row falls back to mapped data */ });
 }
 useEffect(() => {
 load(false);
 // No focus/interval polling - the P&L is not a live ticker, so repeated
 // background loads just churn. Reload (silently) ONLY when a mapping changes
 // (here or in the P&L Mapping tab) so a newly-categorized head flows in at
 // once. Use Refresh for a fresh QB pull.
 const onMappingChanged = () => load(false, true);
 window.addEventListener('category-overrides-changed', onMappingChanged);
 return () => {
 window.removeEventListener('category-overrides-changed', onMappingChanged);
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [entity]);

 // Build the effective row list. Inventory & Raw Materials gets its values
 // OVERRIDDEN with actual inventory-purchase data - because QB's COGS P&L line
 // is accrual recognition, not actual cash spent.
 const visible = useMemo(() => {
 if (!data) return [];
 const overrideRows = data.rows.map((r) => {
 if (!inventory) return r;
 if (!/^inventory\s*&\s*raw materials$/i.test(r.category)) return r;
 // Use the aggregate monthly series + per-account totals.
 const monthly = inventory.monthlyTotal;
 const sources = inventory.byAccount
 .map((a) => ({ name: a.name, total: a.total }))
 .filter((s) => s.total > 0);
 return {
 ...r,
 values: monthly.slice(0, r.values.length),
 qbSources: sources,
 };
 });
 const byGroup = group === 'all' ? overrideRows : overrideRows.filter((r) => r.group === group);
 return byGroup.filter((r) => {
 const total = r.values.reduce((s, v) => s + v, 0);
 return total > 0;
 });
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [data, inventory, group]);

 const monthCount = data?.months.length ?? 0;
 const empty = useMemo(() => new Array(monthCount).fill(0), [monthCount]);
 const totalsByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);
 const payrollByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.filter((r) => r.group === 'Payroll').reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);
 const nonPayrollByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.filter((r) => r.group === 'Non-Payroll').reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);

 const last3Avg = (vals: number[]) => {
 const slice = vals.slice(-3).filter((v) => v !== 0);
 if (slice.length === 0) return 0;
 return slice.reduce((s, v) => s + v, 0) / slice.length;
 };
 const weeklyAvg = (vals: number[]) => last3Avg(vals) / 4.33;
 // Seasonality windows: how much actually went out over the trailing 12 / 6 / 3
 // months (totals, not averages), so recent trend vs the full year is obvious.
 const sumLast = (vals: number[], n: number) => vals.slice(-n).reduce((s, v) => s + v, 0);

 if (loading && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">{title}</h1><div className="page-sub">Loading…</div></div></div>
 </>
 );
 }
 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">{title}</h1></div></div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> <a href="/auth/connect">/auth/connect</a></>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const dateRange = data.monthLabels.length
 ? `${data.monthLabels[0]} – ${data.monthLabels[data.monthLabels.length - 1]}`
 : '';

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">{title}</h1>
 <div className="page-sub">
 {subtitle}{dateRange ? ` · ${dateRange}` : ''}{data.cached ? ' · cached' : ''}
 </div>
 </div>
 {entity !== 'Combined' && (
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh from QB'}
 </button>
 )}
 </div>

 <div className="section" style={{ padding: '12px 18px' }}>
 <div className="filter-row" style={{ gap: 10 }}>
 {(['all', 'Payroll', 'Non-Payroll'] as const).map((g) => (
 <button key={g} className={`filter-tab ${group === g ? 'active' : ''}`} onClick={() => setGroup(g)}>
 {g === 'all' ? 'All' : g}
 </button>
 ))}
 <span style={{ flex: 1 }} />
 <button className={`filter-tab ${showSources ? 'active' : ''}`} onClick={() => setShowSources((s) => !s)}>
 {showSources ? 'Hide QB sources' : 'Show QB sources'}
 </button>
 </div>
 </div>

 <div className="section">
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 260 }}>Category</th>
 <th>Group</th>
 {data.monthLabels.map((m) => (<th key={m} className="num">{m}</th>))}
 <th className="num">Total</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 12mo</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 6mo</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 3mo</th>
 <th className="num">Avg/mo</th>
 <th className="num">Weekly avg</th>
 </tr>
 </thead>
 <tbody>
 {visible.map((r) => {
 const total = r.values.reduce((s, v) => s + v, 0);
 const avg = total / Math.max(1, r.values.filter((v) => v !== 0).length);
 const drillable = r.qbSources.length > 0 && total > 0;
 const isExpanded = expandedCategory === r.category;
 const rowDrill = drill[r.category];
 return (
 <>
 <tr
 key={r.category}
 className={r.qbSources.length === 0 ? 'row-none' : ''}
 onClick={drillable ? () => toggleRow(r.category, r.qbSources) : undefined}
 style={{
 cursor: drillable ? 'pointer' : undefined,
 background: isExpanded ? '#fff3d8' : undefined,
 }}
 title={drillable ? 'Click to see every transaction' : undefined}
 >
 <td>
 <div>
 {drillable && <span style={{ marginRight: 6, color: '#945215' }}>{isExpanded ? '▼' : '▶'}</span>}
 {r.category}
 </div>
 {r.qbSources.length === 0 && <div className="vendor-note">no QB match</div>}
 </td>
 <td><span className={`pill-tag tag-${r.group === 'Payroll' ? 'strong' : 'fuzzy'}`}>{r.group}</span></td>
 {r.values.map((v, i) => (<td key={i} className="num">{v ? formatCurrency(v) : '-'}</td>))}
 <td className="num"><strong>{formatCurrency(total)}</strong></td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 12)))}</td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 6)))}</td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 3)))}</td>
 <td className="num">{formatCurrency(Math.round(avg))}</td>
 <td className="num">{formatCurrency(Math.round(weeklyAvg(r.values)))}</td>
 </tr>
 {isExpanded && (
 <tr key={r.category + '-drill'}>
 <td colSpan={data.monthLabels.length + 8} style={{ background: '#fff8e1', padding: '14px 18px' }}>
 {!rowDrill || rowDrill.loading ? (
 <div style={{ color: '#666' }}>Loading transactions for <strong>{r.category}</strong>…</div>
 ) : (
 <DrillPanel
 category={r.category}
 rowDrill={rowDrill}
 months={data.months}
 monthLabels={data.monthLabels}
 categoryTotal={total}
 qbSources={r.qbSources}
 />
 )}
 </td>
 </tr>
 )}
 {showSources && r.qbSources.length > 0 && !isExpanded && (
 <tr key={r.category + '-sources'}>
 <td colSpan={data.monthLabels.length + 8} style={{ background: '#13182a', paddingLeft: 30, fontSize: 11, color: 'var(--muted)' }}>
 QB sources: {r.qbSources.map((s) => `${s.name} (${formatCurrency(s.total)})`).join(' · ')}
 </td>
 </tr>
 )}
 </>
 );
 })}

 {group === 'all' && (
 <>
 <tr className="total-row">
 <td>Payroll subtotal</td>
 <td></td>
 {payrollByMonth.map((v, i) => (<td key={i} className="num">{formatCurrency(v)}</td>))}
 <td className="num"><strong>{formatCurrency(payrollByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 <td colSpan={5}></td>
 </tr>
 <tr className="total-row">
 <td>Non-Payroll subtotal</td>
 <td></td>
 {nonPayrollByMonth.map((v, i) => (<td key={i} className="num">{formatCurrency(v)}</td>))}
 <td className="num"><strong>{formatCurrency(nonPayrollByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 <td colSpan={5}></td>
 </tr>
 </>
 )}

 <tr className="total-row" style={{ fontSize: 14 }}>
 <td>{totalLabel}</td>
 <td></td>
 {totalsByMonth.map((v, i) => (<td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>))}
 <td className="num"><strong>{formatCurrency(totalsByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 <td colSpan={5}></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 </>
 );
}

/** Drill-down panel: month-by-month totals + per-transaction list. */
function DrillPanel({
 rowDrill, months, monthLabels, categoryTotal, qbSources,
}: {
 category: string;
 rowDrill: RowDrill;
 months: string[];
 monthLabels: string[];
 categoryTotal: number;
 qbSources: Array<{ name: string; total: number }>;
}) {
 const { transactions, total, monthlyTotal } = rowDrill;

 return (
 <>
 <div style={{ display: 'flex', gap: 24, marginBottom: 10, fontSize: 12, color: '#3a4660', flexWrap: 'wrap', alignItems: 'center' }}>
 <span><strong>{transactions.length}</strong> transactions across {qbSources.length} QB account{qbSources.length === 1 ? '' : 's'}</span>
 <span style={{ marginLeft: 'auto', color: '#888' }}>
 Drilled: {formatCurrency(total)} vs row total: {formatCurrency(categoryTotal)}
 </span>
 </div>

 {/* Month-by-month totals */}
 <div style={{ marginBottom: 14, overflowX: 'auto', border: '1px solid #e1d8c2', borderRadius: 4, background: '#fff' }}>
 <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
 <thead>
 <tr style={{ background: '#fff3d8' }}>
 <th style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid #e1d8c2', whiteSpace: 'nowrap' }}></th>
 {monthLabels.map((m) => (
 <th key={m} className="num" style={{ padding: '6px 8px', borderBottom: '1px solid #e1d8c2' }}>{m}</th>
 ))}
 <th className="num" style={{ padding: '6px 10px', borderBottom: '1px solid #e1d8c2', background: '#ffe5b3' }}>Total</th>
 </tr>
 </thead>
 <tbody>
 <tr style={{ background: '#fff9ef' }}>
 <td style={{ padding: '5px 10px', fontWeight: 700 }}>Total</td>
 {months.map((ym) => {
 const v = monthlyTotal[ym] ?? 0;
 return <td key={ym} className="num" style={{ padding: '5px 8px', fontWeight: 700 }}>{v > 0 ? formatCurrency(v) : '-'}</td>;
 })}
 <td className="num" style={{ padding: '5px 10px', fontWeight: 700 }}>{formatCurrency(total)}</td>
 </tr>
 </tbody>
 </table>
 </div>

 {/* Per-transaction list */}
 <div style={{ fontSize: 12, color: '#5a6478', marginBottom: 6 }}>
 Every transaction (sorted newest first). Use the QB sources toggle at the top of the page to see contributing account names.
 </div>
 <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #e1d8c2', borderRadius: 4, background: '#fff' }}>
 <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
 <thead>
 <tr style={{ background: '#fff3d8', position: 'sticky', top: 0 }}>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Date</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Type</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Vendor</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Memo</th>
 <th style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #e1d8c2' }}>Amount</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Paid By</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Source Bank</th>
 </tr>
 </thead>
 <tbody>
 {transactions.length === 0 ? (
 <tr><td colSpan={7} style={{ padding: 14, color: '#888' }}>No transactions found.</td></tr>
 ) : transactions.map((t, i) => (
 <tr key={i} style={{ borderBottom: '1px solid #f5eee0' }}>
 <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{t.date}</td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.txnType}</td>
 <td style={{ padding: '5px 8px' }}>{t.vendor ?? '-'}</td>
 <td style={{ padding: '5px 8px', color: '#666', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.memo ?? '-'}</td>
 <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatCurrency(t.amount)}</td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.paidBy || '-'}</td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.sourceBank}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </>
 );
}
