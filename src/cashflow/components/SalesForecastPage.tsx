import { useEffect, useState } from 'react';
import {
 ResponsiveContainer, ComposedChart, Bar, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { fetchSalesForecast, fetchSalesWeekInvoices, type SalesForecastResult, type SalesForecastBrand, type SalesWeekInvoicesResponse, type SalesBucket } from '../api';
import { formatCurrency, formatSigned } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR_COLORS = ['#94a3b8', '#2563eb', '#059669', '#f59e0b', '#8b5cf6']; // older → newer

// Single aggregate view. The data layer exposes named buckets, but the
// dashboard renders one default aggregate slice.
const DEFAULT_BUCKET: SalesBucket = 'wholesale';

const SUB_TABS = [
  { key: 'history', label: 'Sales History' },
  { key: 'forecast', label: 'Monthly Sales Forecast' },
  { key: 'weekly', label: 'Upcoming Weeks' },
  { key: 'recent', label: 'Past Weeks' },
] as const;
type SubTab = typeof SUB_TABS[number]['key'];

const POLL_MS = 60_000;


export function SalesForecastPage() {
 const [data, setData] = useState<SalesForecastResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [expandedWeek, setExpandedWeek] = useState<string | null>(null);
 const [weekInvoices, setWeekInvoices] = useState<Record<string, SalesWeekInvoicesResponse>>({});
 const [weekLoading, setWeekLoading] = useState<string | null>(null);
 const [selectedBucket] = useState<SalesBucket>(DEFAULT_BUCKET);
 const [subTab, setSubTab] = useState<SubTab>('history');

 async function toggleWeek(weekStart: string) {
  if (expandedWeek === weekStart) { setExpandedWeek(null); return; }
  setExpandedWeek(weekStart);
  // Cache invoices per week so re-opening a row reuses the fetched drill-down.
  const cacheKey = `${selectedBucket}:${weekStart}`;
  if (!weekInvoices[cacheKey]) {
   setWeekLoading(weekStart);
   try {
    const r = await fetchSalesWeekInvoices(weekStart, selectedBucket);
    setWeekInvoices((p) => ({ ...p, [cacheKey]: r }));
   } catch {
    /* swallow - UI shows pending state */
   } finally {
    setWeekLoading(null);
   }
  }
 }

 async function load(silent = false) {
 if (!silent) { setLoading(true); setError(null); }
 try {
 const d = await fetchSalesForecast();
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load();
 const poll = window.setInterval(() => load(true), POLL_MS);
 const onFocus = () => load(true);
 window.addEventListener('focus', onFocus);
 return () => { window.clearInterval(poll); window.removeEventListener('focus', onFocus); };
 }, []);

 if (loading && !data) {
 return <div className="page-head"><h1 className="page-title">Sales Forecast</h1><div className="page-sub">Computing trends...</div></div>;
 }
 if (error) return <div className="error">{error}</div>;
 if (!data) return null;

 const { driver, lookbackWindow, horizonMonths, weeks, brands, churnedBrands, weeklyInflow, monthlyForecast, totalForecastedSales, totalProjectedCash, globalLagCurve } = data;

 // Projection fields for the selected bucket: deseasonalized base,
 // seasonality, history, and per-week cash.
 const bucket = data.buckets[selectedBucket];
 const yearlyHistory = bucket.yearlyHistory;
 const monthlyHistory = bucket.monthlyHistory;
 const seasonality = bucket.seasonality;
 // Chart data for "Monthly history · seasonality": one point per calendar month,
 // each year's sales as a line + the seasonal index as a bar.
 const seasByIdx: Record<number, number> = {};
 for (const s of seasonality) seasByIdx[s.monthOfYear - 1] = s.index;
 const histByYear: Record<string, (number | null)[]> = {};
 for (const y of yearlyHistory) histByYear[y.year] = new Array(12).fill(null);
 for (const m of monthlyHistory) {
 const yr = m.ym.slice(0, 4); const mi = Number(m.ym.slice(5, 7)) - 1;
 if (histByYear[yr] && mi >= 0 && mi < 12) histByYear[yr][mi] = m.total;
 }
 const seasonChart = MONTH_ABBR.map((mn, i) => {
 const row: Record<string, number | string | null> = { month: mn, seasonality: seasByIdx[i] ?? null };
 for (const y of yearlyHistory) row[y.year] = histByYear[y.year][i];
 return row;
 });
 // Year-over-year chart: total sales (bars) + invoice count (line) per year.
 const yoyChart = yearlyHistory.map((y, i) => {
 const prev = yearlyHistory[i - 1];
 const yoyPct = prev && prev.total > 0 ? ((y.total - prev.total) / prev.total) * 100 : null;
 return { year: y.isPartial ? `${y.year} (YTD)` : y.year, Sales: y.total, Invoices: y.invoiceCount, yoy: yoyPct, partial: !!y.isPartial };
 });
 const yoy = bucket.yoy;
 const weeklyAnalysis = bucket.weeklyAnalysis;
 const monthlyForecastV2 = bucket.monthlyForecast;
 const weeklyInflowV2 = bucket.weeklyInflow;
 const weeklyGrossV2 = bucket.weeklyGross;
 const sameWeekRate = data.sameWeekRate ?? 0;
 const totalForecastedInvoiceV2 = bucket.scenarioTotals.base.invoiced;
 const totalProjectedCashV2 = bucket.scenarioTotals.base.cash;

 void weeklyInflow; void monthlyForecast; void totalForecastedSales; void totalProjectedCash; void horizonMonths; void lookbackWindow; void globalLagCurve; void churnedBrands; // legacy/unused response fields kept for backward compat
 // Peak-cash week is computed from the SELECTED bucket so the KPI matches what
 // the rest of the page is showing.
 const peakWeekIdx = weeklyInflowV2.indexOf(Math.max(...weeklyInflowV2, 0));
 const brandLagCount = brands.filter((b) => b.lagSource === 'brand').length;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Sales Forecast</h1>
 <div className="page-sub">
 Forward-looking projection of cash from invoices NOT yet booked. Anchors on
 the same Monday as the 13-week plan · cadence-driven per-invoice projection
 with growth and month-of-year seasonality · cash routed through each brand's
 collection lag curve.
 </div>
 </div>
 <button className="btn ghost" onClick={() => load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
 </div>

 <div className="page-sub" style={{ marginTop: 8, marginBottom: 12, fontSize: 12 }}>
  {bucket.customerCount} customers · deseasonalized base {formatCurrency(bucket.deseasonalizedBase)}/mo
 </div>

 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">13-week projected cash</div>
 <div className="kpi-period">After collection lag</div>
 <div className="kpi-value">{formatCurrency(totalProjectedCashV2)}</div>
 <div className="kpi-sub">Lender-facing figure (matches cashflow row)</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Total gross forecast</div>
 <div className="kpi-period">Next {monthlyForecastV2.length} months invoiced</div>
 <div className="kpi-value">{formatCurrency(totalForecastedInvoiceV2)}</div>
 <div className="kpi-sub">{monthlyForecastV2[0]?.ym} → {monthlyForecastV2[monthlyForecastV2.length - 1]?.ym}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">YoY trend</div>
 <div className="kpi-period">{yoy.currYearLabel} vs {yoy.prevYearLabel} ({yoy.monthsCompared} months)</div>
 <div className="kpi-value" style={{ color: yoy.rate >= 0 ? '#059669' : 'var(--danger)' }}>{(yoy.rate * 100).toFixed(1)}%</div>
 <div className="kpi-sub">{formatCurrency(yoy.currYTD)} vs {formatCurrency(yoy.prevYTD)}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Peak cash week</div>
 <div className="kpi-period">Wk {peakWeekIdx + 1} · {weeks[peakWeekIdx]?.label}</div>
 <div className="kpi-value">{formatCurrency(weeklyInflowV2[peakWeekIdx] ?? 0)}</div>
 <div className="kpi-sub">{brandLagCount}/{brands.length} brands have own lag curve</div>
 </div>
 </div>

 {/* SUB-TABS */}
 <div className="expenses-tabs" style={{ marginTop: 16, marginBottom: 12 }}>
  {SUB_TABS.map((t) => (
   <button key={t.key} className={`expenses-tab ${subTab === t.key ? 'active' : ''}`} onClick={() => setSubTab(t.key)}>{t.label}</button>
  ))}
 </div>

 {subTab === 'history' && (
 <>
 <div className="section">
  <div className="section-head"><div>
   <div className="section-title">Year-over-year history</div>
   <div className="section-sub">Bars = total sales per year · line = invoice count · 2026 is YTD. Hover for YoY.</div>
  </div></div>
  <div style={{ width: '100%', height: 300, padding: '4px 12px 12px' }}>
   <ResponsiveContainer>
    <ComposedChart data={yoyChart} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
     <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
     <XAxis dataKey="year" stroke="var(--muted)" style={{ fontSize: 12 }} />
     <YAxis yAxisId="left" stroke="var(--muted)" style={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000000).toFixed(1)}M`} width={56} />
     <YAxis yAxisId="right" orientation="right" stroke="var(--muted)" style={{ fontSize: 11 }} width={40} />
     <Tooltip
      contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
      formatter={(v: number, name) => name === 'Invoices' ? [Number(v).toLocaleString(), name] : [formatCurrency(Number(v)), name]}
     />
     <Legend wrapperStyle={{ fontSize: 11 }} />
     <Bar yAxisId="left" dataKey="Sales" name="Total sales" maxBarSize={80}>
      {yoyChart.map((d, i) => <Cell key={i} fill={d.partial ? '#93c5fd' : '#2563eb'} />)}
     </Bar>
     <Line yAxisId="right" type="monotone" dataKey="Invoices" name="Invoices" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
    </ComposedChart>
   </ResponsiveContainer>
  </div>
 </div>

 <CollapsibleSection title="Year-over-year numbers (table)">
  <div className="table-wrap">
   <table className="data-table">
    <thead><tr><th>Year</th><th className="num">Total sales</th><th className="num">Invoices</th><th className="num">Months</th><th className="num">YoY</th></tr></thead>
    <tbody>
    {yearlyHistory.map((y, i) => {
     const prev = yearlyHistory[i - 1];
     const yoyPct = prev && prev.total > 0 ? ((y.total - prev.total) / prev.total) * 100 : null;
     const yoyTone = yoyPct === null ? 'var(--muted)' : yoyPct > 0 ? '#059669' : yoyPct < 0 ? 'var(--danger)' : 'var(--muted)';
     return (
      <tr key={y.year}>
       <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>(YTD)</span>}</td>
       <td className="num"><strong>{formatCurrency(y.total)}</strong></td>
       <td className="num">{y.invoiceCount.toLocaleString()}</td>
       <td className="num">{y.monthsObserved}/12</td>
       <td className="num" style={{ color: yoyTone }}>{yoyPct !== null ? `${yoyPct >= 0 ? '+' : ''}${yoyPct.toFixed(1)}%` : '-'}</td>
      </tr>
     );
    })}
    </tbody>
   </table>
  </div>
 </CollapsibleSection>

 <div className="section">
  <div className="section-head"><div>
   <div className="section-title">Monthly history · seasonality</div>
   <div className="section-sub">Lines = each year's monthly sales · bars = seasonal index (× vs average, 1.00 = avg). Hover a month for details.</div>
  </div></div>
  <div style={{ width: '100%', height: 320, padding: '4px 12px 12px' }}>
   <ResponsiveContainer>
    <ComposedChart data={seasonChart} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
     <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
     <XAxis dataKey="month" stroke="var(--muted)" style={{ fontSize: 11 }} />
     <YAxis yAxisId="left" stroke="var(--muted)" style={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} width={52} />
     <YAxis yAxisId="right" orientation="right" stroke="var(--muted)" style={{ fontSize: 11 }} domain={[0, 'auto']} tickFormatter={(v) => `${Number(v).toFixed(1)}×`} width={40} />
     <Tooltip
      contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
      formatter={(v: number, name) => name === 'Seasonality ×' ? [`${Number(v).toFixed(2)}×`, name] : [formatCurrency(Number(v)), name]}
     />
     <Legend wrapperStyle={{ fontSize: 11 }} />
     <ReferenceLine yAxisId="right" y={1} stroke="#9ca3af" strokeDasharray="4 4" />
     <Bar yAxisId="right" dataKey="seasonality" name="Seasonality ×" maxBarSize={26}>
      {seasonChart.map((d, i) => <Cell key={i} fill={(Number(d.seasonality) || 1) >= 1 ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'} />)}
     </Bar>
     {yearlyHistory.map((y, i) => (
      <Line key={y.year} yAxisId="left" type="monotone" dataKey={y.year} name={y.year} stroke={YEAR_COLORS[i % YEAR_COLORS.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
     ))}
    </ComposedChart>
   </ResponsiveContainer>
  </div>
 </div>

 <CollapsibleSection title="Monthly numbers (table)" sub="The same history + seasonality as a table.">
  <div className="table-wrap">
   <table className="data-table">
    <thead><tr><th>Year</th>{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Total</th></tr></thead>
    <tbody>
    {yearlyHistory.map((y) => {
     const byMonth: number[] = new Array(12).fill(0);
     for (const m of monthlyHistory) { if (m.ym.startsWith(y.year)) { byMonth[Number(m.ym.split('-')[1]) - 1] = m.total; } }
     return (
      <tr key={y.year}>
       <td><strong>{y.year}</strong></td>
       {byMonth.map((v, i) => <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span className="vendor-note">-</span>}</td>)}
       <td className="num"><strong>{formatCurrency(byMonth.reduce((s, v) => s + v, 0))}</strong></td>
      </tr>
     );
    })}
    <tr style={{ background: 'var(--accent-soft, #e6f4ef)' }}>
     <td><strong>Seasonality</strong><div className="vendor-note" style={{ fontSize: 10 }}>{seasonality[0]?.basisYear || '-'}</div></td>
     {seasonality.map((s) => {
      const dev = s.index - 1;
      const tone = Math.abs(dev) < 0.1 ? 'var(--muted)' : dev > 0 ? '#059669' : 'var(--danger)';
      return <td key={s.monthOfYear} className="num" style={{ color: tone, fontWeight: 600 }}>{s.index.toFixed(2)}×</td>;
     })}
     <td className="num vendor-note">1.00×</td>
    </tr>
    </tbody>
   </table>
  </div>
 </CollapsibleSection>
 </>
 )}

 {subTab === 'forecast' && (
 <div className="section">
  <div className="section-head"><div className="section-title">Forecast · next {monthlyForecastV2.length} months</div></div>
  <div className="table-wrap">
   <table className="data-table">
    <thead><tr><th>Month</th><th className="num">Forecast</th><th className="num">Seasonal ×</th></tr></thead>
    <tbody>
    {monthlyForecastV2.map((m) => (
     <tr key={m.ym}>
      <td><strong>{m.ym}</strong></td>
      <td className="num"><strong>{formatCurrency(m.forecastedSales)}</strong></td>
      <td className="num">{m.seasonalIndex !== null ? `${m.seasonalIndex.toFixed(2)}×` : <span className="vendor-note">-</span>}</td>
     </tr>
    ))}
    </tbody>
   </table>
  </div>
 </div>
 )}

 {subTab === 'weekly' && (
 <div className="section">
  <div className="section-head"><div><div className="section-title">Weekly gross sales · next 13 weeks</div><div className="section-sub">Same-week cash = portion of each week's sales paid the SAME week it's invoiced ({(sameWeekRate * 100).toFixed(1)}%, from 2024+ paid history). The rest collects later.</div></div></div>
  <div className="table-wrap">
   <table className="data-table" style={{ fontSize: 12 }}>
    <thead><tr><th>Week</th><th>Wk #</th><th className="num">Seas ×</th><th className="num">Gross sales</th><th className="num">Same-week cash</th></tr></thead>
    <tbody>
    {weeks.map((w, i) => {
     const moIdx = Number(w.start.slice(5, 7)) - 1;
     const sidx = seasonality[moIdx]?.index ?? 1;
     const tone = sidx > 1.15 ? '#059669' : sidx < 0.8 ? 'var(--danger)' : 'var(--muted)';
     const gross = weeklyGrossV2[i] ?? 0;
     const sameWeek = gross * sameWeekRate;
     return (
      <tr key={`fg-${w.start}`}>
       <td>{w.start}</td>
       <td>{i + 1}</td>
       <td className="num" style={{ color: tone, fontWeight: 600 }}>{sidx.toFixed(2)}×</td>
       <td className="num"><strong>{gross > 0 ? formatCurrency(gross) : <span className="vendor-note">-</span>}</strong></td>
       <td className="num" style={{ color: '#059669' }}>{sameWeek > 0 ? formatCurrency(sameWeek) : <span className="vendor-note">-</span>}</td>
      </tr>
     );
    })}
    <tr>
     <td colSpan={3} style={{ fontWeight: 700, paddingTop: 6 }}>Total</td>
     <td className="num" style={{ fontWeight: 700, paddingTop: 6 }}>{formatCurrency(weeklyGrossV2.reduce((s, v) => s + v, 0))}</td>
     <td className="num" style={{ fontWeight: 700, paddingTop: 6, color: '#059669' }}>{formatCurrency(weeklyGrossV2.reduce((s, v) => s + v, 0) * sameWeekRate)}</td>
    </tr>
    </tbody>
   </table>
  </div>
 </div>
 )}

 {subTab === 'recent' && (
 <div className="section">
  <div className="section-head"><div className="section-title">Recent weeks · actual sales</div></div>
  <div className="table-wrap">
   <table className="data-table" style={{ fontSize: 12 }}>
    <thead><tr><th>Week start</th><th>ISO wk</th><th className="num">Sales</th><th className="num">Invoices</th></tr></thead>
    <tbody>
    {weeklyAnalysis.history.slice(-13).map((h) => {
     const isExpanded = expandedWeek === h.weekStart;
     const inv = weekInvoices[`${selectedBucket}:${h.weekStart}`];
     return (
      <>
      <tr key={`h-${h.weekStart}`} style={{ cursor: h.invoiceCount > 0 ? 'pointer' : 'default' }} onClick={() => h.invoiceCount > 0 && toggleWeek(h.weekStart)}>
       <td>{h.invoiceCount > 0 && <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>{isExpanded ? '▾' : '▸'}</span>}{h.weekStart}</td>
       <td>{h.weekOfYear}</td>
       <td className="num"><strong>{formatCurrency(h.total)}</strong></td>
       <td className="num">{h.invoiceCount}</td>
      </tr>
      {isExpanded && (
       <tr key={`h-${h.weekStart}-detail`}>
        <td colSpan={4} style={{ background: 'var(--panel-soft, #f8fbfa)', padding: '10px 16px' }}>
        {weekLoading === h.weekStart && !inv && <span className="vendor-note">Loading invoices…</span>}
        {inv && inv.invoices.length === 0 && <span className="vendor-note">No invoices this week.</span>}
        {inv && inv.invoices.length > 0 && (
         <table style={{ width: '100%', fontSize: 12 }}>
          <thead><tr style={{ color: 'var(--muted)' }}><th style={{ textAlign: 'left' }}>Invoice #</th><th style={{ textAlign: 'left' }}>Date</th><th style={{ textAlign: 'left' }}>Customer</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'left' }}>Paid date</th></tr></thead>
          <tbody>
          {inv.invoices.map((row) => (
           <tr key={row.invoiceNumber}>
            <td style={{ fontFamily: 'monospace' }}>{row.invoiceNumber}</td>
            <td>{row.date}</td>
            <td>{row.customer}</td>
            <td className="num"><strong>{formatCurrency(row.amount)}</strong></td>
            <td className="num">{row.paid > 0 ? formatCurrency(row.paid) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
            <td>{row.paidDate || <span style={{ color: 'var(--muted)' }}>unpaid</span>}</td>
           </tr>
          ))}
          <tr><td colSpan={3} style={{ fontWeight: 600, paddingTop: 6 }}>{inv.invoiceCount} invoices</td><td className="num" style={{ fontWeight: 700, paddingTop: 6 }}>{formatCurrency(inv.total)}</td><td colSpan={2}></td></tr>
          </tbody>
         </table>
        )}
        </td>
       </tr>
      )}
      </>
     );
    })}
    </tbody>
   </table>
  </div>
 </div>
 )}
 </>
 );
}
