import { useEffect, useState } from 'react';
import { AutoPoTab } from './AutoPoTab';
import { AutoSoTab } from './AutoSoTab';
import { TrackingTab } from './TrackingTab';
import {
  fetchAutoPoCandidates, fetchAutoSoCandidates, fetchTracking,
  type AutoPoCandidatesResult, type AutoSoResult, type TrackingResult,
} from '../strivenApi';
import { C } from '../chartTheme';

type Sub = 'overview' | 'autopo' | 'autoso' | 'tracking';
const fmtWhen = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

// One "Automation" hub: an Overview control-board + the Auto-PO and Auto-SO
// workflows as sub-tabs (each rendered embedded, so the hub owns the header).
export function AutomationHub({ initialTab = 'overview' }: { initialTab?: Sub } = {}) {
  const [sub, setSub] = useState<Sub>(initialTab);
  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Automation</h1>
          <div className="page-sub">Every hands-off workflow in one place — what runs, in which mode, and the steps you can trigger.</div>
        </div>
      </div>

      <div className="ov-tabs">
        <button className={`ov-tab ${sub === 'overview' ? 'active' : ''}`} onClick={() => setSub('overview')}>Overview</button>
        <button className={`ov-tab ${sub === 'autopo' ? 'active' : ''}`} onClick={() => setSub('autopo')}>Auto-PO</button>
        <button className={`ov-tab ${sub === 'autoso' ? 'active' : ''}`} onClick={() => setSub('autoso')}>Auto-SO</button>
        <button className={`ov-tab ${sub === 'tracking' ? 'active' : ''}`} onClick={() => setSub('tracking')}>Tracking</button>
      </div>

      {sub === 'overview' && <AutomationOverview onOpen={setSub} />}
      {sub === 'autopo' && <AutoPoTab embedded />}
      {sub === 'autoso' && <AutoSoTab embedded />}
      {sub === 'tracking' && <TrackingTab embedded />}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'info'; children: React.ReactNode }) {
  return <span className={`pill-tag tag-${tone}`} style={{ fontSize: 11 }}>{children}</span>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 0' }}>
      <span style={{ flex: 'none', width: 20, height: 20, borderRadius: 999, background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
      <span style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

function AutomationOverview({ onOpen }: { onOpen: (s: Sub) => void }) {
  const [po, setPo] = useState<AutoPoCandidatesResult | null>(null);
  const [so, setSo] = useState<AutoSoResult | null>(null);
  const [tr, setTr] = useState<TrackingResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([fetchAutoPoCandidates(), fetchAutoSoCandidates(), fetchTracking()]).then(([p, s, t]) => {
      if (!alive) return;
      if (p.status === 'fulfilled') setPo(p.value);
      if (s.status === 'fulfilled') setSo(s.value);
      if (t.status === 'fulfilled') setTr(t.value);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const poLive = po?.mode === 'live';
  const poDemoOnly = po?.demoOnly ?? true;

  return (
    <>
      <div className="qb-flash warn" style={{ marginBottom: 16 }}>
        🤖 <b>These run without you clicking through every order.</b> Each one is safe by design — dry-run / preview first, and live writes to Striven stay gated until you turn them on. Open any workflow below to see and trigger its steps.
      </div>

      <div className="chart-grid" style={{ marginBottom: 16 }}>
        {/* ── Auto-PO ── */}
        <div className="section" style={{ margin: 0 }}>
          <div className="section-head">
            <div>
              <h2 className="section-title">🧾 Auto-PO · Sales Order → Purchase Order</h2>
              <div className="section-sub">Raises the vendor PO for a sales order automatically.</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Pill tone={poLive ? 'danger' : 'info'}>{poLive ? '● LIVE' : '● DRY-RUN'}</Pill>
              <Pill tone={poDemoOnly ? 'warn' : 'danger'}>{poDemoOnly ? 'Pilot: demo only' : 'All orders'}</Pill>
            </div>
          </div>
          <div style={{ margin: '4px 0 12px' }}>
            <Step n={1}>Picks up a recent <b>sales order</b> (or the one you choose).</Step>
            <Step n={2}>For each item, finds the <b>vendor</b> from your PO history — same terms & template.</Step>
            <Step n={3}>Shows the exact <b>PO plan</b> (dry-run — creates nothing).</Step>
            <Step n={4}>On your click, <b>creates the PO</b> in Striven — <b>demo/test orders only</b> in pilot.</Step>
            <Step n={5}>Emails the PO <b>PDF</b> to the vendor (internal inbox in pilot).</Step>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>{loading ? 'Checking…' : `${po?.candidates?.length ?? 0} recent orders in view`}</span>
            <button className="btn" onClick={() => onOpen('autopo')}>Open Auto-PO →</button>
          </div>
        </div>

        {/* ── Auto-SO ── */}
        <div className="section" style={{ margin: 0 }}>
          <div className="section-head">
            <div>
              <h2 className="section-title">🔄 Auto-SO · Recurring resupply</h2>
              <div className="section-sub">Flags patients due for a repeat order and drafts it.</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Pill tone={so?.demoOnly === false ? 'danger' : 'warn'}>{so?.demoOnly === false ? 'Live: all' : 'Pilot: demo only'}</Pill>
              <Pill tone={so?.ready ? 'ok' : 'warn'}>{so?.ready ? 'Data ready' : 'Needs data build'}</Pill>
            </div>
          </div>
          <div style={{ margin: '4px 0 12px' }}>
            <Step n={1}>Groups every order by <b>patient</b> from the order history.</Step>
            <Step n={2}>Works out <b>how long</b> since each patient's last order.</Step>
            <Step n={3}>Flags who is <b>due</b> for a resupply ({so?.dueDays ?? 30}+ days).</Step>
            <Step n={4}>Drafts the repeat from their <b>last order's items</b>.</Step>
            <Step n={5}><b>Creates the sales order</b> in Striven on your click — <b>demo/test patients only</b> in pilot, and it won't double-create.</Step>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>{loading ? 'Checking…' : (so?.ready ? `${so?.dueCount ?? 0} due now` : 'run the report build')}</span>
            <button className="btn" onClick={() => onOpen('autoso')}>Open Auto-SO →</button>
          </div>
        </div>

        {/* ── Tracking ── */}
        <div className="section" style={{ margin: 0 }}>
          <div className="section-head">
            <div>
              <h2 className="section-title">🚚 Shipment Tracking</h2>
              <div className="section-sub">Find a patient's shipment + live carrier status.</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Pill tone={tr?.configured ? 'ok' : 'warn'}>{tr?.configured ? 'Shippo' : 'Shippo: connect'}</Pill>
            </div>
          </div>
          <div style={{ margin: '4px 0 12px' }}>
            <Step n={1}>Add the vendor <b>tracking number</b> (from the email/portal) + patient <b>last name / ship-to</b>.</Step>
            <Step n={2}>Carrier is <b>auto-detected</b> (UPS / FedEx / USPS / DHL).</Step>
            <Step n={3}>Live <b>status</b> pulls from Shippo — Delivered / In transit / Exception + ETA.</Step>
            <Step n={4}>Search a <b>last name</b> → see where it is. No more email crafting.</Step>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>{loading ? 'Checking…' : `${tr?.count ?? 0} tracked`}</span>
            <button className="btn" onClick={() => onOpen('tracking')}>Open Tracking →</button>
          </div>
        </div>
      </div>

      {/* ── Data sync (informational) ── */}
      <div className="section" style={{ margin: 0 }}>
        <div className="section-head">
          <div>
            <h2 className="section-title">🔁 Data sync</h2>
            <div className="section-sub">Keeps the numbers these workflows read fresh.</div>
          </div>
          <Pill tone="ok">Auto · every 6h</Pill>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.55 }}>
          Raw Striven data (invoices, orders, POs, payments…) refreshes <b>every 6 hours</b> automatically. The
          sales-order-wise report + resupply data (patient last name, reference, items) rebuilds from the
          <code> gen-reports</code> job — last built <b>{fmtWhen(so?.generatedAt)}</b>. Run it after new orders to
          refresh Auto-SO and the Patient-orders report.
        </div>
      </div>
    </>
  );
}
