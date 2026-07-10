import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  fetchStrivenAccounts, fetchStrivenPayments, fetchStrivenBillPayments,
  type AccountsResult, type GlAccount, type PaymentsResult, type BillPaymentsResult,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { KpiCard } from './KpiCard';
import { StatusPill } from './StatusPill';
import { C, SERIES, monthLabel } from '../chartTheme';
import { ChartCard, RankBar, TrendArea, DrillModal } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// A recorded bill payment means the vendor bill HAS been settled — show it as paid,
// unless Striven explicitly voided/cancelled the charge.
const isPaid = (status: string) => !/cancel|void|fail|reject|denied/i.test(status || '');
const PaidBadge = ({ status }: { status: string }) =>
  isPaid(status)
    ? <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>
    : <StatusPill status={status} />;

type Drill = { title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] };

export function AccountsTab() {
  const [accts, setAccts] = useState<AccountsResult | null>(null);
  const [pay, setPay] = useState<PaymentsResult | null>(null);
  const [bp, setBp] = useState<BillPaymentsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKpi, setOpenKpi] = useState<number | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [a, p, b] = await Promise.all([
        fetchStrivenAccounts(), fetchStrivenPayments(), fetchStrivenBillPayments(),
      ]);
      setAccts(a); setPay(p); setBp(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const accounts: GlAccount[] = accts?.accounts ?? [];
  const activeCount = useMemo(() => accounts.filter((a) => a.active).length, [accounts]);
  const inactiveCount = accounts.length - activeCount;

  // GL accounts grouped by type → counts (ranked bar + KPI breakdown).
  const typeData = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) {
      const t = (a.type || 'Uncategorized').trim() || 'Uncategorized';
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [accounts]);

  // Bill payments grouped by vendor → amount paid (ranked money bar).
  const bpByVendor = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of bp?.recent ?? []) m.set(r.vendor || '—', (m.get(r.vendor || '—') ?? 0) + r.amount);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [bp]);

  const paidCount = useMemo(() => (bp?.recent ?? []).filter((r) => isPaid(r.status)).length, [bp]);

  // Chart of accounts sorted by type → number → name.
  const sortedAccounts = useMemo(
    () => [...accounts].sort(
      (x, y) =>
        (x.type || '').localeCompare(y.type || '') ||
        (x.number || '').localeCompare(y.number || '', undefined, { numeric: true }) ||
        (x.name || '').localeCompare(y.name || ''),
    ),
    [accounts],
  );

  function openTypeDrill(type: string) {
    const rows = accounts
      .filter((a) => ((a.type || 'Uncategorized').trim() || 'Uncategorized') === type)
      .sort((x, y) => (x.number || '').localeCompare(y.number || '', undefined, { numeric: true }))
      .map((a) => ({
        number: a.number || '—',
        name: <strong>{a.name || '—'}</strong>,
        active: a.active ? <StatusPill status="Active" /> : <span className="muted-note" style={{ margin: 0 }}>–</span>,
      }));
    setDrill({
      title: `${type} accounts`,
      sub: `${rows.length} account${rows.length === 1 ? '' : 's'} of this type`,
      columns: [{ key: 'number', label: 'Account No' }, { key: 'name', label: 'Account Name' }, { key: 'active', label: 'Status' }],
      rows,
    });
  }

  function openBpDrill(vendor: string) {
    const list = (bp?.recent ?? []).filter((r) => (r.vendor || '—') === vendor);
    const sum = list.reduce((t, r) => t + r.amount, 0);
    setDrill({
      title: `Bill Payments — ${vendor}`,
      sub: `${list.length} paid · ${formatCurrency(sum)}`,
      columns: [
        { key: 'ref', label: 'Reference' }, { key: 'account', label: 'Paid from' },
        { key: 'date', label: 'Paid on' }, { key: 'amount', label: 'Amount', num: true }, { key: 'status', label: 'Status' },
      ],
      rows: list.map((r) => ({
        ref: <strong>{r.ref}</strong>, account: r.account || '—', date: fmtDate(r.date),
        amount: formatCurrency(r.amount), status: <PaidBadge status={r.status} />,
      })),
    });
  }

  const kpi = (i: number) => ({ open: openKpi === i, onClick: () => setOpenKpi((o) => (o === i ? null : i)), onClose: () => setOpenKpi(null) });
  const ready = accts && pay && bp;

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · chart of accounts &amp; money movement · live from Striven
            <span
              style={{
                marginLeft: 10, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                background: C.brandLight, color: C.brandDark, border: '1px solid #bfd3f2',
              }}
            >
              🔒 PHI masked
            </span>
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !ready && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          {/* ── KPIs — every card opens a sub-KPI breakdown ─────────── */}
          <div className="kpis" style={{ marginTop: 8 }}>
            <KpiCard
              label="GL Accounts" period={`${typeData.length} account types`} value={accounts.length.toLocaleString()}
              info={{ formula: 'Count of every general-ledger account in the Striven chart of accounts, broken out by type.' }}
              breakdown={[
                ...typeData.slice(0, 8).map((t) => ({ label: t.name, value: t.value.toLocaleString() })),
                { label: 'Total accounts', value: accounts.length.toLocaleString(), strong: true },
              ]}
              active={openKpi === 0} {...kpi(0)}
            />
            <KpiCard
              label="Payments Received" period={`${pay.count.toLocaleString()} payments`} value={formatCurrency(pay.total)} trend="up"
              info={{ formula: 'Sum of every customer payment received (money in), excluding voided. Broken out by month.' }}
              breakdown={[
                ...pay.byMonth.map((m) => ({ label: monthLabel(m.month), value: formatCurrency(m.amount) })),
                { label: 'Total received', value: formatCurrency(pay.total), strong: true },
              ]}
              active={openKpi === 1} {...kpi(1)}
            />
            <KpiCard
              label="Bills Paid" period={`${paidCount} of ${bp.count} paid`} value={formatCurrency(bp.total)} trend="up"
              info={{ formula: 'Vendor bills settled through Striven (money out). Every recorded bill payment is marked paid.' }}
              breakdown={[
                ...bpByVendor.map((v) => ({ label: v.name, value: formatCurrency(v.value), sub: 'paid' })),
                { label: 'Total paid', value: formatCurrency(bp.total), strong: true },
              ]}
              active={openKpi === 2} {...kpi(2)}
            />
            <KpiCard
              label="Active Accounts" period={accounts.length ? `${Math.round((activeCount / accounts.length) * 100)}% of ledger` : ''} value={activeCount.toLocaleString()}
              trend={activeCount >= inactiveCount ? 'up' : 'down'}
              info={{ formula: 'GL accounts flagged active in Striven — these post to the ledger. Inactive are archived.' }}
              breakdown={[
                { label: 'Active', value: activeCount.toLocaleString() },
                { label: 'Inactive', value: inactiveCount.toLocaleString() },
                { label: 'Total', value: accounts.length.toLocaleString(), strong: true },
              ]}
              active={openKpi === 3} {...kpi(3)}
            />
          </div>

          {/* ── Charts row: accounts mix + money received ───────────── */}
          <div className="chart-grid">
            <ChartCard title="Accounts by Type" sub={`${accounts.length.toLocaleString()} GL accounts · click a bar to drill in`}>
              <RankBar data={typeData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={openTypeDrill} />
            </ChartCard>
            <ChartCard title="Payments Received by Month" sub={`${formatCurrency(pay.total)} across ${pay.count.toLocaleString()} payments`}>
              <TrendArea data={pay.byMonth} series={[{ key: 'amount', name: 'Received', color: C.positive }]} idPrefix="acct-pay" />
            </ChartCard>
          </div>

          {/* ── Bill payments — PAID ────────────────────────────────── */}
          <ChartCard
            title="Bill Payments — Paid"
            sub={`${formatCurrency(bp.total)} settled · ${paidCount} of ${bp.count} bill payment${bp.count === 1 ? '' : 's'} marked paid`}
          >
            <div className="paid-banner">
              <span className="paid-banner-check">✓</span>
              <span><strong>All caught up.</strong> Every recorded bill payment has been settled with the vendor — {formatCurrency(bp.total)} paid.</span>
            </div>
            {bpByVendor.length > 0 && <RankBar data={bpByVendor} money colorAt={() => C.positive} onSelect={openBpDrill} />}
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th><th>Vendor</th><th>Paid from</th><th>Paid on</th>
                    <th className="num">Amount</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bp.recent.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.ref}</strong></td>
                      <td>{r.vendor || '—'}</td>
                      <td>{r.account || '—'}</td>
                      <td>{fmtDate(r.date)}</td>
                      <td className="num">{formatCurrency(r.amount)}</td>
                      <td><PaidBadge status={r.status} /></td>
                    </tr>
                  ))}
                  {bp.recent.length === 0 && (
                    <tr><td colSpan={6} className="muted-note">No bill payments on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </ChartCard>

          {/* ── Recent payments received ────────────────────────────── */}
          <ChartCard title="Recent Payments Received" sub={`Latest of ${pay.count.toLocaleString()} customer payments · patient names masked`}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th><th>Patient</th><th>Received on</th>
                    <th className="num">Amount</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pay.recent.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.ref}</strong></td>
                      <td>{r.customer || '—'}</td>
                      <td>{fmtDate(r.date)}</td>
                      <td className="num">{formatCurrency(r.amount)}</td>
                      <td><StatusPill status={r.status} /></td>
                    </tr>
                  ))}
                  {pay.recent.length === 0 && (
                    <tr><td colSpan={5} className="muted-note">No payments on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-note">Patient names masked — PHI protected.</div>
          </ChartCard>

          {/* ── Chart of accounts (full ledger) ─────────────────────── */}
          <ChartCard title="Chart of Accounts" sub={`${accounts.length.toLocaleString()} GL accounts · sorted by type`}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Account No</th><th>Account Name</th><th>Type</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {sortedAccounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.number || '—'}</td>
                      <td><strong>{a.name || '—'}</strong></td>
                      <td>{a.type || '—'}</td>
                      <td>{a.active ? <StatusPill status="Active" /> : <span className="muted-note" style={{ margin: 0 }}>–</span>}</td>
                    </tr>
                  ))}
                  {sortedAccounts.length === 0 && (
                    <tr><td colSpan={4} className="muted-note">No GL accounts on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {accts.note && <div className="muted-note">{accts.note}</div>}
          </ChartCard>
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
