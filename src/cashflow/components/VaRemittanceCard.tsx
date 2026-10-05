import { useEffect, useState } from 'react';
import { fetchVaRemittances, type VaRemittances, type VaRemitKind, type VaRemitRow } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { ChartCard, DrillModal } from '../chartKit';
import { SoLink } from './SoLink';
import { Portal } from './Portal';

// VA · STRIVEN AGAINST REMITTANCES (3 Oct 2026, on request) — the VA twin of
// PiLienstarCard.
//
// Striven's VA book (the live VA report: order value and what was invoiced)
// beside the Master File's "VA Remmittances" tab — what Integrated Surgical and
// HiDow actually paid SMR. The difference is invoiced but not yet remitted.
//
// The tab names no Striven order, only the patient, so the case-level match is
// PER PATIENT: everything invoiced to a patient against everything remitted for
// them. The four outcomes below the table each open the patients behind them.

const KIND: Record<VaRemitKind, { label: string; note: string; tone: string }> = {
  agrees: { label: 'Agree', note: 'remitted equals invoiced', tone: C.positive },
  differs: { label: 'Differ', note: 'remitted, but not the invoiced amount', tone: C.warning },
  'striven-only': { label: 'Not remitted', note: 'VA orders with nothing on the remittance tab', tone: C.negative },
  'remit-only': { label: 'Only on remittances', note: 'remitted, no matching Striven VA order', tone: C.negative },
};

const signed = (n: number) => (Math.abs(n) < 0.005 ? '$0' : `${n > 0 ? '+' : '−'}${formatCurrency(Math.abs(n))}`);
const diffTone = (n: number) => (Math.abs(n) < 0.005 ? C.muted : n > 0 ? C.info : C.negative);
/** "2026-09-04" → "4 Sep 2026", built from the parts so no timezone shifts it. */
const day = (iso: string) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
};

export function VaRemittanceCard({ className = 'g12-12' }: { className?: string }) {
  const [d, setD] = useState<VaRemittances | null>(null);
  const [open, setOpen] = useState<VaRemitKind | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  // Refreshed every 90 seconds, like the rest of the board, so a request that
  // failed once (e.g. during a server restart) recovers on its own. A failed
  // refresh keeps the last good figures instead of blanking the card.
  useEffect(() => {
    let alive = true;
    const pull = () => fetchVaRemittances()
      .then((r) => { if (alive) setD((prev) => (r?.ok || !prev?.ok ? r : prev)); })
      .catch(() => { if (alive) setD((prev) => (prev?.ok ? prev : { ok: false, note: 'Could not load the comparison - retrying.' })); });
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const title = 'VA · Striven vs Remittances';
  if (!d) return <ChartCard className={className} title={title} sub="Loading the Master File…"><div className="muted-note">Loading…</div></ChartCard>;
  if (!d.ok || !d.striven || !d.remit || !d.diff || !d.match) {
    return <ChartCard className={className} title={title} sub="Master File · VA Remmittances"><div className="muted-note">{d.note ?? 'Comparison unavailable.'}</div></ChartCard>;
  }
  const { striven: s, remit: r, diff, match } = d;
  const ex = d.excluded;
  const payers = Object.entries(r.byPayer).sort((a, b) => b[1].amount - a[1].amount);

  const list: VaRemitRow[] = open ? (d.rows ?? []).filter((x) => x.kind === open) : [];
  const tot = (k: 'value' | 'invoiced' | 'remitted' | 'diff') => list.reduce((t, x) => t + (x[k] || 0), 0);

  return (
    <ChartCard className={className} title={title}
      sub="Striven (live VA order report) against the Master File's VA Remmittances tab · cancelled orders excluded · difference is invoiced − remitted · click an outcome for its patients">
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th>Measure</th>
            <th className="num">Striven</th>
            <th className="num">Remittances (Master File)</th>
            <th className="num">Difference</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><b>Patients</b><span style={{ display: 'block', fontSize: 11, color: C.muted }}>{s.orders} live VA orders · {r.lines} remittance lines</span></td>
              <td className="num">{s.patients}</td>
              <td className="num">{r.patients}</td>
              <td className="num" style={{ fontWeight: 800, color: diffTone(diff.patients) }}>{diff.patients > 0 ? `+${diff.patients}` : diff.patients < 0 ? `−${Math.abs(diff.patients)}` : '0'}</td>
            </tr>
            <tr>
              <td><b>Order value</b><span style={{ display: 'block', fontSize: 11, color: C.muted }}>report Subtotal · the tab carries no order value</span></td>
              <td className="num">{formatCurrency(s.orderValue)}</td>
              <td className="num" style={{ color: C.muted }}>-</td>
              <td className="num" style={{ color: C.muted }}>-</td>
            </tr>
            <tr>
              <td><b>Invoiced ↔ Remitted</b><span style={{ display: 'block', fontSize: 11, color: C.muted }}>InvoicedTotal · Dist. Payout</span></td>
              <td className="num">{formatCurrency(s.invoiced)}</td>
              <td className="num">{formatCurrency(r.remitted)}</td>
              <td className="num" style={{ fontWeight: 800, color: diffTone(diff.funding) }}>{signed(diff.funding)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 14 }}>
        {(Object.keys(KIND) as VaRemitKind[]).map((k) => {
          const m = match[k];
          const amount = k === 'remit-only' ? m.remitted : m.invoiced;
          return (
            <button key={k} type="button" disabled={!m.count} onClick={() => setOpen(k)} title={KIND[k].note}
              style={{ textAlign: 'left', border: '1px solid var(--border)', borderLeft: `3px solid ${KIND[k].tone}`, borderRadius: 10, padding: '10px 12px', background: 'var(--panel)', cursor: m.count ? 'pointer' : 'default', opacity: m.count ? 1 : 0.55 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>{KIND[k].label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: KIND[k].tone }}>{m.count}</div>
              <div style={{ fontSize: 11.5, color: C.muted }}>
                {formatCurrency(amount)} {k === 'remit-only' ? 'remitted' : 'invoiced'}
                {k === 'differs' && <> · {signed(m.invoiced - m.remitted)} gap</>}
              </div>
            </button>
          );
        })}
      </div>

      {ex && ex.orders > 0 && (
        <button type="button" onClick={() => setShowExcluded(true)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, marginTop: 12, textAlign: 'left', border: '1px dashed var(--border)', borderRadius: 10, padding: '9px 12px', background: 'var(--panel-2)', cursor: 'pointer' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: C.muted, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>Excluded</span>
          <span style={{ fontSize: 12.5, color: C.ink }}>
            <b>{ex.orders} cancelled VA order{ex.orders === 1 ? '' : 's'}</b> ({formatCurrency(ex.orderValue)} order value
            {ex.invoiced > 0 ? `, ${formatCurrency(ex.invoiced)} invoiced` : ', nothing invoiced'}) · cancelled by status or by a CANCELLED label · not counted anywhere above
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: C.brand, whiteSpace: 'nowrap' }}>View list →</span>
        </button>
      )}

      {(d.reportGaps?.length ?? 0) > 0 && (
        <div className="lbl-note" style={{ marginTop: 8 }}>
          <b>{d.reportGaps!.length} live VA order{d.reportGaps!.length === 1 ? ' is' : 's are'} not in the Striven VA report</b> and so are not counted:{' '}
          {d.reportGaps!.map((g, i) => (
            <span key={g.soId}>{i > 0 && ', '}<SoLink soId={g.soId} label={g.ref} /> ({formatCurrency(g.value)})</span>
          ))}. Widen the report's filter in Striven to include them.
        </div>
      )}

      <div className="muted-note" style={{ marginTop: 10 }}>
        Remitted by payer: {payers.map(([p, b]) => `${p} ${formatCurrency(b.amount)} (${b.lines} line${b.lines === 1 ? '' : 's'})`).join(' · ')}.
        {' '}Latest payment on the tab: {day(r.lastPaid)}.
        {' '}Striven: {s.invoicedOrders} of {s.orders} live VA orders invoiced.
        {r.flaggedCells > 0 && <> {r.flaggedCells} payout cell{r.flaggedCells === 1 ? ' is' : 's are'} formatted as a date on the tab and read as the amount underneath.</>}
        {' '}Matched per patient on initial + surname.
      </div>

      {showExcluded && ex && (<Portal>
        <DrillModal
          title="VA · Cancelled orders (excluded)"
          sub={`${ex.orders} VA order${ex.orders === 1 ? '' : 's'} left out of the comparison`}
          columns={[
            { key: 'p', label: 'Patient', left: true },
            { key: 'so', label: 'Order' },
            { key: 'st', label: 'Striven status' },
            { key: 'lb', label: 'Labels', left: true },
            { key: 'v', label: 'Order value', num: true },
            { key: 'inv', label: 'Invoiced', num: true },
          ]}
          rows={ex.rows.map((x) => ({
            p: <b>{x.patient}</b>, so: x.soId ? <SoLink soId={x.soId} label={x.ref} /> : x.ref,
            st: x.status, lb: x.labels || '-', v: formatCurrency(x.value), inv: x.invoiced ? formatCurrency(x.invoiced) : '-',
          }))}
          total={{ v: formatCurrency(ex.orderValue), inv: formatCurrency(ex.invoiced) }}
          onClose={() => setShowExcluded(false)}
        />
      </Portal>)}

      {/* PORTALLED: the card sits in an animated .section, which would make a
          fixed overlay size itself to the card instead of the viewport. */}
      {open && (<Portal>
        <DrillModal
          title={`VA · ${KIND[open].label}`}
          sub={`${list.length} patient${list.length === 1 ? '' : 's'} · ${KIND[open].note}`}
          columns={[
            { key: 'p', label: 'Patient', left: true },
            { key: 'so', label: 'Orders' },
            { key: 'why', label: 'Why', left: true },
            { key: 'py', label: 'Payer', left: true },
            { key: 'lp', label: 'Last paid' },
            { key: 'inv', label: 'Invoiced', num: true },
            { key: 'rem', label: 'Remitted', num: true },
            { key: 'df', label: 'Difference', num: true },
          ]}
          rows={list.map((x) => ({
            p: <><b>{x.patient}</b>{x.rep && <span style={{ display: 'block', fontSize: 11, color: C.muted }}>{x.rep}</span>}</>,
            so: x.orders.length ? <>{x.orders.map((o, i) => <span key={`${o.ref}-${i}`}>{i > 0 && ', '}{o.soId ? <SoLink soId={o.soId} label={o.ref} /> : o.ref}</span>)}</> : '-',
            why: <>{x.reason || '-'}{x.flagged && <span style={{ display: 'block', fontSize: 11, color: C.warning }}>payout cell formatted as a date</span>}</>,
            py: x.payer || '-',
            lp: x.lastPaid ? day(x.lastPaid) : '-',
            inv: x.invoiced ? formatCurrency(x.invoiced) : '-',
            rem: x.remitted ? formatCurrency(x.remitted) : '-',
            df: <span style={{ color: diffTone(x.diff), fontWeight: 700 }}>{signed(x.diff)}</span>,
          }))}
          total={{ inv: formatCurrency(tot('invoiced')), rem: formatCurrency(tot('remitted')), df: signed(tot('diff')) }}
          onClose={() => setOpen(null)}
        />
      </Portal>)}
    </ChartCard>
  );
}
