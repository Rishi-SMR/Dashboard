import { Fragment, useEffect, useState } from 'react';
import { fetchReconciliation, type ReconciliationResult, type ReconciledRow } from '../api';
import { formatCurrency } from '../format';

type View = 'matched' | 'bankOnly' | 'transfers' | 'qbOnly';

export function ReconciliationPage() {
 const [data, setData] = useState<ReconciliationResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [view, setView] = useState<View>('bankOnly'); // start with action items

 async function load(refresh = false) {
 setLoading(true); setError(null);
 try {
 setData(await fetchReconciliation({ refresh }));
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 setLoading(false);
 }
 }

 useEffect(() => { load(false); }, []);

 if (loading && !data) {
 return <div className="page-head"><div><h1 className="page-title">Reconciliation</h1><div className="page-sub">Loading… (merging bank + books data)</div></div></div>;
 }
 if (error) {
 return <><div className="page-head"><div><h1 className="page-title">Reconciliation</h1></div></div><div className="error">{error}</div><button className="btn ghost" onClick={() => load(true)}>Retry</button></>;
 }
 if (!data) return null;

 const matchPct = data.counts.tillerTotal > 0 ? (data.counts.matched / data.counts.tillerTotal) * 100 : 0;
 const rows: ReconciledRow[] =
   view === 'matched' ? data.matched :
   view === 'bankOnly' ? data.bankOnly :
   view === 'transfers' ? data.transfers :
   data.qbOnly;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Bank ↔ Books Reconciliation</h1>
 <div className="page-sub">
 Matches every actual bank movement to its booked expense.
 Window: <strong>{data.windowStart}</strong> → today · match tolerance ±<strong>{data.matchDays} days</strong>
 {data.counts.tillerDuplicatesDropped > 0 && (
   <> · dropped <strong>{data.counts.tillerDuplicatesDropped}</strong> duplicate bank rows</>
 )}
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Summary KPIs */}
 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Matched</div>
 <div className="kpi-period">{matchPct.toFixed(1)}% of bank rows</div>
 <div className="kpi-value">{formatCurrency(data.totals.matched)}</div>
 <div className="kpi-sub">{data.counts.matched.toLocaleString()} transactions reconciled</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Bank-only (needs to be booked)</div>
 <div className="kpi-period">Action items</div>
 <div className="kpi-value" style={{ color: 'var(--danger)' }}>{formatCurrency(data.totals.bankOnly)}</div>
 <div className="kpi-sub">{data.counts.bankOnly.toLocaleString()} bank txns · real spend without a booked entry</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Transfers / CC payoff</div>
 <div className="kpi-period">Intercompany cash moves</div>
 <div className="kpi-value" style={{ color: '#6b7280' }}>{formatCurrency(data.totals.transfers)}</div>
 <div className="kpi-sub">{data.counts.transfers.toLocaleString()} rows · not real spend, no action needed</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Books-only (no bank match)</div>
 <div className="kpi-period">Accrual / clearing / date drift</div>
 <div className="kpi-value" style={{ color: '#b45309' }}>{formatCurrency(data.totals.qbOnly)}</div>
 <div className="kpi-sub">{data.counts.qbOnly.toLocaleString()} booked entries</div>
 </div>
 </div>

 {/* View toggle */}
 <div className="section" style={{ padding: '12px 18px' }}>
 <div className="filter-row" style={{ gap: 10 }}>
 {([
 { k: 'matched',   l: `Matched (${data.counts.matched.toLocaleString()})` },
 { k: 'bankOnly',  l: `Bank-only · action (${data.counts.bankOnly.toLocaleString()})` },
 { k: 'transfers', l: `Transfers / CC payoff (${data.counts.transfers.toLocaleString()})` },
 { k: 'qbOnly',    l: `Books-only (${data.counts.qbOnly.toLocaleString()})` },
 ] as const).map((b) => (
 <button key={b.k} className={`filter-tab ${view === b.k ? 'active' : ''}`} onClick={() => setView(b.k)}>{b.l}</button>
 ))}
 </div>
 </div>

 {/* Category Attribution pivot - month × bank vs CC split (matched only) */}
 {data.categoryAttribution && data.categoryAttribution.length > 0 && data.attributionMonths.length > 0 && (
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Spend Attribution - by Category × Month × Source</div>
 <div className="section-sub">
 Matched bucket only · per category, how much was paid from the bank vs credit card each month ·
 {' '}{data.categoryAttribution.length} categories across {data.attributionMonths.length} months
 </div>
 </div>
 </div>
 <div className="table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}>
 <table className="data-table">
 <thead>
 <tr>
 <th rowSpan={2} style={{ verticalAlign: 'bottom' }}>Category</th>
 {data.attributionMonths.map((m) => (
 <th key={m} colSpan={2} className="num" style={{ borderLeft: '1px solid var(--border)' }}>{m}</th>
 ))}
 <th colSpan={3} className="num" style={{ borderLeft: '1px solid var(--border)' }}>Total</th>
 </tr>
 <tr>
 {data.attributionMonths.map((m) => (
 <Fragment key={m}>
 <th className="num" style={{ borderLeft: '1px solid var(--border)', fontSize: 11 }}>Bank</th>
 <th className="num" style={{ fontSize: 11 }}>CC</th>
 </Fragment>
 ))}
 <th className="num" style={{ borderLeft: '1px solid var(--border)', fontSize: 11 }}>Bank</th>
 <th className="num" style={{ fontSize: 11 }}>CC</th>
 <th className="num" style={{ fontSize: 11 }}>Total</th>
 </tr>
 </thead>
 <tbody>
 {data.categoryAttribution.map((c) => (
 <tr key={c.category}>
 <td><strong>{c.category}</strong></td>
 {data.attributionMonths.map((m) => {
 const v = c.monthly[m];
 return (
 <Fragment key={m}>
 <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>{v && v.bank > 0 ? formatCurrency(v.bank) : '-'}</td>
 <td className="num">{v && v.cc > 0 ? formatCurrency(v.cc) : '-'}</td>
 </Fragment>
 );
 })}
 <td className="num" style={{ borderLeft: '1px solid var(--border)' }}><strong>{formatCurrency(c.bankPaid)}</strong></td>
 <td className="num"><strong>{formatCurrency(c.ccPaid)}</strong></td>
 <td className="num"><strong>{formatCurrency(c.total)}</strong></td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* Row list */}
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">
 {view === 'matched'   && 'Matched transactions'}
 {view === 'bankOnly'  && 'Bank-only · real spend without a booked entry'}
 {view === 'transfers' && 'Intercompany cash movements (CC payoff, bank↔bank transfers)'}
 {view === 'qbOnly'    && 'Books-only · booked, not seen on bank'}
 </div>
 <div className="section-sub">
 {view === 'matched'   && 'Each row links a bank movement to its booked category.'}
 {view === 'bankOnly'  && 'Spend left the bank but no booked entry was found. Likely needs to be booked.'}
 {view === 'transfers' && 'Cash moved between your own accounts (e.g. ACH payment from a bank account to a credit card). Not real expense - the underlying spend on the credit card side is already booked separately. No action needed.'}
 {view === 'qbOnly'    && 'The books have the entry but no matching bank txn was seen (accrual-only or pending).'}
 </div>
 </div>
 </div>
 <div className="table-wrap">
 {view === 'qbOnly' ? (
   <QbOnlyGroupedTable rows={rows} />
 ) : (
   <table className="data-table">
   <thead>
   <tr>
   <th>Date</th>
   <th>Source Bank</th>
   <th>Payee / Vendor</th>
   <th>Category</th>
   <th className="num">Amount</th>
   {view === 'matched' && <th className="num">Day Diff</th>}
   </tr>
   </thead>
   <tbody>
   {rows.slice(0, 500).map((r, i) => (
   <tr key={`${r.tillerTxnId ?? r.qbTxnId ?? i}-${i}`}>
   <td>{r.date}</td>
   <td>{r.sourceBank}</td>
   <td className="vendor-note">{r.payee}</td>
   <td>{r.qbCategory ?? '-'}</td>
   <td className="num"><strong>{formatCurrency(r.amount)}</strong></td>
   {view === 'matched' && <td className="num">{r.daysDiff ?? 0}d</td>}
   </tr>
   ))}
   {rows.length > 500 && (
   <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
   Showing first 500 of {rows.length.toLocaleString()} rows
   </td></tr>
   )}
   <tr className="total-row">
   <td colSpan={4}>TOTAL ({rows.length.toLocaleString()})</td>
   <td className="num"><strong>{formatCurrency(rows.reduce((s, r) => s + r.amount, 0))}</strong></td>
   {view === 'matched' && <td></td>}
   </tr>
   </tbody>
   </table>
 )}
 </div>
 </div>
 </>
 );
}

/**
 * Books-only rows grouped by their nature (journal / capex / bill-payment /
 * real-expense) so the user can tell at a glance which rows are
 * journal-only (no cash) vs which are real spend the bank feed missed.
 */
function QbOnlyGroupedTable({ rows }: { rows: ReconciledRow[] }) {
 const groupMeta = {
   'real-expense': { label: 'Real expense (bank feed missed it)', tone: '#dc2626', hint: 'Genuine spend booked but no matching bank movement. Most likely: wire transfers, manual checks from a non-tracked account, or sync gap.' },
   'bill-payment': { label: 'Bill payments (no detail)',       tone: '#b45309', hint: 'Bill payment entries - categorisation only on the underlying bill, not the payment itself.' },
   'capex':        { label: 'Capex / Investments',             tone: '#0369a1', hint: 'R&D capitalisation, property purchases, long-term investments. Often booked as journal entries, may not show on a cash account.' },
   'journal':      { label: "Journal entries (no cash)",       tone: '#6b7280', hint: "Shareholders' equity, distributions, contributions, intercompany transfers. These are balance-sheet moves - not real spend." },
 } as const;
 const groupOrder: Array<keyof typeof groupMeta> = ['real-expense', 'bill-payment', 'capex', 'journal'];

 const byGroup = new Map<string, ReconciledRow[]>();
 for (const r of rows) {
   const g = r.qbCategoryGroup ?? 'real-expense';
   if (!byGroup.has(g)) byGroup.set(g, []);
   byGroup.get(g)!.push(r);
 }
 return (
   <>
   {groupOrder.map((g) => {
     const items = byGroup.get(g) ?? [];
     if (items.length === 0) return null;
     const meta = groupMeta[g];
     const sum = items.reduce((s, r) => s + r.amount, 0);
     return (
       <div key={g} style={{ marginBottom: 18 }}>
       <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 12px', borderLeft: `3px solid ${meta.tone}`, background: 'var(--panel-soft, #f8fbfa)', marginBottom: 6 }}>
       <div style={{ fontWeight: 700, fontSize: 14, color: meta.tone }}>{meta.label}</div>
       <div style={{ fontSize: 12, color: 'var(--muted)' }}>{items.length} rows · <strong>{formatCurrency(sum)}</strong></div>
       <div style={{ fontSize: 11, color: 'var(--muted)', flex: 1, textAlign: 'right' }}>{meta.hint}</div>
       </div>
       <table className="data-table">
       <thead>
       <tr>
       <th>Date</th>
       <th>Source Bank</th>
       <th>Payee / Vendor</th>
       <th>Category</th>
       <th className="num">Amount</th>
       </tr>
       </thead>
       <tbody>
       {items.slice(0, 200).map((r, i) => (
         <tr key={`${r.qbTxnId ?? i}-${i}`}>
         <td>{r.date}</td>
         <td>{r.sourceBank}</td>
         <td className="vendor-note">{r.payee}</td>
         <td>{r.qbCategory ?? '-'}</td>
         <td className="num"><strong>{formatCurrency(r.amount)}</strong></td>
         </tr>
       ))}
       {items.length > 200 && (
         <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
         Showing first 200 of {items.length.toLocaleString()} rows in this group
         </td></tr>
       )}
       </tbody>
       </table>
       </div>
     );
   })}
   </>
 );
}
