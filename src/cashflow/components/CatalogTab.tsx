import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchStrivenItems, type ItemsResult, type Item } from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, SERIES } from '../chartTheme';
import { ChartCard, RankBar, DrillModal } from '../chartKit';

const ROW_CAP = 100;

export function CatalogTab() {
  const [data, setData] = useState<ItemsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; rows: Record<string, ReactNode>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const items = await fetchStrivenItems();
      setData(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load catalog. Is the backend running on :4747?');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const items: Item[] = data?.items ?? [];
  const activeCount = useMemo(() => items.filter((i) => i.active).length, [items]);
  const inactiveCount = items.length - activeCount;

  // Group items by type → counts. Horizontal ranked bar, sorted desc.
  const typeData = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const t = (it.type || 'Uncategorized').trim() || 'Uncategorized';
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [items]);

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

  const shown = filtered.slice(0, ROW_CAP);
  const more = Math.max(0, filtered.length - ROW_CAP);

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

  const kpi = (i: number) => ({ open: openKpi === i, active: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Catalog</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven · {(data?.count ?? 0).toLocaleString()} items
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          {/* Catalog KPIs — tap any card for the formula. */}
          <div className="kpis">
            <KpiCard label="Items" period={`${typeData.length} distinct types`} value={items.length.toLocaleString()}
              info={{ formula: 'Count of every item & service in the Striven catalog, broken out by type below.' }}
              breakdown={typeData.slice(0, 6).map((t, i) => ({ label: t.name, value: t.value.toLocaleString(), strong: i === 0 }))
                .concat([{ label: 'Total items', value: items.length.toLocaleString(), strong: true }])}
              {...kpi(0)} />
            <KpiCard label="Active" period="currently sellable" value={activeCount.toLocaleString()}
              trend={activeCount >= inactiveCount ? 'up' : 'down'}
              info={{ formula: 'Items flagged active in Striven (Active ÷ Total). Active items are sellable; inactive are retired or draft.' }}
              breakdown={[
                { label: 'Active', value: activeCount.toLocaleString(), strong: true },
                { label: 'Inactive', value: inactiveCount.toLocaleString() },
                { label: 'Total', value: items.length.toLocaleString() },
              ]}
              {...kpi(1)} />
          </div>

          <div className="chart-grid">
            <ChartCard title="Items by Type" sub={`${typeData.length} types · click a bar to drill in`}>
              <RankBar data={typeData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={(name) => openDrillForType(name)} />
            </ChartCard>
          </div>

          <div className="section">
            <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div><h2 className="section-title">Items &amp; Services</h2><div className="section-sub">{filtered.length.toLocaleString()} matching</div></div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search items…"
                style={{ fontSize: 13, padding: '6px 10px', border: `1px solid ${C.grid}`, borderRadius: 6, color: C.ink, minWidth: 200 }}
              />
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item No</th>
                    <th>Item Name</th>
                    <th>Type</th>
                    <th className="num">Price</th>
                    <th className="num">Cost</th>
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
            {more > 0 && <div className="muted-note">+{more.toLocaleString()} more — refine your search to narrow the list.</div>}
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
