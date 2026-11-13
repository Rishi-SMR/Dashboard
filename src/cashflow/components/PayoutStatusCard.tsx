import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPiLienstar, fetchVaRemittances, type PiLienstar, type VaRemittances } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { SourceTag } from '../chartKit';
import { SoLink } from './SoLink';

// PAYOUT RECEIVED? (12 Nov 2026, on request) — every live PI and VA order in
// Striven against the Master File's "PI Lienstar Funding" and "VA Remmittances"
// tabs, with the month of the sales order beside each.
//
// No matching of its own: it reads the same two comparisons as PiLienstarCard
// and VaRemittanceCard (/api/pi-lienstar, /api/va-remittances), so the three
// can never disagree.
//
// THE RULE (owner, 12 Nov 2026). The Master File records what SMR RECEIVED.
// Each order is read on both sides — invoiced in Striven? on the Master File?
//   both, same amount        → RECEIVED
//   neither                  → YET TO BE RECEIVED (worth what it should be
//                              invoiced at: PI 15% of the order total, VA 100%)
//   invoiced, not on the tab → EXCEPTION, with a remark
//   on the tab, not invoiced → EXCEPTION, with a remark
//   both, different amounts  → EXCEPTION, with a remark
//   on the tab, no order     → EXCEPTION, with a remark
// Separately, an invoice that is not PI 15% / VA 100% of the order is flagged.

type Cat = 'received' | 'pending' | 'exception';
type Row = {
  key: string; soId: string; ref: string; patient: string; rep: string;
  vertical: 'PI' | 'VA'; date: string; month: string;
  total: number; expected: number; invoiced: number; onFile: number;
  cat: Cat; kind?: Kind; remark: string; overdue: boolean; invoiceOff: boolean;
};
/** Which line of a summary box the row falls under. */
type Kind = 'received' | 'pending' | 'invNotFile' | 'fileNotInv' | 'differ';
const kindOf = (r: Pick<Row, 'cat' | 'invoiced' | 'onFile'>): Kind => (r.cat !== 'exception' ? r.cat
  : has(r.invoiced) && !has(r.onFile) ? 'invNotFile' : !has(r.invoiced) && has(r.onFile) ? 'fileNotInv' : 'differ');

const PI_SHARE = 0.15;
const TONE: Record<Cat, string> = { received: C.positive, pending: C.info, exception: C.negative };
const r2 = (n: number) => Math.round(n * 100) / 100;
const has = (n: number) => n > 0.005;
const monthKey = (iso: string) => String(iso || '').slice(0, 7);
const monthName = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '-';
};
const day = (iso: string) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
};
const money = (n: number) => formatCurrency(n, true);

/** The two sides of one order → its category and remark. */
function classify(inv: number, onFile: number, tab: string): { cat: Cat; remark: string } {
  if (!has(inv) && !has(onFile)) return { cat: 'pending', remark: 'Not invoiced in Striven · not on the Master File yet' };
  if (has(inv) && !has(onFile)) return { cat: 'exception', remark: `Invoiced in Striven (${money(inv)}) but not on ${tab}` };
  if (!has(inv) && has(onFile)) return { cat: 'exception', remark: `On ${tab} (${money(onFile)}) but not invoiced in Striven` };
  if (Math.abs(inv - onFile) > 0.5) return { cat: 'exception', remark: `Amounts differ: invoiced ${money(inv)}, ${tab} shows ${money(onFile)}` };
  return { cat: 'received', remark: `Received · on ${tab}` };
}

function buildRows(pi: PiLienstar | null, va: VaRemittances | null): Row[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: Row[] = [];
  const PI_TAB = 'Lienstar Funding';
  const VA_TAB = 'VA Remittances';

  for (const r of pi?.ok ? pi.rows ?? [] : []) {
    if (!r.soId) {
      // On the tab with no Striven order behind it.
      out.push({
        key: `pi-tab-${r.patient}-${r.lienValue}`, soId: '', ref: '-', patient: r.patient, rep: '-', vertical: 'PI', date: '', month: '',
        total: r.lienValue, expected: r2(r.lienValue * PI_SHARE), invoiced: 0, onFile: r.toBeFunded,
        cat: 'exception', remark: `On ${PI_TAB} (${money(r.toBeFunded)}) with no matching Striven PI order`, overdue: false, invoiceOff: false,
      });
      continue;
    }
    const onTab = r.kind === 'agrees' || r.kind === 'differs';
    const onFile = onTab ? r.toBeFunded : 0;
    const { cat, remark } = classify(r.invoiced, onFile, PI_TAB);
    const expected = r2(r.strivenValue * PI_SHARE);
    out.push({
      key: `pi-${r.soId}`, soId: r.soId, ref: r.ref, patient: r.patient, rep: r.rep, vertical: 'PI',
      date: r.date ?? '', month: monthKey(r.date ?? ''), total: r.strivenValue, expected, invoiced: r.invoiced, onFile,
      cat, remark: r.lienHold && !onTab ? `${remark} · on Lienstar as ${r.lienHold}` : remark,
      overdue: false, invoiceOff: has(r.invoiced) && Math.abs(r.invoiced - expected) > 0.5,
    });
  }

  for (const p of va?.ok ? va.rows ?? [] : []) {
    if (!p.orders.length) {
      out.push({
        key: `va-tab-${p.patient}`, soId: '', ref: '-', patient: p.patient, rep: p.rep || '-', vertical: 'VA', date: '', month: '',
        total: 0, expected: 0, invoiced: 0, onFile: p.remitted,
        cat: 'exception', remark: `On ${VA_TAB} (${money(p.remitted)}) with no matching Striven VA order`, overdue: false, invoiceOff: false,
      });
      continue;
    }
    // The patient's remittance as the server spread it over their invoiced
    // orders; anything left over belongs to an order not invoiced yet, oldest
    // first, up to each order's value.
    let spare = r2(Math.max(0, (p.remitted ?? 0) - p.orders.reduce((t, o) => t + (has(o.invoiced ?? 0) ? o.remitted ?? 0 : 0), 0)));
    const spareFor = new Map<string, number>();
    for (const o of [...p.orders].filter((x) => !has(x.invoiced ?? 0)).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))) {
      const take = r2(Math.min(spare, has(o.value ?? 0) ? o.value ?? 0 : spare));
      if (has(take)) { spareFor.set(o.soId || o.ref, take); spare = r2(spare - take); }
    }
    for (const o of p.orders) {
      const inv = o.invoiced ?? 0;
      const onFile = has(inv) ? o.remitted ?? 0 : spareFor.get(o.soId || o.ref) ?? 0;
      const { cat, remark } = classify(inv, onFile, VA_TAB);
      const total = o.value ?? 0;
      out.push({
        key: `va-${o.soId || o.ref}`, soId: o.soId, ref: o.ref, patient: p.patient, rep: p.rep, vertical: 'VA',
        date: o.date ?? '', month: monthKey(o.date ?? ''), total, expected: total, invoiced: inv, onFile, cat, remark,
        overdue: cat === 'exception' && has(inv) && inv - onFile > 0.5 && Boolean(o.dueDate && o.dueDate < today),
        invoiceOff: has(inv) && has(total) && Math.abs(inv - total) > 0.5,
      });
    }
  }
  for (const r of out) r.kind = kindOf(r);
  return out.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

type View = 'pending' | 'exception' | 'invoice' | 'received';

export function PayoutStatusCard() {
  const [pi, setPi] = useState<PiLienstar | null>(null);
  const [va, setVa] = useState<VaRemittances | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('pending');
  const [vert, setVert] = useState<'all' | 'PI' | 'VA'>('all');
  // A summary-box line clicked: the table shows exactly those orders.
  const [kind, setKind] = useState<Kind | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Same 90-second refresh as the rest of the board; a failed refresh keeps the
  // last good figures rather than blanking the tile.
  useEffect(() => {
    let alive = true;
    const pull = () => Promise.all([fetchPiLienstar().catch(() => null), fetchVaRemittances().catch(() => null)])
      .then(([a, b]) => {
        if (!alive) return;
        if (a?.ok) setPi(a);
        if (b?.ok) setVa(b);
        setErr(!a?.ok && !b?.ok ? (a?.note || b?.note || 'Could not load the Master File comparison - retrying every 90 seconds.') : '');
      });
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const rows = useMemo(() => buildRows(pi, va), [pi, va]);
  const lists: Record<View, Row[]> = {
    pending: rows.filter((r) => r.cat === 'pending'),
    exception: rows.filter((r) => r.cat === 'exception'),
    invoice: rows.filter((r) => r.invoiceOff),
    received: rows.filter((r) => r.cat === 'received'),
  };
  const sumOf = (list: Row[], f: (r: Row) => number) => list.reduce((t, r) => t + f(r), 0);
  const pendingValue = sumOf(lists.pending, (r) => r.expected);
  const loading = !pi && !va && !err;
  const shown = lists[view].filter((r) => (vert === 'all' || r.vertical === vert) && (!kind || r.kind === kind));
  const KIND_LABEL: Record<Kind, string> = { received: 'Received', pending: 'Yet to be received', invNotFile: 'Invoiced, not on file', fileNotInv: 'On file, not invoiced', differ: 'Amounts differ' };
  const jump = (v: 'PI' | 'VA', k: Kind) => {
    setView(k === 'received' ? 'received' : k === 'pending' ? 'pending' : 'exception');
    setVert(v); setKind(k);
    requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const box = (v: 'PI' | 'VA', heading: string) => {
    const rs = rows.filter((r) => r.vertical === v);
    const line = (label: string, list: Row[], tone: string, amt: (r: Row) => number, note: string, k: Kind) => (
      <button type="button" disabled={!list.length} onClick={() => jump(v, k)} title={list.length ? `Show these ${list.length} ${v} orders` : undefined}
        style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, padding: '4px 6px', margin: '0 -6px', fontSize: 13, font: 'inherit', textAlign: 'left',
          background: kind === k && vert === v ? 'var(--panel-2)' : 'none', border: 0, borderRadius: 6, cursor: list.length ? 'pointer' : 'default', color: 'inherit' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 99, background: tone, marginRight: 8 }} />
          <span style={{ textDecoration: list.length ? 'underline' : undefined, textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }}>{label}</span></span>
        <span style={{ whiteSpace: 'nowrap' }}><b>{list.length}</b><span style={{ color: C.muted, marginLeft: 8 }}>{formatCurrency(sumOf(list, amt))} {note}</span></span>
      </button>
    );
    const ex = rs.filter((r) => r.cat === 'exception');
    const off = rs.filter((r) => r.invoiceOff).length;
    return (
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.4, color: C.muted, marginBottom: 6 }}>{heading} · {rs.filter((r) => r.soId).length} orders</div>
        {line('Received', rs.filter((r) => r.cat === 'received'), C.positive, (r) => r.onFile, 'on file', 'received')}
        {line('Yet to be received', rs.filter((r) => r.cat === 'pending'), C.info, (r) => r.expected, v === 'PI' ? 'at 15%' : 'at 100%', 'pending')}
        {line('Invoiced, not on file', ex.filter((r) => has(r.invoiced) && !has(r.onFile)), C.negative, (r) => r.invoiced, 'invoiced', 'invNotFile')}
        {line('On file, not invoiced', ex.filter((r) => !has(r.invoiced) && has(r.onFile)), C.negative, (r) => r.onFile, 'on file', 'fileNotInv')}
        {line('Amounts differ', ex.filter((r) => has(r.invoiced) && has(r.onFile)), C.warning, (r) => r.invoiced - r.onFile, 'gap', 'differ')}
        <div style={{ fontSize: 12, color: off ? C.warning : C.muted, marginTop: 4 }}>
          Should be invoiced at {v === 'PI' ? '15%' : '100%'} of the order total · {off ? <b>{off} invoice{off === 1 ? '' : 's'} at a different amount</b> : 'every invoice agrees'}
        </div>
      </div>
    );
  };

  const pill = (active: boolean, label: string, onClick: () => void, tone?: string) => (
    <button type="button" onClick={onClick}
      style={{ border: `1px solid ${active ? (tone ?? C.brand) : 'var(--border)'}`, background: active ? (tone ?? C.brand) : 'var(--panel)', color: active ? '#fff' : 'var(--text)', borderRadius: 999, padding: '4px 11px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
  );
  const nExc = lists.exception.length;

  return (
    <div className="section chart-card">
      <div className="section-head" role="button" tabIndex={0} aria-expanded={open} style={{ cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}>
        <div>
          <h2 className="section-title">
            <span style={{ display: 'inline-block', width: 14, color: C.muted, transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s ease' }}>▸</span>
            Remmittance Exceptions
          </h2>
          <SourceTag source="Striven & Master File" />
          <div className="section-sub">
            {loading ? 'Loading the Master File…'
              : err ? err
                : <>Striven orders against the Master File's PI Lienstar Funding and VA Remmittances tabs ·{' '}
                  <b style={{ color: C.info }}>{lists.pending.length} yet to be received ({formatCurrency(pendingValue)})</b>
                  {' · '}<b style={{ color: nExc ? C.negative : C.positive }}>{nExc} exception{nExc === 1 ? '' : 's'}</b>
                  {!open && ' · click to show'}</>}
          </div>
        </div>
      </div>

      {open && !loading && !err && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 14 }}>
            {pi?.ok ? box('PI', 'PI · LIENSTAR FUNDING') : <div className="muted-note">PI comparison unavailable.</div>}
            {va?.ok ? box('VA', 'VA · REMITTANCES') : <div className="muted-note">VA comparison unavailable.</div>}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            {pill(view === 'pending', `Yet to be received (${lists.pending.length})`, () => { setView('pending'); setKind(null); }, C.info)}
            {pill(view === 'exception', `Exceptions (${nExc})`, () => { setView('exception'); setKind(null); }, C.negative)}
            {pill(view === 'invoice', `Invoice ≠ 15% / 100% (${lists.invoice.length})`, () => { setView('invoice'); setKind(null); }, C.warning)}
            {pill(view === 'received', `Received (${lists.received.length})`, () => { setView('received'); setKind(null); }, C.positive)}
            <span style={{ width: 12 }} />
            {pill(vert === 'all', 'PI + VA', () => setVert('all'))}
            {pill(vert === 'PI', 'PI', () => setVert('PI'))}
            {pill(vert === 'VA', 'VA', () => setVert('VA'))}
          </div>

          {kind && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
              <span>Showing <b>{vert === 'all' ? 'PI + VA' : vert} · {KIND_LABEL[kind]}</b> ({shown.length})</span>
              <button type="button" onClick={() => setKind(null)}
                style={{ border: '1px solid var(--border)', background: 'var(--panel)', borderRadius: 999, padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>✕ Clear</button>
            </div>
          )}
          <div ref={tableRef} className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto', scrollMarginTop: 80 }}>
            <table className="data-table">
              <thead><tr>
                <th>Order</th><th>Month</th><th>Order date</th><th>Patient</th><th>Rep</th><th>Vertical</th>
                <th className="num">Order total</th><th className="num">Should invoice</th>
                <th className="num">Invoiced (Striven)</th><th className="num">On Master File</th><th>Remark</th>
              </tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key} style={{ boxShadow: `inset 3px 0 0 ${TONE[r.cat]}`, background: r.cat === 'exception' ? 'color-mix(in srgb, var(--panel) 92%, #dc2626)' : undefined }}>
                    <td>{r.soId ? <SoLink soId={r.soId} label={r.ref} /> : r.ref}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{monthName(r.month)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{day(r.date)}</td>
                    <td>{r.patient}</td>
                    <td>{r.rep || '-'}</td>
                    <td>{r.vertical}</td>
                    <td className="num">{has(r.total) ? money(r.total) : '-'}</td>
                    <td className="num" style={{ color: C.muted }}>{has(r.expected) ? money(r.expected) : '-'}<span style={{ display: 'block', fontSize: 10.5 }}>{r.vertical === 'PI' ? '15%' : '100%'}</span></td>
                    <td className="num" style={{ color: r.invoiceOff ? C.warning : undefined, fontWeight: r.invoiceOff ? 700 : undefined }}>{has(r.invoiced) ? money(r.invoiced) : '-'}</td>
                    <td className="num">{has(r.onFile) ? money(r.onFile) : '-'}</td>
                    <td style={{ color: TONE[r.cat], fontWeight: 600 }}>
                      {r.remark}
                      {r.overdue && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: '#fff', background: C.negative, borderRadius: 999, padding: '1px 7px' }}>Overdue</span>}
                      {r.invoiceOff && <span style={{ display: 'block', fontSize: 11, color: C.warning }}>Invoiced at {has(r.total) ? `${((r.invoiced / r.total) * 100).toFixed(1)}%` : '?'} of the order, not {r.vertical === 'PI' ? '15%' : '100%'}</span>}
                    </td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={11} className="muted-note">No orders in this view.</td></tr>}
                {shown.length > 0 && (
                  <tr className="total-row">
                    <td colSpan={6}><b>Total · {shown.length} order{shown.length === 1 ? '' : 's'}</b></td>
                    <td className="num"><b>{money(sumOf(shown, (r) => r.total))}</b></td>
                    <td className="num"><b>{money(sumOf(shown, (r) => r.expected))}</b></td>
                    <td className="num"><b>{money(sumOf(shown, (r) => r.invoiced))}</b></td>
                    <td className="num"><b>{money(sumOf(shown, (r) => r.onFile))}</b></td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="muted-note" style={{ marginTop: 8 }}>
            Received: invoiced in Striven and on the Master File, same amount · yet to be received: neither invoiced nor on the Master File, valued at what it
            should be invoiced (PI 15%, VA 100% of the order total) · exception (highlighted): on one side only, or the two amounts differ, with the remark saying which.
            Month is the Striven sales order's month. Cancelled orders are excluded. Patients are matched on initial + surname, as on the PI and VA cards.
          </div>
        </>
      )}
    </div>
  );
}
