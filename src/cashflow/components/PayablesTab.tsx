import { useEffect, useMemo, useState } from 'react';
import {
  fetchStrivenAP, fetchStrivenVendors, fetchStrivenPO, fetchStrivenBillPayments,
  type ApResult, type VendorsResult, type PoResult, type BillPaymentsResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, AGING_LABELS } from '../chartTheme';
import { ChartCard, RankBar, AgingBar, DrillModal } from '../chartKit';

const VENDOR_CAP = 50;

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// A recorded bill payment means the vendor bill HAS been settled — show it as paid,
// unless Striven explicitly voided/cancelled the charge.
const isPaid = (status: string) => !/cancel|void|fail|reject|denied/i.test(status || '');
const PaidBadge = ({ status }: { status: string }) =>
  isPaid(status)
    ? <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>
    : <StatusPill status={status} />;

export function PayablesTab() {
  const [ap, setAp] = useState<ApResult | null>(null);
  const [vendors, setVendors] = useState<VendorsResult | null>(null);
  const [po, setPo] = useState<PoResult | null>(null);
  const [bp, setBp] = useState<BillPaymentsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; rows: Record<string, React.ReactNode>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, v, o, p] = await Promise.all([
        fetchStrivenAP(), fetchStrivenVendors(), fetchStrivenPO(), fetchStrivenBillPayments(),
      ]);
      setAp(a); setVendors(v); setPo(o); setBp(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Payables data.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Top vendors by PO spend — horizontal ranked bar (brand blue), sorted desc.
  const vendorData = useMemo(
    () => [...(po?.byVendor ?? [])]
      .filter((v) => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((v) => ({ name: v.vendor || '—', value: v.total })),
    [po],
  );

  // Click a vendor bar → drill into that vendor's recent purchase orders.
  function openVendorDrill(name: string) {
    const rows = (po?.recent ?? [])
      .filter((r) => (r.vendor || '—') === name)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((r) => ({ ref: r.ref || '—', date: fmtDate(r.date), amt: formatCurrency(r.total) }));
    setDrill({ title: name, sub: `${rows.length} purchase order${rows.length === 1 ? '' : 's'} on record`, rows });
  }

  const bills = ap?.bills ?? [];
  const billTotal = useMemo(() => bills.reduce((s, b) => s + (b.total || 0), 0), [bills]);
  const billOpenTotal = useMemo(() => bills.reduce((s, b) => s + (b.open || 0), 0), [bills]);
  const payments = bp?.recent ?? [];
  const payShownTotal = useMemo(() => payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);
  const paidCount = useMemo(() => payments.filter((p) => isPaid(p.status)).length, [payments]);
  const paidByVendor = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of payments) m.set(p.vendor || '—', (m.get(p.vendor || '—') ?? 0) + (p.amount || 0));
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [payments]);
  const vendorRows = (vendors?.vendors ?? []).slice(0, VENDOR_CAP);
  const moreVendors = Math.max(0, (vendors?.vendors.length ?? 0) - vendorRows.length);

  const kpi = (i: number) => ({
    open: openKpi === i, active: openKpi === i,
    onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null),
  });

  const ready = !!ap;

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">PAYABLES</h1>
          <div className="page-sub">
            <span className="live-dot" /> Striven · {ready ? `${ap!.count} open bills` : 'loading…'}
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ap && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          {/* Headline payables KPIs — tap any card for the formula. */}
          <div className="kpis">
            <KpiCard
              label="AP Open"
              period={`${ap!.count} open bills`}
              value={formatCurrency(ap!.totalOpen)}
              trend="down"
              info={{ formula: 'Sum of the unpaid (open) balance across every open vendor bill, split by how overdue each balance is.' }}
              breakdown={AGING_LABELS.map((b) => ({ label: b.label, value: formatCurrency(ap!.aging[b.key] || 0) }))
                .concat([{ label: 'Total open', value: formatCurrency(ap!.totalOpen), strong: true } as any])}
              {...kpi(0)}
            />
            <KpiCard
              label="# Open Bills"
              period="awaiting payment"
              value={String(ap!.count)}
              info={{ formula: 'Count of vendor bills that still carry a remaining open balance (fully paid bills are excluded).' }}
              breakdown={[
                { label: 'Open bills', value: String(ap!.count) },
                { label: 'Billed total', value: formatCurrency(billTotal), sub: 'across shown bills' },
                { label: 'Open balance', value: formatCurrency(ap!.totalOpen), strong: true },
              ]}
              {...kpi(1)}
            />
            <KpiCard
              label="PO Total"
              period={`${po?.count ?? 0} active POs${po?.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''}`}
              value={formatCurrency(po?.totalValue ?? 0)}
              info={{ formula: 'Sum of the value of every ACTIVE purchase order in Striven. Cancelled/voided POs are excluded.' }}
              breakdown={[...(po?.byVendor ?? [])]
                .sort((a, b) => b.total - a.total)
                .slice(0, 5)
                .map((v, i) => ({ label: v.vendor || '—', value: formatCurrency(v.total), strong: i === 0 }))
                .concat(po?.cancelledValue ? [{ label: 'Cancelled (excluded)', value: formatCurrency(po.cancelledValue) } as any] : [])
                .concat([{ label: 'Active total', value: formatCurrency(po?.totalValue ?? 0), strong: true } as any])}
              {...kpi(2)}
            />
            <KpiCard
              label="Bills Paid"
              period={`${paidCount} of ${bp?.count ?? 0} paid`}
              value={formatCurrency(bp?.total ?? 0)}
              trend="up"
              info={{ formula: 'Total settled to vendors in Striven — every recorded bill payment is marked paid. The cash side of payables.' }}
              breakdown={[
                ...paidByVendor.map((v) => ({ label: v.name, value: formatCurrency(v.value), sub: 'paid' })),
                { label: 'Total paid', value: formatCurrency(bp?.total ?? 0), strong: true },
              ]}
              {...kpi(3)}
            />
          </div>

          {/* Uniform 2-col chart grid. */}
          <div className="chart-grid">
            <ChartCard title="Top Vendors by PO Spend" sub={`Active POs only${po?.cancelledCount ? ` · ${po.cancelledCount} cancelled excluded` : ''} · click a bar to drill`}>
              <RankBar data={vendorData} money colorAt={() => C.brand} onSelect={openVendorDrill} />
            </ChartCard>

            <ChartCard title="AP Aging" sub="Open payables by days past due">
              <AgingBar aging={ap!.aging} />
            </ChartCard>
          </div>

          {/* ── OPEN BILLS ──────────────────────────────────────────── */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><h2 className="section-title">Open Bills</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Bill #</th>
                    <th>Vendor</th>
                    <th>Due</th>
                    <th className="num">Total</th>
                    <th className="num">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.id}>
                      <td><strong>#{b.number}</strong></td>
                      <td>{b.vendor || '—'}</td>
                      <td>{fmtDate(b.dueDate)}</td>
                      <td className="num">{formatCurrency(b.total)}</td>
                      <td className="num cell-neg">{formatCurrency(b.open)}</td>
                    </tr>
                  ))}
                  {bills.length === 0 && (
                    <tr><td colSpan={5} style={{ color: C.muted }}>No open bills.</td></tr>
                  )}
                  {bills.length > 0 && (
                    <tr className="total-row">
                      <td><strong>Total</strong></td>
                      <td>{bills.length} bill{bills.length === 1 ? '' : 's'}</td>
                      <td></td>
                      <td className="num">{formatCurrency(billTotal)}</td>
                      <td className="num">{formatCurrency(billOpenTotal)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── BILLS PAID ──────────────────────────────────────────── */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head">
              <div>
                <h2 className="section-title">Bills Paid</h2>
                <div className="section-sub">Vendor bills settled through Striven · {formatCurrency(bp?.total ?? 0)} paid</div>
              </div>
            </div>
            {payments.length > 0 && (
              <div className="paid-banner">
                <span className="paid-banner-check">✓</span>
                <span><strong>All settled.</strong> {paidCount === payments.length ? 'Every' : `${paidCount} of ${payments.length}`} recorded bill payment{payments.length === 1 ? ' has' : 's have'} been paid to the vendor — {formatCurrency(payShownTotal)} total.</span>
              </div>
            )}
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Vendor</th>
                    <th>Paid from</th>
                    <th>Paid on</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.ref || '—'}</strong></td>
                      <td>{p.vendor || '—'}</td>
                      <td>{p.account || '—'}</td>
                      <td>{fmtDate(p.date)}</td>
                      <td className="num cell-pos">{formatCurrency(p.amount)}</td>
                      <td><PaidBadge status={p.status} /></td>
                    </tr>
                  ))}
                  {payments.length === 0 && (
                    <tr><td colSpan={6} style={{ color: C.muted }}>No bills paid yet.</td></tr>
                  )}
                  {payments.length > 0 && (
                    <tr className="total-row">
                      <td><strong>Total paid</strong></td>
                      <td>{payments.length} payment{payments.length === 1 ? '' : 's'}</td>
                      <td></td>
                      <td></td>
                      <td className="num">{formatCurrency(payShownTotal)}</td>
                      <td></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── VENDORS ─────────────────────────────────────────────── */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><h2 className="section-title">Vendors</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Terms</th>
                    <th>Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((v) => (
                    <tr key={v.id}>
                      <td><strong>{v.name || '—'}</strong></td>
                      <td><StatusPill status={v.status} /></td>
                      <td>{v.terms || '—'}</td>
                      <td>{v.phone || '—'}</td>
                    </tr>
                  ))}
                  {vendorRows.length === 0 && (
                    <tr><td colSpan={4} style={{ color: C.muted }}>No vendors on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {moreVendors > 0 && <div className="muted-note">Showing first {VENDOR_CAP} of {vendors?.vendors.length ?? 0} vendors.</div>}
          </div>
        </>
      )}

      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={[
            { key: 'ref', label: 'PO ref' },
            { key: 'date', label: 'Date' },
            { key: 'amt', label: 'Amount', num: true },
          ]}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
