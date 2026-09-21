import { useEffect, useMemo, useState } from 'react';
import { fetchStrivenOrders, type OrdersResult, type OrderRow } from '../strivenApi';
import { formatCurrency, isCompletedStatus, isCancelledStatus } from '../format';
import { StatusPill } from './StatusPill';
import { SoLink } from './SoLink';
import { soIdFromRef } from '../soRef';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const PAGE_SIZE = 15;
type SortKey = 'value' | 'ref' | 'po' | 'inv';
type SoGroup = 'active' | 'completed' | 'cancelled';
const GROUP_OF = (status: string): SoGroup => {
  const s = (status || '').toLowerCase();
  if (/cancel|void|lost|denied|rejected/.test(s)) return 'cancelled';
  if (isCompletedStatus(s)) return 'completed';
  return 'active';
};

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

export function OrderTrackingTab({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<OrdersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState<'All' | SoGroup>('All');
  const [progF, setProgF] = useState<'All' | 'PI' | 'VA' | 'TriCare' | 'Other'>('All');
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
    return orders.filter((o) =>
      (statusF === 'All' || GROUP_OF(o.status) === statusF) &&
      (progF === 'All' || o.pi === progF) &&
      (!q ||
        o.ref.toLowerCase().includes(q) || (o.rep || '').toLowerCase().includes(q) || (o.payer || '').toLowerCase().includes(q) || (o.pi || '').toLowerCase().includes(q) ||
        (o.lastName || '').toLowerCase().includes(q) || (o.item || '').toLowerCase().includes(q) ||
        o.pos.some((p) => p.ref.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q)) ||
        o.invoices.some((i) => i.ref.toLowerCase().includes(q))));
  }, [orders, query, statusF, progF]);

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

  // KPIs count the real book: cancelled orders are excluded (and shown separately).
  const book = useMemo(() => orders.filter((o) => GROUP_OF(o.status) !== 'cancelled'), [orders]);
  const cancelledCount = orders.length - book.length;
  const totalValue = book.reduce((s, o) => s + o.value, 0);
  const withPo = book.filter((o) => o.pos.length > 0).length;
  const invoiced = book.filter((o) => o.invoices.length > 0).length;
  const pctOf = (n: number) => (book.length ? Math.round((n / book.length) * 100) : 0);

  // Export the filtered chain as CSV (client-side only).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Order #', 'Last name', 'Item', 'Program', 'Sales rep', 'Payer', 'Value', 'Status', 'POs', 'PO value', 'Invoices', 'Invoice open'].map(esc).join(','),
      ...sorted.map((o) => [o.ref, o.lastName || '', o.item || '', o.pi, o.rep || '', o.payer || '', o.value, o.status || '', o.pos.length, o.poValue, o.invoices.length, o.invOpen].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'order-tracking.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className={embedded ? undefined : 'exec-deck'} style={embedded ? undefined : { padding: '4px 2px' }}>
      {!embedded && (
        <div className="page-head deck-head" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Order Tracking</h1>
            <div className="page-sub">
              <span className="live-dot" /> Sports Med Recovery · Sales Order → Purchase Order → Invoice, by number{agoText ? ` · updated ${agoText}` : ''}
              <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark }}>🔒 last name only</span>
            </div>
          </div>
          <div className="ov-headright">
            <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
            <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      .ref} style={{ fontSize: 13, marginBottom: 3 }}><strong>{p.ref}</strong> · {p.vendor || '-'} · {formatCurrency(p.value)} · <StatusPill status={p.status} /></div>
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
