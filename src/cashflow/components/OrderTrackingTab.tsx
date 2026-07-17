import { useEffect, useMemo, useState } from 'react';
import { fetchStrivenOrders, type OrdersResult, type OrderRow } from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';

export function OrderTrackingTab() {
  const [data, setData] = useState<OrdersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try { setData(await fetchStrivenOrders()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load orders.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const orders = data?.orders ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      o.ref.toLowerCase().includes(q) || (o.rep || '').toLowerCase().includes(q) || (o.payer || '').toLowerCase().includes(q) || (o.pi || '').toLowerCase().includes(q) ||
      o.pos.some((p) => p.ref.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q)) ||
      o.invoices.some((i) => i.ref.toLowerCase().includes(q)));
  }, [orders, query]);
  const shown = filtered.slice(0, 200);

  const totalValue = orders.reduce((s, o) => s + o.value, 0);
  const withPo = orders.filter((o) => o.pos.length > 0).length;
  const invoiced = orders.filter((o) => o.invoices.length > 0).length;
  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Order Tracking</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · sales order → purchase order → invoice, by number
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark, border: '1px solid #bfd3f2' }}>🔒 no patient data</span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          <div className="kpis" style={{ marginTop: 8 }}>
            <KpiCard label="Orders Tracked" value={orders.length.toLocaleString()} period="DEMO excluded"
              info={{ formula: 'Sales orders with their full chain — linked purchase orders and invoices, referenced by number only.' }} active={openKpi === 0} {...kpi(0)} />
            <KpiCard label="Order Value" value={formatCurrency(totalValue)} period="across tracked orders"
              info={{ formula: 'Total order value across all tracked sales orders.' }} active={openKpi === 1} {...kpi(1)} />
            <KpiCard label="With Purchase Order" value={withPo.toLocaleString()} period={`${orders.length ? Math.round((withPo / orders.length) * 100) : 0}% of orders`}
              info={{ formula: 'Orders that have at least one linked purchase order (raised to a vendor).' }} active={openKpi === 2} {...kpi(2)} />
            <KpiCard label="Invoiced" value={invoiced.toLocaleString()} period={`${orders.length ? Math.round((invoiced / orders.length) * 100) : 0}% of orders`}
              info={{ formula: 'Orders that have at least one invoice raised.' }} active={openKpi === 3} {...kpi(3)} />
          </div>

          {!data.enriched && <div className="info-banner"><span className="info-banner-icon">ℹ</span><span>Order chain is still populating — links will fill in shortly.</span></div>}

          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div><h2 className="section-title">Orders</h2><div className="section-sub">{filtered.length.toLocaleString()} orders · click a row to see its POs &amp; invoices</div></div>
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order #, PO #, invoice #, rep…"
                style={{ fontSize: 13, padding: '6px 10px', border: `1px solid ${C.grid}`, borderRadius: 8, color: C.ink, minWidth: 260 }} />
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Order #</th><th>PI/VA</th><th>Sales Rep</th><th>Payer</th><th className="num">Value</th><th>Status</th><th>POs</th><th>Invoices</th></tr>
                </thead>
                <tbody>
                  {shown.map((o) => (
                    <OrderRowView key={o.ref} o={o} open={openRef === o.ref} onToggle={() => setOpenRef((r) => (r === o.ref ? null : o.ref))} />
                  ))}
                  {shown.length === 0 && <tr><td colSpan={8} className="muted-note">{query ? 'No orders match your search.' : 'No orders.'}</td></tr>}
                </tbody>
              </table>
            </div>
            {filtered.length > shown.length && <div className="muted-note">Showing first {shown.length} of {filtered.length}. Refine your search.</div>}
          </div>
        </>
      )}
    </div>
  );
}

function OrderRowView({ o, open, onToggle }: { o: OrderRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td><strong>{open ? '▾ ' : '▸ '}{o.ref}</strong></td>
        <td><StatusPill status={o.pi} /></td>
        <td>{o.rep || '—'}</td>
        <td>{o.payer || '—'}</td>
        <td className="num">{formatCurrency(o.value)}</td>
        <td><StatusPill status={o.status} /></td>
        <td>{o.pos.length ? `${o.pos.length} · ${formatCurrency(o.poValue)}` : '—'}</td>
        <td>{o.invoices.length ? `${o.invoices.length}${o.invOpen > 0.005 ? ` · ${formatCurrency(o.invOpen)} open` : ' · paid'}` : '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: 'var(--accent-soft)', padding: '10px 16px' }}>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>Purchase Orders</div>
                {o.pos.length === 0 ? <div className="muted-note" style={{ margin: 0 }}>No linked PO</div> : o.pos.map((p) => (
                  <div key={p.ref} style={{ fontSize: 13, marginBottom: 3 }}><strong>{p.ref}</strong> · {p.vendor || '—'} · {formatCurrency(p.value)} · <StatusPill status={p.status} /></div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>Invoices</div>
                {o.invoices.length === 0 ? <div className="muted-note" style={{ margin: 0 }}>Not invoiced</div> : o.invoices.map((i) => (
                  <div key={i.ref} style={{ fontSize: 13, marginBottom: 3 }}><strong>{i.ref}</strong> · {formatCurrency(i.total)} · {i.open > 0.005 ? <span style={{ color: '#b91c1c' }}>{formatCurrency(i.open)} open</span> : <span style={{ color: '#047857' }}>paid</span>} · <StatusPill status={i.status} /></div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
