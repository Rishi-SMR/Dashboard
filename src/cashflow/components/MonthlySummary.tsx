import { useEffect, useState } from 'react';
import {
 ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { fetchMonthlyOpex, fetchMappedExpenses, type MonthlyOpexResult, type MappedExpensesResult } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const POLL_INTERVAL_MS = 30_000;

// Expense heads + colours - SAME palette as the 13-Week cashflow chart, so the
// colour-coding means the same thing across the app.
const OPEX_HEADS: { key: string; color: string; rx: RegExp | null }[] = [
 { key: 'Payroll', color: '#dc2626', rx: /^payroll/i },
 { key: 'Inventory & Raw Materials', color: '#16a34a', rx: /inventory & raw materials/i },
 { key: 'COGS', color: '#f59e0b', rx: /^cogs\b/i },
 { key: 'Rent', color: '#0891b2', rx: /rent|building lease/i },
 { key: 'Software & Subscriptions', color: '#8b5cf6', rx: /software & subscriptions/i },
 { key: 'Other Expenses', color: '#64748b', rx: null }, // catch-all
];
function headFor(category: string): string {
 for (const h of OPEX_HEADS) if (h.rx && h.rx.test(category)) return h.key;
 return 'Other Expenses';
}

/** Tooltip that shows ONLY the segment the cursor is on (not the whole stack). */
function oneSegTip(activeKey: string | null) {
 return ({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: string }) => {
 if (!active || !payload || payload.length === 0) return null;
 const item = (activeKey ? payload.find((p) => p.dataKey === activeKey) : null) ?? payload[payload.length - 1];
 if (!item) return null;
 const color = (item.color ?? item.fill ?? item.stroke) as string | undefined;
 return (
 <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 13 }}>
 <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
 <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
 <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
 <span>{String(item.name)}: <strong>{formatCurrency(Number(item.value))}</strong></span>
 </div>
 </div>
 );
 };
}

export function MonthlySummary() {
 const [data, setData] = useState<MonthlyOpexResult | null>(null);
 const [mapped, setMapped] = useState<MappedExpensesResult | null>(null);
 const [activeKey, setActiveKey] = useState<string | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const [opex, me] = await Promise.all([
 fetchMonthlyOpex({ refresh }),
 fetchMappedExpenses('Combined').catch(() => null),
 ]);
 setData(opex);
 if (me) setMapped(me);
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
 }, []);

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Monthly Expense Summary</h1>
 <div className="page-sub">Loading…</div>
 </div>
 </div>
 </>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Monthly Expense Summary</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { rows, totals, averages } = data;
 const periodStart = rows[0]?.monthLabel ?? '-';
 const periodEnd = rows[rows.length - 1]?.monthLabel ?? '-';

 // Category-stacked chart data: group the mapped expense categories into the
 // same OpEx heads (and colours) the 13-Week cashflow uses, per month.
 const catChart = (mapped?.monthLabels ?? []).map((label, i) => {
 const row: Record<string, number | string> = { month: label };
 for (const h of OPEX_HEADS) row[h.key] = 0;
 for (const r of (mapped?.rows ?? [])) {
 const head = headFor(r.category);
 row[head] = (row[head] as number) + Math.max(0, r.values[i] ?? 0);
 }
 return row;
 });

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Monthly Expense Summary</h1>
 <div className="page-sub">
 Source: QB expense detail (per entity) + Settlement History · {periodStart} – {periodEnd}
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Visual chart - category-coloured (same palette as the 13-Week cashflow), on top. */}
 <CollapsibleSection
 defaultOpen
 title="Visual: Monthly OpEx by category"
 sub="Stacked by expense head, same colours as the 13-Week cashflow. Hover a bar to see the head + amount."
 >
 {catChart.length === 0 ? (
 <div style={{ padding: 18, color: 'var(--muted)' }}>No category data</div>
 ) : (
 <div style={{ width: '100%', height: 360, padding: '0 12px 16px' }}>
 <ResponsiveContainer>
 <BarChart data={catChart} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
 <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
 <XAxis dataKey="month" stroke="var(--muted)" style={{ fontSize: 11 }} />
 <YAxis stroke="var(--muted)" style={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
 <Tooltip cursor={{ fill: 'transparent' }} content={oneSegTip(activeKey)} />
 <Legend />
 {OPEX_HEADS.map((h) => (
 <Bar key={h.key} dataKey={h.key} stackId="opex" fill={h.color} maxBarSize={40} onMouseEnter={() => setActiveKey(h.key)} />
 ))}
 </BarChart>
 </ResponsiveContainer>
 </div>
 )}
 </CollapsibleSection>

 {/* Monthly detail table */}
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Monthly Detail</div>
 <div className="section-sub">Live from QB · all months since Jan 2025.</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Month</th>
 <th className="num">Direct OpEx</th>
 <th className="num">Clearing OpEx</th>
 <th className="num">TOTAL OpEx</th>
 <th className="num">Direct %</th>
 <th className="num">Clearing %</th>
 <th className="num">Remitted</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.monthKey}>
 <td><strong>{r.monthLabel}</strong></td>
 <td className="num">{formatCurrency(r.ltDirect)}</td>
 <td className="num">{formatCurrency(r.purex)}</td>
 <td className="num"><strong>{formatCurrency(r.total)}</strong></td>
 <td className="num">{(r.ltPct * 100).toFixed(1)}%</td>
 <td className="num">{(r.purexPct * 100).toFixed(1)}%</td>
 <td className="num" style={{ color: '#059669' }}>{r.remitted ? formatCurrency(r.remitted) : '-'}</td>
 </tr>
 ))}
 <tr className="total-row">
 <td>TOTAL</td>
 <td className="num"><strong>{formatCurrency(totals.ltDirect)}</strong></td>
 <td className="num"><strong>{formatCurrency(totals.purex)}</strong></td>
 <td className="num"><strong>{formatCurrency(totals.total)}</strong></td>
 <td className="num"><strong>{(totals.ltPct * 100).toFixed(1)}%</strong></td>
 <td className="num"><strong>{(totals.purexPct * 100).toFixed(1)}%</strong></td>
 <td className="num" style={{ color: '#059669' }}><strong>{formatCurrency(totals.remitted)}</strong></td>
 </tr>
 <tr className="total-row">
 <td>AVG / Month</td>
 <td className="num">{formatCurrency(averages.ltDirect)}</td>
 <td className="num">{formatCurrency(averages.purex)}</td>
 <td className="num"><strong>{formatCurrency(averages.total)}</strong></td>
 <td className="num">{(totals.ltPct * 100).toFixed(1)}%</td>
 <td className="num">{(totals.purexPct * 100).toFixed(1)}%</td>
 <td className="num" style={{ color: '#059669' }}>{formatCurrency(averages.remitted)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 </>
 );
}
