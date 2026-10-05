import { useEffect, useState, type ReactNode } from 'react';
import { fetchPiLienstar, type PiLienstar, type PiLienKind, type PiLienRow } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { ChartCard, DrillModal } from '../chartKit';
import { SoLink } from './SoLink';
import { Portal } from './Portal';

// PI · STRIVEN AGAINST LIENSTAR (3 Oct 2026, on request).
//
// Striven's PI book — order value, and the 15% advance invoiced on it — beside
// the Master File's "PI Lienstar Funding" tab: case value and To be Funded. The
// pairs line up (order value ↔ case value, invoiced ↔ To be Funded), so each
// gets a Difference column, Striven minus Lienstar.
//
// The totals alone cannot say WHERE the gap is, so the cases are matched one by
// one on the server and the four outcomes are listed under the table, each
// opening the cases behind it.

const KIND: Record<PiLienKind, { label: string; note: string; tone: string }> = {
  agrees: { label: 'Agree', note: 'same case value and funding on both', tone: C.positive },
  differs: { label: 'Differ', note: 'on both, figures do not match', tone: C.warning },
  'striven-only': { label: 'Only in Striven', note: 'PI order with no Lienstar row', tone: C.negative },
  'lienstar-only': { label: 'Only on Lienstar', note: 'Approved Lienstar row with no PI order', tone: C.negative },
};

/** Signed money, so a difference reads which way it runs. */
const signed = (n: number) => (Math.abs(n) < 0.005 ? '$0' : `${n > 0 ? '+' : '−'}${formatCurrency(Math.abs(n))}`);
const diffTone = (n: number) => (Math.abs(n) < 0.005 ? C.muted : n > 0 ? C.info : C.negative);

export function PiLienstarCard({ className = 'g12-12' }: { className?: string }) {
  const [d, setD] = useState<PiLienstar | null>(null);
  const [open, setOpen] = useState<PiLienKind | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showNotApproved, setShowNotApproved] = useState(false);
  // Refreshed every 90 seconds, like the rest of the board, so a request that
  // failed once (e.g. during a server restart) recovers on its own. A failed
  // refresh keeps the last good figures instead of blanking the card.
  useEffect(() => {
    let alive = true;
    const pull = () => fetchPiLienstar()
      .then((r) => { if (alive) setD((prev) => (r?.ok || !prev?.ok ? r : prev)); })
      // The REASON and the SITE are shown, so a failure can be diagnosed from a
      // screenshot: 'not found' on a site that has not been deployed with this
      // endpoint reads very differently from a sign-in or server error.
      .catch((e) => { if (alive) setD((prev) => (prev?.ok ? prev : { ok: false, note: `Could not load the comparison (${e instanceof Error ? e.message : 'request failed'} · ${location.host}) - retrying every 90 seconds.` })); });
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!d) {
    return <ChartCard className={className} title="PI · Striven vs Lienstar" sub="Loading the Master File…"><div className="muted-note">Loading…</div></ChartCard>;
  }
  if (!d.ok || !d.striven || !d.lienstar || !d.diff || !d.match) {
    return <ChartCard className={className} title="PI · Striven vs Lienstar" sub="Master File · PI Lienstar Funding"><div className="muted-note">{d.note ?? 'Comparison unavailable.'}</div></ChartCard>;
  }
  const { striven: s, lienstar: l, diff, match } = d;
  const ex = d.excluded;

  const rows: { label: string; sv: ReactNode; lv: ReactNode; dv: number; money: boolean; note: string }[] = [
    { label: 'PI cases', sv: s.cases, lv: l.cases, dv: diff.cases, money: false, note: 'live PI orders · Approved Lienstar rows' },
    { label: 'Order value ↔ Case value', sv: formatCurrency(s.orderValue), lv: formatCurrency(l.caseValue), dv: diff.value, money: true, note: 'full case value' },
    { label: 'Invoiced ↔ To be Funded', sv: formatCurrency(s.invoiced), lv: formatCurrency(l.toBeFunded), dv: diff.funding, money: true, note: 'the 15% advance' },
  ];
  const na = ex?.notApproved;
  const fromReport = d.source === 'report';

  const list: PiLienRow[] = open ? (d.rows ?? []).filter((r) => r.kind === open) : [];
  const drillTotal = (k: keyof PiLienRow) => list.reduce((t, r) => t + (Number(r[k]) || 0), 0);

  return (
    <ChartCard className={className} title="PI · Striven vs Lienstar"
      sub={`Striven ${fromReport ? '(live PI order report)' : '(cached order book)'} against the Master File's PI Lienstar Funding tab, Approved rows only · cancelled orders excluded · difference is Striven − Lienstar · click an outcome for its cases`}>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th>Measure</th>
            <th className="num">Striven</th>
            <th className="num">Lienstar · Approved</th>
            <th className="num">Difference</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td><b>{r.label}</b><span style={{ display: 'block', fontSize: 11, color: C.muted }}>{r.note}</span></td>
                <td className="num">{r.sv}</td>
                <td className="num">{r.lv}</td>
                <td className="num" style={{ fontWeight: 800, color: diffTone(r.dv) }}>
                  {r.money ? signed(r.dv) : (r.dv > 0 ? `+${r.dv}` : r.dv < 0 ? `−${Math.abs(r.dv)}` : '0')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* WHERE THE GAP IS: the case-by-case match, one figure per outcome. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 14 }}>
        {(Object.keys(KIND) as PiLienKind[]).map((k) => {
          const m = match[k];
          const money = k === 'lienstar-only' ? m.lienValue : m.strivenValue;
          return (
            <button key={k} type="button" disabled={!m.count} onClick={() => setOpen(k)}
              title={KIND[k].note}
              style={{ textAlign: 'left', border: '1px solid var(--border)', borderLeft: `3px solid ${KIND[k].tone}`, borderRadius: 10, padding: '10px 12px', background: 'var(--panel)', cursor: m.count ? 'pointer' : 'default', opacity: m.count ? 1 : 0.55 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>{KIND[k].label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: KIND[k].tone }}>{m.count}</div>
              <div style={{ fontSize: 11.5, color: C.muted }}>
                {formatCurrency(money)} case value
                {k === 'differs' && <> · {signed(m.strivenValue - m.lienValue)} gap</>}
              </div>
            </button>
          );
        })}
      </div>

      {/* EXCLUDED, STATED. Cancelled (and lost) PI orders are not cases, so
          they are in no figure above — and neither is a Lienstar row that is a
          cancelled order's case. Named here with their totals, and the list one
          click away, so the leaving-out is visible rather than assumed. */}
      {ex && ex.orders > 0 && (
        <button type="button" onClick={() => setShowExcluded(true)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, marginTop: 12, textAlign: 'left', border: '1px dashed var(--border)', borderRadius: 10, padding: '9px 12px', background: 'var(--panel-2)', cursor: 'pointer' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: C.muted, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>Excluded</span>
          <span style={{ fontSize: 12.5, color: C.ink }}>
            <b>{ex.orders} cancelled PI order{ex.orders === 1 ? '' : 's'}</b> ({formatCurrency(ex.orderValue)} order value
            {ex.invoiced > 0 ? `, ${formatCurrency(ex.invoiced)} invoiced` : ', nothing invoiced'})
            {ex.lienRows > 0 && <> · <b>{ex.lienRows} Lienstar row{ex.lienRows === 1 ? '' : 's'}</b> belonging to {ex.lienRows === 1 ? 'one' : 'them'} ({formatCurrency(ex.lienValue)}, {formatCurrency(ex.lienToBeFunded)} to fund)</>}
            {' '}· not counted anywhere above
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: C.brand, whiteSpace: 'nowrap' }}>View list →</span>
        </button>
      )}
      {na && na.count > 0 && (
        <button type="button" onClick={() => setShowNotApproved(true)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, marginTop: 8, textAlign: 'left', border: '1px dashed var(--border)', borderRadius: 10, padding: '9px 12px', background: 'var(--panel-2)', cursor: 'pointer' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: C.muted, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>Excluded</span>
          <span style={{ fontSize: 12.5, color: C.ink }}>
            <b>{na.count} Lienstar row{na.count === 1 ? '' : 's'} not Approved</b>
            {' '}({Object.entries(na.byStatus).map(([st, n]) => `${st} ${n}`).join(', ')} · {formatCurrency(na.caseValue)} case value, {formatCurrency(na.toBeFunded)} to fund) · not counted anywhere above
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: C.brand, whiteSpace: 'nowrap' }}>View list →</span>
        </button>
      )}

      {/* OUTSIDE THE REPORT. The report is scoped in Striven, and live PI orders
          it does not list are not guessed back in — they are named here. */}
      {fromReport && (d.reportGaps?.length ?? 0) > 0 && (
        <div className="lbl-note" style={{ marginTop: 8 }}>
          <b>{d.reportGaps!.length} live PI order{d.reportGaps!.length === 1 ? ' is' : 's are'} not in the Striven PI report</b> and so are not counted:{' '}
          {d.reportGaps!.map((g, i) => (
            <span key={g.soId}>{i > 0 && ', '}<SoLink soId={g.soId} label={g.ref} /> ({g.status}, {formatCurrency(g.value)})</span>
          ))}. Widen the report's filter in Striven to include them.
        </div>
      )}

      <div className="muted-note" style={{ marginTop: 10 }}>
        Lienstar: {l.cases} Approved of {l.rowsOnTab ?? l.cases} rows on the tab.
        {' '}Striven: {s.invoicedCases} of {s.cases} live PI orders invoiced{fromReport ? ', read live from the PI order report (Total = order value, InvoicedTotal = invoiced)' : ', from the cached order book'}.
        {' '}Cases are matched on patient initial + surname and case value.
      </div>

      {showNotApproved && na && (<Portal>
        <DrillModal
          title="PI · Lienstar rows not Approved (excluded)"
          sub={`${na.count} row${na.count === 1 ? '' : 's'} on the PI Lienstar Funding tab with a status other than Approved`}
          columns={[
            { key: 'p', label: 'Patient', left: true },
            { key: 'st', label: 'Lienstar status' },
            { key: 'lf', label: 'Law firm', left: true },
            { key: 'lv', label: 'Case value', num: true },
            { key: 'fund', label: 'To be Funded', num: true },
          ]}
          rows={na.rows.map((r) => ({ rowClass: 'row-lien-hold', p: <b>{r.patient}</b>, st: <span className="pill-tag tag-danger" style={{ fontWeight: 700 }}>{r.status}</span>, lf: r.lawFirm || '-', lv: formatCurrency(r.caseValue), fund: formatCurrency(r.toBeFunded) }))}
          total={{ lv: formatCurrency(na.caseValue), fund: formatCurrency(na.toBeFunded) }}
          onClose={() => setShowNotApproved(false)}
        />
      </Portal>)}

      {showExcluded && ex && (<Portal>
        <DrillModal
          title="PI · Cancelled orders (excluded)"
          sub={`${ex.orders} cancelled PI order${ex.orders === 1 ? '' : 's'} left out of the comparison${ex.lienRows ? `, with ${ex.lienRows} Lienstar row${ex.lienRows === 1 ? '' : 's'} tied to them` : ''}`}
          columns={[
            { key: 'p', label: 'Patient', left: true },
            { key: 'so', label: 'Order' },
            { key: 'st', label: 'Striven status' },
            { key: 'sv', label: 'Order value', num: true },
            { key: 'inv', label: 'Invoiced', num: true },
            { key: 'ls', label: 'On Lienstar' },
            { key: 'lv', label: 'Lienstar value', num: true },
            { key: 'fund', label: 'To be Funded', num: true },
          ]}
          rows={ex.rows.map((r) => ({
            p: <b>{r.patient}</b>,
            so: r.soId ? <SoLink soId={r.soId} label={r.ref} /> : r.ref,
            st: r.status,
            sv: formatCurrency(r.strivenValue),
            inv: r.invoiced ? formatCurrency(r.invoiced) : '-',
            ls: r.lienStatus || '-',
            lv: r.lienValue ? formatCurrency(r.lienValue) : '-',
            fund: r.toBeFunded ? formatCurrency(r.toBeFunded) : '-',
          }))}
          total={{ sv: formatCurrency(ex.orderValue), inv: formatCurrency(ex.invoiced), lv: formatCurrency(ex.lienValue), fund: formatCurrency(ex.lienToBeFunded) }}
          onClose={() => setShowExcluded(false)}
        />
      </Portal>)}

      {/* PORTALLED: the card sits in an animated .section, which would make a
          fixed overlay size itself to the card instead of the viewport. */}
      {open && (<Portal>
        <DrillModal
          title={`PI · ${KIND[open].label}`}
          sub={`${list.length} case${list.length === 1 ? '' : 's'} · ${KIND[open].note}`}
          columns={[
            { key: 'p', label: 'Patient', left: true },
            { key: 'so', label: 'Order' },
            { key: 'why', label: 'Why', left: true },
            { key: 'st', label: 'Lienstar status' },
            { key: 'sv', label: 'Striven value', num: true },
            { key: 'lv', label: 'Lienstar value', num: true },
            { key: 'inv', label: 'Invoiced', num: true },
            { key: 'fund', label: 'To be Funded', num: true },
            { key: 'dv', label: 'Value diff', num: true },
          ]}
          // RED where Lienstar holds the case — on the tab but On Hold, Rejected or
          // any status other than Approved, so no funding is coming yet.
          rows={list.map((r) => ({
            rowClass: r.lienHold ? 'row-lien-hold' : undefined,
            p: <><b>{r.patient}</b>{r.lawFirm && <span style={{ display: 'block', fontSize: 11, color: C.muted }}>{r.lawFirm}</span>}</>,
            so: r.soId ? <SoLink soId={r.soId} label={r.ref} /> : '-',
            why: r.lienHold
              ? <span className="pill-tag tag-danger" style={{ fontWeight: 700 }} title="This case is on the Lienstar tab but not Approved, so Lienstar is not funding it yet.">Lienstar: {r.lienHold}</span>
              : r.reason || '-',
            st: r.kind === 'striven-only' ? '-' : r.status,
            sv: r.strivenValue ? formatCurrency(r.strivenValue) : '-',
            lv: r.lienValue ? formatCurrency(r.lienValue) : '-',
            inv: r.invoiced ? formatCurrency(r.invoiced) : '-',
            fund: r.toBeFunded ? formatCurrency(r.toBeFunded) : '-',
            dv: <span style={{ color: diffTone(r.valueDiff), fontWeight: 700 }}>{signed(r.valueDiff)}</span>,
          }))}
          total={{
            sv: formatCurrency(drillTotal('strivenValue')), lv: formatCurrency(drillTotal('lienValue')),
            inv: formatCurrency(drillTotal('invoiced')), fund: formatCurrency(drillTotal('toBeFunded')),
            dv: signed(drillTotal('valueDiff')),
          }}
          onClose={() => setOpen(null)}
        />
      </Portal>)}
    </ChartCard>
  );
}
