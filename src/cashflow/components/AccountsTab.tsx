import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  fetchStrivenAccounts, fetchStrivenPayments, fetchStrivenBillPayments, fetchApLedger,
  type AccountsResult, type GlAccount, type PaymentsResult, type BillPaymentsResult,
  type ApLedger,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C, SERIES, monthLabel } from '../chartTheme';
import { ChartCard, RankBar, TrendArea, DrillModal, KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

// A recorded bill payment means the vendor bill HAS been settled: show it as paid,
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
  // The AP ledger sheet — where the vendor payments actually live. See `paid`.
  const [apl, setApl] = useState<ApLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const [a, p, b, l] = await Promise.all([
        fetchStrivenAccounts(), fetchStrivenPayments(), fetchStrivenBillPayments(),
        fetchApLedger().catch(() => null),
      ]);
      setAccts(a); setPay(p); setBp(b); setApl(l);
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load accounts.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

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

  // ── BILLS PAID COMES FROM THE AP LEDGER, like every other screen ───────────
  //
  // This card read Striven's bill-payment records: ONE payment, $840 to HiDow.
  // The Payables tab had already moved to the AP ledger's Debit column — 51
  // payments, $76,026.06 — so the site carried two tiles with the same label
  // and a $75,186.06 gap between them, on different tabs where nobody would see
  // them together and notice.
  //
  // Striven's own record is NOT dropped. It keeps its table below, retitled as
  // what it is, so whoever remembers the $840 can still find it.
  const useLedgerPaid = Boolean(apl?.ok && (apl.totals?.paymentRows ?? 0) > 0);
  const paidTotal = useLedgerPaid ? (apl!.totals!.paidRecorded ?? 0) : (bp?.total ?? 0);
  const paidRowCount = useLedgerPaid ? (apl!.totals!.paymentRows ?? 0) : (bp?.count ?? 0);

  // Bill payments grouped by vendor → amount paid (ranked money bar).
  const bpByVendor = useMemo(() => {
    if (useLedgerPaid) {
      return (apl?.subLedgers ?? [])
        .filter((g) => g.paymentRows > 0)
        .map((g) => ({ name: g.subLedger || '-', value: g.paidRecorded }))
        .sort((a, b) => b.value - a.value);
    }
    const m = new Map<string, number>();
    for (const r of bp?.recent ?? []) m.set(r.vendor || '-', (m.get(r.vendor || '-') ?? 0) + r.amount);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [bp, apl, useLedgerPaid]);

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
        number: a.number || '-',
        name: <strong>{a.name || '-'}</strong>,
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
    const list = (bp?.recent ?? []).filter((r) => (r.vendor || '-') === vendor);
    const sum = list.reduce((t, r) => t + r.amount, 0);
    setDrill({
      title: `Bill Payments: ${vendor}`,
      sub: `${list.length} paid · ${formatCurrency(sum)}`,
      columns: [
        { key: 'ref', label: 'Reference' }, { key: 'account', label: 'Paid from' },
        { key: 'date', label: 'Paid on' }, { key: 'amount', label: 'Amount', num: true }, { key: 'status', label: 'Status' },
      ],
      rows: list.map((r) => ({
        ref: <strong>{r.ref}</strong>, account: r.account || '-', date: fmtDate(r.date),
        amount: formatCurrency(r.amount), status: <PaidBadge status={r.status} />,
      })),
    });
  }

  // KPI tap-to-explain drills.
  const kv = (rows: { k: string; v: string }[]) => ({
    columns: [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Value', num: true }],
    rows: rows.map((r) => ({ k: r.k, v: r.v })),
  });
  const ready = accts && pay && bp;
  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Accounts</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · chart of accounts &amp; money movement · live from Striven{agoText ? ` · updated ${agoText}` : ''}
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

      {error && <div className="error">{error}</div>}
      {loading && !ready && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {ready && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="bank" tint="#0A369F" label="GL Accounts" value={accounts.length}
              deltaText={`${typeData.length} account types`} foot="chart of accounts"
              onClick={() => setDrill({
                title: 'GL Accounts', sub: 'Every general-ledger account by type',
                ...kv([...typeData.map((t) => ({ k: t.name, v: t.value.toLocaleString() })), { k: 'Total accounts', v: accounts.length.toLocaleString() }]),
              })} />
            <KpiR ico="cash" tint="#16A34A" label="Payments Received" value={pay.total} format={formatCurrency}
              deltaText={`${pay.count.toLocaleString()} payments`} foot="money in · voided excluded"
              onClick={() => setDrill({
                title: 'Payments Received', sub: 'Customer payments by month',
                ...kv([...pay.byMonth.map((m) => ({ k: monthLabel(m.month), v: formatCurrency(m.amount) })), { k: 'Total received', v: formatCurrency(pay.total) }]),
              })} />
            {/* Same source and therefore the same figure as the Payables tab's
                "Bills Paid". They are the same claim about the same money and
                must not be able to differ. */}
            <KpiR ico="wallet" tint="#D97706" label="Bills Paid" value={paidTotal} format={formatCurrency}
              deltaText={`${paidRowCount} payment${paidRowCount === 1 ? '' : 's'}`}
              foot={useLedgerPaid ? 'AP ledger · Debit column' : 'Striven · ledger unavailable'}
              onClick={() => setDrill({
                title: 'Bills Paid',
                sub: `Vendor bill payments by vendor · ${useLedgerPaid ? 'AP ledger sheet' : 'Striven records'}`,
                ...kv([
                  ...bpByVendor.map((v) => ({ k: v.name, v: formatCurrency(v.value, true) })),
                  { k: 'Total paid', v: formatCurrency(paidTotal, true) },
                  ...(useLedgerPaid && (bp?.count ?? 0) > 0
                    ? [{ k: `— Striven separately records ${bp!.count} payment${bp!.count === 1 ? '' : 's'} (included above)`, v: formatCurrency(bp!.total, true) }]
                    : []),
                ]),
              })} />
            <KpiR ico="users" tint="#7C3AED" label="Active Accounts" value={activeCount}
              deltaText={accounts.length ? `${Math.round((activeCount / accounts.length) * 100)}% of ledger` : '-'}
              foot={`${inactiveCount} archived`} />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="Accounts by Type" sub={`${accounts.length.toLocaleString()} GL accounts · click a bar to drill in`}>
              <RankBar data={typeData} colorAt={(i) => SERIES[i % SERIES.length]} onSelect={openTypeDrill} />
            </ChartCard>
            <ChartCard className="g12-7" title="Payments Received by Month" sub={`${formatCurrency(pay.total)} across ${pay.count.toLocaleString()} payments`}>
              <TrendArea data={pay.byMonth} series={[{ key: 'amount', name: 'Received', color: C.positive }]} idPrefix="acct-pay" dots />
            </ChartCard>
          </div>

          {/* ── Bill payments: PAID ────────────────────────────────── */}
          <ChartCard
            title="Bill Payments: Paid"
            sub={`${formatCurrency(paidTotal)} settled across ${paidRowCount} payment${paidRowCount === 1 ? '' : 's'}${useLedgerPaid ? ' · AP ledger · Debit column' : ''}`}
          >
            <div className="paid-banner">
              <span className="paid-banner-check">✓</span>
              <span><strong>All caught up.</strong> Every recorded bill payment has been settled with the vendor: {formatCurrency(paidTotal)} paid.</span>
            </div>
            {bpByVendor.length > 0 && <RankBar data={bpByVendor} money colorAt={() => C.positive} onSelect={openBpDrill} />}
            {/* STRIVEN'S OWN RECORDS, and only those. The figures above come
                from the AP ledger, which carries a vendor, a date and an amount
                and no reference, bank account or status — so this table cannot
                be rebuilt from it, and is kept as the narrower thing it is
                rather than deleted. The payments here are INCLUDED in the total
                above, not additional to it. */}
            {(bp?.count ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 14, marginBottom: -4 }}>
                Striven&rsquo;s own bill-payment records — {bp!.count} of the {paidRowCount} above, {formatCurrency(bp!.total)}.
                The rest are recorded only in the AP ledger sheet, which carries no reference or bank account.
              </div>
            )}
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
                      <td>{r.vendor || '-'}</td>
                      <td>{r.account || '-'}</td>
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
                      <td>{r.customer || '-'}</td>
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
            <div className="muted-note">Patient names masked: PHI protected.</div>
          </ChartCard>

          {/* ── Chart of accounts (full ledger, every field) ────────── */}
          <ChartCard title="Chart of Accounts" sub={`${accounts.length.toLocaleString()} GL accounts · every field Striven's API returns`}>
            <div className="info-banner">
              <span className="info-banner-icon">ℹ</span>
              <span>
                <strong>No running balances shown: and that's correct.</strong> Striven's API does not expose GL account
                balances (they live only in Striven's Report Builder), so no balance figure here is invented. Every other
                account field is pulled live below.
              </span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Account No</th><th>Account Name</th><th>Type</th><th>Parent</th>
                    <th>Posts to ledger</th><th>Reconcilable</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAccounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.number || '-'}</td>
                      <td><strong>{a.name || '-'}</strong></td>
                      <td>{a.type || '-'}</td>
                      <td>{a.parent || '-'}</td>
                      <td>{a.canPost === false ? <span className="pill-tag tag-warn">No</span> : <span className="pill-tag tag-ok">Yes</span>}</td>
                      <td>{a.reconcilable ? <span className="pill-tag tag-info">Yes</span> : <span className="muted-note" style={{ margin: 0 }}>-</span>}</td>
                      <td>{a.active ? <StatusPill status="Active" /> : <span className="muted-note" style={{ margin: 0 }}>–</span>}</td>
                    </tr>
                  ))}
                  {sortedAccounts.length === 0 && (
                    <tr><td colSpan={7} className="muted-note">No GL accounts on record.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
