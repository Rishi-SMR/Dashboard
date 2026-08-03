import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadXlsx, printToPdf, stamped, type Sheet } from '../export';
import { fetchOrderAnalytics, fetchViews, saveView, deleteView, type AnalyticsOrder, type OrderAnalytics, type SavedView } from '../strivenApi';
import { formatCurrency, isCompletedStatus, isCancelledStatus, isRealAccount } from '../format';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';
import { PiPipeline } from './PiPipeline';
import { DeviceChips, deviceVertical, shortDeviceName } from './DeviceChips';
import { ColumnFilter, SortHead } from './ColumnFilter';

// The order the client asked for: PI and VA are active, DOL is live-but-empty,
// TriCare is legacy and kept for historical data.
const VERTICALS = ['PI', 'VA', 'DOL', 'TriCare'] as const;

// Segmented control: an inset track holds the options, and only the active one
// gets a raised pill. Without the track the two filter groups read as one long
// undifferentiated row.
const TRACK: React.CSSProperties = {
  display: 'inline-flex', gap: 2, background: 'var(--panel-2)', borderRadius: 9, padding: 3,
  border: '1px solid var(--panel-2)',
};
const seg = (active: boolean): React.CSSProperties => ({
  border: 'none', borderRadius: 6, padding: '5px 11px', fontSize: 12.5, fontWeight: 600,
  letterSpacing: 0.1, lineHeight: 1.35, whiteSpace: 'nowrap',
  background: active ? C.brand : 'transparent',
  color: active ? '#fff' : C.sub,
  boxShadow: active ? '0 1px 2px rgba(15,27,46,.18)' : 'none',
  cursor: 'pointer',
});
// Two cards sitting side by side must match in height and column rhythm, or the
// pair reads as a mistake. `height: 100%` lets the grid stretch them equally, and
// the column flex is shared so both tables line up like a matched set.
const CARD_EQUAL: React.CSSProperties = { marginTop: 0, height: '100%', display: 'flex', flexDirection: 'column' };
// label | orders | devices | revenue | share | bar
const REV_COL_W = ['auto', '13%', '13%', '19%', '11%', '20%'];

// Group label — small caps with generous tracking, the one place the bar needs
// hierarchy so "Period" and "Vertical" read as headings, not options.
const GROUP_LABEL: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '0.11em',
  textTransform: 'uppercase', color: C.muted, marginBottom: 6,
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Inclusive date window for the chosen preset. `null` means no bound. */
function windowFor(preset: string, from: string, to: string): { start: number | null; end: number | null } {
  const now = new Date();
  if (preset === 'week') { const s = new Date(now); s.setDate(s.getDate() - 6); s.setHours(0, 0, 0, 0); return { start: s.getTime(), end: null }; }
  if (preset === 'month') { const s = new Date(now); s.setDate(s.getDate() - 29); s.setHours(0, 0, 0, 0); return { start: s.getTime(), end: null }; }
  if (preset === 'custom') {
    const s = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const e = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return { start: Number.isFinite(s as number) ? s : null, end: Number.isFinite(e as number) ? e : null };
  }
  return { start: null, end: null };   // all time
}

// ── Orders & revenue ─────────────────────────────────────────────────────────
// Revenue-side companion to the commission view: filter by week / month / custom
// range, split by vertical, then break down by account and by device.
//
// "Account" is the payer — Veterans Affairs, TriCare, or the PI law firm. Patient
// records are never used as accounts, so nothing here can surface PHI.
export function OrderDashboard({ viewAs }: { viewAs?: string | null }) {
  const [data, setData] = useState<OrderAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [preset, setPreset] = useState<'all' | 'week' | 'month' | 'custom'>('all');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [vert, setVert] = useState<string>('all');
  const [acct, setAcct] = useState<string | null>(null);
  const [devSel, setDevSel] = useState<string | null>(null);
  const [totalDrill, setTotalDrill] = useState<TotalKey | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchOrderAnalytics(viewAs)); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load orders.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [viewAs]);

  const all = data?.orders ?? [];
  const rows = useMemo(() => {
    const { start, end } = windowFor(preset, from, to);
    return all.filter((o) => {
      if (vert !== 'all' && o.vertical !== vert) return false;
      if (start == null && end == null) return true;
      const t = o.date ? new Date(o.date).getTime() : NaN;
      if (!Number.isFinite(t)) return false;
      if (start != null && t < start) return false;
      if (end != null && t > end) return false;
      return true;
    });
  }, [all, preset, from, to, vert]);

  // ── the six headline totals ──
  const totals = useMemo(() => {
    const accounts = new Set<string>();
    let devices = 0, revenue = 0, pending = 0, delivered = 0;
    for (const o of rows) {
      // Only real billed accounts. Counting "Unassigned" here is what made this
      // screen read 79 against the Dashboard's 78 for the same book.
      if (isRealAccount(o.account)) accounts.add(o.account);
      devices += o.units;
      revenue += o.revenue;
      // "Incomplete" contains "complete" — see isCompletedStatus. A substring
      // test here put Incomplete orders in the Delivered bucket.
      if (isCompletedStatus(o.status)) delivered++;
      else if (!isCancelledStatus(o.status)) pending++;
    }
    return { orders: rows.length, devices, accounts: accounts.size, revenue, pending, delivered };
  }, [rows]);

  // Region the PDF captures — the filter bar and page shell are stripped by the
  // print stylesheet so the output is the view, not the app.
  const printRef = useRef<HTMLDivElement>(null);

  // Which saved view is on screen, with the filters it stood for.
  const [view, setView] = useState<{ name: string; filters: { preset: string; from: string; to: string; vert: string } } | null>(null);

  // Editing any filter by hand detaches the view, so an export is never
  // labelled with a saved view whose filters it no longer matches. Compared
  // against the snapshot rather than tracked through each setter — that way a
  // control added later cannot forget to clear it.
  useEffect(() => {
    if (!view) return;
    const f = view.filters;
    const same = f.preset === preset && (f.vert || 'all') === vert
      && (f.from || '') === (from || '') && (f.to || '') === (to || '');
    if (!same) setView(null);
  }, [preset, from, to, vert]);
  const appliedView = view?.name ?? null;

  /**
   * The workbook is the CURRENT view: whatever the filters have left in `rows`.
   * Four sheets, because a single flat dump loses the groupings the screen
   * shows — and Summary carries the filter state so a file sent on to someone
   * else says what it is scoped to.
   *
   * Values are written as NUMBERS, not formatted strings: a client who receives
   * this needs to sum the column, and "$1,415,592" is text to Excel.
   */
  function exportExcel() {
    const period = preset === 'custom' ? `${from || 'earliest'} to ${to || 'latest'}` : preset;
    const summary: Sheet = {
      name: 'Summary',
      rows: [
        ['SMR — order dashboard export'],
        ['Generated', new Date().toLocaleString()],
        // The saved view's NAME, so a file forwarded on says which view it is —
        // "VA This week" is meaningful in a way "All time / VA" is not.
        ...(appliedView ? [['Saved view', appliedView]] : []),
        ['Period', period],
        ['Vertical', vert === 'all' ? 'All verticals' : vert],
        ...(data?.scopedToRep ? [['Scoped to rep', data.scopedToRep]] : []),
        [],
        ['Metric', 'Value'],
        ['Orders in scope', totals.orders],
        ['Orders in the book', all.length],
        ['Revenue', totals.revenue],
        ['Devices (units)', totals.devices],
        ['Accounts', totals.accounts],
        ['Pending', totals.pending],
        ['Delivered', totals.delivered],
        ...(data?.excludedCancelled ? [['Cancelled excluded', data.excludedCancelled]] : []),
      ],
    };

    // Every table drawn on the page gets a sheet. The workbook is meant to be
    // the view, so anything visible on screen has to be in the file — a reader
    // should not have to rebuild "Revenue by vertical" from the Orders tab.
    const verticalSheet: Sheet = {
      name: 'By vertical',
      rows: [
        ['Vertical', 'Orders', 'Devices', 'Revenue', 'Share of revenue'],
        ...byVertical.map((v) => [
          v.vertical, v.orders, v.units, v.revenue,
          totals.revenue > 0 ? v.revenue / totals.revenue : 0,
        ]),
      ],
    };

    const statusMap = new Map<string, { orders: number; units: number; revenue: number }>();
    for (const o of rows) {
      const k = o.status || 'Unknown';
      const e = statusMap.get(k) ?? { orders: 0, units: 0, revenue: 0 };
      e.orders++; e.units += o.units; e.revenue += o.revenue;
      statusMap.set(k, e);
    }
    const statusSheet: Sheet = {
      name: 'By status',
      rows: [
        ['Status', 'Orders', 'Devices', 'Revenue', 'Share of revenue'],
        ...[...statusMap.entries()].sort((x, y) => y[1].revenue - x[1].revenue)
          .map(([k, v]) => [k, v.orders, v.units, v.revenue, totals.revenue > 0 ? v.revenue / totals.revenue : 0]),
      ],
    };

    const orders: Sheet = {
      name: 'Orders',
      rows: [
        ['SO ref', 'Date', 'Vertical', 'Account', 'Rep', 'Status', 'Invoice status', 'Units', 'Revenue', 'Devices'],
        ...rows.map((o) => [
          o.ref, o.date ? o.date.slice(0, 10) : '', o.vertical, o.account, o.rep,
          o.status, o.invStatus, o.units, o.revenue,
          (o.devices || []).map((d) => `${shortDeviceName(d.item)} x${d.qty}`).join('; '),
        ]),
      ],
    };

    const byAccount = new Map<string, { orders: number; units: number; revenue: number }>();
    const byDevice = new Map<string, { units: number; orders: number }>();
    for (const o of rows) {
      const a = byAccount.get(o.account) ?? { orders: 0, units: 0, revenue: 0 };
      a.orders++; a.units += o.units; a.revenue += o.revenue;
      byAccount.set(o.account, a);
      for (const d of o.devices || []) {
        const k = shortDeviceName(d.item);
        const e = byDevice.get(k) ?? { units: 0, orders: 0 };
        e.units += d.qty; e.orders++;
        byDevice.set(k, e);
      }
    }

    const accounts: Sheet = {
      name: 'Accounts',
      rows: [
        ['Account', 'Orders', 'Units', 'Revenue'],
        ...[...byAccount.entries()].sort((x, y) => y[1].revenue - x[1].revenue)
          .map(([name, v]) => [name, v.orders, v.units, v.revenue]),
      ],
    };

    const devices: Sheet = {
      name: 'Devices',
      rows: [
        ['Device', 'Units', 'Orders'],
        ...[...byDevice.entries()].sort((x, y) => y[1].units - x[1].units)
          .map(([name, v]) => [name, v.units, v.orders]),
      ],
    };

    // Order mirrors the page: headline figures, the two breakdowns beneath
    // them, then the detail lists, then every order.
    downloadXlsx(
      [summary, verticalSheet, statusSheet, accounts, devices, orders],
      stamped(appliedView ? `smr-${appliedView.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'smr-orders', 'xlsx'),
    );
  }

  // ── revenue by vertical (together and separate) ──
  const byVertical = useMemo(() => VERTICALS.map((v) => {
    const set = rows.filter((o) => o.vertical === v);
    return { vertical: v, orders: set.length, units: set.reduce((s, o) => s + o.units, 0), revenue: set.reduce((s, o) => s + o.revenue, 0) };
  }), [rows]);

  // ── revenue by account ──
  const byAccount = useMemo(() => {
    const m = new Map<string, { account: string; orders: number; units: number; revenue: number; verticals: Set<string>; devices: Map<string, number> }>();
    for (const o of rows) {
      const e = m.get(o.account) || { account: o.account, orders: 0, units: 0, revenue: 0, verticals: new Set<string>(), devices: new Map<string, number>() };
      e.orders++; e.units += o.units; e.revenue += o.revenue; e.verticals.add(o.vertical);
      for (const d of o.devices) e.devices.set(d.item, (e.devices.get(d.item) || 0) + d.qty);
      m.set(o.account, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  }, [rows]);

  // ── revenue by device type across all accounts ──
  const byDevice = useMemo(() => {
    const m = new Map<string, { item: string; qty: number; orders: number; revenue: number }>();
    for (const o of rows) {
      // An order's revenue is split across its devices by unit share, so device
      // revenue sums back to the order total instead of double-counting it.
      const tot = o.units || 1;
      for (const d of o.devices) {
        const e = m.get(d.item) || { item: d.item, qty: 0, orders: 0, revenue: 0 };
        e.qty += d.qty; e.orders++; e.revenue += o.revenue * (d.qty / tot);
        m.set(d.item, e);
      }
    }
    // Devices that carry no revenue are dropped — they sat at the bottom of the
    // ranking as a run of $0 rows with nothing to compare. The count is kept so
    // the omission is stated rather than silent.
    const all = [...m.values()].sort((a, b) => b.revenue - a.revenue);
    const earning = all.filter((d) => d.revenue >= 0.01);
    return { list: earning, hidden: all.length - earning.length, hiddenUnits: all.filter((d) => d.revenue < 0.01).reduce((s, d) => s + d.qty, 0) };
  }, [rows]);

  // ── account table: search, sort, minimum-orders ──
  // Its own controls rather than the page filter bar, because they narrow this
  // one table without re-scoping every figure above it.
  const [acctQ, setAcctQ] = useState('');
  const [acctMin, setAcctMin] = useState(0);
  const [acctSort, setAcctSort] = useState<{ key: AcctKey; dir: 'asc' | 'desc' }>({ key: 'revenue', dir: 'desc' });
  // Empty set means "all" — the column filter is off until something is picked.
  const [acctPick, setAcctPick] = useState<Set<string>>(new Set());
  const accountRows = useMemo(() => {
    const q = acctQ.trim().toLowerCase();
    const rows = byAccount.filter((a) =>
      (!q || a.account.toLowerCase().includes(q))
      && a.orders >= acctMin
      && (acctPick.size === 0 || acctPick.has(a.account)));
    const { key, dir } = acctSort;
    const val = (a: typeof byAccount[number]) =>
      key === 'account' ? a.account.toLowerCase()
        : key === 'orders' ? a.orders
          : key === 'units' ? a.units
            : key === 'types' ? a.devices.size
              : a.revenue;
    return [...rows].sort((x, y) => {
      const A = val(x), B = val(y);
      const c = typeof A === 'string' ? A.localeCompare(String(B)) : (A as number) - (B as number);
      return dir === 'asc' ? c : -c;
    });
  }, [byAccount, acctQ, acctMin, acctSort, acctPick]);
  const sortBy = (key: AcctKey) =>
    setAcctSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'account' ? 'asc' : 'desc') }));

  const maxAcct = Math.max(1, ...byAccount.map((a) => a.revenue));
  const maxDev = Math.max(1, ...byDevice.list.map((d) => d.revenue));

  return (
    <div ref={printRef}>
      {/* filters */}
      <div className="section chart-card no-print" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 0, padding: '2px 2px 0' }}>
          {/* PERIOD */}
          <div role="group" aria-label="Period" style={{ paddingRight: 22 }}>
            <span style={GROUP_LABEL}>Period</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <div style={TRACK}>
                {([['all', 'All time'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']] as const).map(([k, label]) => (
                  <button key={k} style={seg(preset === k)} aria-pressed={preset === k} onClick={() => setPreset(k)}>{label}</button>
                ))}
              </div>
              {preset === 'custom' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: C.muted }}>
                  <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From date"
                    style={{ padding: '5px 8px', borderRadius: 7, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }} />
                  <span>→</span>
                  <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To date"
                    style={{ padding: '5px 8px', borderRadius: 7, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }} />
                </div>
              )}
            </div>
          </div>

          {/* a real divider, so the two groups cannot read as one row */}
          <div aria-hidden="true" style={{ alignSelf: 'stretch', width: 1, background: `${C.muted}33`, margin: '2px 22px 2px 0' }} />

          {/* VERTICAL */}
          <div role="group" aria-label="Vertical" style={{ paddingRight: 22 }}>
            <span style={GROUP_LABEL}>Vertical</span>
            <div style={TRACK}>
              <button style={seg(vert === 'all')} aria-pressed={vert === 'all'} onClick={() => setVert('all')}>All together</button>
              {VERTICALS.map((v) => {
                const n = all.filter((o) => o.vertical === v).length;
                const on = vert === v;
                return (
                  <button key={v} style={{ ...seg(on), color: on ? '#fff' : (n ? V_C[v] : C.muted), display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    aria-pressed={on} onClick={() => setVert(v)}
                    title={n ? `${n} order${n === 1 ? '' : 's'} in ${v}` : `No ${v} orders yet`}>
                    <span style={{ fontWeight: 700 }}>{v}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', opacity: on ? 0.75 : 0.6 }}>{n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* SAVED VIEWS */}
          <div role="group" aria-label="Saved views" style={{ paddingRight: 22 }}>
            <span style={GROUP_LABEL}>Saved view</span>
            <SavedViews
              current={{ preset, from, to, vert }}
              onApply={(f, name) => {
                // Resolve the effective filters ONCE and use the same object for
                // both the controls and the view snapshot — reading `preset` et al.
                // back here would see the previous render's values.
                const eff = { preset: f.preset, from: f.from || from, to: f.to || to, vert: f.vert || 'all' };
                setPreset(eff.preset as typeof preset); setFrom(eff.from); setTo(eff.to); setVert(eff.vert);
                setView(name ? { name, filters: eff } : null);
              }}
            />
          </div>

          {/* EXPORT — whatever is on screen right now, filters included. */}
          <div role="group" aria-label="Export" style={{ paddingRight: 22 }}>
            <span style={GROUP_LABEL}>Export</span>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              <button className="btn ghost" onClick={() => exportExcel()} disabled={!rows.length}
                title="Download the current view as an Excel workbook — orders, summary, accounts and devices on separate sheets">
                ⤓ Excel
              </button>
              <button className="btn ghost" onClick={() => printToPdf(printRef.current)} disabled={!rows.length}
                title="Open the print dialog — choose “Save as PDF” for a PDF of this view, charts included">
                ⎙ PDF
              </button>
            </div>
          </div>

          <button className="btn ghost" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>

        <div style={{ borderTop: `1px solid ${C.muted}22`, marginTop: 12, paddingTop: 8, fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
          <b style={{ color: C.sub, fontWeight: 700 }}>{rows.length}</b> of {all.length} orders in scope
          {agoText ? ` · updated ${agoText}` : ''}
          {data?.scopedToRep ? ` · scoped to ${data.scopedToRep}` : ''}
          {data?.excludedCancelled ? ` · ${data.excludedCancelled} cancelled excluded` : ''}
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* the six totals */}
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        <KpiR ico="clip" tint={C.brand} label="Total orders" value={totals.orders} format={(n: number) => String(n)} foot="in the selected period · tap" deltaText={preset === 'all' ? 'all time' : 'filtered'} onClick={() => setTotalDrill('orders')} />
        <KpiR ico="cash" tint={C.positive} label="Total revenue" value={totals.revenue} format={formatCurrency} foot="order value · tap" deltaText={`${totals.orders} orders`} onClick={() => setTotalDrill('revenue')} />
        <KpiR ico="trend" tint={V_C.PI} label="Total devices" value={totals.devices} format={(n: number) => String(n)} foot="units shipped on these orders · tap" deltaText="units" onClick={() => setTotalDrill('devices')} />
        <KpiR ico="shield" tint={V_C.DOL} label="Total accounts" value={totals.accounts} format={(n: number) => String(n)} foot="vendors with an order · tap" deltaText="accounts" onClick={() => setTotalDrill('accounts')} />
        <KpiR ico="clip" tint={C.warning} label="Pending orders" value={totals.pending} format={(n: number) => String(n)} foot="not yet completed · tap" deltaText="open" onClick={() => setTotalDrill('pending')} />
        <KpiR ico="shield" tint={V_C.VA} label="Delivered orders" value={totals.delivered} format={(n: number) => String(n)} foot="completed in Striven · tap" deltaText="closed" onClick={() => setTotalDrill('delivered')} />
      </div>

      {/* The two revenue roll-ups answer adjacent questions, so they sit side by
          side and drop to one column when there isn't room for both. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 14, marginTop: 14, alignItems: 'stretch' }}>

      {/* revenue by vertical — together and separate */}
      <div className="section chart-card" style={CARD_EQUAL}>
        <div className="section-head"><div>
          <h2 className="section-title">Revenue by vertical</h2>
          <div className="section-sub">All verticals together, and each one separately. DOL is live but has no orders yet.</div>
        </div></div>
        {/* Mirrors the bar on the status card, so the pair starts at the same
            height and the two splits can be compared at a glance. */}
        <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', marginBottom: 10 }}>
          {byVertical.filter((v) => v.revenue > 0).map((v) => (
            <div key={v.vertical} title={`${v.vertical}: ${formatCurrency(v.revenue)} across ${v.orders} order${v.orders === 1 ? '' : 's'}`}
              style={{ width: `${(v.revenue / (totals.revenue || 1)) * 100}%`, background: V_C[v.vertical] }} />
          ))}
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: REV_COL_W[0] }}>Vertical</th>
              <th className="num" style={{ width: REV_COL_W[1] }}>Orders</th>
              <th className="num" style={{ width: REV_COL_W[2] }}>Devices</th>
              <th className="num" style={{ width: REV_COL_W[3] }}>Revenue</th>
              <th className="num" style={{ width: REV_COL_W[4] }}>Share</th>
              <th style={{ width: REV_COL_W[5] }} />
            </tr></thead>
            <tbody>
              {byVertical.map((v) => (
                <tr key={v.vertical} onClick={() => setVert(vert === v.vertical ? 'all' : v.vertical)} style={{ cursor: 'pointer' }}
                  title={`Filter to ${v.vertical}`}>
                  <td style={{ fontWeight: 700, color: V_C[v.vertical] }}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: V_C[v.vertical], marginRight: 8 }} />{v.vertical}
                    {v.orders === 0 && <span style={{ marginLeft: 6, fontSize: 11, color: C.muted, fontWeight: 600 }}>no orders yet</span>}
                  </td>
                  <td className="num">{v.orders || '-'}</td>
                  <td className="num">{v.units || '-'}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{v.revenue ? formatCurrency(v.revenue) : '-'}</td>
                  <td className="num">{totals.revenue > 0 && v.revenue ? `${Math.round((v.revenue / totals.revenue) * 100)}%` : '—'}</td>
                  <td>
                    <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${totals.revenue ? (v.revenue / totals.revenue) * 100 : 0}%`, background: V_C[v.vertical], borderRadius: 999 }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="total-row">
              <td>All verticals</td><td className="num">{totals.orders}</td><td className="num">{totals.devices}</td>
              <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(totals.revenue)}</td><td /><td />
            </tr></tfoot>
          </table>
        </div>
      </div>

      {/* revenue by status — the summary that pairs with the detailed lists */}
      <StatusBreakdown
        orders={rows}
        title="Revenue by status"
        sub="Revenue at each order status, for the current filter. Cancelled orders are excluded from every figure on this page."
      />

      </div>

      {/* The PI pipeline used to render inline here as well as being its own nav
          entry and Reps subsection — three copies of one view. It now lives only
          under "PI Pipeline". */}

      {/* accounts */}
      <div className="section chart-card" style={{ marginTop: 14 }}>
        <div className="section-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 className="section-title">
              By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 13 }}>
                · {accountRows.length === byAccount.length ? byAccount.length : `${accountRows.length} of ${byAccount.length}`}
              </span>
            </h2>
            <div className="section-sub">The vendor billed on the order — Veterans Affairs, TriCare, or the PI law firm. Click a row for its orders and devices.</div>
          </div>
          {/* search + minimum orders — narrow this table only */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: 9, fontSize: 12, color: C.muted, pointerEvents: 'none' }}>⌕</span>
              <input value={acctQ} onChange={(e) => setAcctQ(e.target.value)} placeholder="Search accounts" aria-label="Search accounts"
                style={{ padding: '6px 26px 6px 24px', borderRadius: 8, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, width: 190 }} />
              {acctQ && (
                <button onClick={() => setAcctQ('')} aria-label="Clear search" title="Clear"
                  style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
              )}
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.sub, fontWeight: 600 }}>
              Min orders
              <select value={acctMin} onChange={(e) => setAcctMin(Number(e.target.value))} aria-label="Minimum orders"
                style={{ padding: '5px 8px', borderRadius: 7, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                {[0, 2, 3, 5, 10].map((v) => <option key={v} value={v}>{v === 0 ? 'any' : `${v}+`}</option>)}
              </select>
            </label>
            {(acctQ || acctMin > 0 || acctPick.size > 0) && (
              <button className="btn ghost" style={{ fontSize: 12.5 }} onClick={() => { setAcctQ(''); setAcctMin(0); setAcctPick(new Set()); }}>Reset</button>
            )}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 34 }}>#</th>
              <th style={{ whiteSpace: 'nowrap' }} aria-sort={acctSort.key === 'account' ? (acctSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <span onClick={() => sortBy('account')} title="Sort by account" style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Account
                  <span style={{ marginLeft: 5, opacity: acctSort.key === 'account' ? 1 : 0.25, fontSize: 10 }}>
                    {acctSort.key === 'account' && acctSort.dir === 'asc' ? '▲' : '▼'}
                  </span>
                </span>
                <ColumnFilter label="Account" options={byAccount.map((a) => ({ value: a.account, count: a.orders }))} picked={acctPick} onChange={setAcctPick} />
              </th>
              <th>Verticals</th>
              <SortHead label="Orders" col="orders" sort={acctSort} onSort={sortBy} num />
              <SortHead label="Devices" col="units" sort={acctSort} onSort={sortBy} num />
              <SortHead label="Device types" col="types" sort={acctSort} onSort={sortBy} num />
              <SortHead label="Revenue" col="revenue" sort={acctSort} onSort={sortBy} num />
              <th style={{ width: '20%' }} />
            </tr></thead>
            <tbody>
              {byAccount.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No orders in this period.</td></tr>}
              {byAccount.length > 0 && accountRows.length === 0 && (
                <tr><td colSpan={8} style={{ color: C.muted }}>
                  No account matches {acctQ && <>“<b>{acctQ}</b>”</>}{acctQ && acctMin > 0 ? ' with ' : ''}{acctMin > 0 && <>{acctMin}+ orders</>}.
                  {' '}<button className="btn ghost" style={{ fontSize: 12.5 }} onClick={() => { setAcctQ(''); setAcctMin(0); setAcctPick(new Set()); }}>Reset filters</button>
                </td></tr>
              )}
              {accountRows.map((a, i) => (
                <tr key={a.account} onClick={() => setAcct(a.account)} style={{ cursor: 'pointer' }} title="Click for this account's orders">
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 700, color: C.brand }}>{a.account}</td>
                  <td>
                    {[...a.verticals].map((v) => (
                      <span key={v} style={{ fontSize: 10.5, fontWeight: 700, color: V_C[v] || C.sub, background: 'var(--panel-2)', borderRadius: 999, padding: '2px 7px', marginRight: 4 }}>{v}</span>
                    ))}
                  </td>
                  <td className="num">{a.orders}</td>
                  <td className="num">{a.units || '-'}</td>
                  <td className="num">{a.devices.size || '-'}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(a.revenue)}</td>
                  <td>
                    <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(a.revenue / maxAcct) * 100}%`, background: C.brand, borderRadius: 999 }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* devices across all accounts */}
      <div className="section chart-card" style={{ marginTop: 14 }}>
        <div className="section-head"><div>
          <h2 className="section-title">By device type <span style={{ fontWeight: 500, color: C.muted, fontSize: 13 }}>· {byDevice.list.length}</span></h2>
          <div className="section-sub">
            Across every account, revenue-earning devices only. Revenue is apportioned across an order's devices by unit share, so it sums back to the order total.
            {byDevice.hidden > 0 && (
              <> <span style={{ color: C.muted }}>
                {byDevice.hidden} device type{byDevice.hidden === 1 ? '' : 's'} ({byDevice.hiddenUnits} unit{byDevice.hiddenUnits === 1 ? '' : 's'}) earned no revenue and {byDevice.hidden === 1 ? 'is' : 'are'} hidden.
              </span></>
            )}
          </div>
        </div></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th style={{ width: 34 }}>#</th><th>Device</th><th className="num">Units</th><th className="num">Orders</th><th className="num">Revenue</th><th style={{ width: '24%' }} /></tr></thead>
            <tbody>
              {byDevice.list.length === 0 && <tr><td colSpan={6} style={{ color: C.muted }}>No revenue-earning devices on these orders.</td></tr>}
              {byDevice.list.map((d, i) => (
                <tr key={d.item} onClick={() => setDevSel(d.item)} style={{ cursor: 'pointer' }}
                  title={`Where ${d.item} went — accounts, verticals and orders`}>
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{d.item}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{d.qty}</td>
                  <td className="num">{d.orders}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(d.revenue)}</td>
                  <td>
                    <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(d.revenue / maxDev) * 100}%`, background: V_C.PI, borderRadius: 999 }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalDrill && (
        <TotalsDrill
          metric={totalDrill} orders={rows} onClose={() => setTotalDrill(null)}
          onPickAccount={(name) => { setTotalDrill(null); setAcct(name); }}
          onPickDevice={(item) => { setTotalDrill(null); setDevSel(item); }}
        />
      )}
      {acct && <AccountModal account={acct} orders={rows.filter((o) => o.account === acct)} onClose={() => setAcct(null)} />}
      {devSel && (
        <DeviceModal
          device={devSel}
          orders={rows.filter((o) => o.devices.some((d) => d.item === devSel))}
          onClose={() => setDevSel(null)}
        />
      )}
    </div>
  );
}

/**
 * Named filter sets, saved per signed-in user. Stores only the filter state —
 * period, date range and vertical — so a saved view always renders against
 * today's data rather than a frozen snapshot.
 */
function SavedViews({ current, onApply }: {
  current: { preset: string; from: string; to: string; vert: string };
  /** `name` is the saved view being applied, so exports can be labelled with it. */
  onApply: (f: { preset: string; from: string; to: string; vert: string }, name?: string) => void;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { fetchViews().then((r) => setViews(r.views || [])).catch(() => setViews([])); }, []);

  async function commit() {
    const n = name.trim();
    if (!n) { setNaming(false); return; }
    setBusy(true); setErr(null);
    try {
      const r = await saveView(n, current);
      if (r?.error) setErr(r.error); else { setViews(r.views || []); setNaming(false); setName(''); }
    } catch { setErr('Could not save that view'); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    try { const r = await deleteView(id); setViews(r.views || []); }
    catch { setErr('Could not delete that view'); }
    finally { setBusy(false); }
  }

  const label = (v: SavedView) => {
    const p = v.filters.preset === 'custom' ? `${v.filters.from} → ${v.filters.to}` : v.filters.preset;
    return `${p} · ${v.filters.vert === 'all' ? 'all verticals' : v.filters.vert}`;
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {views.length > 0 && (
        <div style={TRACK}>
          {views.map((v) => (
            <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <button style={seg(false)} title={`Apply: ${label(v)}`}
                onClick={() => onApply(v.filters, v.name)}>{v.name}</button>
              <button onClick={() => remove(v.id)} disabled={busy} aria-label={`Delete view ${v.name}`} title="Delete this view"
                style={{ border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 13, padding: '0 6px 0 0' }}>×</button>
            </span>
          ))}
        </div>
      )}
      {naming ? (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" maxLength={60}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setNaming(false); setName(''); } }}
            style={{ padding: '5px 9px', borderRadius: 7, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, width: 150 }} />
          <button style={seg(true)} onClick={commit} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          <button style={seg(false)} onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
        </span>
      ) : (
        <button style={{ ...seg(false), border: `1px dashed ${C.muted}66` }} onClick={() => setNaming(true)}
          title="Save the current period and vertical as a named view">+ Save current</button>
      )}
      {err && <span style={{ fontSize: 12, color: C.negative }}>{err}</span>}
    </div>
  );
}

type AcctKey = 'account' | 'orders' | 'units' | 'types' | 'revenue';



// Open work is amber, finished work green, and anything half-entered stays grey —
// so the pipeline's state reads before any number is parsed.
function statusTint(s: string): string {
  const t = String(s || '').toLowerCase();
  // Incomplete is tested FIRST. Reversed, "Incomplete" is caught by the
  // completed test — "complete" is a substring of it — and an unfinished order
  // renders green, which is the same bug that put it in the Delivered drill.
  if (/incomplete|draft|pending/.test(t)) return C.muted;
  if (isCompletedStatus(t)) return C.positive;
  return C.warning;
}

/**
 * Revenue and volume per order status — the summary that sits alongside the
 * detailed list, so "how much revenue is still In Progress" is one glance rather
 * than a manual tally. Cancelled orders never reach here; they are excluded
 * upstream from revenue, devices and counts alike.
 */
function StatusBreakdown({ orders, title, sub, compact = false }: {
  orders: AnalyticsOrder[]; title: string; sub?: string; compact?: boolean;
}) {
  const rows = (() => {
    const m = new Map<string, { status: string; orders: number; units: number; revenue: number }>();
    for (const o of orders) {
      const k = o.status || 'Unknown';
      const e = m.get(k) || { status: k, orders: 0, units: 0, revenue: 0 };
      e.orders++; e.units += o.units; e.revenue += o.revenue;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  })();
  const totRev = rows.reduce((s, r) => s + r.revenue, 0);
  const totOrd = rows.reduce((s, r) => s + r.orders, 0);
  const totUnits = rows.reduce((s, r) => s + r.units, 0);
  if (rows.length === 0) return null;

  const body = (
    <>
      {/* one bar showing how revenue splits across statuses */}
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', marginBottom: 10 }}>
        {rows.filter((r) => r.revenue > 0).map((r) => (
          <div key={r.status} title={`${r.status}: ${formatCurrency(r.revenue)} across ${r.orders} order${r.orders === 1 ? '' : 's'}`}
            style={{ width: `${(r.revenue / (totRev || 1)) * 100}%`, background: statusTint(r.status) }} />
        ))}
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th style={{ width: REV_COL_W[0] }}>Status</th>
            <th className="num" style={{ width: REV_COL_W[1] }}>Orders</th>
            <th className="num" style={{ width: REV_COL_W[2] }}>Devices</th>
            <th className="num" style={{ width: REV_COL_W[3] }}>Revenue</th>
            <th className="num" style={{ width: REV_COL_W[4] }}>Share</th>
            {!compact && <th style={{ width: REV_COL_W[5] }} />}
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.status}>
                <td style={{ fontWeight: 700, color: statusTint(r.status) }}>
                  <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: statusTint(r.status), marginRight: 8 }} />
                  {r.status}
                </td>
                <td className="num" style={{ fontWeight: 700 }}>{r.orders}</td>
                <td className="num">{r.units || '-'}</td>
                <td className="num" style={{ fontWeight: 800 }}>{r.revenue ? formatCurrency(r.revenue) : '-'}</td>
                <td className="num">{totRev > 0 && r.revenue ? `${Math.round((r.revenue / totRev) * 100)}%` : '—'}</td>
                {!compact && (
                  <td>
                    <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${totRev ? (r.revenue / totRev) * 100 : 0}%`, background: statusTint(r.status), borderRadius: 999 }} />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="total-row">
            <td>All statuses</td>
            <td className="num">{totOrd}</td>
            <td className="num">{totUnits || '-'}</td>
            <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(totRev)}</td>
            <td /><td />{compact ? null : null}
          </tr></tfoot>
        </table>
      </div>
    </>
  );

  // Compact: a five-column table will not survive a half-width column, so the
  // rows become a tight grid instead — same information, no horizontal scroll.
  if (compact) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{title}</span>
          {sub && <span style={{ fontSize: 11.5, color: C.muted }}>{sub}</span>}
        </div>
        <div style={{ display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', marginBottom: 8 }}>
          {rows.filter((r) => r.revenue > 0).map((r) => (
            <div key={r.status} title={`${r.status}: ${formatCurrency(r.revenue)}`}
              style={{ width: `${(r.revenue / (totRev || 1)) * 100}%`, background: statusTint(r.status) }} />
          ))}
        </div>
        <div style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '8px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '2px 10px', alignItems: 'center', fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.muted, paddingBottom: 4 }}>
            <span>Status</span><span style={{ textAlign: 'right' }}>Ord · Dev</span><span style={{ textAlign: 'right' }}>Revenue</span>
          </div>
          {rows.map((r) => (
            <div key={r.status} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '2px 10px', alignItems: 'center', padding: '3px 0' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: statusTint(r.status), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: statusTint(r.status), marginRight: 6 }} />
                {r.status}
              </span>
              <span style={{ fontSize: 12, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.orders} · {r.units || '–'}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {r.revenue ? formatCurrency(r.revenue) : '–'}
                <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 600, marginLeft: 5 }}>
                  {totRev > 0 && r.revenue ? `${Math.round((r.revenue / totRev) * 100)}%` : ''}
                </span>
              </span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '2px 10px', alignItems: 'center', borderTop: `1px solid ${C.muted}33`, marginTop: 5, paddingTop: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>All statuses</span>
            <span style={{ fontSize: 12, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{totOrd} · {totUnits || '–'}</span>
            <span style={{ fontSize: 13, fontWeight: 800, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(totRev)}</span>
          </div>
        </div>
      </div>
    );
  }
  // No margin of its own — the caller's grid owns the spacing, so this can sit
  // flush beside a sibling card.
  return (
    <div className="section chart-card" style={CARD_EQUAL}>
      <div className="section-head"><div>
        <h2 className="section-title">{title}</h2>
        {sub && <div className="section-sub">{sub}</div>}
      </div></div>
      {body}
    </div>
  );
}


/**
 * Device types ordered, grouped by vertical and ranked by quantity, instead of
 * one long ragged run of chips. Each group is a scannable column: biggest first,
 * quantities right-aligned on a tabular figure so they form a readable edge.
 */
function DeviceBreakdown({ devices, dense = false }: { devices: [string, number][]; dense?: boolean }) {
  if (devices.length === 0) {
    return <div style={{ fontSize: 13, color: C.muted }}>No device detail on these orders.</div>;
  }
  const groups = new Map<string, { item: string; short: string; qty: number }[]>();
  for (const [item, qty] of devices) {
    const v = deviceVertical(item);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v)!.push({ item, short: shortDeviceName(item, v), qty });
  }
  // Real verticals first in reporting order; DEMO and Other pushed to the end so
  // test data never leads.
  const ORDER = ['PI', 'VA', 'DOL', 'TriCare', 'Other', 'DEMO'];
  const list = [...groups.entries()]
    .map(([vertical, rows]) => ({
      vertical, rows: rows.sort((a, b) => b.qty - a.qty || a.short.localeCompare(b.short)),
      units: rows.reduce((s, r) => s + r.qty, 0),
    }))
    .sort((a, b) => (ORDER.indexOf(a.vertical) - ORDER.indexOf(b.vertical)) || b.units - a.units);

  const grand = list.reduce((s, g) => s + g.units, 0);
  const demo = list.find((g) => g.vertical === 'DEMO');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Device types ordered</span>
        <span style={{ fontSize: 11.5, color: C.muted }}>{devices.length} types · {grand} units</span>
        {demo && (
          <span title="Demo / test items are counted in the totals above — worth excluding at source"
            style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: C.warning, background: 'var(--panel-2)', borderRadius: 999, padding: '2px 8px' }}>
            includes {demo.units} demo units
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${dense ? 190 : 260}px, 1fr))`, gap: dense ? 10 : 14, alignItems: 'start' }}>
        {list.map((g) => {
          const tint = V_C[g.vertical] || (g.vertical === 'DEMO' ? C.warning : C.muted);
          const max = Math.max(...g.rows.map((r) => r.qty));
          return (
            <div key={g.vertical} style={{ background: 'var(--panel-2)', borderRadius: 10, padding: dense ? '8px 10px 6px' : '10px 12px 8px', borderTop: `2px solid ${tint}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: dense ? 5 : 7 }}>
                <span style={{ fontSize: dense ? 11.5 : 12, fontWeight: 700, color: tint, letterSpacing: 0.3 }}>
                  {g.vertical}{g.vertical === 'DEMO' && <span style={{ color: C.muted, fontWeight: 600 }}> · test</span>}
                </span>
                <span style={{ fontSize: dense ? 10.5 : 11.5, color: C.muted, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {g.rows.length}t · {g.units}u
                </span>
              </div>
              {g.rows.map((r) => (
                <div key={r.item} title={`${r.item} — ${r.qty} unit${r.qty === 1 ? '' : 's'}`}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 30px', gap: 6, alignItems: 'center', padding: dense ? '1px 0' : '2px 0' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: dense ? 11.5 : 12.5, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.short}</div>
                    <div style={{ height: dense ? 2 : 3, borderRadius: 999, background: 'var(--panel)', overflow: 'hidden', marginTop: 2 }}>
                      <div style={{ height: '100%', width: `${(r.qty / max) * 100}%`, background: tint, opacity: 0.65 }} />
                    </div>
                  </div>
                  <div style={{ fontSize: dense ? 11.5 : 12.5, fontWeight: 700, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>×{r.qty}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type TotalKey = 'orders' | 'revenue' | 'devices' | 'accounts' | 'pending' | 'delivered';

/**
 * What sits behind a headline tile.
 *
 * Count metrics open the actual orders; composition metrics open the ranked
 * breakdown. Both respect the page filters, so a drill-down can never disagree
 * with the number that was tapped — it is the same set of orders, shown closer.
 */
function TotalsDrill({ metric, orders, onClose, onPickAccount, onPickDevice }: {
  metric: TotalKey; orders: AnalyticsOrder[]; onClose: () => void;
  onPickAccount: (name: string) => void; onPickDevice: (item: string) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const isDone = (o: AnalyticsOrder) => isCompletedStatus(o.status);
  const set = metric === 'pending' ? orders.filter((o) => !isDone(o) && !/cancel|void/i.test(o.status))
    : metric === 'delivered' ? orders.filter(isDone)
      : orders;

  const CFG: Record<TotalKey, { title: string; sub: string; tint: string }> = {
    orders: { title: 'All orders', sub: 'Every order in the current filter.', tint: C.brand },
    revenue: { title: 'Revenue', sub: 'Where the order value comes from.', tint: C.positive },
    devices: { title: 'Devices', sub: 'Units shipped, by device type.', tint: V_C.PI },
    accounts: { title: 'Accounts', sub: 'Vendors with an order in this period.', tint: V_C.DOL },
    pending: { title: 'Pending orders', sub: 'Not yet completed in Striven.', tint: C.warning },
    delivered: { title: 'Delivered orders', sub: 'Marked completed in Striven — not carrier-confirmed delivery.', tint: V_C.VA },
  };
  const cfg = CFG[metric];
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

  // Composition views.
  const byAcct = (() => {
    const m = new Map<string, { name: string; orders: number; units: number; revenue: number }>();
    for (const o of set) {
      const e = m.get(o.account) ?? { name: o.account, orders: 0, units: 0, revenue: 0 };
      e.orders++; e.units += o.units; e.revenue += o.revenue; m.set(o.account, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  })();
  const byDev = (() => {
    const m = new Map<string, { name: string; units: number; orders: number; revenue: number }>();
    for (const o of set) {
      const tot = o.units || 1;
      for (const d of o.devices) {
        const e = m.get(d.item) ?? { name: d.item, units: 0, orders: 0, revenue: 0 };
        e.units += d.qty; e.orders++; e.revenue += o.revenue * (d.qty / tot); m.set(d.item, e);
      }
    }
    return [...m.values()].sort((a, b) => b.units - a.units);
  })();
  const byVert = (() => {
    const m = new Map<string, { name: string; orders: number; units: number; revenue: number }>();
    for (const o of set) {
      const e = m.get(o.vertical) ?? { name: o.vertical, orders: 0, units: 0, revenue: 0 };
      e.orders++; e.units += o.units; e.revenue += o.revenue; m.set(o.vertical, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  })();

  const revenue = set.reduce((s, o) => s + o.revenue, 0);
  const units = set.reduce((s, o) => s + o.units, 0);
  const showList = metric === 'orders' || metric === 'pending' || metric === 'delivered';

  const Ranked = ({ rows, unit, onPick }: { rows: { name: string; orders: number; units: number; revenue: number }[]; unit: 'revenue' | 'units'; onPick?: (n: string) => void }) => {
    const max = Math.max(1, ...rows.map((r) => (unit === 'revenue' ? r.revenue : r.units)));
    return (
      <table className="data-table">
        <thead><tr><th style={{ width: 34 }}>#</th><th>Name</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Revenue</th><th style={{ width: '26%' }} /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name} onClick={() => onPick?.(r.name)} style={{ cursor: onPick ? 'pointer' : 'default' }} title={onPick ? `Open ${r.name}` : undefined}>
              <td style={{ color: C.muted }}>{i + 1}</td>
              <td style={{ fontWeight: 600, color: onPick ? C.brand : C.ink }}>{r.name}</td>
              <td className="num">{r.orders}</td>
              <td className="num">{r.units || '-'}</td>
              <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(r.revenue)}</td>
              <td>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${((unit === 'revenue' ? r.revenue : r.units) / max) * 100}%`, background: cfg.tint, borderRadius: 999 }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(940px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${cfg.tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{cfg.title}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{cfg.sub}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
            <Stat label="Orders" value={String(set.length)} tint={cfg.tint} />
            <Stat label="Devices" value={String(units)} />
            <Stat label="Accounts" value={String(byAcct.length)} />
            <Stat label="Revenue" value={formatCurrency(revenue)} />
          </div>

          {showList ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
                Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· newest first</span>
              </div>
              <table className="data-table">
                <thead><tr>
                  <th>Order</th><th>Date</th><th>Account</th><th>Vertical</th><th>Devices</th>
                  <th className="num">Units</th><th className="num">Revenue</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {set.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No orders here.</td></tr>}
                  {set.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                    <tr key={o.soId}>
                      <td style={{ fontWeight: 600, color: C.brand }}>{o.ref}</td>
                      <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                      <td style={{ fontSize: 12.5 }}>{o.account}</td>
                      <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                      <td><DeviceChips devices={o.devices} showVertical /></td>
                      <td className="num">{o.units || '-'}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>
                      <td style={{ fontSize: 12.5, color: statusTint(o.status), fontWeight: 600 }}>{o.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : metric === 'devices' ? (
            <><div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By device type <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byDev} unit="units" onPick={onPickDevice} /></>
          ) : metric === 'accounts' ? (
            <><div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byAcct} unit="revenue" onPick={onPickAccount} /></>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
              <Ranked rows={byVert} unit="revenue" />
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byAcct.slice(0, 15)} unit="revenue" onPick={onPickAccount} />
            </>
          )}
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
            🔒 No patient names — orders by SO reference. Cancelled orders are excluded from every figure.
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small figure tile used inside the drill-downs. */
function Stat({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: tint || C.ink, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

/**
 * One device type, everywhere it went: which accounts bought it, which verticals
 * it sold into, and the individual orders.
 *
 * An order can carry several devices, so this device's share of that order's
 * revenue is apportioned by unit — the same rule the summary table uses, which
 * keeps the modal's total equal to the row you clicked.
 */
function DeviceModal({ device, orders, onClose }: { device: string; orders: AnalyticsOrder[]; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const qtyOn = (o: AnalyticsOrder) => o.devices.filter((d) => d.item === device).reduce((s, d) => s + d.qty, 0);
  const shareOf = (o: AnalyticsOrder) => o.revenue * (qtyOn(o) / (o.units || 1));

  const units = orders.reduce((s, o) => s + qtyOn(o), 0);
  const revenue = orders.reduce((s, o) => s + shareOf(o), 0);
  const perUnit = units ? revenue / units : 0;

  const byAccount = (() => {
    const m = new Map<string, { account: string; units: number; orders: number; revenue: number }>();
    for (const o of orders) {
      const e = m.get(o.account) || { account: o.account, units: 0, orders: 0, revenue: 0 };
      e.units += qtyOn(o); e.orders++; e.revenue += shareOf(o);
      m.set(o.account, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  })();

  const byVertical = (() => {
    const m = new Map<string, { vertical: string; units: number; orders: number; revenue: number }>();
    for (const o of orders) {
      const e = m.get(o.vertical) || { vertical: o.vertical, units: 0, orders: 0, revenue: 0 };
      e.units += qtyOn(o); e.orders++; e.revenue += shareOf(o);
      m.set(o.vertical, e);
    }
    return [...m.values()].sort((a, b) => b.units - a.units);
  })();

  const maxAcct = Math.max(1, ...byAccount.map((a) => a.revenue));
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const tint = V_C[deviceVertical(device)] || C.brand;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(900px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, wordBreak: 'break-word' }}>{device}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {units} unit{units === 1 ? '' : 's'} · {orders.length} order{orders.length === 1 ? '' : 's'} · {byAccount.length} account{byAccount.length === 1 ? '' : 's'} · {formatCurrency(revenue)}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
            <Stat label="Units" value={String(units)} tint={tint} />
            <Stat label="Orders" value={String(orders.length)} />
            <Stat label="Accounts" value={String(byAccount.length)} />
            <Stat label="Revenue" value={formatCurrency(revenue)} />
            <Stat label="Per unit" value={formatCurrency(perUnit)} />
          </div>

          {byVertical.length > 1 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
                {byVertical.map((v) => (
                  <span key={v.vertical} style={{ fontSize: 12.5, background: 'var(--panel-2)', borderRadius: 8, padding: '6px 11px', borderLeft: `3px solid ${V_C[v.vertical] || C.muted}` }}>
                    <b style={{ color: V_C[v.vertical] || C.ink }}>{v.vertical}</b>
                    <span style={{ color: C.sub, marginLeft: 6 }}>{v.units}u · {v.orders} ord · {formatCurrency(v.revenue)}</span>
                  </span>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
            Which accounts ordered it <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {byAccount.length}</span>
          </div>
          <table className="data-table">
            <thead><tr><th>Account</th><th className="num">Units</th><th className="num">Orders</th><th className="num">Revenue</th><th style={{ width: '28%' }} /></tr></thead>
            <tbody>
              {byAccount.map((a) => (
                <tr key={a.account}>
                  <td style={{ fontWeight: 600 }}>{a.account}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{a.units}</td>
                  <td className="num">{a.orders}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(a.revenue)}</td>
                  <td>
                    <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(a.revenue / maxAcct) * 100}%`, background: tint, borderRadius: 999 }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>
            Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {orders.length}</span>
          </div>
          <table className="data-table">
            <thead><tr>
              <th>Order</th><th>Date</th><th>Account</th><th>Vertical</th>
              <th className="num">Units</th><th className="num">Revenue</th><th>Status</th><th className="num">Age</th>
            </tr></thead>
            <tbody>
              {orders.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                <tr key={o.soId}>
                  <td style={{ fontWeight: 600, color: C.brand }}>{o.ref}</td>
                  <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                  <td style={{ fontSize: 12.5 }}>{o.account}</td>
                  <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{qtyOn(o)}</td>
                  <td className="num">{formatCurrency(shareOf(o))}</td>
                  <td style={{ fontSize: 12.5, color: statusTint(o.status), fontWeight: 600 }}>{o.status || '—'}</td>
                  <td className="num" style={{ color: (o.ageDays ?? 0) > 60 ? C.negative : C.sub }}>{o.ageDays == null ? '—' : `${o.ageDays}d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 No patient names — orders by SO reference. Revenue is this device's share of each order, apportioned by unit, so it sums to the figure in the summary table.
          </div>
        </div>
      </div>
    </div>
  );
}

// Everything the client asked to see inside an account: total orders, the device
// types and counts, order status, revenue and order date.
function AccountModal({ account, orders, onClose }: { account: string; orders: AnalyticsOrder[]; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const revenue = orders.reduce((s, o) => s + o.revenue, 0);
  const units = orders.reduce((s, o) => s + o.units, 0);
  const devices = new Map<string, number>();
  for (const o of orders) for (const d of o.devices) devices.set(d.item, (devices.get(d.item) || 0) + d.qty);
  const devList = [...devices.entries()].sort((a, b) => b[1] - a[1]);
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(880px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${C.brand}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{account}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {orders.length} order{orders.length === 1 ? '' : 's'} · {units} device{units === 1 ? '' : 's'} · {formatCurrency(revenue)}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>
        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          {/* The two summaries sit side by side and drop to one column when the
              modal is too narrow to hold both without cramping. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 18, alignItems: 'start', marginBottom: 18 }}>
            <DeviceBreakdown devices={devList} dense />
            <StatusBreakdown
              orders={orders}
              compact
              title="Revenue by status"
              sub={`${orders.length} order${orders.length === 1 ? '' : 's'} · ${formatCurrency(revenue)}`}
            />
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Orders</div>
          <table className="data-table">
            <thead><tr>
              <th>Order</th><th>Date</th><th>Vertical</th><th>Devices</th>
              <th className="num">Units</th><th className="num">Revenue</th><th>Status</th><th className="num">Age</th>
            </tr></thead>
            <tbody>
              {orders.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                <tr key={o.soId}>
                  <td style={{ fontWeight: 600, color: C.brand }}>{o.ref}</td>
                  <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                  <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                  <td><DeviceChips devices={o.devices} showVertical /></td>
                  <td className="num">{o.units || '-'}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>
                  <td style={{ fontSize: 12.5 }}>{o.status || '—'}</td>
                  <td className="num" style={{ color: (o.ageDays ?? 0) > 60 ? C.negative : C.sub }}>
                    {o.ageDays == null ? '—' : `${o.ageDays}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 No patient names — orders are shown by SO reference. "Account" is the vendor billed on the order.
          </div>
        </div>
      </div>
    </div>
  );
}
