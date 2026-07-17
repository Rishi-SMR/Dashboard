import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { C } from '../chartTheme';
import { formatCurrency } from '../format';
import { ChartCard, RankBar, DrillModal, KpiR, useSyncAgo } from '../chartKit';
import {
  fetchStrivenSO,
  fetchStrivenPO,
  fetchStrivenSODetail,
  fetchStrivenPODetail,
  type SoResult,
  type PoResult,
  type SoDetail,
  type PoDetail,
} from '../strivenApi';
import { StatusPill } from './StatusPill';

type Mode = 'sales' | 'purchase';

// Fixed category colors — PI/VA/Tri-Care read the same on every SMR surface.
const TYPE_COLOR = (name: string): string => {
  const s = (name || '').toLowerCase();
  if (/pi/.test(s)) return '#2563EB';
  if (/\bva\b|veteran/.test(s)) return '#16A34A';
  if (/tri.?care/.test(s)) return '#7C3AED';
  return C.muted;
};
// Client mirror of the server's status grouping (active / completed / cancelled).
type SoGroup = 'active' | 'completed' | 'cancelled';
const GROUP_OF = (status: string): SoGroup => {
  const s = (status || '').toLowerCase();
  if (/cancel|void|lost|denied|rejected/.test(s)) return 'cancelled';
  if (/complete|closed|done/.test(s)) return 'completed';
  return 'active';
};
const GROUP_LABEL: Record<SoGroup | 'All', string> = { All: 'All statuses', active: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' };
const SO_PAGE = 10;
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

// Status hue: in-progress blue, completed green, cancelled red.
const STATUS_COLOR = (name: string): string => {
  const s = (name || '').toLowerCase();
  if (/complete|closed|done|accepted|approved|paid/.test(s)) return C.positive;
  if (/cancel|void|lost|denied|rejected/.test(s)) return '#EF4444';
  if (/progress|open|pending|await|review/.test(s)) return C.brand;
  return C.info;
};

// Chart-click drill payload (rendered by the shared kit DrillModal).
type Drill = {
  title: string;
  sub?: string;
  columns: { key: string; label: string; num?: boolean }[];
  rows: Record<string, ReactNode>[];
};

const fmtDate = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

const infoGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '14px 32px',
};

// Single label/value cell for the detail info grid.
function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: C.muted,
          fontWeight: 600,
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: C.ink, fontWeight: 500 }}>{children}</div>
    </div>
  );
}

// Portal-based detail modal — same house .drill shell the kit DrillModal uses, but
// able to render a 2-col info grid + a full line-items table (the kit modal is table-only).
function DetailModal({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drill-head">
          <div>
            <div className="title">{title}</div>
            <div className="sub">{sub}</div>
          </div>
          <button className="drill-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="drill-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function OrdersTab() {
  const [mode, setMode] = useState<Mode>('sales');
  const [so, setSo] = useState<SoResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  // Dynamic chart toggles.
  const [typeMode, setTypeMode] = useState<'value' | 'count'>('value');
  const [repsShown, setRepsShown] = useState(8);

  // Recent-orders table filters (KPI cards click into these).
  const [soStatusF, setSoStatusF] = useState<'All' | SoGroup>('All');
  const [soProgF, setSoProgF] = useState<'All' | 'PI' | 'VA' | 'TriCare' | 'Other'>('All');
  const [soQuery, setSoQuery] = useState('');
  const [soPage, setSoPage] = useState(1);
  const soTableRef = useRef<HTMLDivElement | null>(null);
  const filterTo = (g: 'All' | SoGroup) => {
    setSoStatusF(g); setSoPage(1);
    soTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Chart-click drill (shared kit DrillModal).
  const [drill, setDrill] = useState<Drill | null>(null);

  // Row-click detail: one expanded id per view + a cache of loaded details keyed by id.
  const [expandedSoId, setExpandedSoId] = useState<number | null>(null);
  const [soDetails, setSoDetails] = useState<Record<number, SoDetail>>({});
  const [expandedPoId, setExpandedPoId] = useState<number | null>(null);
  const [poDetails, setPoDetails] = useState<Record<number, PoDetail>>({});

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [s, p] = await Promise.all([fetchStrivenSO(), fetchStrivenPO()]);
      setSo(s);
      setPo(p);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load orders. Is the backend running on :4747?');
    } finally {
      if (!silent) setLoading(false);
    }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  function switchMode(m: Mode) {
    setMode(m);
    setDrill(null);
    setExpandedSoId(null);
    setExpandedPoId(null);
    setDetailErr(null);
  }

  async function openSo(id: number) {
    setDetailErr(null);
    setExpandedSoId(id);
    if (soDetails[id]) return;
    try {
      const d = await fetchStrivenSODetail(id);
      setSoDetails((prev) => ({ ...prev, [id]: d }));
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : 'Failed to load sales-order detail.');
    }
  }

  async function openPo(id: number) {
    setDetailErr(null);
    setExpandedPoId(id);
    if (poDetails[id]) return;
    try {
      const d = await fetchStrivenPODetail(id);
      setPoDetails((prev) => ({ ...prev, [id]: d }));
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : 'Failed to load purchase-order detail.');
    }
  }

  // KPI tap-to-explain drills (label/value rows in the shared modal).
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });

  // Recent-orders list after search + status-group + program filters.
  const soRecentFiltered = useMemo(() => {
    const q = soQuery.trim().toLowerCase();
    return (so?.recent ?? []).filter((o) =>
      (soStatusF === 'All' || GROUP_OF(o.status) === soStatusF) &&
      (soProgF === 'All' || o.type === soProgF) &&
      (!q || o.ref.toLowerCase().includes(q) || (o.rep || '').toLowerCase().includes(q) || (o.payer || '').toLowerCase().includes(q)));
  }, [so, soStatusF, soProgF, soQuery]);
  const soPages = Math.max(1, Math.ceil(soRecentFiltered.length / SO_PAGE));
  const soPageSafe = Math.min(soPage, soPages);
  const soShown = soRecentFiltered.slice((soPageSafe - 1) * SO_PAGE, soPageSafe * SO_PAGE);

  // SO by status — ranked bar (status-hued), sorted desc, empties dropped.
  const statusData = [...(so?.byStatus ?? [])]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({ name: b.status || '—', value: b.count }));

  // Top vendors by PO spend — ranked money bar, brand blue, sorted desc.
  const vendorData = [...(po?.byVendor ?? [])]
    .filter((v) => v.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)
    .map((v) => ({ name: v.vendor || '—', value: v.total }));

  // Chart drill: SO rows for the clicked status (no patient — ref/type/rep/value).
  function drillSoStatus(status: string) {
    const list = (so?.recent ?? []).filter((o) => (o.status || '—') === status);
    const sum = list.reduce((t, o) => t + (o.value || 0), 0);
    setDrill({
      title: `Sales Orders — ${status}`,
      sub: `${list.length} order${list.length === 1 ? '' : 's'} · ${formatCurrency(sum)}`,
      columns: [
        { key: 'ref', label: 'Order #' },
        { key: 'type', label: 'PI/VA' },
        { key: 'rep', label: 'Sales Rep' },
        { key: 'payer', label: 'Payer' },
        { key: 'value', label: 'Value', num: true },
        { key: 'inv', label: 'Invoiced' },
      ],
      rows: list.map((o) => ({
        ref: <strong>{o.ref}</strong>,
        type: <StatusPill status={o.type} />,
        rep: o.rep || '—',
        payer: o.payer || '—',
        value: formatCurrency(o.value),
        inv: o.invStatus || '—',
      })),
    });
  }

  // Chart drill: PO rows for the clicked vendor.
  function drillPoVendor(vendor: string) {
    const list = (po?.recent ?? []).filter((o) => (o.vendor || '—') === vendor);
    const sum = list.reduce((t, o) => t + o.total, 0);
    setDrill({
      title: `Purchase Orders — ${vendor}`,
      sub: `${list.length} recent · ${formatCurrency(sum)}`,
      columns: [
        { key: 'ref', label: 'PO ref' },
        { key: 'vendor', label: 'Vendor' },
        { key: 'total', label: 'Total', num: true },
        { key: 'created', label: 'Created' },
      ],
      rows: list.map((o) => ({
        ref: <strong>{o.ref}</strong>,
        vendor: o.vendor || '—',
        total: formatCurrency(o.total),
        created: fmtDate(o.date),
      })),
    });
  }

  const records = mode === 'sales' ? so?.count ?? 0 : po?.count ?? 0;
  const soDetail = expandedSoId != null ? soDetails[expandedSoId] : undefined;
  const poDetail = expandedPoId != null ? poDetails[expandedPoId] : undefined;

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Orders</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven · {records.toLocaleString()} records{agoText ? ` · updated ${agoText}` : ''}
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark }}>
              🔒 PHI masked
            </span>
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      <div className="ov-tabs">
        <button className={`ov-tab${mode === 'sales' ? ' active' : ''}`} onClick={() => switchMode('sales')}>
          Sales Orders
        </button>
        <button className={`ov-tab${mode === 'purchase' ? ' active' : ''}`} onClick={() => switchMode('purchase')}>
          Purchase Orders
        </button>
      </div>

      {error && <div className="error" style={{ margin: '10px 0' }}>{error}</div>}
      {loading && !so && !po && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* ── SALES ORDERS ─────────────────────────────────────────── */}
      {mode === 'sales' && so && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="bag" tint="#2563EB" label="Total Order Value" value={so.totalValue} format={formatCurrency}
              deltaText={`${so.count.toLocaleString()} open + completed orders`}
              foot={`${so.statusGroups.cancelled.count} cancelled + ${so.demoCount} demo excluded`}
              onClick={() => filterTo('All')} />
            <KpiR ico="clock" tint="#D97706" label="Pending / In Progress" value={so.statusGroups.active.count}
              deltaText={formatCurrency(so.statusGroups.active.value)} foot="awaiting fulfilment · click to filter"
              onClick={() => filterTo('active')} />
            <KpiR ico="shield" tint="#16A34A" label="Completed" value={so.statusGroups.completed.count}
              deltaText={formatCurrency(so.statusGroups.completed.value)} foot="fulfilled orders · click to filter"
              onClick={() => filterTo('completed')} />
            <KpiR ico="trend" tint="#DC2626" label="Cancelled" value={so.statusGroups.cancelled.count}
              deltaText={formatCurrency(so.statusGroups.cancelled.value)} foot="excluded from every total · click to filter"
              onClick={() => filterTo('cancelled')} />
          </div>

          {!so.enriched && <div className="info-banner"><span className="info-banner-icon">ℹ</span><span>Order type / rep / value enrichment is still populating — numbers will fill in shortly.</span></div>}

          <div className="exec-grid12">
            <ChartCard className="g12-6" title="Order Value by Type" sub="PI vs VA vs Tri-Care · DEMO excluded"
              right={
                <div className="smr-seg" style={{ margin: 0 }}>
                  <button className={typeMode === 'value' ? 'active' : ''} onClick={() => setTypeMode('value')}>By Order Value</button>
                  <button className={typeMode === 'count' ? 'active' : ''} onClick={() => setTypeMode('count')}>By Count</button>
                </div>
              }>
              <RankBar
                data={[...so.byType].sort((a, b) => (typeMode === 'value' ? b.value - a.value : b.count - a.count))
                  .map((t) => ({ name: t.type, value: typeMode === 'value' ? t.value : t.count }))}
                money={typeMode === 'value'}
                colorAt={(i) => TYPE_COLOR([...so.byType].sort((a, b) => (typeMode === 'value' ? b.value - a.value : b.count - a.count))[i]?.type ?? '')}
                onSelect={(name) => {
                  const k = /tri.?care/i.test(name) ? 'TriCare' : /\bva\b|veteran/i.test(name) ? 'VA' : /pi/i.test(name) ? 'PI' : 'Other';
                  setSoProgF(k); setSoPage(1);
                  soTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }} />
            </ChartCard>

            <ChartCard className="g12-6" title="Sales Orders by Status" sub={`${so.count.toLocaleString()} orders · click a bar to drill in`}
              right={<span className="deck-pill muted">by count</span>}>
              <RankBar data={statusData} colorAt={(i) => STATUS_COLOR(statusData[i]?.name ?? '')} onSelect={drillSoStatus} />
            </ChartCard>

            <ChartCard className="g12-12" title="Top Sales Reps by Order Value" sub="Sales rep on the sales order — referral group removed, no patient data">
              <RankBar data={so.byRep.slice(0, repsShown).map((r) => ({ name: r.rep, value: r.value }))} money colorAt={() => C.brand}
                onSelect={(rep) => {
                  setSoQuery(rep); setSoStatusF('All'); setSoProgF('All'); setSoPage(1);
                  soTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }} />
              {so.byRep.length > repsShown && (
                <button className="card-link" style={{ margin: '10px auto 0' }} onClick={() => setRepsShown(so.byRep.length)}>
                  View all sales reps →
                </button>
              )}
            </ChartCard>
          </div>

          <div className="section chart-card" style={{ marginTop: 16 }} ref={soTableRef}>
            <div className="section-head">
              <div><h2 className="section-title">All Sales Orders</h2><div className="section-sub">{soRecentFiltered.length} of {so.recent.length} orders · {GROUP_LABEL[soStatusF]}{soProgF !== 'All' ? ` · ${soProgF === 'TriCare' ? 'Tri-Care' : soProgF}` : ''}</div></div>
              <div className="tbl-controls">
                <input className="tbl-search" style={{ width: 190 }} value={soQuery} onChange={(e) => { setSoQuery(e.target.value); setSoPage(1); }} placeholder="Search order / rep / payer" />
                <select className="tbl-select" value={soStatusF} onChange={(e) => { setSoStatusF(e.target.value as 'All' | SoGroup); setSoPage(1); }}>
                  <option value="All">All statuses</option>
                  <option value="active">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select className="tbl-select" value={soProgF} onChange={(e) => { setSoProgF(e.target.value as typeof soProgF); setSoPage(1); }}>
                  <option value="All">All programs</option>
                  <option value="PI">PI</option>
                  <option value="VA">VA</option>
                  <option value="TriCare">Tri-Care</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Order #</th><th>PI/VA</th><th>Sales Rep</th><th>Payer</th><th className="num">Value</th><th>Status</th><th>Invoiced</th></tr>
                </thead>
                <tbody>
                  {soShown.map((o) => (
                    <tr key={o.id} onClick={() => openSo(o.id)} style={{ cursor: 'pointer' }}>
                      <td><strong>{o.ref}</strong></td>
                      <td><StatusPill status={o.type} /></td>
                      <td>{o.rep || '—'}</td>
                      <td>{o.payer || '—'}</td>
                      <td className="num">{formatCurrency(o.value)}</td>
                      <td><StatusPill status={o.status} /></td>
                      <td>{o.invStatus || '—'}</td>
                    </tr>
                  ))}
                  {soRecentFiltered.length === 0 && (
                    <tr><td colSpan={7} className="muted-note">No orders match the filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="pgn">
              <span className="pgn-info">Showing {soRecentFiltered.length === 0 ? 0 : (soPageSafe - 1) * SO_PAGE + 1} to {Math.min(soPageSafe * SO_PAGE, soRecentFiltered.length)} of {soRecentFiltered.length.toLocaleString()} orders</span>
              <div className="pgn-pages">
                <button disabled={soPageSafe <= 1} onClick={() => setSoPage(soPageSafe - 1)}>‹</button>
                {pageList(soPageSafe, soPages).map((pg, i) => (
                  pg === '…'
                    ? <button key={`e${i}`} disabled>…</button>
                    : <button key={pg} className={pg === soPageSafe ? 'active' : ''} onClick={() => setSoPage(pg)}>{pg}</button>
                ))}
                <button disabled={soPageSafe >= soPages} onClick={() => setSoPage(soPageSafe + 1)}>›</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── PURCHASE ORDERS ──────────────────────────────────────── */}
      {mode === 'purchase' && po && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="box" tint="#2563EB" label="Purchase Orders" value={po.count}
              deltaText="active POs" foot={`${(po.totalCount ?? po.count).toLocaleString()} on record`}
              onClick={() => setDrill({
                title: 'Purchase Orders', sub: 'Active vs excluded purchase orders',
                ...kv([
                  { k: 'Active', v: po.count.toLocaleString() },
                  ...(po.cancelledCount ? [{ k: 'Cancelled (excluded)', v: po.cancelledCount.toLocaleString() }] : []),
                  ...(po.pendingCount ? [{ k: 'Still loading', v: po.pendingCount.toLocaleString() }] : []),
                  { k: 'Total on record', v: (po.totalCount ?? po.count).toLocaleString() },
                ]),
              })} />
            <KpiR ico="cash" tint="#16A34A" label="Total PO Value" value={po.totalValue} format={formatCurrency}
              deltaText="committed spend" foot="active POs only"
              onClick={() => setDrill({
                title: 'Total PO Value', sub: 'Committed spend by vendor — active POs only',
                ...kv([
                  ...[...po.byVendor].sort((a, b) => b.total - a.total).slice(0, 6).map((v) => ({ k: v.vendor || '—', v: formatCurrency(v.total) })),
                  { k: 'Active total', v: formatCurrency(po.totalValue) },
                ]),
              })} />
            <KpiR ico="trend" tint="#DC2626" label="Cancelled Excluded" value={po.cancelledCount ?? 0}
              deltaText={po.cancelledValue ? formatCurrency(po.cancelledValue) : '—'} foot="removed from every figure" />
            <KpiR ico="users" tint="#7C3AED" label="Vendors on POs" value={(po.byVendor ?? []).filter((v) => v.total > 0).length}
              deltaText="with active spend" foot="see Top Vendors below" />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-12"
              title="Top Vendors by PO Spend"
              sub={`Active purchase orders only${po.cancelledCount ? ` · excludes ${po.cancelledCount} cancelled (${formatCurrency(po.cancelledValue ?? 0)})` : ''} · click a bar to drill in`}
            >
              <RankBar
                data={vendorData}
                money
                colorAt={() => C.brand}
                onSelect={drillPoVendor}
              />
            </ChartCard>
          </div>

          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><h2 className="section-title">Recent Purchase Orders</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>PO ref</th>
                    <th>Vendor</th>
                    <th className="num">Total</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {po.recent.map((o) => (
                    <tr key={o.id} onClick={() => openPo(o.id)} style={{ cursor: 'pointer' }}>
                      <td><strong>{o.ref}</strong></td>
                      <td>{o.vendor || '—'}</td>
                      <td className="num">{formatCurrency(o.total)}</td>
                      <td>{o.status ? <StatusPill status={o.status} /> : <span className="pill-tag tag-ok">Active</span>}</td>
                      <td>{fmtDate(o.date)}</td>
                    </tr>
                  ))}
                  {po.recent.length === 0 && (
                    <tr><td colSpan={5} className="muted-note">No recent purchase orders.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Click a PO to open its full detail — what was purchased from the vendor.</div>
          </div>
        </>
      )}

      {/* ── CHART DRILL (shared kit modal) ───────────────────────── */}
      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={drill.columns}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}

      {/* ── SALES-ORDER DETAIL (PHI-limited) ─────────────────────── */}
      {mode === 'sales' && expandedSoId != null && (
        <DetailModal
          title={soDetail?.ref ?? 'Sales Order'}
          sub={soDetail ? `Sales order · ${soDetail.customer || '—'}` : 'Loading…'}
          onClose={() => setExpandedSoId(null)}
        >
          {detailErr ? (
            <div className="error">{detailErr}</div>
          ) : soDetail ? (
            <div className="section" style={{ marginTop: 0 }}>
              <div className="section-head"><h2 className="section-title">Sales Order</h2></div>
              <div style={infoGrid}>
                <KV label="Customer">{soDetail.customer || '—'}</KV>
                <KV label="Status"><StatusPill status={soDetail.status} /></KV>
                <KV label="Total">{formatCurrency(soDetail.total)}</KV>
                <KV label="Line Items">{soDetail.lineItemCount.toLocaleString()}</KV>
                <KV label="Created">{fmtDate(soDetail.date)}</KV>
              </div>
              <div className="muted-note">
                Line-item detail withheld (PHI). Patient name masked — PHI protected.
              </div>
            </div>
          ) : (
            <div className="page-sub" style={{ padding: 16 }}>Loading sales-order detail…</div>
          )}
        </DetailModal>
      )}

      {/* ── PURCHASE-ORDER DETAIL (full — key deliverable) ───────── */}
      {mode === 'purchase' && expandedPoId != null && (
        <DetailModal
          title={poDetail?.ref ?? 'Purchase Order'}
          sub={poDetail ? `Purchase order · ${poDetail.vendor || '—'}` : 'Loading…'}
          onClose={() => setExpandedPoId(null)}
        >
          {detailErr ? (
            <div className="error">{detailErr}</div>
          ) : poDetail ? (
            <>
              <div className="section" style={{ marginTop: 0 }}>
                <div className="section-head"><h2 className="section-title">Purchase Order</h2></div>
                <div style={infoGrid}>
                  <KV label="Raised by">{poDetail.createdBy || '—'}</KV>
                  <KV label="Requested by">{poDetail.requestedBy || '—'}</KV>
                  <KV label="Contact">{poDetail.contact || '—'}</KV>
                  <KV label="Vendor">
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {poDetail.vendor || '—'}
                      <StatusPill status={poDetail.status} />
                    </span>
                  </KV>
                  <KV label="Type">{poDetail.type || '—'}</KV>
                  <KV label="PO Date">{fmtDate(poDetail.poDate)}</KV>
                  <KV label="Promise Date">{fmtDate(poDetail.promiseDate)}</KV>
                  <KV label="Approved Date">{fmtDate(poDetail.approvedDate)}</KV>
                  <KV label="Reviewed Date">{fmtDate(poDetail.reviewedDate)}</KV>
                  <KV label="Accepted by">{poDetail.acceptedBy || '—'}</KV>
                  <KV label="Last updated by">{poDetail.lastUpdatedBy || '—'}</KV>
                  <KV label="Payment Term">{poDetail.paymentTerm || '—'}</KV>
                  <KV label="Account">{poDetail.account || '—'}</KV>
                  <KV label="Drop-ship">{poDetail.dropShipCustomer || '—'}</KV>
                </div>
                <div className="muted-note">Drop-ship customer masked — PHI protected.</div>
              </div>

              <div className="section">
                <div className="section-head"><h2 className="section-title">Line Items — what was purchased</h2></div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Description</th>
                        <th className="num">Qty</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poDetail.lineItems.map((li, i) => (
                        <tr key={i}>
                          <td><strong>{li.item || '—'}</strong></td>
                          <td>{li.description || '—'}</td>
                          <td className="num">{li.qty.toLocaleString()}</td>
                          <td className="num">{formatCurrency(li.amount)}</td>
                        </tr>
                      ))}
                      {poDetail.lineItems.length === 0 && (
                        <tr><td colSpan={4} className="muted-note">No line items on this purchase order.</td></tr>
                      )}
                      {poDetail.lineItems.length > 0 && (
                        <tr className="total-row">
                          <td colSpan={3}>TOTAL</td>
                          <td className="num">{formatCurrency(poDetail.total)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="page-sub" style={{ padding: 16 }}>Loading purchase-order detail…</div>
          )}
        </DetailModal>
      )}
    </div>
  );
}
