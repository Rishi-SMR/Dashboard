import { useEffect, useMemo, useState } from 'react';
import {
 fetchCashflow13, fetchCashflowEdits, saveCashflowEdits,
 fetchPayeeEdits, savePayeeEdits, fetchManualHeads, saveManualHead, removeManualHead,
 type Cashflow13, type CashflowEdits, type PayeeEdits, type ManualHeads,
} from '../api';
import { formatCurrency } from '../format';

/**
 * Editable weekly table for ONE 13-week outflow line (matched by `rowRx`),
 * broken down PER PAYEE (the QB accounts / people that feed the line) PLUS any
 * manual heads the owner adds. Weeks across as columns, one editable row per
 * payee/head, plus Computed-line and Your-line totals.
 *
 * Each payee's computed week = the line's weekly value × that payee's share (so
 * the column sums to the line). Manual heads start at 0 and add on top. Editing
 * any cell writes a per-payee override (cashflow-payee-edits, attributed) AND
 * rolls the new weekly line total up into the shared cashflow-cell-edits store,
 * so the 13-Week grid + dashboard reflect it (and stay in sync both ways).
 */
type PRow = { key: string; amount: number; manual: boolean; details: string };

export function WeeklyRowEdit({ rowRx, heading, sub, hideHeading }: { rowRx: RegExp; heading: string; sub: string; hideHeading?: boolean }) {
 const [data, setData] = useState<Cashflow13 | null>(null);
 const [, setLineEdits] = useState<CashflowEdits>({});
 const [payeeEdits, setPayeeEdits] = useState<PayeeEdits>({});
 const [manualHeads, setManualHeads] = useState<ManualHeads>({});
 const [buf, setBuf] = useState<Record<string, string>>({});
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [savedAt, setSavedAt] = useState<number | null>(null);
 // Add-head form
 const [addOpen, setAddOpen] = useState(false);
 const [aName, setAName] = useState('');
 const [aDetails, setADetails] = useState('');
 const [aAmt, setAAmt] = useState('');

 async function load() {
 setLoading(true); setError(null);
 try {
 const [cf, le, pe, mh] = await Promise.all([fetchCashflow13({ direction: 'future' }), fetchCashflowEdits(), fetchPayeeEdits(), fetchManualHeads()]);
 setData(cf); setLineEdits(le ?? {}); setPayeeEdits(pe ?? {}); setManualHeads(mh ?? {});
 } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load'); }
 finally { setLoading(false); }
 }
 useEffect(() => {
 void load();
 const reload = () => void load();
 window.addEventListener('cashflow-edits-changed', reload);
 return () => { window.removeEventListener('cashflow-edits-changed', reload); };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const allRows = useMemo(() => [...(data?.inflows ?? []), ...(data?.outflows ?? [])], [data]);
 const row = useMemo(() => allRows.find((l) => rowRx.test(l.label)) ?? null, [allRows, rowRx]);
 const label = row?.label ?? '';

 const weeks = useMemo(() => (data?.weeks ?? []).map((w, i) => ({
 i, start: w.start, wk: `Wk ${i + 1}`,
 range: `${w.start.slice(5).replace('-', '/')} – ${w.end.slice(5).replace('-', '/')}`,
 })), [data]);

 const computedPayees = useMemo(() => {
 const bd = (row?.breakdown ?? []).filter((b) => Number.isFinite(b.amount));
 if (bd.length === 0 && row) return [{ label: row.label, amount: 1 }];
 return bd.map((b) => ({ label: b.label, amount: b.amount }));
 }, [row]);
 const sumAmt = useMemo(() => computedPayees.reduce((s, p) => s + (p.amount || 0), 0), [computedPayees]);
 const heads = manualHeads[label] ?? [];

 // Combined rows: QB-computed payees (share of the line) + manual heads (start 0).
 const rows: PRow[] = useMemo(() => ([
 ...computedPayees.map((p) => ({ key: p.label, amount: p.amount, manual: false, details: '' })),
 ...heads.map((h) => ({ key: h.name, amount: 0, manual: true, details: h.details })),
 ]), [computedPayees, heads]);

 const pKey = (payee: string, weekStart: string) => `${label}::${payee}|${weekStart}`;
 const comp = (amount: number, wi: number): number => {
 const lineWk = row?.values[wi] ?? 0;
 return sumAmt > 0 ? lineWk * (amount / sumAmt) : 0;
 };
 const parse = (raw: string): number | null => {
 const n = Number(raw.replace(/[$,\s]/g, ''));
 return raw.trim() !== '' && Number.isFinite(n) ? n : null;
 };
 const eff = (key: string, c: number): number => {
 if (key in buf) { const n = parse(buf[key]); return n ?? c; }
 return payeeEdits[key]?.value ?? c;
 };
 const dirty = Object.keys(buf).length > 0;

 // Sum effective payees per week → line total; clear when it equals computed.
 function buildRollup(rowsList: PRow[], effFn: (k: string, c: number) => number) {
 const lset: Record<string, number> = {}; const lclear: string[] = [];
 for (const w of weeks) {
 let total = 0;
 for (const r of rowsList) total += effFn(pKey(r.key, w.start), comp(r.amount, w.i));
 const lk = `${label}|${w.start}`;
 if (Math.round(total) === Math.round(row?.values[w.i] ?? 0)) lclear.push(lk); else lset[lk] = +total.toFixed(2);
 }
 return { lset, lclear };
 }

 async function onSave() {
 if (!row) return;
 setSaving(true); setError(null);
 try {
 const compByKey: Record<string, number> = {};
 for (const r of rows) for (const w of weeks) compByKey[pKey(r.key, w.start)] = comp(r.amount, w.i);
 const pset: Record<string, number> = {}; const pclear: string[] = [];
 for (const [k, raw] of Object.entries(buf)) {
 if (raw.trim() === '') { pclear.push(k); continue; }
 const n = parse(raw); if (n == null) continue;
 if (Math.round(n) === Math.round(compByKey[k] ?? Number.NaN)) pclear.push(k); else pset[k] = n;
 }
 const nextPayee = await savePayeeEdits(pset, pclear);
 const valueAfter = (k: string, c: number): number => {
 if (k in pset) return pset[k];
 if (pclear.includes(k)) return c;
 return nextPayee[k]?.value ?? c;
 };
 const { lset, lclear } = buildRollup(rows, valueAfter);
 const nextLine = await saveCashflowEdits(lset, lclear);
 setPayeeEdits(nextPayee); setLineEdits(nextLine); setBuf({}); setSavedAt(Date.now());
 } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
 finally { setSaving(false); }
 }

 async function onAddHead() {
 const nm = aName.trim();
 if (!nm) { setError('Head name required'); return; }
 const exists = rows.some((r) => r.key.toLowerCase() === nm.toLowerCase());
 if (exists) { setError(`"${nm}" already exists on this line`); return; }
 setError(null);
 try {
 const next = await saveManualHead(label, nm, aDetails.trim());
 setManualHeads(next);
 // Seed the new head's weekly cells with the entered amount (editable after).
 const amt = parse(aAmt);
 if (amt != null && amt !== 0) {
 setBuf((b) => { const nb = { ...b }; for (const w of weeks) nb[pKey(nm, w.start)] = String(Math.round(amt)); return nb; });
 }
 setAName(''); setADetails(''); setAAmt(''); setAddOpen(false);
 } catch (e) { setError(e instanceof Error ? e.message : 'Add failed'); }
 }

 async function onRemoveHead(name: string) {
 if (!row) return;
 setSaving(true); setError(null);
 try {
 const headKeys = weeks.map((w) => pKey(name, w.start));
 const nextPayee = await savePayeeEdits({}, headKeys); // drop its amounts
 const nextHeads = await removeManualHead(label, name);
 setManualHeads(nextHeads);
 // Recompute the line total without this head.
 const remaining: PRow[] = [
 ...computedPayees.map((p) => ({ key: p.label, amount: p.amount, manual: false, details: '' })),
 ...(nextHeads[label] ?? []).map((h) => ({ key: h.name, amount: 0, manual: true, details: h.details })),
 ];
 const { lset, lclear } = buildRollup(remaining, (k, c) => nextPayee[k]?.value ?? c);
 const nextLine = await saveCashflowEdits(lset, lclear);
 setPayeeEdits(nextPayee); setLineEdits(nextLine);
 setBuf((b) => { const nb = { ...b }; for (const k of headKeys) delete nb[k]; return nb; });
 setSavedAt(Date.now());
 } catch (e) { setError(e instanceof Error ? e.message : 'Remove failed'); }
 finally { setSaving(false); }
 }

 if (loading && !data) return <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading {heading}…</div>;
 if (!row) return <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>{heading}: line not found in the 13-week model.</div>;

 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 const stickyL = { position: 'sticky' as const, left: 0, background: 'var(--surface, #f8fafc)', zIndex: 1 };
 const lineYourTot = weeks.map((w) => rows.reduce((s, r) => s + eff(pKey(r.key, w.start), comp(r.amount, w.i)), 0));
 const lineCompTot = weeks.map((w) => row.values[w.i] ?? 0);
 const grandYour = lineYourTot.reduce((s, v) => s + v, 0);
 const grandComp = lineCompTot.reduce((s, v) => s + v, 0);

 return (
 <div className={hideHeading ? '' : 'section'}>
 <div className="section-head" style={{ alignItems: 'center' }}>
 {!hideHeading && (
 <div>
 <div className="section-title">{heading}</div>
 <div className="section-sub">{sub} · per-payee, editable per week · matches the 13-Week breakdown · saved with your name.</div>
 </div>
 )}
 <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: hideHeading ? 'auto' : undefined }}>
 <button className="btn ghost" onClick={() => { setAddOpen((o) => !o); setError(null); }}>+ Add head</button>
 {savedAt && !dirty && <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
 <button className="btn" onClick={() => void onSave()} disabled={saving || !dirty}>
 {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
 </button>
 </div>
 </div>
 {error && <div className="error" style={{ margin: '0 0 10px' }}>{error}</div>}

 {addOpen && (
 <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px', padding: 10, background: 'var(--surface, #f8fafc)', borderRadius: 8, border: '1px solid var(--border)' }}>
 <input value={aName} onChange={(e) => setAName(e.target.value)} placeholder="Head name (e.g. New Vendor)"
 style={{ padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', minWidth: 180 }} />
 <input value={aDetails} onChange={(e) => setADetails(e.target.value)} placeholder="Details (what is it)"
 style={{ padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', minWidth: 220 }} />
 <input value={aAmt} onChange={(e) => setAAmt(e.target.value)} inputMode="decimal" placeholder="Amt / week (optional)"
 style={{ padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', width: 150, textAlign: 'right' }} />
 <button className="btn" onClick={() => void onAddHead()}>Add</button>
 <button className="btn ghost" onClick={() => { setAddOpen(false); setError(null); }}>Cancel</button>
 <span className="vendor-note">Seeds every week with the amount; edit cells after, then Save.</span>
 </div>
 )}

 <div className="table-wrap">
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>
 <th style={{ ...stickyL, minWidth: 180 }}>Payee / head ({rows.length})</th>
 {weeks.map((w) => (
 <th key={w.start} className="num" style={{ minWidth: 92 }}>{w.wk}<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{w.range}</div></th>
 ))}
 <th className="num" style={{ minWidth: 100 }}>Total</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => {
 let rowTot = 0;
 const cells = weeks.map((w) => {
 const key = pKey(r.key, w.start);
 const c = comp(r.amount, w.i);
 const e = eff(key, c);
 rowTot += e;
 const over = Math.round(e) !== Math.round(c);
 const raw = key in buf ? buf[key] : (payeeEdits[key]?.value != null ? String(Math.round(payeeEdits[key].value)) : '');
 return (
 <td key={key} className="num" style={{ padding: '3px 4px' }}>
 <input
 type="text" inputMode="decimal" value={raw} placeholder={fmt0(c)}
 onFocus={() => setBuf((b) => (key in b ? b : { ...b, [key]: String(Math.round(payeeEdits[key]?.value ?? c)) }))}
 onChange={(ev) => setBuf((b) => ({ ...b, [key]: ev.target.value }))}
 style={{
 width: 80, textAlign: 'right', padding: '4px 6px', borderRadius: 5,
 border: `1px solid ${over ? 'var(--accent, #059669)' : 'var(--border)'}`,
 background: over ? 'var(--accent-soft, #ecfdf5)' : 'var(--bg)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
 }}
 />
 </td>
 );
 });
 return (
 <tr key={r.key}>
 <td style={{ ...stickyL }} title={r.details || r.key}>
 <span>{r.key}</span>
 {r.manual && <span className="pill-tag tag-line" style={{ marginLeft: 6, fontSize: 10 }}>added</span>}
 {r.manual && (
 <button onClick={() => void onRemoveHead(r.key)} title="Remove head"
 style={{ marginLeft: 6, border: 'none', background: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 13 }}>×</button>
 )}
 {r.details && <div className="vendor-note" style={{ fontSize: 10 }}>{r.details}</div>}
 </td>
 {cells}
 <td className="num" style={{ color: 'var(--muted)' }}>{fmt0(rowTot)}</td>
 </tr>
 );
 })}
 <tr style={{ borderTop: '2px solid var(--border)' }}>
 <td style={{ ...stickyL, fontWeight: 600, color: 'var(--muted)' }}>Computed line</td>
 {weeks.map((w, i) => <td key={w.start} className="num" style={{ color: 'var(--muted)' }}>{fmt0(lineCompTot[i])}</td>)}
 <td className="num" style={{ color: 'var(--muted)' }}><strong>{fmt0(grandComp)}</strong></td>
 </tr>
 <tr>
 <td style={{ ...stickyL, fontWeight: 700 }}>Your line total →</td>
 {weeks.map((w, i) => {
 const over = Math.round(lineYourTot[i]) !== Math.round(lineCompTot[i]);
 return <td key={w.start} className="num" style={{ fontWeight: 600, color: over ? 'var(--accent-hover, #047857)' : 'var(--text)' }}>{fmt0(lineYourTot[i])}</td>;
 })}
 <td className="num"><strong style={{ color: 'var(--accent-hover, #047857)' }}>{fmt0(grandYour)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 <div className="vendor-note" style={{ marginTop: 8 }}>
 Each payee's computed week = the line's weekly value split by that payee's share; manual heads add on top. The "Your line total"
 (sum of all rows) flows to the 13-Week grid + dashboard, so editing here updates there. Blank = computed. Saved with your name + time.
 </div>
 </div>
 );
}
