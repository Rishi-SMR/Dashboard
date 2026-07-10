import { useEffect, useState } from 'react';
import {
 fetchQbPlReport, fetchAccountTransactions, fetchQbBalanceSheet,
 type QbPlReport, type QbPlRow, type AccountTransactionsResult, type QbBalanceSheetReport,
} from '../api';
import { formatCurrency } from '../format';

const POLL_INTERVAL_MS = 60_000;
type AcctMethod = 'Accrual' | 'Cash';

export function LivePLPage() {
 const [data, setData] = useState<QbPlReport | null>(null);
 const [bs, setBs] = useState<QbBalanceSheetReport | null>(null);
 const [method, setMethod] = useState<AcctMethod>('Accrual');
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
 const [drillData, setDrillData] = useState<AccountTransactionsResult | null>(null);
 const [drillLoading, setDrillLoading] = useState(false);

 async function openDrill(accountName: string) {
 if (expandedAccount === accountName) {
 setExpandedAccount(null);
 setDrillData(null);
 return;
 }
 setExpandedAccount(accountName);
 setDrillData(null);
 setDrillLoading(true);
 try {
 const d = await fetchAccountTransactions(accountName);
 setDrillData(d);
 } catch (e) {
 setDrillData({
 account: accountName, asOf: new Date().toISOString(),
 total: 0, purexTotal: 0, moyshTotal: 0, unpaidTotal: 0,
 transactions: [],
 });
 console.error('drill fetch failed', e);
 } finally {
 setDrillLoading(false);
 }
 }

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const [pl, balSheet] = await Promise.all([
 fetchQbPlReport({ refresh, method }),
 fetchQbBalanceSheet({ refresh }).catch(() => null),
 ]);
 setData(pl);
 if (balSheet) setBs(balSheet);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const poll = window.setInterval(() => load(false, true), POLL_INTERVAL_MS);
 const onFocus = () => load(false, true);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [method]); // re-fetch P&L when method toggled

 if (loading && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Live P&L</h1><div className="page-sub">Loading…</div></div></div>
 </>
 );
 }
 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Live P&L</h1></div></div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> <a href="/auth/connect">/auth/connect</a></>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const monthCount = data.months.length;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Live P&L</h1>
 <div className="page-sub">
 Pulled live from QB's Profit &amp; Loss report ·{' '}
 <strong>{data.monthLabels[0]} – {data.monthLabels[monthCount - 1]}</strong> ·{' '}
 {data.rows.length} rows · matches QB exactly · {method} basis
 </div>
 </div>
 <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
 <div className="segmented" style={{ display: 'flex' }}>
 <button
 className={method === 'Accrual' ? 'active' : ''}
 onClick={() => setMethod('Accrual')}
 title="Bills counted when recorded. Includes inventory-COGS accrual entries. Matches QB default P&L."
 >
 Accrual
 </button>
 <button
 className={method === 'Cash' ? 'active' : ''}
 onClick={() => setMethod('Cash')}
 title="Bills counted only when paid. No inventory-COGS accrual entries - actual cash spent."
 >
 Cash
 </button>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh from QB'}
 </button>
 </div>
 </div>

 {bs && (
 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Inventory (asset)</div>
 <div className="kpi-period">From Balance Sheet · as of {bs.reportAsOf}</div>
 <div className="kpi-value">{formatCurrency(bs.totals.inventory)}</div>
 <div className="kpi-sub">On hand (not yet sold / consumed)</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Accounts Receivable</div>
 <div className="kpi-period">From Balance Sheet</div>
 <div className="kpi-value">{formatCurrency(bs.totals.accountsReceivable)}</div>
 <div className="kpi-sub">Owed by customers</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Accounts Payable</div>
 <div className="kpi-period">From Balance Sheet</div>
 <div className="kpi-value">{formatCurrency(bs.totals.accountsPayable)}</div>
 <div className="kpi-sub">Bills owed to vendors</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Cash &amp; Bank</div>
 <div className="kpi-period">From Balance Sheet</div>
 <div className="kpi-value">{formatCurrency(bs.totals.cashAndBank)}</div>
 <div className="kpi-sub">All bank + cash accounts</div>
 </div>
 </div>
 )}

 <div className="section">
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 320, position: 'sticky', left: 0, background: '#fff', zIndex: 2 }}>Account</th>
 {data.monthLabels.map((m) => (<th key={m} className="num">{m}</th>))}
 <th className="num" style={{ background: '#eef4ff' }}>Total</th>
 </tr>
 </thead>
 <tbody>
 {data.rows.map((row, idx) => (
 <PlRow
 key={idx}
 row={row}
 monthCount={monthCount}
 expandedAccount={expandedAccount}
 drillData={drillData}
 drillLoading={drillLoading}
 onClickDetail={openDrill}
 />
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}

type PlRowProps = {
 row: QbPlRow;
 monthCount: number;
 expandedAccount: string | null;
 drillData: AccountTransactionsResult | null;
 drillLoading: boolean;
 onClickDetail: (accountName: string) => void;
};

function PlRow({ row, monthCount, expandedAccount, drillData, drillLoading, onClickDetail }: PlRowProps) {
 const isTopSection = row.depth === 0 && (row.kind === 'section' || row.kind === 'header');
 const isSummary = row.kind === 'summary';
 const isHeader = row.kind === 'header';
 const isDetail = row.kind === 'detail';
 const indent = row.depth * 18;

 let bg: string | undefined;
 let weight: number = 400;
 let fontSize: number | undefined;
 if (isTopSection) { bg = '#eef4ff'; weight = 700; fontSize = 13; }
 else if (isSummary) { bg = '#f7f8fa'; weight = 700; }
 else if (row.kind === 'section') { weight = 600; }

 const showValues = !isHeader;
 const isExpanded = expandedAccount === row.name;
 // Only LEAF detail rows (actual QB accounts) are drillable.
 const drillable = isDetail && row.total !== 0;

 return (
 <>
 <tr
 style={{
 background: isExpanded ? '#fff3d8' : bg,
 cursor: drillable ? 'pointer' : undefined,
 }}
 onClick={drillable ? () => onClickDetail(row.name) : undefined}
 title={drillable ? 'Click to see all transactions for this account' : undefined}
 >
 <td style={{ paddingLeft: 12 + indent, fontWeight: weight, fontSize, position: 'sticky', left: 0, background: isExpanded ? '#fff3d8' : (bg ?? '#fff'), zIndex: 1 }}>
 {drillable && <span style={{ marginRight: 6, color: '#945215' }}>{isExpanded ? '▼' : '▶'}</span>}
 {row.name}
 </td>
 {row.monthly.slice(0, monthCount).map((v, i) => (
 <td key={i} className="num" style={{ fontWeight: weight }}>
 {showValues && v !== 0 ? formatCurrency(v) : showValues ? '-' : ''}
 </td>
 ))}
 <td className="num" style={{ fontWeight: showValues ? 700 : weight, background: '#eef4ff' }}>
 {showValues && row.total !== 0 ? formatCurrency(row.total) : showValues ? '-' : ''}
 </td>
 </tr>

 {isExpanded && (
 <tr>
 <td colSpan={monthCount + 2} style={{ background: '#fff8e1', padding: '14px 18px' }}>
 {drillLoading || !drillData ? (
 <div style={{ color: '#666' }}>Loading transactions for <strong>{row.name}</strong>…</div>
 ) : drillData.transactions.length === 0 ? (
 <div style={{ color: '#666' }}>
 No drilled transactions found for <strong>{row.name}</strong>. This account's value may come from
 inventory-sales auto-COGS or other postings outside Purchase/Bill/JournalEntry.
 </div>
 ) : (
 <>
 <div style={{ display: 'flex', gap: 24, marginBottom: 10, fontSize: 12, color: '#3a4660' }}>
 <span><strong>{drillData.transactions.length}</strong> transactions</span>
 <span style={{ marginLeft: 'auto', color: '#888' }}>Drilled total: {formatCurrency(drillData.total)} vs P&L total: {formatCurrency(row.total)}</span>
 </div>
 <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid #e1d8c2', borderRadius: 4, background: '#fff' }}>
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
 {drillData.transactions.map((t, i) => (
 <tr key={i} style={{ borderBottom: '1px solid #f5eee0' }}>
 <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{t.date}</td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.txnType}</td>
 <td style={{ padding: '5px 8px' }}>{t.vendor ?? '-'}</td>
 <td style={{ padding: '5px 8px', color: '#666', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
 {t.memo ?? '-'}
 </td>
 <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
 {formatCurrency(t.amount)}
 </td>
 <td style={{ padding: '5px 8px' }}>
 <span style={{
 padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
 color: '#3a4660', background: '#eef4ff',
 }}>{t.paidBy}</span>
 </td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.sourceBank}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </>
 )}
 </td>
 </tr>
 )}
 </>
 );
}
