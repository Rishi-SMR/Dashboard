import { useEffect, useState } from 'react';
import { fetchQbBalanceSheet, type QbBalanceSheetReport } from '../api';
import { formatCurrency } from '../format';

const POLL_INTERVAL_MS = 60_000;

type BsRow = QbBalanceSheetReport['rows'][number];

export function LiveBSPage() {
 const [data, setData] = useState<QbBalanceSheetReport | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [method, setMethod] = useState<'Accrual' | 'Cash'>('Accrual');

 async function load(refresh = false, silent = false, m: 'Accrual' | 'Cash' = method) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 setData(await fetchQbBalanceSheet({ refresh, method: m }));
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false, false, method);
 const poll = window.setInterval(() => load(false, true, method), POLL_INTERVAL_MS);
 const onFocus = () => load(false, true, method);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 }, [method]);

 if (loading && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Live Balance Sheet</h1><div className="page-sub">Loading…</div></div></div>
 </>
 );
 }
 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Balance Sheet</h1></div></div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> <a href="/auth/connect">/auth/connect</a></>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Balance Sheet</h1>
 <div className="page-sub">
 As of <strong>{data.reportAsOf}</strong> · live pass-through from QB ·{' '}
 {data.rows.length} rows · matches QB exactly · <strong>{method}</strong> basis
 </div>
 </div>
 <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
 <div className="segmented" style={{ display: 'flex' }}>
 <button
 className={method === 'Accrual' ? 'active' : ''}
 onClick={() => setMethod('Accrual')}
 title="Bills/AR/AP counted when recorded. Matches QB default Balance Sheet."
 >
 Accrual
 </button>
 <button
 className={method === 'Cash' ? 'active' : ''}
 onClick={() => setMethod('Cash')}
 title="Only paid transactions. AR/AP not included - reflects cash-only position."
 >
 Cash
 </button>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh from QB'}
 </button>
 </div>
 </div>

 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Total Assets</div>
 <div className="kpi-period">As of {data.reportAsOf}</div>
 <div className="kpi-value">{formatCurrency(data.totals.totalAssets)}</div>
 <div className="kpi-sub">All current + fixed + other</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Inventory</div>
 <div className="kpi-period">On hand</div>
 <div className="kpi-value">{formatCurrency(data.totals.inventory)}</div>
 <div className="kpi-sub">Raw materials + finished goods</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Accounts Receivable</div>
 <div className="kpi-period">Owed to company</div>
 <div className="kpi-value">{formatCurrency(data.totals.accountsReceivable)}</div>
 <div className="kpi-sub">From customers</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Cash &amp; Bank</div>
 <div className="kpi-period">All bank/cash accounts</div>
 <div className="kpi-value">{formatCurrency(data.totals.cashAndBank)}</div>
 <div className="kpi-sub">Sum across banks</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Accounts Payable</div>
 <div className="kpi-period">Bills to vendors</div>
 <div className="kpi-value">{formatCurrency(data.totals.accountsPayable)}</div>
 <div className="kpi-sub">Unpaid bills</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Total Equity</div>
 <div className="kpi-period">Net worth</div>
 <div className="kpi-value">{formatCurrency(data.totals.totalEquity)}</div>
 <div className="kpi-sub">Assets − Liabilities</div>
 </div>
 </div>

 <div className="section">
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 320, position: 'sticky', left: 0, background: '#fff', zIndex: 2 }}>Account</th>
 {data.monthLabels.map((m) => (<th key={m} className="num">{m}</th>))}
 <th className="num" style={{ background: '#eef4ff' }}>Latest</th>
 </tr>
 </thead>
 <tbody>
 {data.rows.map((row, idx) => <BsRowView key={idx} row={row} monthCount={data.months.length} />)}
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}

function BsRowView({ row, monthCount }: { row: BsRow; monthCount: number }) {
 const isTopSection = row.depth === 0 && (row.kind === 'section' || row.kind === 'header');
 const isSummary = row.kind === 'summary';
 const isHeader = row.kind === 'header';
 const indent = row.depth * 18;

 let bg: string | undefined;
 let weight: number = 400;
 let fontSize: number | undefined;
 if (isTopSection) { bg = '#eef4ff'; weight = 700; fontSize = 13; }
 else if (isSummary) { bg = '#f7f8fa'; weight = 700; }
 else if (row.kind === 'section') { weight = 600; }

 const showValue = !isHeader;

 return (
 <tr style={{ background: bg }}>
 <td style={{ paddingLeft: 12 + indent, fontWeight: weight, fontSize, position: 'sticky', left: 0, background: bg ?? '#fff', zIndex: 1 }}>
 {row.name}
 </td>
 {(row.monthly ?? new Array(monthCount).fill(0)).slice(0, monthCount).map((v, i) => (
 <td key={i} className="num" style={{ fontWeight: weight }}>
 {showValue && v !== 0 ? formatCurrency(v) : showValue ? '-' : ''}
 </td>
 ))}
 <td className="num" style={{ fontWeight: showValue ? 700 : weight, background: '#eef4ff' }}>
 {showValue && row.amount !== 0 ? formatCurrency(row.amount) : showValue ? '-' : ''}
 </td>
 </tr>
 );
}
