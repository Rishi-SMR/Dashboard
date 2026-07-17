import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchStrivenItems, type ItemsResult, type Item } from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { SERIES } from '../chartTheme';
import { ChartCard, RankBar, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const PAGE_SIZE = 10;
type SortKey = 'name' | 'number' | 'type' | 'price' | 'cost';

// Windowed page list: 1 2 3 … N.
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

export function CatalogTab() {
  const [data, setData] = useState<ItemsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [page, setPage] = useState(1);
  const [drill, setDrill] = useState<null | { title: string; sub: string; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setData(await fetchStrivenItems());
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load catalog. Is the backend running on :4747?');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const items: Item[] = data?.items ?? [];
  const activeCount = useMemo(() => items.filter((i) => i.active).length, [items]);
  const inactiveCount = items.length - activeCount;
  const priced = items.filter((i) => (i.price || 0) > 0).length;

  // Group items by type → counts. Horizontal ranked bar, sorted desc.
  const typeData = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const t = (it.type || 'Uncategorized').trim() || 'Uncategorized';
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [items]);

  // Table: filter → sort → paginate.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.number || '').toLowerCase().includes(q) ||
        (i.type || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q),
    );
  }, [items, query]);
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sort.key === 'price' || sort.key === 'cost') return ((a[sort.key] || 0) - (b[sort.key] || 0)) * sort.dir;
      const v = (x: Item): string => (sort.key === 'number' ? x.number : sort.key === 'type' ? x.type : x.name) || '';
      return v(a).localeCompare(v(b), undefined, { numeric: true }) * sort.dir;
    });
  }, [filtered, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const setSortKey = (key: SortKey) => { setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'price' || key === 'cost' ? -1 : 1 })); setPage(1); };
  const sortInd = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  // Clicking a bar drills into every item of that type.
  const openDrillForType = (type: string) => {
    if (!type) return;
    const rows = items
      .filter((i) => ((i.type || 'Uncategorized').trim() || 'Uncategorized') === type)
      .map((i) => ({
        number: i.number || '—',
        name: <strong>{i.name || '—'}</strong>,
        price: formatCurrency(i.price),
        cost: formatCurrency(i.cost),
        active: i.active ? <StatusPill status="Active" /> : '–',
      }));
    setDrill({ title: `${type} items`, sub: `${rows.length} item${rows.length === 1 ? '' : 's'} of type ${type}`, rows });
  };

  // Export the filtered catalog as CSV (client-side only).
  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [
      ['Item no', 'Item name', 'Type', 'Price', 'Cost', 'Active'].map(esc).join(','),
      ...sorted.map((i) => [i.number || '', i.name || '', i.type || '', i.price, i.cost, i.active ? 'Active' : ''].map(esc).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'catalog.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Catalog</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven · {(data?.count ?? 0).toLocaleString()} items{agoText ? ` · updated ${agoText}` : ''}
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
            <KpiR ico="box" tint="#2563EB" label="Items" value={items.length}
              deltaText={`${typeData.length} distinct types`} foot="items & services in Striven"
              onClick={() => openDrillForType(typeData[0]?.name ?? '')} />
            <KpiR ico="shield" tint="#16A34A" label="Active" value={activeCount}
              deltaText="currently sellable" foot={`${items.length ? Math.round((activeCount / items.length) * 100) : 0}% of catalog`} />
            <KpiR ico="clip" tint="#D97706" label="Inactive" value={inactiveCount}
              deltaText="retired or draft" foot="not sellable" />
            <KpiR ico="cash" tint="#7C3AED" label="Priced" value={priced}
              deltaText="with a sale price set" foot={`${items.length ? Math.round((priced / items.length) * 100) : 0}% of catalog`} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-12" title="Items by Type" sub={`${typeData.length} types · click a bar to drill in`}>
              <RankBar data={typeData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={(name) => openDrillForType(name)} />
            </ChartCard>

            <div className="section chart-card g12-12">
              <div className="section-head">
                <div><h2 className="section-title">Items &amp; Services</h2><div className="section-sub">{filtered.length.toLocaleString()} matching</div></div>
                <div className="tbl-controls">
                  <input className="tbl-search" style={{ width: 220 }} type="text" value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                    placeholder="Search items…" />
                  <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered items" onClick={exportCsv}>⤓ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sortable" onClick={() => setSortKey('number')}>Item No {sortInd('number')}</th>
                      <th className="sortable" onClick={() => setSortKey('name')}>Item Name {sortInd('name')}</th>
                      <th className="sortable" onClick={() => setSortKey('type')}>Type {sortInd('type')}</th>
                      <th className="num sortable" onClick={() => setSortKey('price')}>Price {sortInd('price')}</th>
                      <th className="num sortable" onClick={() => setSortKey('cost')}>Cost {sortInd('cost')}</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((it) => (
                      <tr key={it.id}>
                        <td>{it.number || '—'}</td>
                        <td><strong>{it.name || '—'}</strong></td>
                        <td>{it.type || '—'}</td>
                        <td className="num">{formatCurrency(it.price)}</td>
                        <td className="num">{formatCurrency(it.cost)}</td>
                        <td>{it.active ? <StatusPill status="Active" /> : <span className="muted-note" style={{ margin: 0 }}>–</span>}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted-note">{query.trim() ? 'No items match your search.' : 'No catalog items.'}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="pgn">
                <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()} items</span>
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
          </div>
        </>
      )}

      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={[
            { key: 'number', label: 'Item No' },
            { key: 'name', label: 'Name' },
            { key: 'price', label: 'Price', num: true },
            { key: 'cost', label: 'Cost', num: true },
            { key: 'active', label: 'Active' },
          ]}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
