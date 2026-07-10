import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCommission, setCommissionOverride, setCommissionRepOverride, type CommissionResult, type CommissionType, type CommissionInvoice } from '../api';
// Info-tip button (plain JSX, only depends on react).
import InfoTip from './InfoTip.jsx';

const REP_OPTIONS = ['Manny', 'Dave', 'Johan', 'Joe P', 'Ken'];
import { formatCurrency } from '../format';

const cleanCust = (s: string) => s.trim();
const POLL_MS = 60_000;

// Per-rep colour palette [base, deep] - drives the colourful KPI cards and the
// drill-modal header. Any rep not listed (e.g. "Unattributed") gets slate.
const REP_COLORS: Record<string, [string, string]> = {
 Manny: ['#6366f1', '#4f46e5'],
 Dave: ['#10b981', '#059669'],
 Johan: ['#f59e0b', '#d97706'],
 'Joe P': ['#f43f5e', '#e11d48'],
 Ken: ['#06b6d4', '#0891b2'],
};
const repColor = (rep: string): [string, string] => REP_COLORS[rep] ?? ['#64748b', '#475569'];

export function Commission() {
 const [data, setData] = useState<CommissionResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [silentRefreshing, setSilentRefreshing] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [selectedRep, setSelectedRep] = useState<string | null>(null);
 const lastFetchedRef = useRef<number>(0);

 async function load(silent = false) {
   if (silent) setSilentRefreshing(true);
   else setLoading(true);
   setError(null);
   try {
     setData(await fetchCommission());
     lastFetchedRef.current = Date.now();
   } catch (e) {
     if (!silent) setError(e instanceof Error ? e.message : 'Failed');
   } finally {
     if (silent) setSilentRefreshing(false);
     else setLoading(false);
   }
 }

 useEffect(() => {
   load();
   const poll = window.setInterval(() => load(true), POLL_MS);
   const onFocus = () => { if (Date.now() - lastFetchedRef.current > 10_000) load(true); };
   const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
   window.addEventListener('focus', onFocus);
   document.addEventListener('visibilitychange', onVisibility);
   return () => {
     window.clearInterval(poll);
     window.removeEventListener('focus', onFocus);
     document.removeEventListener('visibilitychange', onVisibility);
   };
 }, []);

 // Close the drill modal on Escape.
 useEffect(() => {
   if (!selectedRep) return;
   const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedRep(null); };
   window.addEventListener('keydown', onKey);
   return () => window.removeEventListener('keydown', onKey);
 }, [selectedRep]);

 if (loading && !data) return (
   <div className="page-head"><h1 className="page-title">Commission</h1><div className="page-sub">Loading per-rep workbooks + commission sheet…</div></div>
 );
 if (error) return (<>
   <div className="page-head"><h1 className="page-title">Commission</h1></div>
   <div className="error">{error}</div>
   <button className="btn ghost" onClick={() => load()}>Retry</button>
 </>);
 if (!data) return null;

 const { rules, reps, totals } = data;
 const selected = selectedRep ? reps.find((r) => r.rep === selectedRep) : null;

 return (
   <div className="commission-tab">
     <div className="cm-page-head">
       <div>
         <h1 className="page-title">
           Commission
           <span
             className="cm-live-dot"
             title={silentRefreshing ? 'Re-fetching…' : `Auto-refreshes every ${POLL_MS / 1000}s`}
             style={{
               background: silentRefreshing ? '#eab308' : '#059669',
               boxShadow: silentRefreshing ? '0 0 0 4px rgba(234,179,8,0.18)' : '0 0 0 4px rgba(5,150,105,0.18)',
             }}
           />
           {silentRefreshing && <span className="cm-refreshing">refreshing…</span>}
           <InfoTip
             style={{ position: 'static', top: 'auto', right: 'auto', marginLeft: 10, display: 'inline-flex', verticalAlign: 'middle' }}
             title="Commission"
             purpose="Sales commission owed per rep, calculated from paid invoices in the consolidated commission workbook."
             detail="For each paid invoice the net basis = Invoice minus Tax, Shipping, Credit and Fee, then the rate is applied by business type: NEW (gap over the threshold), OLD (gap within the threshold), or WHITELABEL. Per-rep totals are the sum across their paid invoices; house sales are excluded and only PAID invoices count. Example: a rep on 5% with $200,000 of net new business earns $10,000."
             source="Consolidated commission workbook (Calculation tab)."
           />
         </h1>
         <div className="cm-rules">
           <span className="cm-rule-chip">Net = Inv − Tax − Ship − Credit − Fee</span>
           <span className="cm-rule-chip cm-rule-new">NEW {(rules.newRate * 100).toFixed(0)}% · gap &gt; {rules.newOldThresholdDays}d</span>
           <span className="cm-rule-chip cm-rule-old">OLD {(rules.oldRate * 100).toFixed(0)}% · gap ≤ {rules.newOldThresholdDays}d</span>
           <span className="cm-rule-chip cm-rule-wl">WHITELABEL {(rules.whitelabelRate * 100).toFixed(0)}%</span>
           <span className="cm-rule-chip cm-rule-muted">House sales excluded</span>
           <span className="cm-rule-chip cm-rule-muted">PAID only</span>
         </div>
       </div>
       <button className="btn ghost" onClick={() => load(false)} disabled={loading}>↻ Refresh now</button>
     </div>

     {/* === Per-rep KPI cards (colourful · click to pop up the drill) === */}
     <div className="kpis">
       {reps.map((r) => {
         const isActive = selectedRep === r.rep;
         const [c1, c2] = repColor(r.rep);
         return (
           <div
             key={r.rep}
             className={`kpi cm-kpi ${isActive ? 'is-active' : ''}`}
             style={{ cursor: 'pointer', ['--cm-accent' as any]: c1, ['--cm-accent-2' as any]: c2 }}
             onClick={() => setSelectedRep(r.rep)}
             title={`Open ${r.rep}'s breakdown`}
           >
             <InfoTip
               title={`${r.rep} - commission`}
               purpose={`${r.rep}'s total commission earned from paid invoices.`}
               detail={`Sum of the commission on every paid invoice attributed to ${r.rep}: each invoice's net (Invoice minus Tax, Shipping, Credit, Fee) times its rate (NEW 5%, OLD 2% or WHITELABEL 1%). Shows their paid-invoice count and share of the team total; click the card to drill into months and invoices. Example: $200,000 of net new business at 5% = $10,000.`}
               source="Consolidated commission workbook (Calculation tab)."
             />
             <div className="kpi-label">{r.rep}</div>
             <div className="kpi-period">{r.invoiceCount} paid · {r.shareOfTotalPct.toFixed(1)}% share</div>
             <div className="kpi-value" style={{ color: isActive ? '#fff' : c1 }}>{formatCurrency(r.totalCommission)}</div>
           </div>
         );
       })}
       <div className="kpi cm-kpi cm-total is-active" style={{ ['--cm-accent' as any]: '#15803d', ['--cm-accent-2' as any]: '#166534' }}>
         <InfoTip
           title="Total commission"
           purpose="The whole team's commission across every paid invoice."
           detail="Sum of all reps' commission on paid invoices, with the total paid-invoice count; the sub-line breaks out commission earned year-to-date and in the current month. Example: five reps earning $10K, $8K, $6K, $4K and $2K total $30,000."
           source="Consolidated commission workbook (Calculation tab)."
         />
         <div className="kpi-label">TOTAL</div>
         <div className="kpi-period">{totals.grandTotalInvoiceCount} paid invoices</div>
         <div className="kpi-value" style={{ color: '#fff' }}>{formatCurrency(totals.grandTotalCommission)}</div>
         <div className="kpi-sub">YTD {formatCurrency(totals.commissionYtd)} · this mo {formatCurrency(totals.commissionThisMonth)}</div>
       </div>
     </div>

     {/* === Top-level month × rep grid (paid-month basis) === */}
     <MonthRepGrid data={data} onPickRep={(r) => setSelectedRep(r)} selectedRep={selectedRep} />

     {/* === Per-rep drill: now a pop-up modal === */}
     {selected && (
       <RepDrillModal rep={selected} invoices={data.invoices} onClose={() => setSelectedRep(null)} onChange={() => load(true)} />
     )}
   </div>
 );
}

/** Pop-up modal wrapping the per-rep monthly drill. Closes on backdrop click,
 *  the × button, or Escape (handled by the parent). */
function RepDrillModal({ rep, invoices, onClose, onChange }: {
 rep: CommissionResult['reps'][number]; invoices: CommissionInvoice[]; onClose: () => void; onChange: () => void;
}) {
 const [c1, c2] = repColor(rep.rep);
 return (
   <div className="cm-modal-backdrop" onClick={onClose}>
     <div
       className="cm-modal"
       style={{ ['--cm-accent' as any]: c1, ['--cm-accent-2' as any]: c2 }}
       onClick={(e) => e.stopPropagation()}
     >
       <div className="cm-modal-head">
         <div className="cm-head-left">
           <span className="cm-rep-dot" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }} />
           <div>
             <div className="cm-title">{rep.rep}</div>
             <div className="cm-sub">
               {rep.invoiceCount} paid invoices · {formatCurrency(rep.totalCommission)} commission · {rep.shareOfTotalPct.toFixed(1)}% of team
             </div>
           </div>
         </div>
         <button className="cm-modal-close" onClick={onClose} title="Close (Esc)">×</button>
       </div>
       <div className="cm-modal-body">
         <RepMonthlyDrill rep={rep} invoices={invoices} onChange={onChange} />
       </div>
     </div>
   </div>
 );
}

/** Top-level grid: row = rep, column = paid month. Shows the team's commission
 *  payout cadence at a glance. */
function MonthRepGrid({ data, onPickRep, selectedRep }: {
 data: CommissionResult; onPickRep: (rep: string) => void; selectedRep: string | null;
}) {
 const { months, reps, totals } = data;
 // Group months by year for header.
 const years = useMemo(() => {
   const m: Record<string, number[]> = {};
   months.forEach((mo, i) => { const y = mo.ym.split('-')[0]; (m[y] ??= []).push(i); });
   return m;
 }, [months]);
 return (
   <div className="section">
     <InfoTip
       title="Commission by paid month"
       purpose="Each rep's commission laid out month by month, so you can see the payout cadence at a glance."
       detail="Rows are reps, columns are months, bucketed by the month an invoice was PAID (when the rep gets credited), not when it was issued. Each cell is that rep's commission earned that month with its invoice count; the Total column and bottom row sum across. Click a rep row to drill in. Example: a rep paid on $80,000 of net OLD business in March shows $1,600 under Mar."
       source="Consolidated commission workbook (Calculation tab)."
     />
     <div className="section-head">
       <div>
         <div className="section-title">Commission by paid month · rep × month</div>
         <div className="section-sub">
           Bucketed by <strong>paid month</strong> (when the team gets credited) - not invoice issue. Click a rep row to drill in.
         </div>
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 11 }}>
         <thead>
           <tr>
             <th rowSpan={2}>Rep</th>
             {Object.entries(years).map(([y, idxs]) => (
               <th key={y} colSpan={idxs.length} className="num" style={{ textAlign: 'center', borderBottom: '1px solid var(--border)' }}>{y}</th>
             ))}
             <th rowSpan={2} className="num">Total</th>
             <th rowSpan={2} className="num">Inv</th>
           </tr>
           <tr>
             {months.map((m) => (
               <th key={m.ym} className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>{m.label.split(' ')[0]}</th>
             ))}
           </tr>
         </thead>
         <tbody>
           {reps.map((r) => {
             const isActive = selectedRep === r.rep;
             return (
               <tr
                 key={r.rep}
                 onClick={() => onPickRep(r.rep)}
                 style={{ cursor: 'pointer', background: isActive ? 'var(--accent-soft, #e6f4ef)' : undefined }}
               >
                 <td>
                   <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, background: repColor(r.rep)[0], marginRight: 7, verticalAlign: 'middle' }} />
                   <strong>{r.rep}</strong>
                 </td>
                 {r.monthly.map((m, i) => (
                   <td key={i} className="num">
                     {m.commission > 0 ? (
                       <>
                         <div>{formatCurrency(m.commission)}</div>
                         <div style={{ fontSize: 9, color: 'var(--muted)' }}>{m.invoiceCount} inv</div>
                       </>
                     ) : <span style={{ color: 'var(--muted)' }}>-</span>}
                   </td>
                 ))}
                 <td className="num"><strong>{formatCurrency(r.totalCommission)}</strong></td>
                 <td className="num">{r.invoiceCount}</td>
               </tr>
             );
           })}
           <tr className="total-row">
             <td>TOTAL</td>
             {totals.monthly.map((v, i) => (
               <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
             ))}
             <td className="num"><strong>{formatCurrency(totals.grandTotalCommission)}</strong></td>
             <td className="num">{totals.grandTotalInvoiceCount}</td>
           </tr>
         </tbody>
       </table>
     </div>
   </div>
 );
}

/** Per-rep drill: yearly summary on top + monthly breakdown + grouped
 *  invoice-by-invoice table with the full 22-col detail. */
function RepMonthlyDrill({ rep, invoices, onChange }: {
 rep: CommissionResult['reps'][number]; invoices: CommissionInvoice[]; onChange: () => void;
}) {
 const repInvoices = useMemo(() => invoices.filter((i) => i.rep === rep.rep).sort((a, b) => b.paidDate.localeCompare(a.paidDate)), [invoices, rep.rep]);
 // Two-level drill: null = overview (yearly + monthly tables); a ym opens that
 // month's invoice-level detail, '__ALL__' opens every invoice.
 const [view, setView] = useState<string | null>(null);

 if (view) {
   const isAll = view === '__ALL__';
   const monthLabel = isAll ? null : (rep.monthly.find((m) => m.ym === view)?.label ?? view);
   const shown = isAll ? repInvoices : repInvoices.filter((i) => i.paidMonth === view);
   return (
     <>
       <button className="btn ghost cm-back" onClick={() => setView(null)}>← Back to {rep.rep} overview</button>
       <RepCommissionTable rep={rep.rep} invoices={shown} onChange={onChange} subtitle={monthLabel} />
     </>
   );
 }

 return (
   <>
     {/* Yearly summary */}
     <div className="section">
       <InfoTip
         title={`${rep.rep} - yearly summary`}
         purpose={`${rep.rep}'s commission by year, with year-over-year growth.`}
         detail="For each paid year: total commission earned, the number of invoices behind it, and the percent change versus the prior year (YTD marks a year still in progress). Example: $40,000 this year versus $32,000 last year shows +25%."
         source="Consolidated commission workbook (Calculation tab)."
       />
       <div className="section-head">
         <div>
           <div className="section-title">{rep.rep} · yearly summary</div>
           <div className="section-sub">By paid year · year-over-year growth.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead><tr><th>Year</th><th className="num">Commission</th><th className="num">Invoices</th><th className="num">YoY</th></tr></thead>
           <tbody>
             {rep.yearly.map((y) => {
               const tone = y.yoyPct === null ? 'var(--muted)' : y.yoyPct >= 0 ? '#059669' : 'var(--danger)';
               return (
                 <tr key={y.year}>
                   <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 4, fontSize: 10 }}>YTD</span>}</td>
                   <td className="num"><strong>{formatCurrency(y.commission)}</strong></td>
                   <td className="num">{y.invoiceCount}</td>
                   <td className="num" style={{ color: tone, fontWeight: 600 }}>{y.yoyPct === null ? '-' : `${y.yoyPct >= 0 ? '+' : ''}${y.yoyPct.toFixed(1)}%`}</td>
                 </tr>
               );
             })}
           </tbody>
         </table>
       </div>
     </div>

     {/* Per-month breakdown (matches the Summary tab in their workbooks) */}
     <div className="section">
       <InfoTip
         title={`${rep.rep} - monthly commission`}
         purpose={`${rep.rep}'s commission per month, on a paid-month basis.`}
         detail="One row per month (bucketed by when invoices were PAID, not issued) showing commission earned and the invoice count, totalling at the bottom. Click any month to open its invoice-level details. Example: March shows $1,600 across 4 paid invoices."
         source="Consolidated commission workbook (Calculation tab)."
       />
       <div className="section-head">
         <div>
           <div className="section-title">{rep.rep} · monthly commission (paid month basis)</div>
           <div className="section-sub">New/Old biz = distinct accounts that month (a recurring customer counts once per month). The TOTAL row counts each account once overall, so the monthly figures don't add up to it. Click any month for invoice details.</div>
         </div>
         <button className="btn ghost" onClick={() => setView('__ALL__')} style={{ fontSize: 11 }}>View all {rep.invoiceCount} invoices →</button>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 11 }}>
           <thead>
             <tr>
               <th>Month</th>
               <th className="num">Commission</th>
               <th className="num">Invoices</th>
               <th className="num" title="Distinct NEW-business accounts that month">New biz</th>
               <th className="num" title="Distinct OLD-business accounts that month">Old biz</th>
               <th></th>
             </tr>
           </thead>
           <tbody>
             {rep.monthly.filter((m) => m.commission > 0 || m.invoiceCount > 0).map((m) => {
               return (
                 <tr
                   key={m.ym}
                   className="cm-month-row"
                   onClick={() => setView(m.ym)}
                   style={{ cursor: 'pointer' }}
                 >
                   <td><strong>{m.label}</strong></td>
                   <td className="num"><strong>{formatCurrency(m.commission)}</strong></td>
                   <td className="num">{m.invoiceCount}</td>
                   <td className="num" style={{ color: '#059669', fontWeight: 600 }}>{m.newAccounts || ''}</td>
                   <td className="num" style={{ color: '#64748b', fontWeight: 600 }}>{m.oldAccounts || ''}</td>
                   <td className="num" style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                     View details →
                   </td>
                 </tr>
               );
             })}
             <tr className="total-row">
               <td>TOTAL</td>
               <td className="num"><strong>{formatCurrency(rep.totalCommission)}</strong></td>
               <td className="num">{rep.invoiceCount}</td>
               <td className="num" style={{ color: '#059669', fontWeight: 600 }}>{rep.newBusinessAccounts}</td>
               <td className="num" style={{ color: '#64748b', fontWeight: 600 }}>{rep.oldBusinessAccounts}</td>
               <td></td>
             </tr>
           </tbody>
         </table>
       </div>
     </div>

   </>
 );
}

function RepCommissionTable({ rep, invoices, onChange, subtitle }: {
 rep: string;
 invoices: CommissionInvoice[];
 onChange: () => void;
 subtitle?: string | null;
}) {
 // Caller already filters to this rep + any month filter; sort newest first.
 const repInvoices = useMemo(() => [...invoices].sort((a, b) => b.paidDate.localeCompare(a.paidDate)), [invoices]);
 const totals = useMemo(() => {
   const t = { count: repInvoices.length, invoice: 0, tax: 0, shipping: 0, credit: 0, purex: 0, net: 0, commission: 0, byType: { NEW: 0, OLD: 0, WHITELABEL: 0 } };
   for (const i of repInvoices) {
     t.invoice += i.invoiceAmount; t.tax += i.tax; t.shipping += i.shipping; t.credit += i.credit;
     t.purex += i.pureXFee; t.net += i.netAmount; t.commission += i.commission;
     t.byType[i.commissionType] = (t.byType[i.commissionType] || 0) + i.commission;
   }
   return t;
 }, [repInvoices]);
 return (
   <div className="section">
     <InfoTip
       title={`${rep} - invoice-level commission`}
       purpose="Every paid invoice behind this rep's commission, line by line."
       detail="One row per paid invoice: the amounts deducted to reach Net (Invoice minus Tax, Fee, Shipping, Credit), the order/business type, the rate applied, and the resulting commission (Net x Rate). The order/business-type dropdowns let you reclassify NEW/OLD/WHITELABEL and recalculate; a purple border marks a manual override. Example: a $3,400 net OLD invoice at 2% = $68 commission."
       source="Consolidated commission workbook (Calculation tab)."
     />
     <div className="section-head">
       <div>
         <div className="section-title">{rep} · {totals.count} paid invoices · total commission <strong>{formatCurrency(totals.commission)}</strong>{subtitle && <span className="vendor-note" style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)' }}>· {subtitle}</span>}</div>
         <div className="section-sub">
           Source-of-truth: per-rep workbook ✓ when available · dropdowns change OLD/NEW/WHITELABEL per invoice · auto-recalc · purple border = manual override.
         </div>
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 11 }}>
         <thead>
           <tr>
             <th>Inv #</th>
             <th className="num">Issued</th>
             <th>Customer</th>
             <th className="num">Inv $</th>
             <th>Status</th>
             <th className="num">Paid</th>
             <th className="num">Paid $</th>
             <th>Paid mo</th>
             <th className="num">Tax</th>
             <th className="num">Fee</th>
             <th className="num">Ship</th>
             <th className="num">Net $</th>
             <th>Order type</th>
             <th>Biz type</th>
             <th>Owner</th>
             <th className="num">Rate</th>
             <th className="num">Commission</th>
           </tr>
         </thead>
         <tbody>
           {repInvoices.map((inv) => (
             <CommissionRow key={inv.invoiceNumber + inv.paidDate} inv={inv} onChange={onChange} />
           ))}
           {repInvoices.length === 0 && (
             <tr><td colSpan={17} style={{ textAlign: 'center', color: 'var(--muted)', padding: 18 }}>no paid invoices for {rep}</td></tr>
           )}
           <tr className="total-row">
             <td colSpan={3}>TOTAL · {totals.count} inv</td>
             <td className="num">{formatCurrency(totals.invoice)}</td>
             <td></td><td></td><td></td><td></td>
             <td className="num">{formatCurrency(totals.tax)}</td>
             <td className="num">{formatCurrency(totals.purex)}</td>
             <td className="num">{formatCurrency(totals.shipping)}</td>
             <td className="num">{formatCurrency(totals.net)}</td>
             <td colSpan={4}></td>
             <td className="num"><strong>{formatCurrency(totals.commission)}</strong>
               <div className="vendor-note" style={{ fontSize: 10 }}>N:{formatCurrency(totals.byType.NEW)} · O:{formatCurrency(totals.byType.OLD)} · WL:{formatCurrency(totals.byType.WHITELABEL)}</div>
             </td>
           </tr>
         </tbody>
       </table>
     </div>
   </div>
 );
}

/** "Needs Review" section at the top of the page - shows invoices the system
 *  couldn't fully figure out, so the user can fix them inline. */
function NeedsReviewSection({ invoices, unmappedCount, onChange }: {
 invoices: CommissionInvoice[]; unmappedCount: number; onChange: () => void;
}) {
 const reviewInvoices = useMemo(() => invoices.filter((i) => i.needsReview).slice(0, 50), [invoices]);
 return (
   <div className="section" style={{ background: 'rgba(234, 179, 8, 0.08)', border: '1px solid rgba(234, 179, 8, 0.4)', borderRadius: 6, padding: 12, marginBottom: 16 }}>
     <div className="section-head" style={{ marginBottom: 6 }}>
       <div>
         <div className="section-title" style={{ color: '#a16207' }}>⚠ {reviewInvoices.length} invoices need review</div>
         <div className="section-sub">
           {unmappedCount > 0 && <><strong>{unmappedCount}</strong> have no rep assigned (pick one from the dropdown). </>}
           Rest have fallback Net or marginal NEW/OLD gap. Hover the warning column for the reason.
         </div>
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 11 }}>
         <thead>
           <tr>
             <th>Inv #</th>
             <th>Customer</th>
             <th className="num">Paid</th>
             <th className="num">Net</th>
             <th>Rep</th>
             <th>Type</th>
             <th className="num">Commission</th>
             <th>Issue</th>
           </tr>
         </thead>
         <tbody>
           {reviewInvoices.map((inv) => (
             <CommissionRow key={inv.invoiceNumber + inv.paidDate + '-rev'} inv={inv} onChange={onChange} compact />
           ))}
         </tbody>
       </table>
     </div>
   </div>
 );
}

function CommissionRow({ inv, onChange, compact }: { inv: CommissionInvoice; onChange: () => void; compact?: boolean }) {
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const tone = inv.commissionType === 'NEW' ? '#059669' : inv.commissionType === 'WHITELABEL' ? '#eab308' : '#94a3b8';

 async function changeType(next: CommissionType | null) {
   setSaving(true);
   setError(null);
   try { await setCommissionOverride(inv.invoiceNumber, next); onChange(); }
   catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
   finally { setSaving(false); }
 }
 async function changeRep(next: string | null) {
   setSaving(true);
   setError(null);
   try { await setCommissionRepOverride(inv.invoiceNumber, next); onChange(); }
   catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
   finally { setSaving(false); }
 }

 const wlTone = inv.commissionType === 'WHITELABEL' ? '#fff7e0' : undefined;
 const reviewTone = inv.needsReview && !wlTone ? '#fffbeb' : undefined;
 const rowBg = wlTone ?? reviewTone;
 const isOverride = inv.typeSource === 'override';
 const isRepOverride = inv.repSource === 'override';
 const isUnmapped = inv.repSource === 'unmapped';
 const orderTypeValue = inv.commissionType === 'WHITELABEL' ? 'White label' : 'Regular';

 // Compact mode = the "Needs Review" section (8 columns).
 if (compact) {
   return (
     <tr style={rowBg ? { background: rowBg } : undefined}>
       <td>
         <strong>{inv.invoiceNumber}</strong>
         {inv.needsReview && (
           <span
             title={inv.reviewReasons.join(' · ')}
             style={{ marginLeft: 4, color: '#a16207', fontSize: 12 }}
           >⚠</span>
         )}
       </td>
       <td>{cleanCust(inv.customer)}</td>
       <td className="num vendor-note">{inv.paidDate}</td>
       <td className="num"><strong>{formatCurrency(inv.netAmount)}</strong>{inv.netSource === 'fallback' && <div style={{ fontSize: 9, color: '#eab308' }}>fallback</div>}</td>
       <td>
         <select
           value={isUnmapped ? '' : inv.rep}
           disabled={saving}
           onChange={(e) => changeRep(e.target.value || null)}
           style={{
             padding: '2px 4px', fontSize: 10, borderRadius: 3,
             background: isUnmapped ? '#fee2e2' : '#e0f2fe',
             border: isRepOverride ? '2px solid #6366f1' : isUnmapped ? '2px solid var(--danger)' : '1px solid transparent',
           }}
         >
           {isUnmapped && <option value="">- pick rep -</option>}
           {REP_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
         </select>
       </td>
       <td>
         <select
           value={inv.commissionType}
           disabled={saving}
           onChange={(e) => changeType(e.target.value as CommissionType)}
           style={{
             padding: '2px 4px', fontSize: 10, borderRadius: 3,
             background: tone, color: '#fff',
             border: isOverride ? '2px solid #6366f1' : '1px solid transparent',
           }}
         >
           <option value="NEW">NEW (5%)</option>
           <option value="OLD">OLD (2%)</option>
           <option value="WHITELABEL">WLBL (1%)</option>
         </select>
       </td>
       <td className="num"><strong>{formatCurrency(inv.commission)}</strong></td>
       <td style={{ fontSize: 10, color: 'var(--muted)' }} title={inv.reviewReasons.join('\n')}>
         {inv.reviewReasons[0]?.slice(0, 45)}{inv.reviewReasons.length > 1 ? ` (+${inv.reviewReasons.length - 1})` : ''}
       </td>
     </tr>
   );
 }

 return (
   <tr style={rowBg ? { background: rowBg } : undefined}>
     <td>
       <strong>{inv.invoiceNumber}</strong>
       {inv.needsReview && (
         <span title={inv.reviewReasons.join(' · ')} style={{ marginLeft: 4, color: '#a16207', fontSize: 11 }}>⚠</span>
       )}
     </td>
     <td className="num vendor-note">{inv.invoiceDate}</td>
     <td>{cleanCust(inv.customer)}</td>
     <td className="num">{formatCurrency(inv.invoiceAmount)}</td>
     <td><span className="pill-tag tag-strong" style={{ fontSize: 9 }}>Paid</span></td>
     <td className="num vendor-note">{inv.paidDate}</td>
     <td className="num">{formatCurrency(inv.invoiceAmount)}</td>
     <td className="vendor-note">{inv.paidMonth.split('-')[1]}/{inv.paidMonth.split('-')[0].slice(2)}</td>
     <td className="num">{inv.tax > 0 ? formatCurrency(inv.tax) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
     <td className="num">{inv.pureXFee > 0 ? formatCurrency(inv.pureXFee) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
     <td className="num">{inv.shipping > 0 ? formatCurrency(inv.shipping) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
     <td className="num"><strong>{formatCurrency(inv.netAmount)}</strong>
       {inv.netSource === 'workbook' && <div style={{ fontSize: 9, color: '#059669' }}>✓ workbook</div>}
       {inv.netSource === 'fallback' && <div style={{ fontSize: 9, color: '#eab308' }}>fallback</div>}
     </td>
     <td>
       {/* Order type dropdown: White label vs Regular - toggles WHITELABEL */}
       <select
         value={orderTypeValue}
         disabled={saving}
         onChange={(e) => {
           const next: CommissionType = e.target.value === 'White label' ? 'WHITELABEL' :
             (inv.businessTypeLabel.toLowerCase().includes('new') ? 'NEW' : 'OLD');
           changeType(next);
         }}
         style={{
           padding: '2px 4px', fontSize: 10, borderRadius: 3,
           background: inv.commissionType === 'WHITELABEL' ? '#eab308' : '#e5e7eb',
           color: inv.commissionType === 'WHITELABEL' ? '#fff' : '#000',
           border: isOverride ? '2px solid #6366f1' : '1px solid transparent',
           cursor: saving ? 'wait' : 'pointer',
         }}
       >
         <option value="Regular">Regular</option>
         <option value="White label">White label</option>
       </select>
     </td>
     <td>
       {/* Business type dropdown: New / Old (only meaningful when not WL) */}
       <select
         value={inv.commissionType === 'WHITELABEL' ? '-' : inv.commissionType === 'NEW' ? 'New business' : 'Old Business'}
         disabled={saving || inv.commissionType === 'WHITELABEL'}
         onChange={(e) => changeType(e.target.value === 'New business' ? 'NEW' : 'OLD')}
         style={{
           padding: '2px 4px', fontSize: 10, borderRadius: 3,
           background: inv.commissionType === 'NEW' ? '#059669' : inv.commissionType === 'OLD' ? '#94a3b8' : '#e5e7eb',
           color: '#fff',
           border: isOverride ? '2px solid #6366f1' : '1px solid transparent',
           cursor: saving ? 'wait' : 'pointer',
           opacity: inv.commissionType === 'WHITELABEL' ? 0.4 : 1,
         }}
       >
         {inv.commissionType === 'WHITELABEL' && <option value="-">-</option>}
         <option value="New business">New business</option>
         <option value="Old Business">Old Business</option>
       </select>
       {isOverride && (
         <button
           className="btn ghost"
           onClick={() => changeType(null)}
           disabled={saving}
           style={{ marginLeft: 4, padding: '0 4px', fontSize: 9, height: 16 }}
           title="Revert to auto"
         >×</button>
       )}
       {error && <div style={{ color: 'var(--danger)', fontSize: 9 }}>{error}</div>}
     </td>
     <td>
       <select
         value={isUnmapped ? '' : inv.rep}
         disabled={saving}
         onChange={(e) => changeRep(e.target.value || null)}
         style={{
           padding: '2px 4px', fontSize: 10, borderRadius: 3,
           background: isUnmapped ? '#fee2e2' : (REP_OPTIONS.includes(inv.rep) ? '#e0f2fe' : '#fef3c7'),
           border: isRepOverride ? '2px solid #6366f1' : isUnmapped ? '2px solid var(--danger)' : '1px solid transparent',
         }}
       >
         {isUnmapped && <option value="">- pick -</option>}
         {!isUnmapped && !REP_OPTIONS.includes(inv.rep) && <option value={inv.rep}>{inv.rep}</option>}
         {REP_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
       </select>
       {(inv.isPredicted || inv.needsReview) && <div style={{ fontSize: 9, color: 'var(--muted)' }}>{inv.isPredicted ? 'pred' : ''}{inv.needsReview ? ' ⚠' : ''}</div>}
     </td>
     <td className="num" style={{ color: tone, fontWeight: 600 }}>{(inv.rate * 100).toFixed(0)}%</td>
     <td className="num"><strong>{formatCurrency(inv.commission)}</strong>
       <div style={{ fontSize: 9, color: 'var(--muted)' }}>net × rate</div>
     </td>
   </tr>
 );
}
