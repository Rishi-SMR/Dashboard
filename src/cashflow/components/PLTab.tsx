import { useEffect, useState } from 'react';
import { fetchStrivenPL, type PlResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { C, monthLabel } from '../chartTheme';
import { ChartCard, RankBar, TrendArea } from '../chartKit';

const pct = (n: number) => `${(Number(n) || 0).toFixed(1)}%`;

export function PLTab() {
  const [pl, setPl] = useState<PlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try { setPl(await fetchStrivenPL()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load P&L.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });
  const year = pl ? pl.periodFrom.slice(0, 4) : '';

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Profit &amp; Loss</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · YTD {year} · accrual basis, computed live from Striven invoices &amp; bills
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !pl && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {pl && (
        <>
          {/* ── KPIs (each opens a sub-KPI breakdown) ───────────────── */}
          <div className="kpis" style={{ marginTop: 8 }}>
            <KpiCard
              label="Revenue" period={`${pl.invoiceCount.toLocaleString()} invoices`} value={formatCurrency(pl.revenue)} trend="up"
              info={{ formula: 'Sum of every customer invoice total for the year (voided excluded). Money earned.' }}
              breakdown={[
                ...pl.series.map((m) => ({ label: monthLabel(m.month), value: formatCurrency(m.revenue) })),
                { label: 'Total revenue', value: formatCurrency(pl.revenue), strong: true },
              ]}
              active={openKpi === 0} {...kpi(0)}
            />
            <KpiCard
              label="Expenses" period={`${pl.billCount.toLocaleString()} bills`} value={formatCurrency(pl.expenses)} trend="down"
              info={{ formula: 'Sum of every vendor bill total for the year (voided excluded). Money spent, broken out by vendor.' }}
              breakdown={[
                ...pl.byVendor.slice(0, 8).map((v) => ({ label: v.name, value: formatCurrency(v.value) })),
                { label: 'Total expenses', value: formatCurrency(pl.expenses), strong: true },
              ]}
              active={openKpi === 1} {...kpi(1)}
            />
            <KpiCard
              label="Net Profit" period={`${pct(pl.margin)} net margin`} value={formatCurrency(pl.net)} trend={pl.net >= 0 ? 'up' : 'down'}
              info={{ formula: 'Revenue − Expenses. Net margin = Net ÷ Revenue.' }}
              breakdown={[
                { label: 'Revenue', value: formatCurrency(pl.revenue) },
                { label: 'Expenses', value: formatCurrency(pl.expenses) },
                { label: 'Net profit', value: formatCurrency(pl.net), strong: true },
              ]}
              active={openKpi === 2} {...kpi(2)}
            />
            <KpiCard
              label="Cash Received" period="payments collected" value={formatCurrency(pl.cashReceived)} trend="up"
              info={{ formula: 'Customer payments actually received this year (cash basis) — how much of the billed revenue has been collected.' }}
              active={openKpi === 3} {...kpi(3)}
            />
          </div>

          {/* ── Income statement ────────────────────────────────────── */}
          <ChartCard title={`Income Statement · YTD ${year}`} sub="Accrual basis — invoices as revenue, bills as expense">
            <div className="pl-statement">
              <div className="pl-line"><span className="lbl">Revenue</span><span className="val">{formatCurrency(pl.revenue)}</span></div>
              <div className="pl-line"><span className="lbl">Less: Expenses</span><span className="val neg">−{formatCurrency(pl.expenses)}</span></div>
              <div className="pl-line pl-total"><span className="lbl">Net Profit</span><span className="val">{formatCurrency(pl.net)}</span></div>
              <div className="pl-line pl-sub"><span className="lbl">Net margin</span><span className="val">{pct(pl.margin)}</span></div>
            </div>
            <div className="pl-meta">
              <div><span>Avg invoice</span><strong>{formatCurrency(pl.avgInvoice)}</strong></div>
              <div><span>Avg bill</span><strong>{formatCurrency(pl.avgBill)}</strong></div>
              <div><span>Cash collected</span><strong>{formatCurrency(pl.cashReceived)}</strong></div>
            </div>
          </ChartCard>

          {/* ── Trend + expense mix ─────────────────────────────────── */}
          <div className="chart-grid">
            <ChartCard title="Revenue vs Expenses by Month" sub={`${pl.series.length} month${pl.series.length === 1 ? '' : 's'} · YTD ${year}`}>
              <TrendArea
                data={pl.series}
                series={[{ key: 'revenue', name: 'Revenue', color: C.positive }, { key: 'expenses', name: 'Expenses', color: C.negative }]}
                idPrefix="pl-rev"
              />
            </ChartCard>
            <ChartCard title="Expenses by Vendor" sub={`${formatCurrency(pl.expenses)} across ${pl.billCount} bill${pl.billCount === 1 ? '' : 's'}`}>
              <RankBar data={pl.byVendor} money colorAt={() => C.negative} />
            </ChartCard>
          </div>

          {/* ── Monthly P&L table ───────────────────────────────────── */}
          <ChartCard title="Monthly P&L" sub="Revenue, expenses and net profit per month">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Month</th><th className="num">Revenue</th><th className="num">Expenses</th>
                    <th className="num">Net</th><th className="num">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {pl.series.map((m) => (
                    <tr key={m.month}>
                      <td><strong>{monthLabel(m.month)} {m.month.slice(0, 4)}</strong></td>
                      <td className="num">{formatCurrency(m.revenue)}</td>
                      <td className="num">{formatCurrency(m.expenses)}</td>
                      <td className="num" style={{ color: m.net >= 0 ? '#047857' : '#b91c1c', fontWeight: 700 }}>{formatCurrency(m.net)}</td>
                      <td className="num">{m.revenue ? pct((m.net / m.revenue) * 100) : '—'}</td>
                    </tr>
                  ))}
                  {pl.series.length === 0 && <tr><td colSpan={5} className="muted-note">No transactions in the period.</td></tr>}
                  {pl.series.length > 0 && (
                    <tr className="total-row">
                      <td>TOTAL</td>
                      <td className="num">{formatCurrency(pl.revenue)}</td>
                      <td className="num">{formatCurrency(pl.expenses)}</td>
                      <td className="num">{formatCurrency(pl.net)}</td>
                      <td className="num">{pct(pl.margin)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">
              Accrual basis · computed from {pl.invoiceCount} invoices &amp; {pl.billCount} bills. Striven's API has no P&amp;L report endpoint, so this statement is derived live from the underlying transactions.
            </div>
          </ChartCard>
        </>
      )}
    </div>
  );
}
