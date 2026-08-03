import { useEffect, useState } from 'react';
import { fetchMe, fetchRepOverview, fetchCommission, type Me, type RepOverview, type CommissionResult } from '../strivenApi';
import { C } from '../chartTheme';

// ── Settings ─────────────────────────────────────────────────────────────────
// Read-only for now: who you are signed in as, the rep roster, and the state of
// the commission configuration. Everything here is edited in Supabase
// `app_config` (see README → Commission configuration), so this page reports
// rather than writes — it is deliberately not a place to change pay.
export function SettingsTab() {
  const [me, setMe] = useState<Me | null>(null);
  const [reps, setReps] = useState<RepOverview | null>(null);
  const [comm, setComm] = useState<CommissionResult | null>(null);

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null));
    fetchRepOverview().then(setReps).catch(() => setReps(null));
    fetchCommission().then(setComm).catch(() => setComm(null));
  }, []);

  const gaps = comm?.striven?.rateGaps ?? [];
  const Row = ({ k, v, note }: { k: string; v: React.ReactNode; note?: string }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 14, padding: '9px 0', borderBottom: `1px solid ${C.muted}22` }}>
      <div style={{ fontSize: 12.5, color: C.muted, fontWeight: 700 }}>{k}</div>
      <div style={{ fontSize: 13.5, color: C.ink }}>{v}{note && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{note}</div>}</div>
    </div>
  );

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Settings</h1>
          <div className="page-sub">Who you are, who the reps are, and how commission is configured.</div>
        </div>
      </div>

      <div className="section chart-card" style={{ marginBottom: 14 }}>
        <div className="section-head"><div><h2 className="section-title">Your account</h2></div></div>
        <Row k="Signed in as" v={me?.email ?? '—'} />
        <Row k="Role" v={
          <span style={{ fontWeight: 700, color: me?.role === 'admin' ? C.brand : C.sub }}>
            {me?.role === 'admin' ? 'Admin / Manager' : 'Rep'}
          </span>
        } note={me?.role === 'admin' ? 'Sees every rep unredacted, and can preview any rep’s view.' : 'Sees own figures in full, and order counts for the rest of the team.'} />
        <Row k="Mapped to rep" v={me?.repName ?? <span style={{ color: C.muted }}>not mapped</span>}
          note={me?.repName ? undefined : 'Add this address to REP_DIRECTORY to give it a personal rep view.'} />
      </div>

      <div className="section chart-card" style={{ marginBottom: 14 }}>
        <div className="section-head"><div>
          <h2 className="section-title">Rep roster</h2>
          <div className="section-sub">The reps are exactly the names on the commission sheet. Edit via the REP_DIRECTORY key in app_config.</div>
        </div></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 2px' }}>
          {(reps?.reps ?? []).map((r) => (
            <span key={r.rep} style={{ fontSize: 13, fontWeight: 700, background: 'var(--panel-2)', borderRadius: 999, padding: '6px 12px', color: r.isSelf ? C.brand : C.ink }}>
              {r.rep}{r.isSelf && <span style={{ marginLeft: 6, fontSize: 10.5, color: C.positive }}>YOU</span>}
            </span>
          ))}
          {(reps?.reps ?? []).length === 0 && <span style={{ fontSize: 13, color: C.muted }}>No reps loaded.</span>}
        </div>
      </div>

      <div className="section chart-card">
        <div className="section-head"><div>
          <h2 className="section-title">Commission configuration</h2>
          <div className="section-sub">Set in Supabase <code>app_config</code>; the checked-in defaults apply until overridden.</div>
        </div></div>
        <Row k="Rule" v={<code>commission = units × per-device rate</code>} note="Cancelled orders, $0-value orders and orders on hold all earn nothing." />
        <Row k="Sheet match threshold" v={comm?.minMatchRate != null ? `${comm.minMatchRate}%` : '—'}
          note="A rep's sheet figures count as verified at or above this, with no unresolved exceptions." />
        <Row k="Devices without a rate" v={
          <span style={{ fontWeight: 700, color: gaps.length ? C.warning : C.positive }}>{gaps.length}</span>
        } note={gaps.length ? `Priced off the legacy vertical fallback: ${gaps.slice(0, 4).join(', ')}${gaps.length > 4 ? '…' : ''}` : 'Every device has an explicit rate.'} />
        <Row k="Order labels" v="hold · waiting for reimbursement"
          note="Matched against Striven order status. Neither label exists in Striven yet, so Waiting currently reads $0." />
        <Row k="PI stages" v="Tracked in this portal"
          note="Striven has no stage field, so the five PI stages and their history live in the portal's own store." />
      </div>
    </div>
  );
}
