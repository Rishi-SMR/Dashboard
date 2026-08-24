import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  fetchVendorItemsReport, fetchPatientItemsReport,
  type VendorItemsReport, type PatientItemsReport,
} from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';
import { DeviceChips } from './DeviceChips';
import { SoLink } from './SoLink';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-';

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
            <span className="live-dot" /> What we buy from each vendor · what each patient orders: cancelled excluded{agoText ? ` · loaded ${agoText}` : ''}
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
      {tab === 'patients' && pat && (pat.orders?.length ? <OrdersReport data={pat} /> : <PatientReport data={pat} />)}
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
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
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
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
        <KpiR ico="users" tint={C.brand} label="Patients" value={data.patients.length} foot="by reference: no names" deltaText="ranked by # orders" />
        <KpiR ico="clip" tint="#8B5CF6" label="Sales orders" value={totalSo} foot="non-cancelled orders" deltaText="across all patients" />
        <KpiR ico="cash" tint="#16A34A" label="Total order value" value={totalValue} format={formatCurrency} foot="from non-cancelled SOs" deltaText="all patients" />
      </div>

      <div className="qb-flash warn" style={{ marginBottom: 12 }}>
        🔒 Patient names are protected health information and are never shown or stored here. Each patient appears as a reference
        (<b>PT-&lt;Striven customer id&gt;</b>): look the reference up inside Striven when you need to identify someone.
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
            <div className="table-scroll">
              <table className="data-table" style={{ margin: '0 0 0 28px', width: 'calc(100% - 28px)' }}>
                <thead><tr>{columns.map((col, i) => <th key={col} className={i > 0 ? 'num' : undefined}>{col}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>{r.map((cell, j) => <td key={j} className={j > 0 ? 'num' : undefined} style={j === 0 ? { fontWeight: 600 } : undefined}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// SO-wise patient orders (client SOW): one row per sales order, with the shared
// patient reference, last name (minimum-necessary PHI) and its line items.
const PROG_C: Record<string, string> = { PI: '#0A369F', VA: '#16A34A', TriCare: '#0D9488', Other: '#94A3B8' };
/** "2026-08-05T10:20:35.73" → "Aug 5, 2026". An unparseable date reads "-"
 *  rather than "Invalid Date", which is the browser talking, not the data. */
const fmtOrderDate = (s: string | null) => {
  if (!s) return '-';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
function OrdersReport({ data }: { data: PatientItemsReport }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const all = data.orders ?? [];

  // NEWEST FIRST, by order date. The server serves these grouped by patient
  // reference, which is why the list read SO-3, SO-5, SO-6 … and then jumped to
  // SO-479 — an order that is meaningful to the report's other tab and
  // meaningless in a chronological list.
  //
  // Date, not the SO number, even though the two agree today: every one of the
  // 472 orders carries a date and walking the numbers in order produces zero
  // date inversions, so both keys give the identical sequence. They agree
  // because Striven issues numbers in order — an accident of the numbering, not
  // a rule about it. The date is the fact being asked for, so it is the key,
  // and the SO id breaks a tie so the order is stable rather than dependent on
  // the sort's internals.
  //
  // An undated order sorts LAST, not first: '' compares below any real date.
  // There are none today, and if one appears it must not claim to be the newest
  // thing in the book on the strength of a missing field.
  const sorted = useMemo(() => [...all]
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.soId - a.soId), [all]);

  const orders = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return sorted;
    return sorted.filter((o) =>
      o.so.toLowerCase().includes(t) || String(o.ref).toLowerCase().includes(t) ||
      (o.lastName || '').toLowerCase().includes(t) || (o.program || '').toLowerCase().includes(t) ||
      o.items.some((i) => i.item.toLowerCase().includes(t)));
  }, [sorted, q]);

  const totalValue = all.reduce((s, o) => s + o.value, 0);
  const patients = new Set(all.map((o) => o.custRef || o.ref).filter(Boolean)).size;

  function exportCsv() {
    // `sorted`, not `all`: the file comes out in the order the screen shows it,
    // newest first. It still exports every order rather than the search
    // results — that is the existing behaviour and a separate decision.
    //
    // The date is a COLUMN here, not just a sort key. A spreadsheet is where
    // someone re-sorts, and a file ordered by a field it does not contain
    // cannot be put back the way it came.
    const rows = sorted.flatMap((o) => (o.items.length ? o.items : [{ item: '-', qty: 0, value: 0 }])
      .map((i) => [o.so, o.ref || '', o.lastName || '', o.program || '', o.date?.slice(0, 10) || '', i.item, i.qty, i.value]));
    // "Patient (initial + surname)", matching what the column actually carries —
    // a file that leaves the portal labelled "Last name" while holding an
    // initial misstates the PHI in it.
    downloadCsv('patient-orders.csv', ['Sales order', 'Reference', 'Patient (initial + surname)', 'Program', 'Order date', 'Item', 'Qty', 'Value'], rows);
  }

  if (!all.length) return <NotReady note={data.note} />;

  return (
    <div className="section">
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
        <KpiR ico="clip" tint={C.brand} label="Sales orders" value={all.length} foot="one row per SO" deltaText="non-cancelled" />
        <KpiR ico="users" tint="#8B5CF6" label="Patients" value={patients} foot="distinct references" deltaText="by PT-<id>" />
        <KpiR ico="cash" tint="#16A34A" label="Total order value" value={totalValue} format={formatCurrency} foot="from non-cancelled SOs" deltaText="all orders" />
      </div>

      <div className="qb-flash warn" style={{ marginBottom: 12 }}>
        🔒 Minimum-necessary PHI: patient <b>last name</b> is shown for order matching (per client request). Full name, DOB and
        address are never shown or stored, and every view is audit-logged. Look the reference up in Striven for full identity.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="page-sub" style={{ margin: 0, fontSize: 12.5 }}>One row per sales order, newest first by order date. Click a row to see its items.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="login-input" style={{ maxWidth: 260, height: 38 }} placeholder="Search SO / ref / last name / item…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={exportCsv}>⭳ CSV</button>
        </div>
      </div>

      {/* ── ONE ROW, ONE HEIGHT ────────────────────────────────────────────────
          This list was ragged in three separate ways, and all three came from
          letting the browser size it:

            · auto table layout, so every column shifted with its widest cell
            · "SO-100" broke across two lines mid-token once the Items column
              squeezed the order column
            · the device chips wrapped, so a five-device order stood twice as
              tall as a one-device order

          A colgroup fixes the geometry, `nowrap` keeps identifiers whole, and
          the chips are capped so the tallest cell in a row is one line. The
          result is a grid you can scan down a column of, which is the whole job
          of a hundred-row table. */}
      <div className="table-wrap">
        <table className="data-table so-table">
          <colgroup>
            <col className="c-idx" /><col className="c-so" /><col className="c-ref" /><col className="c-pat" />
            <col className="c-prog" /><col className="c-date" /><col /><col className="c-val" />
          </colgroup>
          <thead><tr>
            {/* "Patient", not "Last name": the column now carries an initial
                too, and a header that says otherwise is a claim about PHI. */}
            <th>#</th><th>Sales order</th><th>Reference</th><th>Patient</th><th>Program</th>
            {/* THE COLUMN THE LIST IS SORTED BY. Ordering rows by a field that
                is nowhere on screen leaves a reader unable to check the claim —
                and here it would read as "sorted by SO number descending",
                which is a different rule that happens to agree. */}
            <th>Order date</th>
            <th>Items</th><th className="num">Value</th>
          </tr></thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No orders match.</td></tr>}
            {orders.map((o, i) => (
              <Fragment key={o.soId}>
                <tr onClick={() => o.items.length && setOpen(open === o.soId ? null : o.soId)}
                  style={{ cursor: o.items.length ? 'pointer' : 'default', background: open === o.soId ? 'var(--accent-soft-2)' : undefined, opacity: o.incomplete ? 0.6 : undefined }}>
                  <td className="c-idx">{i + 1}</td>
                  {/* The caret is its own fixed-width element rather than a
                      character in the text: as a prefix it shifted every order
                      number sideways by the width of a glyph the moment a row
                      opened, and rows with no items shifted the other way. */}
                  <td style={{ fontWeight: 700 }}>
                    <span className="so-caret" aria-hidden="true">{o.items.length ? (open === o.soId ? '▾' : '▸') : ''}</span>
                    {/* The caret belongs to the ROW, which expands the order's
                        items; the reference opens the order itself. Two actions
                        in one cell, so the link stops the click from also
                        toggling the drawer under it. */}
                    <span onClick={(e) => e.stopPropagation()} role="presentation">
                      <SoLink soId={o.soId} label={o.so} canOpenInStriven />
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }} title={o.ref || undefined}>{o.ref || '-'}</td>
                  <td title={o.lastName || undefined}>{o.lastName || '-'}{o.incomplete && <span className="pill-tag tag-warn" style={{ marginLeft: 6, fontSize: 10 }}>incomplete</span>}</td>
                  <td><span className="pill-tag" style={{ color: PROG_C[o.program] || PROG_C.Other, borderColor: 'currentColor' }}>{o.program || '-'}</span></td>
                  {/* Date only. The payload carries a full timestamp and the
                      sort uses all of it, but a time of day in a column scanned
                      for sequence is noise. */}
                  <td style={{ color: 'var(--muted-strong)' }} title={o.date || undefined}>{fmtOrderDate(o.date)}</td>
                  {/* DEVICE NAMES, not a count. The names were already in the
                      payload — the row expanded to show them, so the top level
                      made you click to learn what "5" meant.

                      Capped at three: past that the chips wrapped and took the
                      row's height with them. The rest collapse into a "+N" chip
                      that names them on hover, and clicking the row still opens
                      the full itemised list underneath. */}
                  <td>
                    {o.items.length === 0
                      ? <span style={{ color: C.muted }}>-</span>
                      : <DeviceChips max={3} devices={o.items.map((it) => ({ item: it.item, qty: it.qty }))} />}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.value)}</td>
                </tr>
                {open === o.soId && o.items.length > 0 && (
                  <tr><td colSpan={8} style={{ padding: '0 0 8px 0', background: 'var(--accent-soft-2)' }}>
                    <div className="table-scroll">
                      <table className="data-table" style={{ margin: '0 0 0 28px', width: 'calc(100% - 28px)' }}>
                        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
                        <tbody>
                          {o.items.map((it, j) => (
                            <tr key={j}><td style={{ fontWeight: 600 }}>{it.item}</td><td className="num">{it.qty}</td><td className="num">{formatCurrency(it.value)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
