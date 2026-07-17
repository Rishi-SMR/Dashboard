import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { C, SERIES } from '../chartTheme';
import { formatCurrency } from '../format';
import { ChartCard, RankBar, DrillModal } from '../chartKit';
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
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';

type Mode = 'sales' | 'purchase';

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
  const [openKpi, setOpenKpi] = useState<number | null>(null);

  // Chart-click drill (shared kit DrillModal).
  const [drill, setDrill] = useState<Drill | null>(null);

  // Row-click detail: one expanded id per view + a cache of loaded details keyed by id.
  const [expandedSoId, setExpandedSoId] = useState<number | null>(null);
  const [soDetails, setSoDetails] = useState<Record<number, SoDetail>>({});
  const [expandedPoId, setExpandedPoId] = useState<number | null>(null);
  const [poDetails, setPoDetails] = useState<Record<number, PoDetail>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([fetchStrivenSO(), fetchStrivenPO()]);
      setSo(s);
      setPo(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orders. Is the backend running on :4747?');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function switchMode(m: Mode) {
    setMode(m);
    setOpenKpi(null);
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

  const kpi = (i: number) => ({
    open: openKpi === i,
    onClick: () => setOpenKpi((o) => (o === i ? null : i)),
    onClose: () => setOpenKpi(null),
  });

  // SO by status — ranked bar (per-cell SERIES), sorted desc, empties dropped.
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

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">ORDERS</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven · {records.toLocaleString()} records
            <span
              style={{
                marginLeft: 10,
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                background: C.brandLight,
                color: C.brandDark,
                border: '1px solid #bfd3f2',
              }}
            >
              🔒 PHI masked
            </span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          ↻ Refresh
        </button>
      </div>

      <div className="segmented" style={{ marginTop: 6 }}>
        <button className={mode === 'sales' ? 'active' : ''} onClick={() => switchMode('sales')}>
          Sales Orders
        </button>
        <button className={mode === 'purchase' ? 'active' : ''} onClick={() => switchMode('purchase')}>
          Purchase Orders
        </button>
      </div>

      {error && <div className="error" style={{ margin: '10px 0' }}>{error}</div>}
      {loading && !so && !po && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* ── SALES ORDERS ─────────────────────────────────────────── */}
      {mode === 'sales' && so && (
        <>
          <div className="kpis" style={{ marginTop: 16 }}>
            <KpiCard
              label="Total Order Value" value={formatCurrency(so.totalValue)} period={`${so.count.toLocaleString()} orders · ${so.demoCount} demo excluded`}
              info={{ formula: 'Sum of order value across all live sales orders (DEMO/test orders excluded), broken out by PI / VA / Tri-Care.' }}
              breakdown={[
                ...so.byType.map((t) => ({ label: t.type, value: formatCurrency(t.value) })),
                { label: 'Total', value: formatCurrency(so.totalValue), strong: true },
              ]}
              active={openKpi === 0} {...kpi(0)}
            />
            <KpiCard label="PI Orders" value={so.piva.PI.count.toLocaleString()} period={formatCurrency(so.piva.PI.value)} trend="up"
              info={{ formula: 'Personal-Injury sales orders (order type = "PI Order"). Count and total order value.' }}
              breakdown={[{ label: 'PI orders', value: so.piva.PI.count.toLocaleString() }, { label: 'PI value', value: formatCurrency(so.piva.PI.value), strong: true }]}
              active={openKpi === 1} {...kpi(1)} />
            <KpiCard label="VA Orders" value={so.piva.VA.count.toLocaleString()} period={formatCurrency(so.piva.VA.value)} trend="up"
              info={{ formula: 'Veterans Affairs sales orders (order type = "VA Order"). Count and total order value.' }}
              breakdown={[{ label: 'VA orders', value: so.piva.VA.count.toLocaleString() }, { label: 'VA value', value: formatCurrency(so.piva.VA.value), strong: true }]}
              active={openKpi === 2} {...kpi(2)} />
            <KpiCard label="Tri-Care Orders" value={so.piva.TriCare.count.toLocaleString()} period={formatCurrency(so.piva.TriCare.value)}
              info={{ formula: 'A third order type "Tri-Care" exists in Striven (military health) beyond PI/VA — flagged for confirmation.' }}
              breakdown={[{ label: 'Tri-Care orders', value: so.piva.TriCare.count.toLocaleString() }, { label: 'Tri-Care value', value: formatCurrency(so.piva.TriCare.value), strong: true }]}
              active={openKpi === 3} {...kpi(3)} />
          </div>

          {!so.enriched && <div className="info-banner"><span className="info-banner-icon">ℹ</span><span>Order type / rep / value enrichment is still populating — numbers will fill in shortly.</span></div>}

          <div className="chart-grid">
            <ChartCard title="Order Value by Type" sub="PI vs VA vs Tri-Care · DEMO excluded">
              <RankBar data={so.byType.map((t) => ({ name: t.type, value: t.value }))} money colorAt={(i) => SERIES[i % SERIES.length]} />
            </ChartCard>
            <ChartCard title="Sales Orders by Status" sub={`${so.count.toLocaleString()} orders · click a bar to drill in`}>
              <RankBar data={statusData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={drillSoStatus} />
            </ChartCard>
          </div>

          <ChartCard title="Top Sales Reps by Order Value" sub="Sales rep on the sales order — referral group removed, no patient data">
            <RankBar data={so.byRep.map((r) => ({ name: r.rep, value: r.value }))} money colorAt={() => C.brand} />
          </ChartCard>

          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><div><h2 className="section-title">Recent Sales Orders</h2><div className="section-sub">Order # · sales rep · payer (law firm / VA / TriCare) · no patient data</div></div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Order #</th><th>PI/VA</th><th>Sales Rep</th><th>Payer</th><th className="num">Value</th><th>Status</th><th>Invoiced</th></tr>
                </thead>
                <tbody>
                  {so.recent.map((o) => (
                    <tr key={o.id}>
                      <td><strong>{o.ref}</strong></td>
                      <td><StatusPill status={o.type} /></td>
                      <td>{o.rep || '—'}</td>
                      <td>{o.payer || '—'}</td>
                      <td className="num">{formatCurrency(o.value)}</td>
                      <td><StatusPill status={o.status} /></td>
                      <td>{o.invStatus || '—'}</td>
                    </tr>
                  ))}
                  {so.recent.length === 0 && (
                    <tr><td colSpan={7} className="muted-note">No sales orders.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── PURCHASE ORDERS ──────────────────────────────────────── */}
      {mode === 'purchase' && po && (
        <>
          <div className="kpis" style={{ marginTop: 16 }}>
            <KpiCard
              label="Purchase Orders"
              value={po.count.toLocaleString()}
              period={`active${po.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''}`}
              info={{ formula: 'Count of active purchase orders (cancelled/voided POs are excluded from every figure on this tab).' }}
              breakdown={[
                { label: 'Active', value: po.count.toLocaleString() },
                ...(po.cancelledCount ? [{ label: 'Cancelled (excluded)', value: po.cancelledCount.toLocaleString() }] : []),
                ...(po.pendingCount ? [{ label: 'Still loading', value: po.pendingCount.toLocaleString() }] : []),
                { label: 'Total on record', value: (po.totalCount ?? po.count).toLocaleString(), strong: true },
              ]}
              active={openKpi === 0}
              {...kpi(0)}
            />
            <KpiCard
              label="Total PO Value"
              value={formatCurrency(po.totalValue)}
              period={`active POs only${po.cancelledCount ? ` · excl. ${formatCurrency(po.cancelledValue ?? 0)} cancelled` : ''}`}
              info={{ formula: 'Sum of the value of every ACTIVE purchase order. Cancelled/voided POs are excluded. Top vendors by spend below.' }}
              breakdown={[
                ...[...po.byVendor]
                  .sort((a, b) => b.total - a.total)
                  .slice(0, 6)
                  .map((v) => ({ label: v.vendor || '—', value: formatCurrency(v.total) })),
                ...(po.cancelledValue ? [{ label: 'Cancelled (excluded)', value: formatCurrency(po.cancelledValue) }] : []),
                { label: 'Active total', value: formatCurrency(po.totalValue), strong: true },
              ]}
              active={openKpi === 1}
              {...kpi(1)}
            />
          </div>

          <div className="chart-grid">
            <ChartCard
              title="Top Vendors by PO Spend"
              sub={`Active purchase orders only${po.cancelledCount ? ` · excludes ${po.cancelledCount} cancelled (${formatCurrency(po.cancelledValue ?? 0)})` : ''}${po.pendingCount ? ` · ${po.pendingCount} still loading` : ''} · click a bar to drill in`}
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
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {po.recent.map((o) => (
                    <tr key={o.id} onClick={() => openPo(o.id)} style={{ cursor: 'pointer' }}>
                      <td><strong>{o.ref}</strong></td>
                      <td>{o.vendor || '—'}</td>
                      <td className="num">{formatCurrency(o.total)}</td>
                      <td>{fmtDate(o.date)}</td>
                    </tr>
                  ))}
                  {po.recent.length === 0 && (
                    <tr><td colSpan={4} className="muted-note">No recent purchase orders.</td></tr>
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
