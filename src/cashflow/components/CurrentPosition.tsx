import { useEffect, useState } from 'react';
import {
 fetchArOpen,
 fetchGelatoAr,
 fetchLinkedBalances,
 fetchPurexClearing,
 type ArResult,
 type GelatoArResult,
 type LinkedBalances,
 type PurexClearingResult,
} from '../api';
import { formatCurrency } from '../format';

const POLL_INTERVAL_MS = 60_000;

/**
 * User-confirmed cash mappings - pairs the QB account with its Tiller twin.
 * Cash side is locked in; credit cards still being reviewed in side-by-side.
 */
type Pair = { label: string; qbMatch: RegExp; tillerMatch: RegExp; notes: string };
const CASH_PAIRS: Pair[] = [
 { label: 'Checking 7561', qbMatch: /7561/, tillerMatch: /crb indirect|7561/i, notes: 'Primary operating account' },
 { label: 'BMM Account', qbMatch: /0910/, tillerMatch: /business mm|0910/i, notes: 'Secondary (Business Money Market)' },
];

type CcPair = { label: string; qbMatch: RegExp; tillerMatch: RegExp; isPersonal: boolean; notes: string };
const CC_PAIRS: CcPair[] = [
 { label: 'MC Consumer', qbMatch: /mc consumer|4362/i, tillerMatch: /mc consumer|4362/i, isPersonal: false, notes: 'Business' },
 { label: 'Amex Blue Business', qbMatch: /81009/, tillerMatch: /blue business plus|1009/i, isPersonal: false, notes: 'Business' },
 { label: 'Delta Business', qbMatch: /11007/, tillerMatch: /delta gold business|1007/i, isPersonal: false, notes: 'Business' },
 { label: 'Amex Everyday', qbMatch: /71006/, tillerMatch: /everyday|1006/i, isPersonal: false, notes: 'Business' },
 { label: 'FNBO', qbMatch: /fnbo/i, tillerMatch: /signature|6037/i, isPersonal: false, notes: 'Business' },
 { label: 'Chase 4158', qbMatch: /\(4158\)|^chase 4158/i, tillerMatch: /\(-4158\)|· 4158/i, isPersonal: false, notes: 'Business' },
 { label: 'Chase 0715', qbMatch: /\(7566\)|^chase 7566/i, tillerMatch: /\(-0715\)|· 0715/i, isPersonal: false, notes: 'Business (QB internal code 7566, actual card 0715)' },
 { label: 'Citi Double Cash', qbMatch: /citi 0744|0744/i, tillerMatch: /double cash/i, isPersonal: false, notes: 'Business (Citi)' },
 { label: 'Citi Strata', qbMatch: /citi 4267|4267/i, tillerMatch: /strata/i, isPersonal: false, notes: 'Business (Citi)' },
];

function agoString(at: Date, _tick: number): string {
 const sec = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
 if (sec < 60) return `${sec}s ago`;
 const min = Math.floor(sec / 60);
 if (min < 60) return `${min}m ${sec % 60}s ago`;
 const hr = Math.floor(min / 60);
 return `${hr}h ${min % 60}m ago`;
}

export function CurrentPosition() {
 const [data, setData] = useState<LinkedBalances | null>(null);
 const [ar, setAr] = useState<ArResult | null>(null);
 const [batchAr, setBatchAr] = useState<GelatoArResult | null>(null);
 const [clearing, setClearing] = useState<PurexClearingResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
 const [tick, setTick] = useState(0);
 const [showAllAr, setShowAllAr] = useState(false);

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const [linked, arData, batchArData, clearingData] = await Promise.all([
 fetchLinkedBalances({ refresh }),
 fetchArOpen({ refresh }).catch(() => null),
 fetchGelatoAr({ refresh }).catch(() => null),
 fetchPurexClearing({ refresh }).catch(() => null),
 ]);
 setData(linked);
 if (arData) setAr(arData);
 if (batchArData) setBatchAr(batchArData);
 if (clearingData) setClearing(clearingData);
 setLastFetchedAt(new Date());
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const pollId = window.setInterval(() => load(false, true), POLL_INTERVAL_MS);
 const onFocus = () => load(false, true);
 window.addEventListener('focus', onFocus);
 const tickId = window.setInterval(() => setTick((t) => t + 1), 1_000);
 return () => {
 window.clearInterval(pollId);
 window.clearInterval(tickId);
 window.removeEventListener('focus', onFocus);
 };
 }, []);

 if (loading && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Current Position</h1></div></div>
 <div className="page-sub">Loading…</div>
 </>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Current Position</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { qb, tiller, warnings } = data;
 const qbDisconnected = warnings.some((w) => /not connected|invalid|authorize/i.test(w));

 // Build matched cash pairs (locked-in mappings).
 const cashRows = CASH_PAIRS.map((p) => ({
 label: p.label,
 notes: p.notes,
 qb: qb.cashAccounts.find((a) => p.qbMatch.test(a.name)) ?? null,
 tiller: tiller.cashAccounts.find((a) => p.tillerMatch.test(a.name)) ?? null,
 }));
 // For a BANK account, "cash in hand" = the AVAILABLE balance (spendable now,
 // net of pending holds/authorisations), falling back to the ledger balance when
 // Tiller doesn't report an available figure.
 const cih = (t: { balance: number; balanceAvailable: number | null } | null): number =>
 t ? (t.balanceAvailable != null ? t.balanceAvailable : t.balance) : 0;
 const cashTotalLive = cashRows.reduce((s, r) => s + cih(r.tiller), 0);

 // Build matched credit-card pairs (locked-in mappings).
 // MC Consumer can show up in either tiller.creditCards or tiller.loans.
 const tillerAllCredit = [...tiller.creditCards, ...tiller.loans];
 const ccRows = CC_PAIRS.map((p) => ({
 label: p.label,
 isPersonal: p.isPersonal,
 notes: p.notes,
 qb: qb.creditCards.find((a) => p.qbMatch.test(a.name)) ?? null,
 tiller: tillerAllCredit.find((a) => p.tillerMatch.test(a.name)) ?? null,
 }));
 const ccBusinessRows = ccRows.filter((r) => !r.isPersonal);
 const ccBusinessTotal = ccBusinessRows.reduce((s, r) => s + Math.abs(r.tiller?.balance ?? 0), 0);

 // --- Net liquidity ---
 // Net collectible AR = gross billed minus what the Invoice Tracker shows
 // already received.
 const netCollectibleAr = batchAr ? Math.max(0, batchAr.totals.open - batchAr.totals.receivedOnOpen) : 0;
 const netWorkingCapital = cashTotalLive - ccBusinessTotal + (clearing?.clearing ?? 0) + netCollectibleAr;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Current Position</h1>
 <div className="page-sub">
 Tiller bank-sync date <strong>{tiller.cashAccounts[0]?.lastUpdated ?? data.tillerLatestDate}</strong> ·{' '}
 <a href={data.sheetUrl} target="_blank" rel="noreferrer">open Tiller sheet</a>
 {lastFetchedAt && <> · <span style={{ color: '#059669' }}>● </span>auto-refresh every {POLL_INTERVAL_MS / 1000}s · updated {agoString(lastFetchedAt, tick)}</>}
 </div>
 </div>
 <div style={{ display: 'flex', gap: 8 }}>
 {qbDisconnected && (
 <a className="btn" href="/auth/connect" style={{ background: 'var(--info)' }}>Connect QuickBooks</a>
 )}
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>
 </div>

 {qbDisconnected && (
 <div className="section" style={{ padding: '12px 16px', background: 'var(--info-soft)', border: '1px solid var(--info)', marginBottom: 16 }}>
 <div style={{ fontWeight: 700, color: 'var(--info)', marginBottom: 4 }}>QuickBooks not connected</div>
 <div className="page-sub" style={{ fontSize: 12 }}>
 Click <a href="/auth/connect">Connect QuickBooks</a> to pull the QB account list. Cash balances are already live from Tiller.
 </div>
 </div>
 )}

 {/* SECTION 1 - CASH (locked-in mapping) */}
 <div className="section" data-cfo-anchor="cash-on-hand">
 <div className="section-head">
 <div>
 <div className="section-title">1. Cash on Hand</div>
 <div className="section-sub">QB-linked operating accounts · balances live from Tiller</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Account (per QB / lender sheet)</th>
 <th>QB Account</th>
 <th>Tiller Account</th>
 <th className="num">Cash in hand (Tiller available)</th>
 <th>Notes</th>
 </tr>
 </thead>
 <tbody>
 {cashRows.map((r) => (
 <tr key={r.label} className={!r.tiller ? 'row-none' : ''}>
 <td><strong>{r.label}</strong></td>
 <td>
 {r.qb ? (
 <>
 <div>{r.qb.name}</div>
 <div className="vendor-note">QB book: {formatCurrency(r.qb.balance, true)}</div>
 </>
 ) : <span className="vendor-note">(QB not connected)</span>}
 </td>
 <td>
 {r.tiller ? (
 <>
 <div>{r.tiller.name}</div>
 <div className="vendor-note">synced {r.tiller.lastUpdated}</div>
 </>
 ) : <span className="vendor-note">no Tiller match</span>}
 </td>
 <td className="num">
 <strong style={{ color: '#059669' }}>
 {r.tiller ? formatCurrency(cih(r.tiller), true) : '-'}
 </strong>
 </td>
 <td className="vendor-note">{r.notes}</td>
 </tr>
 ))}
 <tr className="total-row">
 <td colSpan={3}>TOTAL CASH ON HAND</td>
 <td className="num"><strong>{formatCurrency(cashTotalLive, true)}</strong></td>
 <td></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 {warnings.length > 0 && !qbDisconnected && (
 <div className="section" style={{ padding: '12px 16px', background: 'var(--warn-soft)', border: '1px solid var(--warn)', marginBottom: 16 }}>
 {warnings.map((w, i) => <div key={i} className="page-sub" style={{ fontSize: 12, color: 'var(--warn)' }}>· {w}</div>)}
 </div>
 )}

 {/* SECTION 2 - CREDIT CARDS (locked-in mapping) */}
 <div className="section" data-cfo-anchor="credit-cards">
 <div className="section-head">
 <div>
 <div className="section-title">2. Credit Card Debt</div>
 <div className="section-sub">QB-linked cards · balances live from Tiller</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Card</th>
 <th className="num">Used</th>
 <th className="num">Available</th>
 <th className="num">Limit</th>
 <th className="num">Use %</th>
 <th>Last Closing</th>
 <th>Next Payment Date</th>
 <th>Next Closing Date</th>
 </tr>
 </thead>
 <tbody>
 {ccBusinessRows.map((r) => {
 const used = r.tiller ? Math.abs(r.tiller.balance) : 0;
 const limit = r.tiller?.balanceLimit != null ? Math.abs(r.tiller.balanceLimit) : null;
 // Available = Limit − Used (what's left to spend), computed so the three
 // columns always reconcile. A card over its limit shows a negative available
 // (flagged red) instead of a misleading positive from the raw Tiller field.
 const avail = limit != null
 ? limit - used
 : (r.tiller?.balanceAvailable != null ? Math.abs(r.tiller.balanceAvailable) : null);
 const pct = r.tiller?.usePct;
 // Colour by how much credit is still AVAILABLE (avail ÷ limit):
 //   overused (avail < 0) → red · ≤20% left → yellow · ≥80% left → green.
 const availPct = (avail != null && limit != null && limit > 0) ? avail / limit : null;
 const availColor = avail != null && avail < 0
 ? 'var(--danger)'
 : availPct == null ? 'var(--muted)'
 : availPct <= 0.2 ? 'var(--warn)'
 : availPct >= 0.8 ? '#059669'
 : 'var(--muted)';
 return (
 <tr key={r.label} className={!r.tiller ? 'row-none' : ''}>
 <td>
 <strong>{r.label}</strong>
 <div className="vendor-note">{r.tiller ? r.tiller.name : '(no Tiller match)'}</div>
 </td>
 <td className="num">
 {r.tiller ? formatCurrency(used, true) : '-'}
 </td>
 <td className="num" style={{ color: availColor, fontWeight: 700 }}>
 {avail != null ? formatCurrency(avail, true) : '-'}
 </td>
 <td className="num">
 {limit != null ? formatCurrency(limit, true) : '-'}
 </td>
 <td className="num" style={{ color: availColor, fontWeight: 600 }}>
 {pct != null ? (pct * 100).toFixed(1) + '%' : '-'}
 </td>
 <td className="vendor-note">{r.tiller?.lastStatementClose ?? '-'}</td>
 <td className="vendor-note">{r.tiller?.nextPayment ?? '-'}</td>
 <td className="vendor-note">{r.tiller?.nextClosing ?? '-'}</td>
 </tr>
 );
 })}
 {(() => {
 const totUsed = ccBusinessRows.reduce((s, r) => s + (r.tiller ? Math.abs(r.tiller.balance) : 0), 0);
 const totLimit = ccBusinessRows.reduce((s, r) => s + (r.tiller?.balanceLimit != null ? Math.abs(r.tiller.balanceLimit) : 0), 0);
 // Available subtotal = Limit − Used (matches the per-row computation above).
 const totAvail = ccBusinessRows.reduce((s, r) => {
 if (!r.tiller) return s;
 const u = Math.abs(r.tiller.balance);
 const l = r.tiller.balanceLimit != null ? Math.abs(r.tiller.balanceLimit) : null;
 return s + (l != null ? l - u : (r.tiller.balanceAvailable != null ? Math.abs(r.tiller.balanceAvailable) : 0));
 }, 0);
 const overallPct = totLimit > 0 ? totUsed / totLimit : null;
 return (
 <tr className="total-row">
 <td>Subtotal: Business Credit Cards</td>
 <td className="num"><strong>{formatCurrency(totUsed, true)}</strong></td>
 <td className="num"><strong>{formatCurrency(totAvail, true)}</strong></td>
 <td className="num"><strong>{formatCurrency(totLimit, true)}</strong></td>
 <td className="num"><strong>{overallPct != null ? (overallPct * 100).toFixed(1) + '%' : '-'}</strong></td>
 <td colSpan={3}></td>
 </tr>
 );
 })()}
 </tbody>
 </table>
 </div>
 </div>

 {/* SECTION 3 - Intercompany clearing (computed live from sales+expense sheets) */}
 <div className="section" data-cfo-anchor="intercompany">
 <div className="section-head">
 <div>
 <div className="section-title">3. Intercompany</div>
 <div className="section-sub">
 Computed live · Sales{' '}
 {clearing && <a href={clearing.sheetUrl} target="_blank" rel="noreferrer">(AR tab)</a>}{' '}
 minus Expense{' '}
 {clearing && <a href={clearing.expenseSheetUrl} target="_blank" rel="noreferrer">(Expenses tab)</a>}
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <tbody>
 <tr>
 <td>Sales - Total Collected (I2)</td>
 <td className="num">{clearing ? formatCurrency(clearing.sales.i2, true) : '-'}</td>
 <td className="vendor-note">Column I row 2 of AR sheet</td>
 </tr>
 <tr>
 <td>Less: Open AR baseline (I1)</td>
 <td className="num" style={{ color: 'var(--danger)' }}>
 {clearing ? `−${formatCurrency(clearing.sales.i1, true)}` : '-'}
 </td>
 <td className="vendor-note">Column I row 1 of AR sheet</td>
 </tr>
 <tr>
 <td>Net Sales (I2 − I1)</td>
 <td className="num">{clearing ? formatCurrency(clearing.sales.net, true) : '-'}</td>
 <td className="vendor-note"></td>
 </tr>
 <tr>
 <td>Less: Total Expenses (Expenses!F2)</td>
 <td className="num" style={{ color: 'var(--danger)' }}>
 {clearing ? `−${formatCurrency(clearing.expense.total, true)}` : '-'}
 </td>
 <td className="vendor-note">From Expenses tab</td>
 </tr>
 <tr className="total-row">
 <td>Intercompany clearing balance</td>
 <td className="num">
 <strong>{clearing ? formatCurrency(clearing.clearing, true) : 'loading…'}</strong>
 </td>
 <td className="vendor-note">
 {clearing && clearing.clearing < 0
 ? 'Working capital cushion - more paid out on behalf than collected'
 : clearing
 ? 'Net receivable'
 : ''}
 </td>
 </tr>
 <tr>
 <td>Expected remittance (Week 1 lump sum)</td>
 <td className="num">-</td>
 <td className="vendor-note"></td>
 </tr>
 </tbody>
 </table>
 </div>
 {clearing && clearing.warnings.length > 0 && (
 <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
 {clearing.warnings.map((w, i) => <div key={i} className="vendor-note" style={{ color: '#ffc966' }}>· {w}</div>)}
 </div>
 )}
 </div>

 {/* SECTION 4 - Accounts Receivable (live, lender layout) */}
 {batchAr ? (
 <div className="section" data-cfo-anchor="accounts-receivable">
 <div className="section-head">
 <div>
 <div className="section-title">4. Accounts Receivable</div>
 <div className="section-sub">
 Live from Sales / Batches sheet · <strong>{batchAr.totals.openCount}</strong> pending batch invoices ·{' '}
 payments checked against the Invoice Tracker - <strong style={{ color: '#059669' }}>{formatCurrency(batchAr.totals.receivedOnOpen, true)}</strong> received
 {batchAr.totals.underpaidCount > 0 && <>, <strong style={{ color: '#b91c1c' }}>{batchAr.totals.underpaidCount} underpaid</strong></>} ·{' '}
 <a href={batchAr.sheetUrl} target="_blank" rel="noreferrer">open sheet</a>
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Period</th>
 <th>Description</th>
 <th>Invoice #</th>
 <th className="num">Billed</th>
 <th className="num">Received</th>
 <th>Status</th>
 </tr>
 </thead>
 <tbody>
 {batchAr.pendingInvoices.map((inv, idx) => {
 const ps = inv.paymentStatus ?? 'pending';
 const received = inv.receivedAmount ?? 0;
 const pill = ps === 'paid'
 ? { cls: 'tag-ok', label: 'Paid' }
 : ps === 'underpaid'
 ? { cls: 'tag-none', label: `Underpaid −${formatCurrency(inv.shortfall ?? 0, true)}` }
 : { cls: 'tag-warn', label: 'Pending' };
 return (
 <tr key={(inv.invoiceNumber || inv.description) + idx}>
 <td><strong>{inv.period}</strong></td>
 <td>
 <div>{inv.description}</div>
 {inv.comment && <div className="vendor-note">{inv.comment}</div>}
 </td>
 <td className="vendor-note">{inv.invoiceNumber || '-'}</td>
 <td className="num"><strong>{formatCurrency(inv.amount, true)}</strong></td>
 <td className="num">
 {received > 0
 ? <strong style={{ color: '#059669' }}>{formatCurrency(received, true)}</strong>
 : <span className="vendor-note">-</span>}
 </td>
 <td><span className={`pill-tag ${pill.cls}`}>{pill.label}</span></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td colSpan={3}>TOTAL AR (Gross)</td>
 <td className="num"><strong>{formatCurrency(batchAr.totals.open, true)}</strong></td>
 <td className="num"><strong style={{ color: '#059669' }}>{formatCurrency(batchAr.totals.receivedOnOpen, true)}</strong></td>
 <td></td>
 </tr>
 <tr>
 <td colSpan={3}>Less: already received (per Invoice Tracker)</td>
 <td className="num">−{formatCurrency(batchAr.totals.receivedOnOpen, true)}</td>
 <td></td>
 <td></td>
 </tr>
 <tr className="total-row">
 <td colSpan={3}>NET STILL TO COLLECT</td>
 <td className="num"><strong>{formatCurrency(Math.max(0, batchAr.totals.open - batchAr.totals.receivedOnOpen), true)}</strong></td>
 <td></td>
 <td></td>
 </tr>
 </tbody>
 </table>
 </div>
 {ar && (
 <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
 <details>
 <summary className="vendor-note" style={{ cursor: 'pointer' }}>
 Other AR - {ar.totals.openInvoiceCount} invoices, {formatCurrency(ar.totals.open, true)}{' '}
 <span style={{ color: 'var(--muted)' }}>(click to view)</span>
 </summary>
 <div style={{ marginTop: 10, maxHeight: 300, overflowY: 'auto' }}>
 <table className="data-table">
 <thead>
 <tr>
 <th>Customer</th>
 <th className="num">Open</th>
 <th className="num">Invoices</th>
 <th>Oldest</th>
 </tr>
 </thead>
 <tbody>
 {(showAllAr ? ar.byCustomer : ar.byCustomer.slice(0, 10)).map((c) => (
 <tr key={c.customer}>
 <td>{c.customer}</td>
 <td className="num">{formatCurrency(c.openBalance, true)}</td>
 <td className="num">{c.openInvoices}</td>
 <td className="vendor-note">{c.oldestDate}</td>
 </tr>
 ))}
 {!showAllAr && ar.byCustomer.length > 10 && (
 <tr>
 <td colSpan={4} style={{ textAlign: 'center', padding: 8 }}>
 <button className="btn ghost" onClick={() => setShowAllAr(true)}>
 Show all {ar.byCustomer.length}
 </button>
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </details>
 </div>
 )}
 </div>
 ) : (
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">4. Accounts Receivable</div>
 <div className="section-sub">Loading from sheet…</div>
 </div>
 </div>
 </div>
 )}

 {/* SECTION 5 - Net Liquidity Position */}
 <div className="section" data-cfo-anchor="net-liquidity">
 <div className="section-head">
 <div>
 <div className="section-title">5. Net Liquidity Position</div>
 <div className="section-sub">Computed live from sections 1, 2, 3, 4.</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <tbody>
 <tr>
 <td>Total Cash on Hand</td>
 <td className="num">{formatCurrency(cashTotalLive, true)}</td>
 </tr>
 <tr>
 <td>Less: Business Credit Card Debt</td>
 <td className="num" style={{ color: 'var(--danger)' }}>−{formatCurrency(ccBusinessTotal, true)}</td>
 </tr>
 <tr>
 <td>Add: Clearing balance</td>
 <td className="num" style={{ color: (clearing?.clearing ?? 0) < 0 ? 'var(--danger)' : undefined }}>
 {clearing ? formatCurrency(clearing.clearing, true) : '-'}
 </td>
 </tr>
 <tr>
 <td>
 Add: Net Collectible AR
 <div className="vendor-note">billed − received</div>
 </td>
 <td className="num">{batchAr ? formatCurrency(netCollectibleAr, true) : '-'}</td>
 </tr>
 <tr className="total-row" style={{ fontSize: 16 }}>
 <td>NET WORKING CAPITAL POSITION</td>
 <td className="num">
 <strong>{formatCurrency(netWorkingCapital, true)}</strong>
 </td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}
