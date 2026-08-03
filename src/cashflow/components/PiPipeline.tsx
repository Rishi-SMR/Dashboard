import { useEffect, useState } from 'react';
import { fetchPiStages, setPiStage, type PiStages, type PiStageName, type PiStageOrder } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { DeviceChips } from './DeviceChips';
import { ColumnFilter, SortHead } from './ColumnFilter';

// Cool → warm across the pipeline, so position reads as progress at a glance.
const STAGE_C: Record<string, string> = {
  'Order received': '#64748B',
  'Awaiting LOP': '#D97706',
  Dispensed: '#0A369F',
  Shipped: '#0891B2',
  Delivered: '#16A34A',
};
// Days in a stage past which a row is worth chasing.
const STALE_DAYS = 14;
type SortKey = 'ref' | 'account' | 'devices' | 'units' | 'revenue' | 'days';

// ── Personal Injury pipeline ─────────────────────────────────────────────────
// Striven only carries In Progress / Completed / Canceled / Incomplete, so these
// five stages are tracked in the portal. Every move is recorded, which is what
// makes "how long has this been sitting" a real measurement rather than a guess.
export function PiPipeline({ viewAs }: { viewAs?: string | null }) {
  const [data, setData] = useState<PiStages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PiStageName | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Per-stage table controls. Cleared whenever a different stage is opened, so
  // filters never silently carry over and make a stage look empty.
  const [query, setQuery] = useState('');
  const [pickAcct, setPickAcct] = useState<Set<string>>(new Set());
  const [pickDev, setPickDev] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'days', dir: 'asc' });
  useEffect(() => { setQuery(''); setPickAcct(new Set()); setPickDev(new Set()); }, [open]);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchPiStages(viewAs)); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load the pipeline.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [viewAs]);

  async function move(o: PiStageOrder, stage: PiStageName) {
    setSaving(o.soId);
    try {
      const r = await setPiStage(o.soId, stage);
      if (r?.error) setError(r.error); else await load(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not move that order.'); }
    finally { setSaving(null); }
  }

  const stages = data?.stages ?? [];
  const total = stages.reduce((s, x) => s + x.count, 0);
  const inStage = open ? (data?.orders ?? []).filter((o) => o.stage === open) : [];

  // Options are built from the orders IN THIS STAGE, so the pickers only ever
  // offer values that can actually match.
  const acctOpts = (() => {
    const m = new Map<string, number>();
    for (const o of inStage) m.set(o.account, (m.get(o.account) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  })();
  const devOpts = (() => {
    const m = new Map<string, number>();
    for (const o of inStage) for (const d of o.devices) m.set(d.item, (m.get(d.item) ?? 0) + d.qty);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  })();

  const openOrders = (() => {
    const q = query.trim().toLowerCase();
    const rows = inStage.filter((o) =>
      (pickAcct.size === 0 || pickAcct.has(o.account))
      && (pickDev.size === 0 || o.devices.some((d) => pickDev.has(d.item)))
      && (!q
        || o.ref.toLowerCase().includes(q)
        || o.account.toLowerCase().includes(q)
        || o.devices.some((d) => d.item.toLowerCase().includes(q))));
    const { key, dir } = sort;
    const val = (o: PiStageOrder) =>
      key === 'account' ? o.account.toLowerCase()
        : key === 'ref' ? o.ref.toLowerCase()
          : key === 'devices' ? o.devices.length
            : key === 'units' ? o.units
              : key === 'revenue' ? o.revenue
                : (o.daysInStage ?? 0);
    return [...rows].sort((x, y) => {
      const A = val(x), B = val(y);
      const c = typeof A === 'string' ? A.localeCompare(String(B)) : (A as number) - (B as number);
      return dir === 'asc' ? c : -c;
    });
  })();
  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'account' || key === 'ref' ? 'asc' : 'desc') }));
  const filtersOn = Boolean(query) || pickAcct.size > 0 || pickDev.size > 0;
  const resetFilters = () => { setQuery(''); setPickAcct(new Set()); setPickDev(new Set()); };

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 10 }}><div>
        <h2 className="section-title">Personal Injury pipeline</h2>
        <div className="section-sub">
          {total} PI order{total === 1 ? '' : 's'}. Click a stage to see its orders, and move an order with the dropdown on its row.
          {data && data.trackedCount < total && (
            <> Ageing is measured from the first time an order is moved: <b>{total - data.trackedCount}</b> {total - data.trackedCount === 1 ? 'order has' : 'orders have'} never
            been moved, so {total - data.trackedCount === 1 ? 'its' : 'their'} age falls back to the order date and is marked <i>est.</i></>
          )}
        </div>
      </div></div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* stage cards: count, ageing and revenue per stage */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))', gap: 12, marginBottom: 14 }}>
        {stages.map((s, i) => {
          const active = open === s.stage;
          return (
            <button key={s.stage} onClick={() => setOpen(active ? null : s.stage)}
              title={`${s.count} order${s.count === 1 ? '' : 's'}: click to ${active ? 'hide' : 'list'} them`}
              style={{
                textAlign: 'left', cursor: 'pointer', background: 'var(--panel)', borderRadius: 12, padding: '14px 16px',
                border: `1px solid ${active ? STAGE_C[s.stage] : 'var(--panel-2)'}`,
                boxShadow: active ? `0 0 0 3px ${STAGE_C[s.stage]}22` : 'none', position: 'relative', overflow: 'hidden',
              }}>
              <span style={{ position: 'absolute', inset: '0 auto 0 0', width: 3, background: STAGE_C[s.stage] }} />
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: C.muted }}>
                Stage {i + 1}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: STAGE_C[s.stage], marginTop: 2 }}>{s.stage}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.ink, marginTop: 4, letterSpacing: -0.5 }}>{s.count}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {s.count === 0 ? 'nothing here' : <>avg {s.avgDays}d · oldest {s.oldestDays}d</>}
              </div>
              {s.revenue > 0 && <div style={{ fontSize: 12, color: C.sub, fontWeight: 600, marginTop: 3 }}>{formatCurrency(s.revenue)}</div>}
            </button>
          );
        })}
      </div>

      {/* flow bar: share of the pipeline sitting at each stage */}
      {total > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
            {stages.filter((s) => s.count > 0).map((s) => (
              <div key={s.stage} title={`${s.stage}: ${s.count}`} onClick={() => setOpen(open === s.stage ? null : s.stage)}
                style={{ width: `${(s.count / total) * 100}%`, background: STAGE_C[s.stage], cursor: 'pointer' }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8, fontSize: 12, color: C.sub }}>
            {stages.filter((s) => s.count > 0).map((s) => (
              <span key={s.stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: STAGE_C[s.stage] }} />
                {s.stage} {Math.round((s.count / total) * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* the orders in the clicked stage */}
      {open && (
        <div className="section chart-card">
          <div className="section-head"><div>
            <h2 className="section-title" style={{ color: STAGE_C[open] }}>
              {open} · {openOrders.length === inStage.length ? `${inStage.length}` : `${openOrders.length} of ${inStage.length}`} order{inStage.length === 1 ? '' : 's'}
            </h2>
            <div className="section-sub">
              Newest first: the most recent arrivals at the top, then in ascending order of time in stage.
              Anything past {STALE_DAYS} days is still flagged in red wherever it sits.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: 9, fontSize: 12, color: C.muted, pointerEvents: 'none' }}>⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order, account, device" aria-label="Search this stage"
                style={{ padding: '6px 26px 6px 24px', borderRadius: 8, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, width: 230 }} />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Clear search" title="Clear"
                  style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
              )}
            </div>
            {filtersOn && <button className="btn ghost" style={{ fontSize: 12.5 }} onClick={resetFilters}>Reset</button>}
            <button className="btn ghost" onClick={() => setOpen(null)}>Close</button>
          </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <SortHead label="Order" col="ref" sort={sort} onSort={sortBy} />
                <SortHead label="Account" col="account" sort={sort} onSort={sortBy}>
                  <ColumnFilter label="Account" options={acctOpts} picked={pickAcct} onChange={setPickAcct} />
                </SortHead>
                <SortHead label="Devices" col="devices" sort={sort} onSort={sortBy}>
                  <ColumnFilter label="Device" options={devOpts} picked={pickDev} onChange={setPickDev} />
                </SortHead>
                <SortHead label="Units" col="units" sort={sort} onSort={sortBy} num />
                <SortHead label="Revenue" col="revenue" sort={sort} onSort={sortBy} num />
                <SortHead label="In stage" col="days" sort={sort} onSort={sortBy} num />
                <th>Move to</th>
              </tr></thead>
              <tbody>
                {openOrders.length === 0 && <tr><td colSpan={7} style={{ color: C.muted }}>No orders at this stage.</td></tr>}
                {openOrders.map((o) => {
                  const stale = (o.daysInStage ?? 0) >= STALE_DAYS;
                  return (
                    <tr key={o.soId}>
                      <td style={{ fontWeight: 600, color: C.brand }}>{o.ref}</td>
                      <td style={{ fontSize: 12.5 }}>{o.account}</td>
                      {/* Every order here is PI, so the dot would say the same
                          thing on every chip: the name alone is enough. */}
                      <td><DeviceChips devices={o.devices} /></td>
                      <td className="num">{o.units || '-'}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>
                      <td className="num" style={{ color: stale ? C.negative : C.sub, fontWeight: stale ? 700 : 400 }}>
                        {o.daysInStage == null ? '-' : `${o.daysInStage}d`}
                        {o.estimated && <span title="Never moved: measured from the order date" style={{ fontSize: 10.5, color: C.muted, marginLeft: 4 }}>est.</span>}
                      </td>
                      <td>
                        <select value={o.stage} disabled={!data?.canEdit || saving === o.soId}
                          onChange={(e) => move(o, e.target.value as PiStageName)}
                          aria-label={`Stage for ${o.ref}`}
                          style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${C.muted}55`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 600, cursor: data?.canEdit ? 'pointer' : 'not-allowed' }}>
                          {(data?.stageNames ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        {saving === o.soId && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>saving…</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            🔒 No patient names: orders by SO reference. Moving an order records the transition, so its time-in-stage is measured from then on.
          </div>
        </div>
      )}

      {data && !data.autoFromTracking && (
        <div className="qb-flash warn" style={{ marginTop: 14 }}>
          ⚠️ Shipped and Delivered are set by hand. Carrier status can't advance them automatically yet: the tracking module keys its rows
          by patient last name, not by sales order, so there is no reliable join. Add an SO reference to tracking rows and I can wire it up.
        </div>
      )}
    </div>
  );
}
