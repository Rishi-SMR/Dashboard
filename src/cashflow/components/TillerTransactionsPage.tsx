import { useEffect, useMemo, useState } from 'react';
import { fetchTillerTransactions, type TillerTransactionsResult, type TillerEntity, type TxnsByAccountMonth } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const POLL_INTERVAL_MS = 60_000;

type Props = {
 /** Which entity bucket to filter accounts on. */
 entity: TillerEntity;
 title: string;
 subtitle: string;
};

export function TillerTransactionsPage({ entity, title, subtitle }: Props) {
 const [data, setData] = useState<TillerTransactionsResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [selectedAccount, setSelectedAccount] = useState<string | null>(null);

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 setData(await fetchTillerTransactions({ refresh }));
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const poll = window.setInterval(() => load(false, true), POLL_INTERVAL_MS);
 return () => window.clearInterval(poll);
 }, []);

 const accounts: TxnsByAccountMonth[] = useMemo(() => {
 if (!data) return [];
 // Restrict to linked accounts only - unlinked/personal accounts excluded.
 return data.accounts.filter((a) => a.entity === entity && a.inQb);
 }, [data, entity]);

 const selectedAcctTxns = useMemo(() => {
 if (!data || !selectedAccount) return [];
 return data.transactions
 .filter((t) => t.account === selectedAccount)
 .sort((a, b) => b.date.localeCompare(a.date));
 }, [data, selectedAccount]);

 // Per-category breakdown of the selected account - how much of the account's
 // activity went to each category. Splits outflow vs inflow per category.
 const selectedCategorySummary = useMemo(() => {
 if (selectedAcctTxns.length === 0) return [];
 const m = new Map<string, { outflow: number; inflow: number; count: number }>();
 for (const t of selectedAcctTxns) {
 const cat = t.category || '(uncategorized)';
 const c = m.get(cat) ?? { outflow: 0, inflow: 0, count: 0 };
 if (t.amount < 0) c.outflow += Math.abs(t.amount);
 else c.inflow += t.amount;
 c.count += 1;
 m.set(cat, c);
 }
 return [...m.entries()]
 .map(([category, v]) => ({ category, ...v, net: v.inflow - v.outflow }))
 .sort((a, b) => (b.outflow + b.inflow) - (a.outflow + a.inflow));
 }, [selectedAcctTxns]);

 /** Month × category outflow pivot for the selected account - how much was
 * spent per category in each month. */
 const selectedMonthPivot = useMemo(() => {
 if (selectedAcctTxns.length === 0) return { months: [], rows: [], rowTotals: new Map<string, number>(), colTotals: new Map<string, number>(), grand: 0 };
 const monthsSet = new Set<string>();
 const grid = new Map<string, Map<string, number>>(); // category → month → outflow
 for (const t of selectedAcctTxns) {
 if (t.amount >= 0) continue; // outflow only - where the money went
 const cat = t.category || '(uncategorized)';
 const ym = t.date.slice(0, 7);
 monthsSet.add(ym);
 const row = grid.get(cat) ?? new Map<string, number>();
 row.set(ym, (row.get(ym) ?? 0) + Math.abs(t.amount));
 grid.set(cat, row);
 }
 const months = [...monthsSet].sort();
 const rowTotals = new Map<string, number>();
 const colTotals = new Map<string, number>();
 let grand = 0;
 const rows = [...grid.entries()].map(([category, perMonth]) => {
 const monthly = months.map((m) => perMonth.get(m) ?? 0);
 const total = monthly.reduce((s, v) => s + v, 0);
 rowTotals.set(category, total);
 months.forEach((m, i) => colTotals.set(m, (colTotals.get(m) ?? 0) + monthly[i]));
 grand += total;
 return { category, monthly, total };
 }).sort((a, b) => b.total - a.total);
 return { months, rows, rowTotals, colTotals, grand };
 }, [selectedAcctTxns]);

 if (loading && !data) {
 return (
 <div className="page-head"><div><h1 className="page-title">{title}</h1><div className="page-sub">Loading…</div></div></div>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">{title}</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const grandOutflow = accounts.reduce((s, a) => s + Object.values(a.monthlyOutflow).reduce((x, v) => x + v, 0), 0);
 const grandInflow = accounts.reduce((s, a) => s + Object.values(a.monthlyInflow).reduce((x, v) => x + v, 0), 0);
 const grandTxns = accounts.reduce((s, a) => s + a.txnCount, 0);

 const selectedTotal = selectedAcctTxns.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">{title}</h1>
 <div className="page-sub">
 {subtitle} · {accounts.length} account{accounts.length === 1 ? '' : 's'} · {grandTxns.toLocaleString()} transactions ·
 outflow <strong>{formatCurrency(grandOutflow)}</strong> · inflow <strong>{formatCurrency(grandInflow)}</strong>
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Account summary table - click row to drill into its transactions */}
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Accounts</div>
 <div className="section-sub">Click an account to see its transaction detail.</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Account</th>
 <th className="num">Transactions</th>
 <th className="num">Total Outflow</th>
 <th className="num">Total Inflow</th>
 <th className="num">Net</th>
 </tr>
 </thead>
 <tbody>
 {accounts.map((a) => {
 const isSelected = selectedAccount === a.account;
 const totOut = Object.values(a.monthlyOutflow).reduce((s, v) => s + v, 0);
 const totIn = Object.values(a.monthlyInflow).reduce((s, v) => s + v, 0);
 const net = totIn - totOut;
 return (
 <tr
 key={a.account}
 onClick={() => setSelectedAccount(isSelected ? null : a.account)}
 style={{
 cursor: 'pointer',
 background: isSelected ? 'var(--accent-soft, #e6f4ef)' : undefined,
 }}
 >
 <td>
 <strong>{a.account}</strong>
 <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>
 {isSelected ? '▼ hide details' : '▶ view transactions'}
 </span>
 </td>
 <td className="num">{a.txnCount.toLocaleString()}</td>
 <td className="num"><strong>{formatCurrency(totOut)}</strong></td>
 <td className="num">{formatCurrency(totIn)}</td>
 <td className="num" style={{ color: net < 0 ? 'var(--danger)' : '#059669' }}>
 {formatCurrency(net)}
 </td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td>Total</td>
 <td className="num">{grandTxns.toLocaleString()}</td>
 <td className="num"><strong>{formatCurrency(grandOutflow)}</strong></td>
 <td className="num">{formatCurrency(grandInflow)}</td>
 <td className="num">{formatCurrency(grandInflow - grandOutflow)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 {/* Month × category pivot - spend per category per month */}
 {selectedAccount && selectedMonthPivot.rows.length > 0 && (
 <CollapsibleSection
 title={`Month × Category Spend - ${selectedAccount}`}
 sub={<>Outflow per category per month · sorted biggest spend first · {selectedMonthPivot.rows.length} categor{selectedMonthPivot.rows.length === 1 ? 'y' : 'ies'} · {selectedMonthPivot.months.length} months · grand total <strong>{formatCurrency(selectedMonthPivot.grand)}</strong></>}
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Category</th>
 {selectedMonthPivot.months.map((m) => (<th key={m} className="num">{m}</th>))}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 {selectedMonthPivot.rows.map((r) => (
 <tr key={r.category}>
 <td><strong>{r.category}</strong></td>
 {r.monthly.map((v, i) => (
 <td key={i} className="num" style={{ color: v === 0 ? 'var(--muted)' : undefined }}>
 {v === 0 ? '-' : formatCurrency(v)}
 </td>
 ))}
 <td className="num"><strong>{formatCurrency(r.total)}</strong></td>
 </tr>
 ))}
 <tr className="total-row">
 <td>Total</td>
 {selectedMonthPivot.months.map((m) => (
 <td key={m} className="num"><strong>{formatCurrency(selectedMonthPivot.colTotals.get(m) ?? 0)}</strong></td>
 ))}
 <td className="num"><strong>{formatCurrency(selectedMonthPivot.grand)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 )}

 {/* Category breakdown - where the money went for this account */}
 {selectedAccount && selectedCategorySummary.length > 0 && (
 <CollapsibleSection
 title={`Category Breakdown - ${selectedAccount}`}
 sub={<>{selectedCategorySummary.length} categor{selectedCategorySummary.length === 1 ? 'y' : 'ies'} · outflow tells where the money went · inflow tells where it came from</>}
 rightSlot={<button className="btn ghost" onClick={() => setSelectedAccount(null)}>Close</button>}
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Category</th>
 <th className="num">Transactions</th>
 <th className="num">Outflow</th>
 <th className="num">Inflow</th>
 <th className="num">Net</th>
 </tr>
 </thead>
 <tbody>
 {selectedCategorySummary.map((c) => (
 <tr key={c.category}>
 <td><strong>{c.category}</strong></td>
 <td className="num">{c.count}</td>
 <td className="num">{c.outflow > 0 ? formatCurrency(c.outflow) : '-'}</td>
 <td className="num" style={{ color: c.inflow > 0 ? '#059669' : 'var(--muted)' }}>
 {c.inflow > 0 ? formatCurrency(c.inflow) : '-'}
 </td>
 <td className="num" style={{ color: c.net < 0 ? 'var(--text)' : '#059669' }}>
 <strong>{formatCurrency(c.net)}</strong>
 </td>
 </tr>
 ))}
 <tr className="total-row">
 <td>Total</td>
 <td className="num">{selectedAcctTxns.length}</td>
 <td className="num"><strong>{formatCurrency(selectedCategorySummary.reduce((s, c) => s + c.outflow, 0))}</strong></td>
 <td className="num"><strong>{formatCurrency(selectedCategorySummary.reduce((s, c) => s + c.inflow, 0))}</strong></td>
 <td className="num"><strong>{formatCurrency(selectedCategorySummary.reduce((s, c) => s + c.net, 0))}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 )}

 {/* Month × category pivot - spend per category per month */}
 {selectedAccount && selectedMonthPivot.rows.length > 0 && selectedMonthPivot.months.length > 0 && (
 <CollapsibleSection
 title={`Monthly Spend by Category - ${selectedAccount}`}
 sub={<>Outflow only · {selectedMonthPivot.rows.length} categories × {selectedMonthPivot.months.length} months · grand total <strong>{formatCurrency(selectedMonthPivot.grand)}</strong></>}
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Category</th>
 {selectedMonthPivot.months.map((m) => (
 <th key={m} className="num">{m}</th>
 ))}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 {selectedMonthPivot.rows.map((r) => (
 <tr key={r.category}>
 <td><strong>{r.category}</strong></td>
 {r.monthly.map((v, i) => (
 <td key={i} className="num" style={{ color: v > 0 ? 'var(--text)' : 'var(--muted)' }}>
 {v > 0 ? formatCurrency(v) : '-'}
 </td>
 ))}
 <td className="num"><strong>{formatCurrency(r.total)}</strong></td>
 </tr>
 ))}
 <tr className="total-row">
 <td>Total</td>
 {selectedMonthPivot.months.map((m) => (
 <td key={m} className="num"><strong>{formatCurrency(selectedMonthPivot.colTotals.get(m) ?? 0)}</strong></td>
 ))}
 <td className="num"><strong>{formatCurrency(selectedMonthPivot.grand)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 )}

 {/* Transaction detail - shown when an account row is clicked */}
 {selectedAccount && selectedAcctTxns.length > 0 && (
 <CollapsibleSection
 title={`Transaction Detail - ${selectedAccount}`}
 sub={`${selectedAcctTxns.length} transactions · sorted newest first · total outflow ${formatCurrency(selectedTotal)}`}
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Date</th>
 <th>Payee / Business</th>
 <th>Category</th>
 <th className="num">Amount</th>
 <th>Status</th>
 </tr>
 </thead>
 <tbody>
 {selectedAcctTxns.map((t) => (
 <tr key={t.txnId || `${t.date}-${t.amount}-${t.payee}`}>
 <td>{t.date}</td>
 <td className="vendor-note">{t.payee}</td>
 <td>{t.category || '-'}</td>
 <td className="num" style={{ color: t.amount < 0 ? 'var(--text)' : '#059669' }}>
 <strong>{formatCurrency(t.amount)}</strong>
 </td>
 <td>{t.status || '-'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 )}
 </>
 );
}
