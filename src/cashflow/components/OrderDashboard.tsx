import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { downloadXlsx, printToPdf, stamped, type Sheet } from '../export';
import { fetchOrderAnalytics, fetchViews, saveView, deleteView, type AnalyticsOrder, type OrderAnalytics, type SavedView } from '../strivenApi';

// Is the signed-in caller a rep? Sourced from the SERVER's `scopedToRep`, which
// is non-null only when the API narrowed the payload to one person, so it cannot
// be spoofed from the client. A rep may see counts and units, never dollars, and
// this screen renders money in a dozen places across four sub-components, so the
// flag travels by context rather than through four prop chains.
const RepScope = createContext(false);
const useIsRep = () => useContext(RepScope);
import { formatCurrency, isCompletedStatus, isCancelledStatus, isRealAccount } from '../format';
import { C, VERTICAL_COLORS as V_C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';
import { PiPipeline } from './PiPipeline';
import { DeviceChips, deviceVertical, shortDeviceName } from './DeviceChips';
import { TrackingCell } from './TrackingCell';
import { ColumnFilter, SortHead } from './ColumnFilter';
import { Portal } from './Portal';
import { StatStrip } from './StatStrip';
import { SoLink } from './SoLink';

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
// No `height: 100%`: that is what made a short card stretch to its tallest
// sibling and hold the difference as blank space. A card is its own content
// now; spacing comes from padding. `marginTop: 0` stays — the grid owns the gap.
const CARD_EQUAL: React.CSSProperties = { marginTop: 0, display: 'flex', flexDirection: 'column' };

// Keeps a long label on ONE line in the flexible column of a table.
// `maxWidth: 0` is the part that makes it work: a table cell sizes to its
// content, so it will not clip until it is told it has no intrinsic width — the
// column then takes what the fixed columns leave and ellipsises the overflow.
// Without this, "SMR T/N 10 - PI TENS/NMES" wrapped to three lines in a
// half-width card and every row ended up a different height.
const ELLIPSIS: React.CSSProperties = {
  maxWidth: 0, width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
// label | orders | devices | revenue | share | bar
// Shared by the "Figures by vertical" and "Data by Status" tables so the pair
// lines up. Share and the per-row bar were dropped from both; the two trailing
// widths went with them, and the freed width goes to the label column.
const REV_COL_W = ['auto', '13%', '13%', '19%'];

// Group label: small caps with generous tracking, the one place the bar needs
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
// "Account" is the payer: Veterans Affairs, TriCare, or the PI law firm. Patient
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
  // Server-scoped role signal: non-null only when the API narrowed this payload
  // to one rep. A rep may see counts and units, never dollars, so the money
  // surfaces below are withheld rather than rendered as $0 (getOrderAnalytics
  // already nulls every revenue field for them).
  const isRep = Boolean(data?.scopedToRep);
  const totals = useMemo(() => {
    const accounts = new Set<string>();
    let devices = 0, revenue = 0, pending = 0, delivered = 0;
    for (const o of rows) {
      // Only real billed accounts. Counting "Unassigned" here is what made this
      // screen read 79 against the Dashboard's 78 for the same book.
      if (isRealAccount(o.account)) accounts.add(o.account);
      devices += o.units;
      revenue += o.revenue;
      // "Incomplete" contains "complete": see isCompletedStatus. A substring
      // test here put Incomplete orders in the Delivered bucket.
      if (isCompletedStatus(o.status)) delivered++;
      else if (!isCancelledStatus(o.status)) pending++;
    }
    return { orders: rows.length, devices, accounts: accounts.size, revenue, pending, delivered };
  }, [rows]);

  // Region the PDF captures: the filter bar and page shell are stripped by the
  // print stylesheet so the output is the view, not the app.
  const printRef = useRef<HTMLDivElement>(null);

  // Which saved view is on screen, with the filters it stood for.
  const [view, setView] = useState<{ name: string; filters: { preset: string; from: string; to: string; vert: string } } | null>(null);

  // Editing any filter by hand detaches the view, so an export is never
  // labelled with a saved view whose filters it no longer matches. Compared
  // against the snapshot rather than tracked through each setter: that way a
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
   * shows: and Summary carries the filter state so a file sent on to someone
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
        ['SMR: order dashboard export'],
        ['Generated', new Date().toLocaleString()],
        // The saved view's NAME, so a file forwarded on says which view it is,
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
    // the view, so anything visible on screen has to be in the file: a reader
    // should not have to rebuild "Figures by vertical" from the Orders tab.
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
        ['SO ref', 'Date', 'Vertical', 'Account', 'Rep', 'Status', 'Invoice status', 'Units', 'Revenue', 'Devices', 'Tracking #', 'Carrier'],
        ...rows.map((o) => [
          o.ref, o.date ? o.date.slice(0, 10) : '', o.vertical, o.account, o.rep,
          o.status, o.invStatus, o.units, o.revenue,
          (o.devices || []).map((d) => `${shortDeviceName(d.item)} x${d.qty}`).join('; '),
          // Appended rather than inserted: this sheet has no totals row keyed to
          // column positions, but anyone with a saved filter or lookup against
          // the file does, and moving Revenue would silently break it.
          // Text — a 22-digit USPS number becomes 9.33462E+21 as a number.
          o.tracking || '', o.shipVia || '',
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
  // Only verticals that ACTUALLY have orders in the current filter.
  //
  // Every vertical used to be listed whether or not it had anything, so a rep
  // working VA alone read three rows of dashes and a "no orders yet" note about
  // programmes they do not touch. The empty rows said nothing the totals did not
  // already say. `VERTICALS` still sets the ORDER, so the survivors keep their
  // familiar sequence rather than re-sorting by volume.
  const byVertical = useMemo(() => VERTICALS.map((v) => {
    const set = rows.filter((o) => o.vertical === v);
    return { vertical: v, orders: set.length, units: set.reduce((s, o) => s + o.units, 0), revenue: set.reduce((s, o) => s + o.revenue, 0) };
  }).filter((v) => v.orders > 0), [rows]);

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
    // Ranked by UNITS, and nothing is hidden.
    //
    // This used to rank by revenue and drop devices earning under a cent — they
    // sat at the bottom as a run of $0 rows with nothing to compare. With the
    // revenue column gone that filter had no visible basis left: it would have
    // silently omitted 4 device types (5 real units) from a table of unit
    // counts, for a reason the table no longer showed. `revenue` is still
    // computed because DeviceModal and the export use it.
    // `hidden` / `hiddenUnits` went with the filter — they existed only to state
    // how much the revenue cut-off had removed, and nothing is removed now.
    return { list: [...m.values()].sort((a, b) => b.qty - a.qty || a.item.localeCompare(b.item)) };
  }, [rows]);

  // ── account table: search, sort, minimum-orders ──
  // Its own controls rather than the page filter bar, because they narrow this
  // one table without re-scoping every figure above it.
  const [acctQ, setAcctQ] = useState('');
  const [acctMin, setAcctMin] = useState(0);
  const [acctSort, setAcctSort] = useState<{ key: AcctKey; dir: 'asc' | 'desc' }>({ key: 'revenue', dir: 'desc' });
  // Empty set means "all": the column filter is off until something is picked.
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
  // Scales the row bar. Units now, matching the column it sits beside.
  const maxDev = Math.max(1, ...byDevice.list.map((d) => d.qty));

  return (
    <RepScope.Provider value={isRep}>
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
                // both the controls and the view snapshot: reading `preset` et al.
                // back here would see the previous render's values.
                const eff = { preset: f.preset, from: f.from || from, to: f.to || to, vert: f.vert || 'all' };
                setPreset(eff.preset as typeof preset); setFrom(eff.from); setTo(eff.to); setVert(eff.vert);
                setView(name ? { name, filters: eff } : null);
              }}
            />
          </div>

          {/* EXPORT: whatever is on screen right now, filters included. */}
          <div role="group" aria-label="Export" style={{ paddingRight: 22 }}>
            <span style={GROUP_LABEL}>Export</span>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              <button className="btn ghost" onClick={() => exportExcel()} disabled={!rows.length}
                title="Download the current view as an Excel workbook: orders, summary, accounts and devices on separate sheets">
                ⤓ Excel
              </button>
              <button className="btn ghost" onClick={() => printToPdf(printRef.current)} disabled={!rows.length}
                title="Open the print dialog: choose “Save as PDF” for a PDF of this view, charts included">
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
      <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 14 }}>
        <KpiR ico="clip" tint={C.brand} label="Total orders" value={totals.orders} format={(n: number) => String(n)} foot="in the selected period · tap" deltaText={preset === 'all' ? 'all time' : 'filtered'} onClick={() => setTotalDrill('orders')} />
        {!isRep && (
          <KpiR ico="cash" tint={C.positive} label="Total revenue" value={totals.revenue} format={formatCurrency} foot="order value · tap" deltaText={`${totals.orders} orders`} onClick={() => setTotalDrill('revenue')} />
        )}
        <KpiR ico="trend" tint={V_C.PI} label="Total devices" value={totals.devices} format={(n: number) => String(n)} foot="units shipped on these orders · tap" deltaText="units" onClick={() => setTotalDrill('devices')} />
        <KpiR ico="shield" tint={V_C.DOL} label="Total accounts" value={totals.accounts} format={(n: number) => String(n)} foot="vendors with an order · tap" deltaText="accounts" onClick={() => setTotalDrill('accounts')} />
        <KpiR ico="clip" tint={C.warning} label="Pending orders" value={totals.pending} format={(n: number) => String(n)} foot="not yet completed · tap" deltaText="open" onClick={() => setTotalDrill('pending')} />
        <KpiR ico="shield" tint={V_C.VA} label="Delivered orders" value={totals.delivered} format={(n: number) => String(n)} foot="completed in Striven · tap" deltaText="closed" onClick={() => setTotalDrill('delivered')} />
      </div>

      {/* Layout lives in .dash-grid (cashflow.css), not inline, because it needs
          media queries: the rep's explicit card placement must not apply at a
          width too narrow for two columns. Cards size to their own content —
          see the `align-items: start` note there. */}
      <div className={`dash-grid${isRep ? ' dash-grid-rep' : ''}`}>

      {/* revenue by vertical: together and separate */}
      <div className="section chart-card dg-vertical" style={CARD_EQUAL}>
        <div className="section-head"><div>
          <h2 className="section-title">Figures by vertical</h2>
          {/* The old copy named DOL specifically as "live but has no orders yet".
              Verticals without orders are no longer listed, so that sentence
              described a row the reader could not see. */}
          <div className="section-sub">Each vertical with orders in the current filter, and the total.</div>
        </div></div>
        {/* Split by ORDERS, not revenue. On revenue this strip rendered as an
            empty grey bar for a rep — the server nulls their revenue, so every
            segment computed to zero width. Orders are a figure both roles have. */}
        <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)', marginBottom: 10 }}>
          {byVertical.filter((v) => v.orders > 0).map((v) => (
            <div key={v.vertical} title={`${v.vertical}: ${v.orders} order${v.orders === 1 ? '' : 's'}`}
              style={{ width: `${(v.orders / (totals.orders || 1)) * 100}%`, background: V_C[v.vertical] }} />
          ))}
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ width: REV_COL_W[0] }}>Vertical</th>
              <th className="num" style={{ width: REV_COL_W[1] }}>Orders</th>
              <th className="num" style={{ width: REV_COL_W[2] }}>Devices</th>
              {!isRep && <th className="num" style={{ width: REV_COL_W[3] }}>Revenue</th>}
            </tr></thead>
            <tbody>
              {byVertical.map((v) => (
                <tr key={v.vertical} onClick={() => setVert(vert === v.vertical ? 'all' : v.vertical)} style={{ cursor: 'pointer' }}
                  title={`Filter to ${v.vertical}`}>
                  <td style={{ fontWeight: 700, color: V_C[v.vertical] }}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: V_C[v.vertical], marginRight: 8 }} />{v.vertical}
                    {/* The "no orders yet" tag went with the empty rows — every
                        row here has orders now, so it could never render. */}
                  </td>
                  <td className="num">{v.orders}</td>
                  <td className="num">{v.units || '-'}</td>
                  {!isRep && <td className="num" style={{ fontWeight: 800 }}>{v.revenue ? formatCurrency(v.revenue) : '-'}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="total-row">
              <td>All verticals</td><td className="num">{totals.orders}</td><td className="num">{totals.devices}</td>
              {!isRep && <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(totals.revenue)}</td>}
            </tr></tfoot>
          </table>
        </div>
      </div>

      {/* data by status: the summary that pairs with the detailed lists */}
      {!isRep && (
        <StatusBreakdown
          orders={rows}
          title="Data by Status"
          sub="Revenue at each order status, for the current filter. Cancelled orders are excluded from every figure on this page."
        />
      )}

      {/* The PI pipeline used to render inline here as well as being its own nav
          entry and Reps subsection: three copies of one view. It now lives only
          under "PI Pipeline". */}

      {/* accounts — INSIDE the grid above, so a rep (who gets no status card)
          sees it beside "Figures by vertical" instead of stranded under a
          half-empty row. A manager already has two cards on that row, so this
          one spans the full width and their layout is unchanged. */}
      <div className="section chart-card dg-accounts" style={{ marginTop: 0 }}>
        <div className="section-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 className="section-title">
              By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 13 }}>
                · {accountRows.length === byAccount.length ? byAccount.length : `${accountRows.length} of ${byAccount.length}`}
              </span>
            </h2>
            <div className="section-sub">The vendor billed on the order: Veterans Affairs, TriCare, or the PI law firm. Click a row for its orders and devices.</div>
          </div>
          {/* search + minimum orders: narrow this table only */}
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
        <div className="table-wrap dg-scroll">
          {/* `tbl-fit` UNCONDITIONALLY, not just for a rep. It is the rule that
              shares the width evenly and centres each figure under its own
              header, and the admin view needed it more than the rep view did:
              the app-wide `.num { width: 1% }` collapses every numeric column
              to its content and hands ALL the slack to the one text column, so
              Account took ~60% of the table — mostly empty — while Verticals
              through Revenue were pushed into a huddle against the right edge,
              a third of a screen from the names they describe. */}
          <table className="data-table tbl-fit">
            <thead><tr>
              <th style={{ width: 34 }}>#</th>
              {/* Declared, because `table-layout: fixed` splits the remaining
                  width EQUALLY between undeclared columns — six of them here,
                  which would have left the names ~16% and ellipsised most of
                  them. Account carries the longest content in the table and is
                  the column a reader scans, so it takes the larger share. */}
              <th style={{ whiteSpace: 'nowrap', width: '30%' }} aria-sort={acctSort.key === 'account' ? (acctSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <span onClick={() => sortBy('account')} title="Sort by account" style={{ cursor: 'pointer', userSelect: 'none' }}>
                  Account
                  <span style={{ marginLeft: 5, opacity: acctSort.key === 'account' ? 1 : 0.25, fontSize: 10 }}>
                    {acctSort.key === 'account' && acctSort.dir === 'asc' ? '▲' : '▼'}
                  </span>
                </span>
                <ColumnFilter label="Account" options={byAccount.map((a) => ({ value: a.account, count: a.orders }))} picked={acctPick} onChange={setAcctPick} />
              </th>
              {/* Centred by hand: `tbl-fit` centres `.num`, and this column is
                  chips rather than a figure, so it would have been the one item
                  still hugging the left edge of its share. */}
              <th style={{ textAlign: 'center' }}>Verticals</th>
              <SortHead label="Orders" col="orders" sort={acctSort} onSort={sortBy} num />
              <SortHead label="Devices" col="units" sort={acctSort} onSort={sortBy} num />
              {/* "Device types" was the widest cell in the table — the header,
                  not any value — and with its sort arrow it is what pushed the
                  column off the right edge of a half-width card. */}
              <SortHead label={isRep ? 'Types' : 'Device types'} col="types" sort={acctSort} onSort={sortBy} num />
              {!isRep && <SortHead label="Revenue" col="revenue" sort={acctSort} onSort={sortBy} num />}
              {/* The revenue sparkbar column is GONE, for the admin view too.
                  It was already dropped for a rep (the server nulls their
                  revenue, so it rendered as an empty 20% column that forced a
                  sideways scroll). The same 20% is dead weight here: the table
                  is sorted by revenue, so the bar restated the row order, and
                  the distribution is too skewed for it to say anything else —
                  Abuhamdan at $78,939 against $25,980 at the bottom of the
                  page, with Veterans Affairs off the top of the scale. */}
            </tr></thead>
            <tbody>
              {byAccount.length === 0 && <tr><td colSpan={isRep ? 6 : 7} style={{ color: C.muted }}>No orders in this period.</td></tr>}
              {byAccount.length > 0 && accountRows.length === 0 && (
                <tr><td colSpan={isRep ? 6 : 7} style={{ color: C.muted }}>
                  No account matches {acctQ && <>“<b>{acctQ}</b>”</>}{acctQ && acctMin > 0 ? ' with ' : ''}{acctMin > 0 && <>{acctMin}+ orders</>}.
                  {' '}<button className="btn ghost" style={{ fontSize: 12.5 }} onClick={() => { setAcctQ(''); setAcctMin(0); setAcctPick(new Set()); }}>Reset filters</button>
                </td></tr>
              )}
              {accountRows.map((a, i) => (
                <tr key={a.account} onClick={() => setAcct(a.account)} style={{ cursor: 'pointer' }} title="Click for this account's orders">
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  {/* Same one-line rule as the device column: "Deon S
                      Goldschmidt Attorneys, PLLC" wrapped and dragged its row
                      to twice the height of the ones around it. */}
                  <td style={{ fontWeight: 700, color: C.brand, ...ELLIPSIS }} title={a.account}>{a.account}</td>
                  {/* `marginRight` became `gap`: the old margin hung off the
                      last chip, so a centred cell sat 4px left of true centre
                      and a single-chip row looked misaligned against the header
                      above it. */}
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                    <span style={{ display: 'inline-flex', gap: 4, justifyContent: 'center' }}>
                      {[...a.verticals].map((v) => (
                        <span key={v} style={{ fontSize: 10.5, fontWeight: 700, color: V_C[v] || C.sub, background: 'var(--panel-2)', borderRadius: 999, padding: '2px 7px' }}>{v}</span>
                      ))}
                    </span>
                  </td>
                  <td className="num">{a.orders}</td>
                  <td className="num">{a.units || '-'}</td>
                  <td className="num">{a.devices.size || '-'}</td>
                  {!isRep && <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(a.revenue)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* devices across all accounts — LEFT column, under "Figures by vertical",
          with "By account" alongside it. Explicit placement rather than DOM
          order: the accounts card is written before this one and has to sit to
          its right, which auto-flow cannot express. A manager keeps the
          full-width row they had. */}
      <div className="section chart-card dg-devices" style={{ marginTop: 0 }}>
        <div className="section-head"><div>
          <h2 className="section-title">By device type <span style={{ fontWeight: 500, color: C.muted, fontSize: 13 }}>· {byDevice.list.length}</span></h2>
          <div className="section-sub">
            Across every account, ranked by units dispensed. Every device type on these orders is listed.
          </div>
        </div></div>
        <div className="table-wrap dg-scroll">
          <table className={`data-table${isRep ? ' tbl-fit' : ''}`}>
            {/* The bar column is dropped in the REP layout: this card is half
                width there, and a 24% bar left the device name so little room
                that "SMR T/N 10 - PI TENS/NMES" wrapped over three lines while
                short names took one — rows of three different heights down the
                column. Units are already the second column, so the bar is the
                least of what is lost. */}
            <thead><tr><th style={{ width: 34 }}>#</th><th>Device</th><th className="num">Units</th><th className="num">Orders</th>{!isRep && <th style={{ width: '24%' }} />}</tr></thead>
            <tbody>
              {byDevice.list.length === 0 && <tr><td colSpan={isRep ? 4 : 5} style={{ color: C.muted }}>No devices on these orders.</td></tr>}
              {byDevice.list.map((d, i) => (
                <tr key={d.item} onClick={() => setDevSel(d.item)} style={{ cursor: 'pointer' }}
                  title={`Where ${d.item} went: accounts, verticals and orders`}>
                  <td style={{ color: C.muted }}>{i + 1}</td>
                  <td style={{ fontWeight: 600, ...ELLIPSIS }}>{d.item}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{d.qty}</td>
                  <td className="num">{d.orders}</td>
                  {!isRep && (
                    <td>
                      <div style={{ height: 9, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(d.qty / maxDev) * 100}%`, background: V_C.PI, borderRadius: 999 }} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      </div>{/* end of the side-by-side grid opened above the vertical card */}

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
    </RepScope.Provider>
  );
}

/**
 * Named filter sets, saved per signed-in user. Stores only the filter state,
 * period, date range and vertical: so a saved view always renders against
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



// Open work is amber, finished work green, and anything half-entered stays grey,
// so the pipeline's state reads before any number is parsed.
function statusTint(s: string): string {
  const t = String(s || '').toLowerCase();
  // Incomplete is tested FIRST. Reversed, "Incomplete" is caught by the
  // completed test: "complete" is a substring of it: and an unfinished order
  // renders green, which is the same bug that put it in the Delivered drill.
  if (/incomplete|draft|pending/.test(t)) return C.muted;
  if (isCompletedStatus(t)) return C.positive;
  return C.warning;
}

/**
 * Revenue and volume per order status: the summary that sits alongside the
 * detailed list, so "how much revenue is still In Progress" is one glance rather
 * than a manual tally. Cancelled orders never reach here; they are excluded
 * upstream from revenue, devices and counts alike.
 */
function StatusBreakdown({ orders, title, sub, compact = false }: {
  orders: AnalyticsOrder[]; title: string; sub?: string; compact?: boolean;
}) {
  const isRep = useIsRep();
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
            {!isRep && <th className="num" style={{ width: REV_COL_W[3] }}>Revenue</th>}
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
                {!isRep && <td className="num" style={{ fontWeight: 800 }}>{r.revenue ? formatCurrency(r.revenue) : '-'}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="total-row">
            <td>All statuses</td>
            <td className="num">{totOrd}</td>
            <td className="num">{totUnits || '-'}</td>
            {!isRep && <td className="num" style={{ fontWeight: 800 }}>{formatCurrency(totRev)}</td>}
          </tr></tfoot>
        </table>
      </div>
    </>
  );

  // Compact: a five-column table will not survive a half-width column, so the
  // rows become a tight grid instead: same information, no horizontal scroll.
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
  // No margin of its own: the caller's grid owns the spacing, so this can sit
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
          <span title="Demo / test items are counted in the totals above: worth excluding at source"
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
                <div key={r.item} title={`${r.item}: ${r.qty} unit${r.qty === 1 ? '' : 's'}`}
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

/** How many accounts the Revenue drill lists before it stops and says so. The
 *  full ranking is one tap away on the Accounts drill, which caps nothing. */
const ACCT_CAP = 15;

/**
 * What sits behind a headline tile.
 *
 * Count metrics open the actual orders; composition metrics open the ranked
 * breakdown. Both respect the page filters, so a drill-down can never disagree
 * with the number that was tapped: it is the same set of orders, shown closer.
 */
function TotalsDrill({ metric, orders, onClose, onPickAccount, onPickDevice }: {
  metric: TotalKey; orders: AnalyticsOrder[]; onClose: () => void;
  onPickAccount: (name: string) => void; onPickDevice: (item: string) => void;
}) {
  const isRep = useIsRep();
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
    delivered: { title: 'Delivered orders', sub: 'Marked completed in Striven: not carrier-confirmed delivery.', tint: V_C.VA },
  };
  const cfg = CFG[metric];
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');

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

  // NO SPARKBAR COLUMN. Every ranked view here is sorted by the very quantity
  // the bar encoded, so the bar re-stated the row order and nothing else —
  // while taking 26% of the width from the names, which is the column that
  // actually needed it ("Deon S Goldschmidt Attorneys, PLLC" was wrapping to
  // three lines beside a 4px stub).
  //
  // It also could not do the one job a bar is for. These distributions are
  // long-tailed: PI is $1,010,160 against TriCare's $24,025, and Veterans
  // Affairs is 5.5× the next account. Scaled to the leader, every row below
  // second place rendered as the same indistinguishable nub, so the comparison
  // it offered was one the numbers already made better.
  //
  // `money` is opt-OUT rather than global: the device views turn the Revenue
  // column off, everything else keeps it. `unit` went with the bar — it only
  // ever chose which quantity to scale by.
  const Ranked = ({ rows, onPick, money = true }: {
    rows: { name: string; orders: number; units: number; revenue: number }[];
    onPick?: (n: string) => void; money?: boolean;
  }) => {
    const showMoney = money && !isRep;
    return (
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th style={{ width: 34 }}>#</th><th>Name</th><th className="num">Orders</th><th className="num">Units</th>{showMoney && <th className="num">Revenue</th>}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} onClick={() => onPick?.(r.name)} style={{ cursor: onPick ? 'pointer' : 'default' }} title={onPick ? `Open ${r.name}` : undefined}>
                <td style={{ color: C.muted }}>{i + 1}</td>
                <td style={{ fontWeight: 600, color: onPick ? C.brand : C.ink }}>{r.name}</td>
                <td className="num">{r.orders}</td>
                <td className="num">{r.units || '-'}</td>
                {showMoney && <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(r.revenue)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // Width follows the CONTENT, not one figure for every drill. The order list
  // carries eight columns and needs the room; the ranked views carry four, and
  // at 940px the name column swallowed ~600px of slack — which is the gap. A
  // table is width:100%, so the only real fix is to stop the card being wider
  // than the table has anything to put in it.
  //
  // REVENUE USED TO TAKE THE ORDER LIST'S 940 and had the same problem one step
  // down: five columns, four of them `.num` and so collapsed to their own
  // content, which sends every pixel of slack to the account name — and the
  // longest name on the book ("Deon S Goldschmidt Attorneys, PLLC") wants about
  // 220 of them. The rest was a blank corridor between the names and the
  // figures, on both of its tables at once. 640 fits the longest name with room
  // to spare and puts the numbers back within reading distance of it.
  const width = showList ? 940 : metric === 'revenue' ? 640 : 560;
  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: `min(${width}px, 100%)`, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${cfg.tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '14px 16px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{cfg.title}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{cfg.sub}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '12px 16px', overflowX: 'auto' }}>
          <StatStrip items={[
            { label: 'Orders', value: String(set.length), tint: cfg.tint },
            { label: 'Devices', value: String(units) },
            { label: 'Accounts', value: String(byAcct.length) },
            // Withheld on the DEVICES drill, where the table below carries no
            // money either — a lone revenue figure above a units-only table
            // invites the reader to tie the two together, and they don't.
            !isRep && metric !== 'devices' && { label: 'Revenue', value: formatCurrency(revenue) },
          ]} />

          {showList ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
                Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· newest first</span>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr>
                    <th>Order</th><th>Patient</th><th>Tracking #</th><th>Date</th><th>Account</th><th>Vertical</th><th>Devices</th>
                    <th className="num">Units</th>{!isRep && <th className="num">Revenue</th>}<th>Status</th>
                  </tr></thead>
                  <tbody>
                    {set.length === 0 && <tr><td colSpan={10} style={{ color: C.muted }}>No orders here.</td></tr>}
                    {set.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                      <tr key={o.soId}>
                        <td><SoLink soId={o.soId} label={o.ref} canOpenInStriven={!isRep} /></td>
                        <td style={{ fontWeight: 600 }}>{o.patient || <span style={{ color: C.muted, fontWeight: 400 }}>-</span>}</td>
                        {/* compact: this table already carries nine columns inside
                            a 940px modal, so the carrier chip is dropped and the
                            carrier is left to the link's own title. */}
                        <td><TrackingCell shipments={o.shipments} compact /></td>
                        <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                        <td style={{ fontSize: 12.5 }}>{o.account}</td>
                        <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                        <td><DeviceChips devices={o.devices} showVertical /></td>
                        <td className="num">{o.units || '-'}</td>
                        {!isRep && <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>}
                        <td style={{ fontSize: 12.5, color: statusTint(o.status), fontWeight: 600 }}>{o.status || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : metric === 'devices' ? (
            <><div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By device type <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byDev} onPick={onPickDevice} money={false} /></>
          ) : metric === 'accounts' ? (
            <><div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byAcct} onPick={onPickAccount} /></>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
              <Ranked rows={byVert} />
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '14px 0 8px' }}>By account <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· click for detail</span></div>
              <Ranked rows={byAcct.slice(0, ACCT_CAP)} onPick={onPickAccount} />
              {/* SAYS THAT IT IS CUT. The cap was silent: 15 rows under a
                  heading reading "By account", in a modal whose own strip says
                  82 accounts, invites the reader to take the column as the whole
                  of the revenue — and it sums to a fraction of it. One line is
                  cheaper than the wrong total. */}
              {byAcct.length > ACCT_CAP && (
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 7 }}>
                  Top {ACCT_CAP} of {byAcct.length} accounts by revenue — the other{' '}
                  {byAcct.length - ACCT_CAP} carry {formatCurrency(byAcct.slice(ACCT_CAP).reduce((t, a) => t + a.revenue, 0))} between them.
                </div>
              )}
            </>
          )}
          {/* THE PRIVACY HALF ONLY WHERE THERE IS A PATIENT ON SCREEN. The
              ranked views are accounts, verticals and device types — no patient
              column, no patient anywhere — so promising that only surnames are
              shown was answering a question this drill does not raise, in two
              lines at the foot of it. The exclusions note applies to every
              figure here and stays on all of them. */}
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
            {showList && '🔒 Patient SURNAME only — never a first name, date of birth or address. '}
            Cancelled orders are excluded from every figure.
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// `Stat` — the tile this file's drills used to head with — is GONE, not merely
// unused: both callers now read StatStrip, and leaving the tile behind would
// invite the next drill to reach for it and reintroduce the 74px header the
// strip exists to remove. The page-level tiles are a different component and are
// untouched.

/**
 * One device type, everywhere it went: which accounts bought it, which verticals
 * it sold into, and the individual orders.
 *
 * An order can carry several devices, so this device's share of that order's
 * revenue is apportioned by unit: the same rule the summary table uses, which
 * keeps the modal's total equal to the row you clicked.
 */
function DeviceModal({ device, orders, onClose }: { device: string; orders: AnalyticsOrder[]; onClose: () => void }) {
  // BACK, for a different reason than it left. This was dropped when the revenue
  // columns went — nothing on the modal needed the role. The order reference is
  // now openable, and only an admin is offered the jump into Striven, so the
  // flag is read again. It still gates NOTHING about the data on screen.
  const isRep = useIsRep();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const qtyOn = (o: AnalyticsOrder) => o.devices.filter((d) => d.item === device).reduce((s, d) => s + d.qty, 0);

  // No revenue on this modal: not the summary line, not a tile, not a column,
  // and not the bar. Both tables rank and scale by UNITS instead, which is what
  // they now show. `shareOf` — this device's apportioned share of an order's
  // revenue — went with them; the same rule still lives in the page's byDevice
  // memo, which the Excel export reads.
  const units = orders.reduce((s, o) => s + qtyOn(o), 0);

  const byAccount = (() => {
    const m = new Map<string, { account: string; units: number; orders: number }>();
    for (const o of orders) {
      const e = m.get(o.account) || { account: o.account, units: 0, orders: 0 };
      e.units += qtyOn(o); e.orders++;
      m.set(o.account, e);
    }
    return [...m.values()].sort((a, b) => b.units - a.units || a.account.localeCompare(b.account));
  })();

  const byVertical = (() => {
    const m = new Map<string, { vertical: string; units: number; orders: number }>();
    for (const o of orders) {
      const e = m.get(o.vertical) || { vertical: o.vertical, units: 0, orders: 0 };
      e.units += qtyOn(o); e.orders++;
      m.set(o.vertical, e);
    }
    return [...m.values()].sort((a, b) => b.units - a.units);
  })();

  const maxAcct = Math.max(1, ...byAccount.map((a) => a.units));
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');
  const tint = V_C[deviceVertical(device)] || C.brand;

  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,46,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'clamp(10px, 3vw, 20px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(900px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', borderTop: `4px solid ${tint}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '16px 18px', borderBottom: '1px solid #EAEEF4', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, wordBreak: 'break-word' }}>{device}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {units} unit{units === 1 ? '' : 's'} · {orders.length} order{orders.length === 1 ? '' : 's'} · {byAccount.length} account{byAccount.length === 1 ? '' : 's'}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close" style={{ flex: 'none' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', overflowX: 'auto' }}>
          {/* NO FIGURE STRIP HERE AT ALL. The three cards that stood here —
              Units, Orders, Accounts — were the subtitle of this very modal
              printed a second time, six lines lower and four times taller:
              "215 units · 47 orders · 9 accounts" is already in the header. A
              summary that summarises the line above it is not a summary.

              (Revenue and Per unit went earlier, and for a different reason: per
              unit was revenue ÷ units, so without revenue it was a dollar figure
              with nothing on the modal to derive it from.) */}

          {byVertical.length > 1 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>By vertical</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
                {byVertical.map((v) => (
                  <span key={v.vertical} style={{ fontSize: 12.5, background: 'var(--panel-2)', borderRadius: 8, padding: '6px 11px', borderLeft: `3px solid ${V_C[v.vertical] || C.muted}` }}>
                    <b style={{ color: V_C[v.vertical] || C.ink }}>{v.vertical}</b>
                    <span style={{ color: C.sub, marginLeft: 6 }}>{v.units}u · {v.orders} ord</span>
                  </span>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
            Which accounts ordered it <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {byAccount.length}</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Account</th><th className="num">Units</th><th className="num">Orders</th><th style={{ width: '28%' }} /></tr></thead>
              <tbody>
                {byAccount.map((a) => (
                  <tr key={a.account}>
                    <td style={{ fontWeight: 600 }}>{a.account}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{a.units}</td>
                    <td className="num">{a.orders}</td>
                    <td>
                      <div style={{ height: 8, borderRadius: 999, background: 'var(--panel-2)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(a.units / maxAcct) * 100}%`, background: tint, borderRadius: 999 }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: '18px 0 8px' }}>
            Order by order <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {orders.length}</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>
                <th>Order</th><th>Patient</th><th>Tracking #</th><th>Date</th><th>Account</th><th>Vertical</th>
                <th className="num">Units</th><th>Status</th><th className="num">Age</th>
              </tr></thead>
              <tbody>
                {orders.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                  <tr key={o.soId}>
                    <td><SoLink soId={o.soId} label={o.ref} canOpenInStriven={!isRep} /></td>
                    <td style={{ fontWeight: 600 }}>{o.patient || <span style={{ color: C.muted, fontWeight: 400 }}>-</span>}</td>
                    <td><TrackingCell shipments={o.shipments} compact /></td>
                    <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                    <td style={{ fontSize: 12.5 }}>{o.account}</td>
                    <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{qtyOn(o)}</td>
                    <td style={{ fontSize: 12.5, color: statusTint(o.status), fontWeight: 600 }}>{o.status || '-'}</td>
                    <td className="num" style={{ color: (o.ageDays ?? 0) > 60 ? C.negative : C.sub }}>{o.ageDays == null ? '-' : `${o.ageDays}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 Patient SURNAME only — never a first name, date of birth or address. Units are this device's own count on each order, not the order's total.
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// Everything the client asked to see inside an account: total orders, the device
// types and counts, order status, revenue and order date.
function AccountModal({ account, orders, onClose }: { account: string; orders: AnalyticsOrder[]; onClose: () => void }) {
  const isRep = useIsRep();
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
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-');

  return (
    // Portalled to <body>: a fixed backdrop must mean the VIEWPORT, and any
    // transform on an ancestor silently redefines that. See Portal.tsx.
    <Portal>
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
              title="Data by Status"
              sub={`${orders.length} order${orders.length === 1 ? '' : 's'} · ${formatCurrency(revenue)}`}
            />
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Orders</div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>
                <th>Order</th><th>Patient</th><th>Tracking #</th><th>Date</th><th>Vertical</th><th>Devices</th>
                <th className="num">Units</th>{!isRep && <th className="num">Revenue</th>}<th>Status</th><th className="num">Age</th>
              </tr></thead>
              <tbody>
                {orders.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((o) => (
                  <tr key={o.soId}>
                    <td><SoLink soId={o.soId} label={o.ref} canOpenInStriven={!isRep} /></td>
                    <td style={{ fontWeight: 600 }}>{o.patient || <span style={{ color: C.muted, fontWeight: 400 }}>-</span>}</td>
                    <td><TrackingCell shipments={o.shipments} compact /></td>
                    <td style={{ fontSize: 12.5 }}>{fmtDate(o.date)}</td>
                    <td style={{ fontWeight: 600, color: V_C[o.vertical] || C.ink }}>{o.vertical}</td>
                    <td><DeviceChips devices={o.devices} showVertical /></td>
                    <td className="num">{o.units || '-'}</td>
                    {!isRep && <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>}
                    <td style={{ fontSize: 12.5 }}>{o.status || '-'}</td>
                    <td className="num" style={{ color: (o.ageDays ?? 0) > 60 ? C.negative : C.sub }}>
                      {o.ageDays == null ? '-' : `${o.ageDays}d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 Patient SURNAME only — never a first name, date of birth or address. "Account" is the vendor billed on the order.
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}
