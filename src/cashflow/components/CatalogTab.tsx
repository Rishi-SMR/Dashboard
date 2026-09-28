import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchInventoryItems, type InventoryItemsResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { SERIES } from '../chartTheme';
import { ChartCard, RankBar, KpiR, DrillModal, useSyncAgo } from '../chartKit';

const PAGE_SIZE = 10;

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

const money = (s: string) => { const n = Number(String(s).replace(/[^0-9.-]/g, '')); return s && Number.isFinite(n) ? n : null; };

// Vendors & Items → Items & Catalog, entirely from the Master Data sheet's
// "Inventory Items" tab. The table's columns are whatever the sheet's header
// row says; the cards, chips and chart look up Vertical, Product Line,
// Therapy / Treatment and Notes by name and skip themselves when one is absent.
export function CatalogTab() {
  const [data, setData] = useState<InventoryItemsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [vertical, setVertical] = useState('All');
  const [therapy, setTherapy] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [showVerticals, setShowVerticals] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showTherapies, setShowTherapies] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setData(await fetchInventoryItems());
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load inventory items. Is the backend running on :4747?');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const moneySet = useMemo(() => new Set(data?.moneyCols ?? []), [data]);
  const vIdx = columns.findIndex((c) => /^vertical$/i.test(c.trim()));
  const tIdx = columns.findIndex((c) => /therapy|treatment/i.test(c));
  const plIdx = columns.findIndex((c) => /product\s*line/i.test(c));
  const notesIdx = columns.findIndex((c) => /^notes?$/i.test(c.trim()));
  const nameIdx = columns.findIndex((c) => /item\s*name|^name$/i.test(c.trim()));
  // A leading "#" column is the sheet's row counter, not data worth a column.
  const numIdx = columns.findIndex((c) => c.trim() === '#');

  const verticals = useMemo(() => {
    if (vIdx < 0) return [];
    const m = new Map<string, number>();
    for (const r of rows) { const v = r[vIdx] || 'Unassigned'; m.set(v, (m.get(v) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows, vIdx]);

  // Items per Therapy / Treatment, biggest first. Follows the Vertical chips,
  // so picking "PI" shows the PI catalogue's therapy mix.
  const therapyData = useMemo(() => {
    if (tIdx < 0) return [];
    const m = new Map<string, number>();
    for (const r of rows) {
      if (vertical !== 'All' && (r[vIdx] || 'Unassigned') !== vertical) continue;
      const t = r[tIdx] || 'Unassigned';
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [rows, tIdx, vIdx, vertical]);

  const distinct = (i: number) => (i < 0 ? 0 : new Set(rows.map((r) => r[i]).filter(Boolean)).size);
  const productLines = useMemo(() => distinct(plIdx), [rows, plIdx]);
  const therapyCount = useMemo(() => distinct(tIdx), [rows, tIdx]);
  const topTherapy = useMemo(() => {
    const m = new Map<string, number>();
    if (tIdx >= 0) for (const r of rows) if (r[tIdx]) m.set(r[tIdx], (m.get(r[tIdx]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  }, [rows, tIdx]);
  // "Needs review" = the sheet's own Notes column is filled in.
  const reviewCount = useMemo(() => (notesIdx < 0 ? 0 : rows.filter((r) => r[notesIdx]).length), [rows, notesIdx]);
  const clearFilters = () => { setQuery(''); setVertical('All'); setTherapy(null); setReviewOnly(false); setPage(1); };
  // The Items card jumps to the full, unfiltered Inventory Items table.
  const tableRef = useRef<HTMLDivElement>(null);
  const showVertical = (v: string) => {
    clearFilters(); setVertical(v); setShowVerticals(false);
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // One row per vertical for the Verticals card's pop-up.
  const verticalRows = useMemo(() => verticals.map(([v, n]) => {
    const mine = rows.filter((r) => (r[vIdx] || 'Unassigned') === v);
    const count = (i: number) => (i < 0 ? 0 : new Set(mine.map((r) => r[i]).filter(Boolean)).size);
    return {
      vertical: <button className="btn ghost" style={{ padding: '2px 8px' }} title={`Show ${v} items in the table`} onClick={() => showVertical(v)}><strong>{v}</strong></button>,
      items: n.toLocaleString(),
      share: `${Math.round((n / Math.max(1, rows.length)) * 100)}%`,
      lines: count(plIdx),
      therapies: count(tIdx),
      review: notesIdx < 0 ? 0 : mine.filter((r) => r[notesIdx]).length,
    };
  }), [verticals, rows, vIdx, plIdx, tIdx, notesIdx]);
  // The Needs Review card's pop-up: every item whose Notes cell is filled in.
  const reviewRows = useMemo(() => (notesIdx < 0 ? [] : rows.filter((r) => r[notesIdx]).map((r) => ({
    num: numIdx >= 0 ? r[numIdx] : '',
    name: <strong>{nameIdx >= 0 ? r[nameIdx] : '-'}</strong>,
    vertical: vIdx >= 0 ? r[vIdx] || '–' : '–',
    line: plIdx >= 0 ? r[plIdx] || '–' : '–',
    therapy: tIdx >= 0 ? r[tIdx] || '–' : '–',
    note: r[notesIdx],
  }))), [rows, notesIdx, numIdx, nameIdx, vIdx, plIdx, tIdx]);
  const showReviewInTable = () => {
    clearFilters(); setReviewOnly(true); setShowReview(false);
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const showTherapy = (t: string) => {
    clearFilters(); setTherapy(t); setShowTherapies(false);
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // The Therapies card's pop-up: one row per therapy across the whole sheet
  // (the chart's own counts follow the Vertical chips; this does not).
  const therapyRows = useMemo(() => {
    if (tIdx < 0) return [];
    const g = new Map<string, string[][]>();
    for (const r of rows) { const t = r[tIdx] || 'Unassigned'; g.set(t, [...(g.get(t) ?? []), r]); }
    const count = (mine: string[][], i: number) => (i < 0 ? 0 : new Set(mine.map((r) => r[i]).filter(Boolean)).size);
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length).map(([t, mine]) => ({
      therapy: <button className="btn ghost" style={{ padding: '2px 8px', textAlign: 'left' }} title={`Show ${t} items in the table`} onClick={() => showTherapy(t)}><strong>{t}</strong></button>,
      items: mine.length.toLocaleString(),
      share: `${Math.round((mine.length / Math.max(1, rows.length)) * 100)}%`,
      lines: count(mine, plIdx),
      verticals: vIdx < 0 ? '–' : [...new Set(mine.map((r) => r[vIdx]).filter(Boolean))].join(' · ') || '–',
      review: notesIdx < 0 ? 0 : mine.filter((r) => r[notesIdx]).length,
    }));
  }, [rows, tIdx, plIdx, vIdx, notesIdx]);
  const showAllItems = () => { clearFilters(); tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) =>
      (vertical === 'All' || (r[vIdx] || 'Unassigned') === vertical) &&
      (!therapy || (r[tIdx] || 'Unassigned') === therapy) &&
      (!reviewOnly || Boolean(r[notesIdx])) &&
      (!q || r.some((c) => c.toLowerCase().includes(q))));
  }, [rows, query, vertical, vIdx, therapy, tIdx, reviewOnly, notesIdx]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { col, dir } = sort;
    return [...filtered].sort((a, b) => {
      if (moneySet.has(col)) return ((money(a[col]) ?? -Infinity) - (money(b[col]) ?? -Infinity)) * dir;
      return a[col].localeCompare(b[col], undefined, { numeric: true }) * dir;
    });
  }, [filtered, sort, moneySet]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const shown = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const setSortCol = (col: number) => { setSort((s) => (s?.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 })); setPage(1); };
  const sortInd = (col: number) => <span className="sort-ind">{sort?.col === col ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  function exportCsv() {
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [columns.map(esc).join(','), ...sorted.map((r) => r.map(esc).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'inventory-items.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const cell = (r: string[], i: number) => {
    const v = r[i];
    if (moneySet.has(i)) { const n = money(v); return n == null ? <span className="muted-note" style={{ margin: 0 }}>–</span> : formatCurrency(n); }
    if (!v) return <span className="muted-note" style={{ margin: 0 }}>–</span>;
    return i === nameIdx ? <strong>{v}</strong> : v;
  };

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Catalog</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Master Data · {rows.length.toLocaleString()} items{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {data && !data.ok && <div className="error">{data.note}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data?.ok && (
        <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <KpiR ico="box" tint="#0A369F" label="Items" value={rows.length}
            deltaText={`${productLines} product lines`} foot={`"${data.tab}" · Master Data`} onClick={showAllItems} />
          <KpiR ico="pie" tint="#16A34A" label="Verticals" value={verticals.length}
            deltaText={verticals[0] ? `${verticals[0][0]} leads · ${verticals[0][1]} items` : 'none set'}
            foot={verticals.slice(0, 4).map(([v]) => v).join(' · ') || '–'} onClick={() => setShowVerticals(true)} />
          <KpiR ico="shield" tint="#7C3AED" label="Therapies" value={therapyCount}
            deltaText={topTherapy ? `top: ${topTherapy[0]}` : 'none set'}
            foot={topTherapy ? `${topTherapy[1]} items (${Math.round((topTherapy[1] / Math.max(1, rows.length)) * 100)}%) · click for all` : '–'}
            onClick={() => setShowTherapies(true)} />
          <KpiR ico="clip" tint="#D97706" label="Needs Review" value={reviewCount}
            deltaText="flagged in the Notes column" foot="click for the details"
            onClick={() => setShowReview(true)} />
        </div>
      )}

      <div className="exec-grid12">
    {data?.ok && therapyData.length > 0 && (
      <ChartCard className="g12-12 rank-tall" title="Items by Therapy / Treatment"
        sub={`${therapyData.length} therapies${vertical !== 'All' ? ` · ${vertical}` : ''} · click a bar to filter the list`}>
        <RankBar data={therapyData} colorAt={(i) => SERIES[i % SERIES.length]} labelWidth={280}
          onSelect={(name) => { if (name) { setTherapy((t) => (t === name ? null : name)); setPage(1); } }} />
      </ChartCard>
    )}
    <div className="section chart-card g12-12" ref={tableRef} style={{ scrollMarginTop: 16 }}>
      <div className="section-head">
        <div>
          <h2 className="section-title">Inventory Items · Master Data</h2>
          <div className="section-sub">
            {data?.ok ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} items · from the "${data.tab}" tab` : 'Master Data sheet'}
            {reviewOnly && (
              <> · <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} title="Clear review filter"
                onClick={() => { setReviewOnly(false); setPage(1); }}>Needs review ✕</button></>
            )}
            {therapy && (
              <> · <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} title="Clear therapy filter"
                onClick={() => { setTherapy(null); setPage(1); }}>{therapy} ✕</button></>
            )}
          </div>
        </div>
        <div className="tbl-controls">
          <input className="tbl-search" style={{ width: 220 }} type="text" value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search inventory…" />
          <button className="btn ghost" style={{ padding: '7px 11px' }} title="Download CSV of the filtered items" onClick={exportCsv} disabled={!data?.ok}>⤓ CSV</button>
        </div>
      </div>

      {data?.ok && (
        <>
          {verticals.length > 1 && (
            <div className="ov-tabs" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              {[['All', rows.length] as [string, number], ...verticals].map(([v, n]) => (
                <button key={v} className={`ov-tab${vertical === v ? ' active' : ''}`} onClick={() => { setVertical(v); setPage(1); }}>
                  {v} <span className="muted-note" style={{ margin: 0 }}>{n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i} className={`sortable${moneySet.has(i) ? ' num' : ''}`} onClick={() => setSortCol(i)}>{c} {sortInd(i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, ri) => (
                  <tr key={`${r[numIdx >= 0 ? numIdx : 0]}-${ri}`}>
                    {columns.map((_, i) => <td key={i} className={moneySet.has(i) ? 'num' : undefined}>{cell(r, i)}</td>)}
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={columns.length || 1} className="muted-note">{query.trim() ? 'No items match your search.' : 'No inventory items.'}</td></tr>
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
        </>
      )}
    </div>
      </div>

      {showTherapies && (
        <DrillModal
          title="Therapies / Treatments"
          sub={`${therapyRows.length} therapies · ${rows.length.toLocaleString()} items · click a therapy to list its items`}
          columns={[
            { key: 'therapy', label: 'Therapy / Treatment' },
            { key: 'items', label: 'Items', num: true },
            { key: 'share', label: 'Share', num: true },
            { key: 'lines', label: 'Product Lines', num: true },
            { key: 'verticals', label: 'Verticals' },
            { key: 'review', label: 'Needs Review', num: true },
          ]}
          rows={therapyRows}
          total={{ items: rows.length.toLocaleString(), share: '100%', review: reviewCount }}
          onClose={() => setShowTherapies(false)}
        />
      )}

      {showReview && (
        <DrillModal
          title="Needs Review"
          sub={`${reviewRows.length} item${reviewRows.length === 1 ? '' : 's'} with a note in the Master Data sheet`}
          summary={reviewRows.length > 0 && (
            <button className="btn ghost" style={{ padding: '5px 10px' }} onClick={showReviewInTable}>Show these in the table ↓</button>
          )}
          columns={[
            { key: 'num', label: '#' },
            { key: 'name', label: 'Item Name' },
            { key: 'vertical', label: 'Vertical' },
            { key: 'line', label: 'Product Line' },
            { key: 'therapy', label: 'Therapy / Treatment' },
            { key: 'note', label: 'Note' },
          ]}
          rows={reviewRows}
          onClose={() => setShowReview(false)}
        />
      )}

      {showVerticals && (
        <DrillModal
          title="Verticals"
          sub={`${verticals.length} verticals · ${rows.length.toLocaleString()} items · click a vertical to list its items`}
          columns={[
            { key: 'vertical', label: 'Vertical' },
            { key: 'items', label: 'Items', num: true },
            { key: 'share', label: 'Share', num: true },
            { key: 'lines', label: 'Product Lines', num: true },
            { key: 'therapies', label: 'Therapies', num: true },
            { key: 'review', label: 'Needs Review', num: true },
          ]}
          rows={verticalRows}
          total={{ items: rows.length.toLocaleString(), share: '100%', review: reviewCount }}
          onClose={() => setShowVerticals(false)}
        />
      )}
    </div>
  );
}
