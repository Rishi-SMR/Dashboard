import { useEffect, useState } from 'react';
import { C } from '../chartTheme';
import { formatCurrency } from '../format';
import { fetchStrivenSODetail, type SoDetail } from '../strivenApi';
import { Portal } from './Portal';
import { StatusPill } from './StatusPill';

/**
 * THE SALES-ORDER REFERENCE, MADE OPENABLE.
 *
 * Every order table in the portal printed its reference — "SO-553" — in the
 * brand blue, at weight 600. It looked exactly like a link and did nothing, so
 * the one thing a reader most wants from a row ("what IS this order?") was the
 * one thing the row would not give them, and the styling actively promised
 * otherwise. This makes the promise true.
 *
 * IT OPENS IN THE PORTAL, not in Striven, and that is the important choice.
 * Reps have no Striven login at all — the whole redaction architecture exists so
 * they never need one — so a deep link into the ERP would be a dead end for the
 * very people who spend their day on these tables. The drill is served by
 * /api/so/:id, the same endpoint the Orders tab has always used, which means the
 * PHI rules are the server's and not this component's: patient names arrive
 * masked, and addresses, notes and line descriptions are withheld before
 * serialization. Nothing here can widen that.
 *
 * The Striven jump is offered as well, for the admins who do have a login — see
 * STRIVEN_SO_URL below.
 */

/**
 * WHERE A SALES ORDER LIVES IN STRIVEN'S OWN UI. `{id}` is substituted.
 *
 * The tenant's own address, supplied by the owner rather than guessed — nothing
 * in this repository references the Striven web app, only the API host
 * api.striven.com, so it could not have been derived from the code.
 *
 * THE TRAILING NUMBER IS OUR `soId`, checked rather than assumed: the sample URL
 * ended /sales-orders/331, and soId 331 is SO-331 in the book (Christy Tan,
 * 14 Jul 2026, Veterans Affairs). Every `SO-<n>` reference in this portal is
 * built as `SO-${so.id}` from the same Striven id, so substitution is exact and
 * needs no lookup.
 *
 * IT IS A #HASH ROUTE. The id sits after the fragment marker, which means the
 * browser will NOT re-navigate an already-open Striven tab that differs only
 * after the '#'. Hence target="_blank" on the anchor: a fresh tab always lands
 * on the right order, where reusing one could silently show the previous one.
 *
 * Emptying this string disables the button everywhere, which is the intended
 * off switch if the tenant address ever changes.
 */
export const STRIVEN_SO_URL: string = 'https://sportsmedrecovery.striven.com/next/crm#/sales-orders/{id}';

/** The id the API needs, from a `SO-553`-style reference, when a row carries the
 *  reference but not the numeric id. Returns null rather than guessing. */
export const soIdFromRef = (ref: string | null | undefined): number | null => {
  const m = /(\d+)\s*$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
};

/**
 * WHAT AN OPENABLE SALES-ORDER REFERENCE LOOKS LIKE.
 *
 * Exported because SoLink is not the only way one is opened. The Orders tab
 * already had its own richer drill on the row — created/updated, payment term,
 * AR account, the PO chain — reached by clicking anywhere in the row, and its
 * reference cell was plain bold text that gave no hint of it. Pointing that cell
 * at this style rather than wrapping it in a SoLink keeps the richer drill AND
 * makes the reference look openable, without putting two different sales-order
 * dialogs one row apart.
 *
 * ONE DECLARATION, because "what a reference looks like" is exactly the kind of
 * detail that drifts when it is written twice: the colour and the underline
 * offset would be adjusted in one table and not the other, and the two would
 * stop reading as the same affordance.
 */
export const SO_REF_STYLE: React.CSSProperties = {
  background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer',
  fontWeight: 600, color: C.brand, textDecoration: 'underline',
  // A REFERENCE IS ONE TOKEN. "SO-553" was breaking after the hyphen and
  // rendering as "SO-" over "553" — two lines for six characters, in the
  // narrowest column of the table, which reads as two different things rather
  // than one order number. Browsers treat a hyphen as a legal break point, so
  // the column being tight is enough to trigger it; the cell must widen instead
  // of the number folding.
  whiteSpace: 'nowrap',
  // The underline sits off the glyphs so a reference reads as cleanly as it did
  // as plain text; it is the affordance, not decoration.
  textUnderlineOffset: 3, textDecorationThickness: 1,
  textDecorationColor: 'rgba(10,54,159,0.35)',
};

/**
 * The clickable reference itself.
 *
 * A BUTTON, not an <a>. It opens a dialog in place rather than navigating, and
 * an anchor with no href is exactly the thing screen readers announce as a link
 * and then cannot follow. `canOpenInStriven` is passed from the caller's role —
 * it only governs whether the jump is OFFERED, never what the drill contains,
 * because what the drill contains was already decided on the server.
 */
export function SoLink({ soId, label, canOpenInStriven = false }: {
  /** STRING OR NUMBER, because the payload is not consistent about it and this
   *  component should not make every caller remember which one they hold:
   *  AnalyticsOrder types `soId` as a string while ReportOrder types it as a
   *  number, and both feed order tables. Coerced once, here. */
  soId: string | number | null | undefined;
  label: string;
  canOpenInStriven?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = soId == null || soId === '' ? NaN : Number(soId);
  // Without a usable id there is nothing to fetch. The reference still prints —
  // losing the number entirely would be a worse outcome than losing the link.
  if (!Number.isFinite(id)) {
    return <span style={{ fontWeight: 600, color: C.brand, whiteSpace: 'nowrap' }}>{label}</span>;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${label}`}
        style={SO_REF_STYLE}
      >
        {label}
      </button>
      {open && <SoDetailModal soId={id} label={label} canOpenInStriven={canOpenInStriven} onClose={() => setOpen(false)} />}
    </>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted, fontWeight: 700, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

const fmtDate = (s: string | null | undefined) =>
  (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-');

/**
 * Money, or a dash where the server withheld it.
 *
 * NOT a formatting nicety. `getSODetailFor` nulls every dollar for a rep, and
 * this project compiles with `strict: false`, so nothing in the type system
 * stops a null reaching `formatCurrency` — it would render "$NaN" on a rep's
 * screen and read as a broken page rather than as a figure they may not see.
 */
const money = (v: number | null | undefined) =>
  (typeof v === 'number' && Number.isFinite(v) ? formatCurrency(v) : '—');

function SoDetailModal({ soId, label, canOpenInStriven, onClose }: {
  soId: number; label: string; canOpenInStriven: boolean; onClose: () => void;
}) {
  const [detail, setDetail] = useState<SoDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchStrivenSODetail(soId)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load this sales order.'); });
    return () => { live = false; };
  }, [soId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const strivenHref = STRIVEN_SO_URL ? STRIVEN_SO_URL.replace('{id}', String(soId)) : '';

  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
      <div onClick={onClose} role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
        <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Sales order ${label}`}
          style={{ background: '#fff', borderRadius: 14, width: 'min(860px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${C.brand}` }}>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{detail?.ref || label}</div>
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
                {detail ? `Sales order · ${detail.customer || '-'} · ${detail.type || '-'}` : err ? 'Could not load' : 'Loading…'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Only where a URL has actually been configured AND the viewer has
                  a Striven login to land in. See STRIVEN_SO_URL. */}
              {canOpenInStriven && strivenHref && (
                <a className="btn ghost" href={strivenHref} target="_blank" rel="noopener noreferrer"
                  title="Open this sales order in Striven">Open in Striven ↗</a>
              )}
              <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
            </div>
          </div>

          <div style={{ padding: 18 }}>
            {err ? (
              <div className="error">{err}</div>
            ) : !detail ? (
              <div style={{ color: C.muted, fontSize: 13, padding: '10px 0' }}>Loading…</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 16 }}>
                  <KV label="Customer">{detail.customer || '-'}</KV>
                  <KV label="Payer">{detail.payer || '-'}</KV>
                  <KV label="Program / Type">
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <StatusPill status={detail.program} />{detail.type || '-'}
                    </span>
                  </KV>
                  <KV label="Status"><StatusPill status={detail.status} /></KV>
                  <KV label="Invoice status">{detail.invoiceStatus || '-'}</KV>
                  <KV label="Sales rep">{detail.rep || '-'}</KV>
                  <KV label="Order date">{fmtDate(detail.orderDate)}</KV>
                  <KV label="Target date">{fmtDate(detail.targetDate)}</KV>
                  <KV label="Tracking #">{detail.trackingNumber || '-'}</KV>
                  <KV label="Customer PO #">{detail.customerPONumber || '-'}</KV>
                  <KV label="Ship via">{detail.shipVia || '-'}</KV>
                  <KV label="Total">{money(detail.total)}</KV>
                </div>

                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '4px 0 8px' }}>
                  What was ordered
                  <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}> · {detail.lineItems.length} line{detail.lineItems.length === 1 ? '' : 's'}</span>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr>
                      <th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th>
                    </tr></thead>
                    <tbody>
                      {detail.lineItems.map((li, i) => (
                        <tr key={i}>
                          <td><strong>{li.item || '-'}</strong></td>
                          <td className="num">{li.qty.toLocaleString()}</td>
                          <td className="num">{money(li.unit)}</td>
                          <td className="num">{money(li.amount)}</td>
                        </tr>
                      ))}
                      {detail.lineItems.length === 0 && (
                        <tr><td colSpan={4} style={{ color: C.muted, fontSize: 12.5 }}>No line items on this sales order.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {detail.moneyMasked && (
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
                    Order value and line prices are not shown on a rep login — your own commission is the one dollar figure on your board.
                  </div>
                )}
                {detail.phiMasked && (
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
                    🔒 Customer shown as its <b>PT-&lt;id&gt;</b> reference, not a patient name. Addresses, notes &amp; line
                    descriptions withheld (PHI).
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
