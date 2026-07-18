import { useEffect, useMemo, useState } from 'react';
import {
  fetchVendorItemsReport, fetchPatientItemsReport,
  type VendorItemsReport, type PatientItemsReport,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

type Tab = 'vendors' | 'patients';

function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function ReportsTab() {
  const [tab, setTab] = useState<Tab>('vendors');
  const [vend, setVend] = useState<VendorItemsReport | null>(null);
  const [pat, setPat] = useState<PatientItemsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [v, p] = await Promise.all([fetchVendorItemsReport(), fetchPatientItemsReport()]);
      setVend(v); setPat(p); setLastSync(Date.now());
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load reports.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const generatedAt = tab === 'vendors' ? vend?.generatedAt ?? null : pat?.generatedAt ?? null;

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Reports</h1>
          <div className="page-sub">
            <span className="live-dot" /> What we buy from each vendor · what each patient orders — cancelled excluded{agoText ? ` · loaded ${agoText}` : ''}
            {generatedAt && <span style={{ marginLeft: 10, fontSize: 12 }}>· data as of {fmtDate(generatedAt)}</span>}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="ov-tabs">
        <button className={`ov-tab ${tab === 'vendors' ? 'active' : ''}`} onClick={() => setTab('vendors')}>Vendor purchases</button>
        <button className={`ov-tab ${tab === 'patients' ? 'active' : ''}`} onClick={() => setTab('patients')}>Patient orders</button>
      </div>

      {loading && !vend && !pat && <div className="page-sub" style={{ padding: 16 }}>Loading reports…</div>}
      {tab === 'vendors' && vend && <VendorReport data={vend} />}
      {tab === 'patients' && pat && <PatientReport data={pat} />}
    </div>
  );
}

function VendorReport({ data }: { data: VendorItemsReport }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const vendors = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.vendors.filter((v) => !t || v.vendor.toLowerCase().includes(t) || v.items.some((i) => i.item.toLowerCase().includes(t)));
  }, [data, q]);

  const totalSpend = data.vendors.reduce((s, v) => s + v.totalCost, 0);
  const totalItems = new Set(data.vendors.flatMap((v) => v.items.map((i) => i.item))).size;

  function exportCsv() {
    const rows = data.vendors.flatMap((v) => v.items.map((i) => [v.vendor, i.item, i.qty, i.cost, i.poCount]));
    downloadCsv('vendor-purchases.csv', ['Vendor', 'Item', 'Qty', 'Cost', 'PO count'], rows);
  }

  if (!data.vendors.length) return <NotReady note={data.note} />;

  return (
    <div className="section">
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
        <KpiR ico="bag" tint={C.brand} label="Vendors" value={data.vendors.length} foot="vendors we purchase from" deltaText="ranked by spend" />
        <KpiR ico="box" tint="#8B5CF6" label="Distinct items" value={totalItems} foot="unique items purchased" deltaText="across all vendors" />
        <KpiR ico="cash" tint="#16A34A" label="Total purchase cost" value={totalSpend} format={formatCurrency} foot="from non-cancelled POs" deltaText="all vendors" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Click a vendor to see exactly what we buy from them.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="login-input" style={{ maxWidth: 240, height: 38 }} placeholder="Search vendor / item…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={exportCsv}>⭳ CSV</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th style={{ width: 40 }}>#</th><th>Vendor</th><th className="num">POs</th><th className="num">Items</th><th className="num">Total cost</th></tr></thead>
          <tbody>
            {vendors.length === 0 && <tr><td colSpan={5} style={{ color: C.muted }}>No vendors.</td></tr>}
            {vendors.map((v, i) => (
              <FragmentRow key={v.vendor}
                rank={i + 1} name={v.vendor} a={v.poCount} b={v.items.length} c={v.totalCost}
                open={open === v.vendor} onToggle={() => setOpen(open === v.vendor ? null : v.vendor)}
                columns={['Item', 'Qty', 'Cost', 'POs']}
                rows={v.items.map((it) => [it.item, it.qty, formatCurrency(it.cost), it.poCount])} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PatientReport({ data }: { data: PatientItemsReport }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const patients = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.patients.filter((p) => !t || p.ref.toLowerCase().includes(t) || p.items.some((i) => i.item.toLowerCase().includes(t)));
  }, [data, q]);

  const totalValue = data.patients.reduce((s, p) => s + p.totalValue, 0);
  const totalSo = data.patients.reduce((s, p) => s + p.soCount, 0);

  function exportCsv() {
    const rows = data.patients.flatMap((p) => p.items.map((i) => [p.ref, p.soCount, i.item, i.qty, i.value]));
    downloadCsv('patient-orders.csv', ['Patient ref', 'SO count', 'Item', 'Qty', 'Value'], rows);
  }

  if (!data.patients.length) return <NotReady note={data.note} />;

  return (
    <div className="section">
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
        <KpiR ico="users" tint={C.brand} label="Patients" value={data.patients.length} foot="by reference — no names" deltaText="ranked by # orders" />
        <KpiR ico="clip" tint="#8B5CF6" label="Sales orders" value={totalSo} foot="non-cancelled orders" deltaText="across all patients" />
        <KpiR ico="cash" tint="#16A34A" label="Total order value" value={totalValue} format={formatCurrency} foot="from non-cancelled SOs" deltaText="all patients" />
      </div>

      <div className="qb-flash warn" style={{ marginBottom: 12 }}>
        🔒 Patient names are protected health information and are never shown or stored here. Each patient appears as a reference
        (<b>PT-&lt;Striven customer id&gt;</b>) — look the reference up inside Striven when you need to identify someone.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>Ranked by number of orders. Click a reference to see what they order.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="login-input" style={{ maxWidth: 240, height: 38 }} placeholder="Search ref / item…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={exportCsv}>⭳ CSV</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th style={{ width: 40 }}>#</th><th>Patient ref</th><th className="num">Orders</th><th className="num">Items</th><th className="num">Total value</th></tr></thead>
          <tbody>
            {patients.length === 0 && <tr><td colSpan={5} style={{ color: C.muted }}>No patients.</td></tr>}
            {patients.map((p, i) => (
              <FragmentRow key={p.ref}
                rank={i + 1} name={p.ref} a={p.soCount} b={p.items.length} c={p.totalValue}
                open={open === p.ref} onToggle={() => setOpen(open === p.ref ? null : p.ref)}
                columns={['Item', 'Qty', 'Value', 'Orders']}
                rows={p.items.map((it) => [it.item, it.qty, formatCurrency(it.value), it.soCount])} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A master row + (when open) a nested items table spanning all columns.
function FragmentRow({ rank, name, a, b, c, open, onToggle, columns, rows }: {
  rank: number; name: string; a: number; b: number; c: number; open: boolean; onToggle: () => void;
  columns: string[]; rows: (string | number)[][];
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', background: open ? 'var(--accent-soft-2)' : undefined }}>
        <td style={{ color: 'var(--muted)' }}>{rank}</td>
        <td style={{ fontWeight: 700 }}>{open ? '▾ ' : '▸ '}{name}</td>
        <td className="num">{a}</td>
        <td className="num">{b}</td>
        <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(c)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: '0 0 8px 0', background: 'var(--accent-soft-2)' }}>
            <table className="data-table" style={{ margin: '0 0 0 28px', width: 'calc(100% - 28px)' }}>
              <thead><tr>{columns.map((col, i) => <th key={col} className={i > 0 ? 'num' : undefined}>{col}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>{r.map((cell, j) => <td key={j} className={j > 0 ? 'num' : undefined} style={j === 0 ? { fontWeight: 600 } : undefined}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function NotReady({ note }: { note: string }) {
  return (
    <div className="section">
      <div className="page-sub" style={{ padding: 16 }}>
        {note || 'Report not generated yet.'} It is compiled from item-level order data; it will appear after the next data build.
      </div>
    </div>
  );
}
