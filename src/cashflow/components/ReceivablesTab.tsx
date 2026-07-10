import { useEffect, useState } from 'react';
import {
  fetchStrivenAR, fetchStrivenPayments, fetchStrivenCustomers,
  type ArResult, type PaymentsResult, type CustomersResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard, type KpiBreakdownRow } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, AGING_LABELS } from '../chartTheme';
import { ChartCard, AgingBar, TrendArea, DrillModal } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// Bucket a single invoice by how overdue it is — labels match AGING_LABELS so a
// clicked aging bar can filter invoices back to the exact bucket it represents.
const bucketOf = (dueDate: string | null): string => {
  if (!dueDate) return 'Current';
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 'Current';
  const days = Math.floor((Date.now() - due) / 86_400_000);
  if (days <= 0) return 'Current';
  if (days <= 30) return '1–30';
  if (days <= 60) return '31–60';
  if (days <= 90) return '61–90';
  return '90+';
};

export function ReceivablesTab() {
  const [ar, setAr] = useState<ArResult | null>(null);
  const [payments, setPayments] = useState<PaymentsResult | null>(null);
  const [customers, setCustomers] = useState<CustomersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | { title: string; sub: string; rows: Record<string, string>[] }>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, pay, cust] = await Promise.all([
        fetchStrivenAR(), fetchStrivenPayments(), fetchStrivenCustomers(),
      ]);
      setAr(a); setPayments(pay); setCustomers(cust);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Receivables data.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });

  // Click an aging bar → list every open invoice that falls in that bucket.
  function openDrillFor(label: string) {
    if (!ar) return;
    const rows = ar.invoices
      .filter((inv) => bucketOf(inv.dueDate) === label)
      .sort((a, b) => (b.open || 0) - (a.open || 0))
      .map((inv) => ({
        number: `#${inv.number}`,
        customer: inv.customer || '—',
        due: fmtDate(inv.dueDate),
        total: formatCurrency(inv.total),
        received: (inv.total || 0) - (inv.open || 0) > 0.005 ? formatCurrency((inv.total || 0) - (inv.open || 0)) : '—',
        open: formatCurrency(inv.open),
      }));
    setDrill({
      title: `Open Invoices · ${label}`,
      sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} in this aging bucket · patient names masked`,
      rows,
    });
  }

  const payData = (payments?.byMonth ?? []).map((m) => ({ month: m.month, amount: m.amount }));

  const invoices = ar?.invoices ?? [];
  const invTotal = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const invOpen = invoices.reduce((s, i) => s + (i.open || 0), 0);
  const payRows = payments?.recent ?? [];
  const payShownTotal = payRows.reduce((s, p) => s + (p.amount || 0), 0);

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Receivables</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · live from Striven
            <span style={{ marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: C.brandLight, color: C.brandDark, border: `1px solid ${C.brandLight}` }}>🔒 PHI masked</span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ar && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ar && payments && customers && (
        <>
          {/* Headline KPIs — tap any card for the formula. */}
          <div className="kpis">
            <KpiCard label="AR Open" period={`${ar.count} open invoices`} value={formatCurrency(ar.totalOpen)}
              info={{ formula: 'Total unpaid balance across open patient invoices — the sum of each invoice’s remaining Open amount, split by how overdue it is.' }}
              breakdown={([
                ...AGING_LABELS.map((b) => ({ label: b.label, value: formatCurrency(ar.aging[b.key] || 0) })),
                { label: 'Total', value: formatCurrency(ar.totalOpen), strong: true },
              ]) as KpiBreakdownRow[]}
              {...kpi(0)} active={openKpi === 0} />
            <KpiCard label="Open Invoices" period="awaiting payment" value={String(ar.count)}
              info={{ formula: 'Count of patient invoices that still carry a remaining balance (not yet fully paid).' }}
              breakdown={[
                { label: 'Open invoices', value: String(ar.count) },
                { label: 'Total open', value: formatCurrency(ar.totalOpen), strong: true },
              ]}
              {...kpi(1)} active={openKpi === 1} />
            <KpiCard label="Cash Received" period={`${payments.count} payments`} value={formatCurrency(payments.total)} trend="up"
              info={{ formula: 'Total customer payments collected and recorded in Striven — actual money in the door.' }}
              breakdown={[
                { label: 'Payments recorded', value: String(payments.count) },
                { label: 'Total received', value: formatCurrency(payments.total), strong: true },
              ]}
              {...kpi(2)} active={openKpi === 2} />
            <KpiCard label="Patients" period="on record" value={String(customers.count)}
              info={{ formula: 'Count of distinct patients (customers) on record in Striven.' }}
              breakdown={[
                { label: 'Active', value: String(customers.customers.filter((c) => /active/i.test(c.status)).length) },
                { label: 'Total patients', value: String(customers.count), strong: true },
              ]}
              {...kpi(3)} active={openKpi === 3} />
          </div>

          {/* Charts — uniform 2-col grid. */}
          <div className="chart-grid">
            <ChartCard title="AR Aging" sub="Open receivables by days past due · click a bar to drill">
              <AgingBar aging={ar.aging} onSelect={openDrillFor} />
            </ChartCard>

            <ChartCard title="Cash Received by Month" sub="Customer payments collected">
              <TrendArea data={payData} idPrefix="rc-pay" series={[{ key: 'amount', name: 'Received', color: C.brand }]} />
            </ChartCard>
          </div>

          {/* Open Invoices */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><div><h2 className="section-title">Open Invoices</h2><div className="section-sub">
              Unpaid patient invoices with a remaining balance — matches Striven's A/R aging
              {(ar.unappliedCredits ?? 0) > 0.005 && <> · <span style={{ color: '#047857', fontWeight: 700 }}>{formatCurrency(ar.unappliedCredits!)}</span> paid but unapplied (netted out)</>}
              {(ar.voidedExcluded ?? 0) > 0.005 && <> · {formatCurrency(ar.voidedExcluded!)} voided excluded</>}
            </div></div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Patient</th>
                    <th>Due</th>
                    <th className="num">Total</th>
                    <th className="num">Received</th>
                    <th className="num">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const recv = (inv.total || 0) - (inv.open || 0);
                    return (
                      <tr key={inv.id}>
                        <td>
                          <strong>#{inv.number}</strong>
                          {recv > 0.005 && <span className="pill-tag tag-ok" style={{ marginLeft: 8, fontSize: 10.5 }}>part-paid</span>}
                        </td>
                        <td>{inv.customer || '—'}</td>
                        <td>{fmtDate(inv.dueDate)}</td>
                        <td className="num">{formatCurrency(inv.total)}</td>
                        <td className="num cell-pos">{recv > 0.005 ? formatCurrency(recv) : '—'}</td>
                        <td className="num cell-neg">{formatCurrency(inv.open)}</td>
                      </tr>
                    );
                  })}
                  {invoices.length === 0 && (
                    <tr><td colSpan={6} style={{ color: C.muted }}>No open invoices.</td></tr>
                  )}
                  {invoices.length > 0 && (
                    <tr className="total-row">
                      <td colSpan={3}>TOTAL</td>
                      <td className="num">{formatCurrency(invTotal)}</td>
                      <td className="num">{formatCurrency(invTotal - invOpen)}</td>
                      <td className="num">{formatCurrency(invOpen)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Patient names masked — PHI protected.</div>
          </div>

          {/* Recent Payments */}
          <div className="section" style={{ marginTop: 16 }}>
            <div className="section-head"><div><h2 className="section-title">Recent Payments</h2><div className="section-sub">Latest customer payments received</div></div></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payment Ref</th>
                    <th>Patient</th>
                    <th>Date</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payRows.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.ref || '—'}</strong></td>
                      <td>{p.customer || '—'}</td>
                      <td>{fmtDate(p.date)}</td>
                      <td className="num cell-pos">{formatCurrency(p.amount)}</td>
                      <td><StatusPill status={p.status} /></td>
                    </tr>
                  ))}
                  {payRows.length === 0 && (
                    <tr><td colSpan={5} style={{ color: C.muted }}>No recent payments.</td></tr>
                  )}
                  {payRows.length > 0 && (
                    <tr className="total-row">
                      <td colSpan={3}>TOTAL</td>
                      <td className="num">{formatCurrency(payShownTotal)}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Patient names masked — PHI protected.</div>
          </div>
        </>
      )}

      {drill && (
        <DrillModal
          title={drill.title}
          sub={drill.sub}
          columns={[
            { key: 'number', label: 'Invoice #' },
            { key: 'customer', label: 'Patient' },
            { key: 'due', label: 'Due' },
            { key: 'total', label: 'Total', num: true },
            { key: 'received', label: 'Received', num: true },
            { key: 'open', label: 'Open', num: true },
          ]}
          rows={drill.rows}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
