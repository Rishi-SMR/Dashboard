import { useEffect, useMemo, useState } from 'react';
import { fetchStrivenOrders, type OrdersResult, type OrderRow } from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PAGE_SIZE = 15;
type SortKey = 'value' | 'ref' | 'po' | 'inv';

// Windowed page list: 1 2 3 … 21 (with the current page's neighbours kept visible).
function pageList(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, 2, 3, cur - 1, cur, cur + 1, total]);
  const nums = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push('…');
    out.push(nums[i]);
  }
  return out;
}

export function OrderTrackingTab() {
  const [data, setData] = useState<OrdersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'value', dir: -1 });
  const [page, setPage] = useState(1);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setData(await fetchStrivenOrders());
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load orders.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const orders = data?.orders ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      o.ref.toLowerCase().includes(q) || (o.rep || '').toLowerCase().includes(q) || (o.payer || '').toLowerCase().includes(q) || (o.pi || '').toLowerCase().includes(q) ||
      o.pos.some((p) => p.ref.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q)) ||
      o.invoices.some((i) => i.ref.toLowerCase().includes(q)));
  }, [orders, query]);

  const sorted = useMemo(() => {
    const v = (o: OrderRow): number | string => sort.key === 'value' ? o.value
      : sort.key === 'po' ? o.poValue : sort.key === 'inv' ? o.invoices.length : o.ref;
    return [...filtered].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c * sort.dir;
    });
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'ref' ? 1 : -1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  const totalValue = orders.reduce((s, o) => s + o.value, 0);
  const withPo = orders.filter((o) => o.pos.length > 0).length;
  const invoiced = orders.filter((o) => o.invoices.length > 0).length;
  const pctOf = (n: number) => (orders.length ? Math.round((n / orders.length) * 100) : 0);

  // Export the filtered chain as CSV (client-side only).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Order #', 'Program', 'Sales rep', 'Payer', 'Value', 'Status', 'POs', 'PO value', 'Invoices', 'Invoice open'].map(esc).join(','),
      ...sorted.map((o) => [o.ref, o.pi, o.rep || '', o.payer || '', o.value, o.status || '', o.pos.length, o.poValue, o.invoices.length, o.invOpen].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'order-tracking.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Order Tracking</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · Sales Order → Purchase Order → Invoice, by number{agoText ? ` · updated ${agoText}` : ''}
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark }}>🔒 no patient data</span>
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="box" tint="#2563EB" label="Orders Tracked" value={orders.length}
              deltaText="DEMO excluded" foot="full SO → PO → invoice chain" />
            <KpiR ico="cash" tint="#16A34A" label="Order Value" value={totalValue} format={formatCurrency}
              deltaText="across tracked orders" foot="order book, not revenue" />
            <KpiR ico="bag" tint="#7C3AED" label="With Purchase Order" value={withPo}
              deltaText={`${pctOf(withPo)}% of orders`} foot="at least one linked PO" />
            <KpiR ico="doc" tint="#D97706" label="Invoiced" value={invoiced}
              deltaText={`${pctOf(invoiced)}% of orders`} foot="at least one invoice raised" />
          </div>

          {!data.enriched && <div className="info-banner"><span className="info-banner-icon">ℹ</span><span>Order chain is still populating — links will fill in shortly.</span></div>}

          <div className="section chart-card">
            <div className="section-head">
              <div><h2 className="section-title">Orders</h2><div className="section-sub">{filtered.length.toLocaleString()} orders · click a row to see its POs &amp; invoices</div></div>
              <div className="tbl-controls">
                <input className="tbl-search" style={{ width: 250 }} type="text" value={query}
                  onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                  placeholder="Search order #, PO #, invoice #, rep…" />
                <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered orders" onClick={exportCsv}>⤓ CSV</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => setSortKey('ref')}>Order # {sortInd('ref')}</th>
                    <th>P/I/VA</th>
                    <th>Sales Rep</th>
                    <th>Payer</th>
                    <th className="num sortable" onClick={() => setSortKey('value')}>Value {sortInd('value')}</th>
                    <th>Status</th>
                    <th className="sortable" onClick={() => setSortKey('po')}>POs {sortInd('po')}</th>
                    <th className="sortable" onClick={() => setSortKey('inv')}>Invoices {sortInd('inv')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((o) => (
                    <OrderRowView key={o.ref} o={o} open={openRef === o.ref} onToggle={() => setOpenRef((r) => (r === o.ref ? null : o.ref))} />
                  ))}
                  {shown.length === 0 && <tr><td colSpan={8} className="muted-note">{query ? 'No orders match your search.' : 'No orders.'}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="pgn">
              <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()} entries</span>
              <div className="pgn-pages">
                <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                {pageList(pageSafe, pages).map((p, i) => (
                  p === '…'
                    ? <button key={`e${i}`} disabled>…</button>
                    : <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                ))}
                <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
              </div>
            </div>
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
