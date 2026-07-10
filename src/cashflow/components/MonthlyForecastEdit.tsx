import { useEffect, useMemo, useState } from 'react';
import {
 fetchCashflow13, fetchSalesForecast, fetchCashflowEdits, saveCashflowEdits,
 type Cashflow13, type SalesForecastResult, type CashflowEdits,
} from '../api';
import { formatCurrency } from '../format';

const SALES_RX = /^sales \(this week/i;   // the 13-week gross-sales row
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1] ?? m} ${y}`; };

/**
 * Monthly sales forecast, LINKED to the weekly edit + 13-Week. Each month shows
 * the in-window weeks' sales and their seasonality factor. Editing the factor
 * (1.23 → 1.5) scales that month's weeks and saves them to the shared store -
 * so the weekly table and the 13-Week grid change too. And editing a week makes
 * the factor here recompute. One source of truth: the weekly "Sales" row.
 */
export function MonthlyForecastEdit() {
 const [cf, setCf] = useState<Cashflow13 | null>(null);
 const [fc, setFc] = useState<SalesForecastResult | null>(null);
 const [edits, setEdits] = useState<CashflowEdits>({});
 const [buf, setBuf] = useState<Record<string, string>>({});   // ym -> seasonality input
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [savedAt, setSavedAt] = useState<number | null>(null);

 async function load() {
 setLoading(true); setError(null);
 try {
 const [c, f, e] = await Promise.all([fetchCashflow13({ direction: 'future' }), fetchSalesForecast(), fetchCashflowEdits()]);
 setCf(c); setFc(f); setEdits(e ?? {});
 } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
 finally { setLoading(false); }
 }
 useEffect(() => {
 void load();
 const reload = () => void load();
 window.addEventListener('cashflow-edits-changed', reload);   // linked: weekly / 13-week saved (no focus/poll)
 return () => { window.removeEventListener('cashflow-edits-changed', reload); };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const salesLabel = useMemo(() => cf?.inflows.find((l) => SALES_RX.test(l.label))?.label ?? '', [cf]);
 const seasByYm = useMemo(() => {
 const m: Record<string, number> = {};
 for (const r of fc?.buckets.wholesale.monthlyForecast ?? []) if (r.seasonalIndex && r.seasonalIndex > 0) m[r.ym] = r.seasonalIndex;
 return m;
 }, [fc]);

 // Group the 13-week weeks by month, carrying each week's computed value + base
 // (= computed ÷ original seasonality) so we can rescale + recompute factors.
 const months = useMemo(() => {
 if (!cf) return [];
 const row = cf.inflows.find((l) => SALES_RX.test(l.label));
 const byYm = new Map<string, { ym: string; origSeas: number; weeks: Array<{ key: string; computed: number; base: number }> }>();
 cf.weeks.forEach((w, i) => {
 const ym = w.start.slice(0, 7);
 const origSeas = seasByYm[ym] ?? 1;
 const computed = row?.values[i] ?? 0;
 const g = byYm.get(ym) ?? { ym, origSeas, weeks: [] };
 g.weeks.push({ key: `${salesLabel}|${w.start}`, computed, base: origSeas > 0 ? computed / origSeas : computed });
 byYm.set(ym, g);
 });
 return [...byYm.values()];
 }, [cf, seasByYm, salesLabel]);

 const effOf = (key: string, computed: number) => edits[key]?.value ?? computed;

 const parse = (raw: string): number | null => { const n = Number(raw.replace(/[×x*\s]/g, '')); return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null; };
 const dirty = Object.keys(buf).length > 0;

 async function onSave() {
 setSaving(true); setError(null);
 try {
 const set: Record<string, number> = {};
 for (const [ym, raw] of Object.entries(buf)) {
 const newSeas = parse(raw); if (newSeas == null) continue;
 const mo = months.find((m) => m.ym === ym); if (!mo) continue;
 // Scale each in-window week of this month to base × newSeasonality.
 for (const w of mo.weeks) set[w.key] = +(w.base * newSeas).toFixed(2);
 }
 setEdits(await saveCashflowEdits(set, []));
 setBuf({}); setSavedAt(Date.now());
 } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
 finally { setSaving(false); }
 }

 if (loading && !cf) return <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading monthly forecast…</div>;
 if (error && !cf) return <div className="section"><div className="error">{error}</div></div>;
 if (!cf || months.length === 0) return null;

 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 let totComp = 0, totEff = 0;
 const rows = months.map((mo) => {
 const compSum = mo.weeks.reduce((s, w) => s + w.computed, 0);
 const baseSum = mo.weeks.reduce((s, w) => s + w.base, 0);
 // LIVE preview: while typing a new factor, recompute adjusted sales from it
 // (base × your factor) so the Adjusted + Change columns update instantly.
 const pending = mo.ym in buf ? parse(buf[mo.ym]) : null;
 let effSum: number, effSeas: number;
 if (pending != null) { effSeas = pending; effSum = baseSum * pending; }
 else { effSum = mo.weeks.reduce((s, w) => s + effOf(w.key, w.computed), 0); effSeas = baseSum > 0 ? effSum / baseSum : mo.origSeas; }
 totComp += compSum; totEff += effSum;
 return { ym: mo.ym, compSum, effSum, effSeas, origSeas: mo.origSeas };
 });

 return (
 <div className="section">
 <div className="section-head" style={{ alignItems: 'center' }}>
 <div>
 <div className="section-title">Monthly forecast · edit seasonality (linked)</div>
 <div className="section-sub">
 In-window weeks per month + their seasonality. Edit the factor (1.23 → 1.5) → that month's weeks scale and
 save to the shared store, so the weekly table + 13-Week change too. Editing a week recomputes the factor here.
 </div>
 </div>
 <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
 {savedAt && !dirty && <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
 <button className="btn" onClick={() => void onSave()} disabled={saving || !dirty}>{saving ? 'Saving…' : dirty ? 'Save & apply' : 'Saved'}</button>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead><tr>
 <th>Month</th>
 <th className="num">Computed sales<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>weeks in window</div></th>
 <th className="num" style={{ minWidth: 100 }}>Seasonality</th>
 <th className="num">Adjusted sales</th>
 <th className="num">Change</th>
 </tr></thead>
 <tbody>
 {rows.map((r) => {
 const over = Math.abs(r.effSeas - r.origSeas) > 1e-6 || (r.ym in buf);
 const d = r.effSum - r.compSum;
 const raw = r.ym in buf ? buf[r.ym] : r.effSeas.toFixed(2);
 return (
 <tr key={r.ym} style={over ? { background: 'var(--accent-soft, #ecfdf5)' } : undefined}>
 <td><strong>{monthLabel(r.ym)}</strong></td>
 <td className="num">{fmt0(r.compSum)}</td>
 <td className="num">
 <input type="text" inputMode="decimal" value={raw}
 onFocus={() => setBuf((p) => (r.ym in p ? p : { ...p, [r.ym]: r.effSeas.toFixed(2) }))}
 onChange={(e) => setBuf((p) => ({ ...p, [r.ym]: e.target.value }))}
 style={{ width: 78, textAlign: 'right', padding: '5px 8px', borderRadius: 6, border: `1px solid ${over ? 'var(--accent, #059669)' : 'var(--border)'}`, background: 'var(--bg)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }} />
 </td>
 <td className="num" style={{ fontWeight: over ? 700 : 400, color: over ? 'var(--accent-hover, #047857)' : undefined }}>{fmt0(r.effSum)}</td>
 <td className="num">{Math.round(d) === 0 ? <span style={{ color: 'var(--muted)' }}>—</span> : <span style={{ color: d >= 0 ? '#059669' : 'var(--danger)', fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt0(d)} · {d >= 0 ? '+' : ''}{r.compSum ? Math.round((d / r.compSum) * 100) : 0}%</span>}</td>
 </tr>
 );
 })}
 <tr className="total-row" style={{ fontSize: 14 }}>
 <td><strong>Total</strong></td>
 <td className="num"><strong>{fmt0(totComp)}</strong></td>
 <td></td>
 <td className="num"><strong>{fmt0(totEff)}</strong></td>
 <td className="num">{Math.round(totEff - totComp) === 0 ? <span style={{ color: 'var(--muted)' }}>—</span> : <span style={{ color: totEff >= totComp ? '#059669' : 'var(--danger)', fontWeight: 600 }}>{totEff >= totComp ? '+' : ''}{fmt0(totEff - totComp)}</span>}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 );
}
