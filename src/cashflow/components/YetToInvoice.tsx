import { useMemo, useState } from 'react';
import type { ArPending } from '../strivenApi';
import { formatCurrency } from '../format';
import { SoLink } from './SoLink';

// Sales orders that exist in Striven and have never been invoiced, every
// vertical. The list is getArPending() on the server: cancelled, lost, DEMO and
// $0 orders are already gone, and an order the invoice book shows as billed is
// struck off even where the cached order detail has not caught up.
//
// It is an ACTION LIST, not a receivable: nothing on it is counted in AR until
// an invoice is raised.
/**
 * `fill`: take the height of the row instead of setting it. The list grows into
 * whatever the card beside it leaves (Business growth on Kevin's board) and
 * scrolls inside that, so the two cards end level.
 */
export function YetToInvoice({ pending, className, listHeight = 300, fill = false }: { pending: ArPending | null | undefined; className: string; listHeight?: number; fill?: boolean }) {
  const [vert, setVert] = useState('All');
  const orders = pending?.orders ?? [];
  const verticals = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) m.set(o.vertical, (m.get(o.vertical) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [orders]);
  const shown = vert === 'All' ? orders : orders.filter((o) => o.vertical === vert);
  const value = shown.reduce((s, o) => s + o.caseValue, 0);

  return (
    <div className={`section chart-card ${className}`} style={fill ? { display: 'flex', flexDirection: 'column' } : undefined}>
      <div className="section-head">
        <div>
          <h2 className="section-title">Yet to be Invoiced</h2>
          <div className="section-sub">{orders.length.toLocaleString()} sales orders · all verticals · cancelled &amp; lost excluded</div>
        </div>
      </div>

      {verticals.length > 1 && (
        <div className="ov-tabs yti-tabs" style={{ marginBottom: 8 }}>
          {[['All', orders.length] as [string, number], ...verticals].map(([v, n]) => (
            <button key={v} className={`ov-tab${vert === v ? ' active' : ''}`} onClick={() => setVert(v)}>
              {v} <span className="muted-note" style={{ margin: 0 }}>{n}</span>
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="muted-note">{pending ? 'Every live sales order has an invoice.' : 'Loading…'}</div>
      ) : (
        <div style={{ ...(fill ? { flex: '1 1 0', minHeight: 160 } : { maxHeight: listHeight }), overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table className="data-table" style={{ margin: 0 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr>
                <th>Order</th>
                <th>Vertical</th>
                <th>Payer · Rep</th>
                <th className="num">Order value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.soId}>
                  <td><SoLink soId={o.soId} label={o.ref} canOpenInStriven /></td>
                  <td>{o.vertical}</td>
                  <td>
                    <div>{o.payer || '–'}</div>
                    <div className="muted-note" style={{ margin: 0 }}>{o.rep || 'no rep'}{o.status && o.status !== 'In Progress' ? ` · ${o.status}` : ''}</div>
                  </td>
                  <td className="num">{formatCurrency(o.caseValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cfoot">
        <div className="cf-i"><div className="l">Orders</div><div className="v">{shown.length.toLocaleString()}</div></div>
        <div className="cf-i" style={{ textAlign: 'right' }}><div className="l">Order value</div><div className="v accent">{formatCurrency(value)}</div></div>
      </div>
    </div>
  );
}
