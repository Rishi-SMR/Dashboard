import { useEffect, useMemo, useState } from 'react';
import { fetchTracking, trackingAdd, trackingRemove, type TrackingResult, type TrackingEntry } from '../strivenApi';
import { C } from '../chartTheme';
import { KpiR, useSyncAgo } from '../chartKit';

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';

const STATUS_TONE = (raw: string): 'ok' | 'info' | 'warn' | 'none' => {
  if (raw === 'DELIVERED') return 'ok';
  if (raw === 'TRANSIT') return 'info';
  if (raw === 'PRE_TRANSIT') return 'warn';
  if (raw === 'FAILURE' || raw === 'RETURNED') return 'none';
  return 'warn';
};
const CARRIERS = [{ v: '', l: 'Auto-detect' }, { v: 'ups', l: 'UPS' }, { v: 'fedex', l: 'FedEx' }, { v: 'usps', l: 'USPS' }, { v: 'dhl_express', l: 'DHL' }];

// Shipment tracking: vendor tracking numbers matched to a patient (last name /
// ship-to), with LIVE carrier status via Shippo. Crystal's use case: search a
// last name → see where the shipment is, no email crafting.
export function TrackingTab({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<TrackingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);
  // add form
  const [patient, setPatient] = useState('');
  const [vendor, setVendor] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tn, setTn] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchTracking()); setLastSync(Date.now()); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load tracking.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); const r = setInterval(() => load(true), 90_000); return () => clearInterval(r); }, []);

  async function add() {
    if (!tn.trim() || busy) return;
    setBusy(true);
    try {
      await trackingAdd({ patient: patient.trim(), vendor: vendor.trim(), carrier, tn: tn.trim() });
      setPatient(''); setVendor(''); setCarrier(''); setTn('');
      await load(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to add.'); }
    finally { setBusy(false); }
  }
  async function remove(id: string) { try { await trackingRemove(id); await load(true); } catch { /* ignore */ } }

  const entries = data?.entries ?? [];
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return entries;
    return entries.filter((e) => (e.patient || '').toLowerCase().includes(t) || e.tn.toLowerCase().includes(t) ||
      (e.vendor || '').toLowerCase().includes(t) || (e.status || '').toLowerCase().includes(t));
  }, [entries, q]);

  const delivered = entries.filter((e) => e.statusRaw === 'DELIVERED').length;
  const transit = entries.filter((e) => e.statusRaw === 'TRANSIT' || e.statusRaw === 'PRE_TRANSIT').length;
  const issues = entries.filter((e) => e.statusRaw === 'FAILURE' || e.statusRaw === 'RETURNED').length;
  const tokenBad = entries.some((e) => e.lookupError === 'bad_token') || (data && !data.configured);

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      {!embedded && (
        <div className="page-head deck-head" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Shipment Tracking</h1>
            <div className="page-sub">
              <span className="live-dot" /> Find a patient by last name → see where the shipment is{agoText ? ` · updated ${agoText}` : ''}
            </div>
          </div>
          <div className="ov-headright">
            <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}

      {tokenBad && (
        <div className="qb-flash err" style={{ marginBottom: 12 }}>
          🔑 <b>Shippo not connected</b>: live status is off until a valid Shippo <b>Live API token</b> is set
          (Settings → API in Shippo). Entries + carrier links work now; statuses will fill in once the token is valid.
        </div>
      )}

      <div className="section">
        <div className="kpi-r-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
          <KpiR ico="box" tint={C.brand} label="Tracked shipments" value={entries.length} foot="active tracking numbers" deltaText="total" />
          <KpiR ico="clock" tint="#D97706" label="In transit" value={transit} foot="on the way" deltaText="live" />
          <KpiR ico="shield" tint={issues ? '#DC2626' : '#16A34A'} label={issues ? 'Needs attention' : 'Delivered'} value={issues || delivered} foot={issues ? 'returned / exception' : 'completed'} deltaText={issues ? 'check these' : 'ok'} />
        </div>

        <div className="qb-flash warn" style={{ marginBottom: 12 }}>
          🔒 Matched by <b>last name / ship-to</b> (vendor invoices carry no order number): full patient names are never stored.
          Add a tracking number below (from the vendor email/portal); status updates automatically via Shippo.
        </div>

        {/* Add form */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="login-input" style={{ height: 38, maxWidth: 180 }} placeholder="Last name / ship-to" value={patient} onChange={(e) => setPatient(e.target.value)} />
          <input className="login-input" style={{ height: 38, maxWidth: 150 }} placeholder="Vendor (opt)" value={vendor} onChange={(e) => setVendor(e.target.value)} />
          <select className="tbl-select" value={carrier} onChange={(e) => setCarrier(e.target.value)} style={{ height: 38 }}>
            {CARRIERS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
          <input className="login-input" style={{ height: 38, maxWidth: 220 }} placeholder="Tracking number" value={tn}
            onChange={(e) => setTn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="btn" onClick={add} disabled={busy || !tn.trim()}>{busy ? 'Adding…' : '+ Add'}</button>
          <div style={{ flex: 1 }} />
          <input className="login-input" style={{ maxWidth: 220, height: 38 }} placeholder="Search last name / tracking…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {loading && !data ? <div className="page-sub" style={{ padding: 16 }}>Loading…</div> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Patient</th><th>Vendor</th><th>Carrier</th><th>Tracking #</th><th>Status</th><th>Updated</th><th>ETA</th><th />
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>{entries.length ? 'No shipments match.' : 'No tracking numbers yet: add one above.'}</td></tr>}
                {rows.map((e: TrackingEntry) => (
                  <tr key={e.id}>
                    <td style={{ fontWeight: 700 }}>{e.patient || '-'}</td>
                    <td>{e.vendor || '-'}</td>
                    <td>{e.carrierName}</td>
                    <td>
                      {e.trackingUrl
                        ? <a href={e.trackingUrl} target="_blank" rel="noreferrer" style={{ fontVariantNumeric: 'tabular-nums' }}>{e.tn} ↗</a>
                        : <span style={{ fontVariantNumeric: 'tabular-nums' }}>{e.tn}</span>}
                    </td>
                    <td>
                      <span className={`pill-tag tag-${STATUS_TONE(e.statusRaw)}`} title={e.detail || undefined}>{e.status}</span>
                      {e.location && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>{e.location}</span>}
                    </td>
                    <td style={{ fontSize: 12, color: C.muted }}>{fmtDate(e.statusUpdatedAt)}</td>
                    <td style={{ fontSize: 12, color: C.muted }}>{fmtDate(e.eta)}</td>
                    <td className="num">
                      <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => remove(e.id)} title="Remove">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
