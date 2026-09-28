import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchRepTerritories, type RepTerritories, type TerritoryRep } from '../strivenApi';
import { KpiR, DrillModal, useSyncAgo } from '../chartKit';

// Reps & Territories, from the Master Data sheet's "Reps With Its Clinics &
// Law Firms" tab. The SERVER decides what each viewer gets: an admin receives
// every rep, a rep receives only their own blocks — nothing here filters for
// privacy, it only filters for the admin's search.

// One row per law firm, the clinic named once beside its firms (rowSpan).
// A clinic with no firm listed still gets its row.
function ClinicList({ rep }: { rep: TerritoryRep }) {
  if (rep.clinics.length === 0) return <div className="muted-note">No clinics listed for this rep yet.</div>;
  let n = 0;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Clinic</th>
            <th style={{ width: 48 }} className="num">#</th>
            <th>Law Firm</th>
          </tr>
        </thead>
        <tbody>
          {rep.clinics.map((c) => {
            const firms = c.lawFirms.length ? c.lawFirms : [null];
            return firms.map((f, i) => (
              <tr key={`${c.name}-${f?.name ?? 'none'}`}>
                {i === 0 && (
                  <td rowSpan={firms.length} style={{ verticalAlign: 'top', borderRight: '1px solid var(--border)' }}>
                    <strong>{c.name}</strong>
                    <div className="muted-note" style={{ margin: '2px 0 0' }}>
                      {c.lawFirms.length ? `${c.lawFirms.length} law firm${c.lawFirms.length === 1 ? '' : 's'}` : 'no law firms'}
                    </div>
                  </td>
                )}
                <td className="num muted-note" style={{ margin: 0 }}>{f ? ++n : ''}</td>
                <td>
                  {!f ? <span className="muted-note" style={{ margin: 0 }}>–</span>
                    : f.doNotAccept
                      ? <span className="pill-tag tag-none" title="Flagged in the sheet: do not accept orders">{f.name}</span>
                      : f.name}
                </td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RepTerritoriesTab() {
  const [data, setData] = useState<RepTerritories | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [drill, setDrill] = useState<null | 'reps' | 'clinics' | 'firms'>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const agoText = useSyncAgo(lastSync);

  // The Refresh button passes `fresh` so it reads the sheet itself, not the
  // server's copy; the silent 90s poll does not, to keep the sheet unhammered.
  async function load(silent = false, fresh = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setData(await fetchRepTerritories(null, fresh));
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load territories.');
    } finally { if (!silent) setLoading(false); }
  }
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const isAdmin = data?.scope === 'all';
  const reps = data?.reps ?? [];

  // Admin search: a rep matches on their own label, email, any clinic or any
  // law firm. A clinic/firm hit also opens that rep so the match is visible.
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (!q ? reps : reps.filter((r) =>
    r.rep.toLowerCase().includes(q) || r.emails.some((e) => e.includes(q)) ||
    r.clinics.some((c) => c.name.toLowerCase().includes(q) || c.lawFirms.some((f) => f.name.toLowerCase().includes(q))))), [reps, q]);

  // ── Card drills ────────────────────────────────────────────────────────────
  // Admin: a name in a drill is a button that filters the All Reps table to it
  // and scrolls there. Rep: their page already shows everything, so names are
  // plain text and the drill is the summary itself.
  const jump = (opts: { rep?: string; search?: string }) => {
    setDrill(null);
    setQuery(opts.search ?? '');
    setOpen(opts.rep ?? null);
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const link = (label: string, go: () => void): ReactNode => (isAdmin
    ? <button className="btn ghost" style={{ padding: '2px 8px', textAlign: 'left' }} onClick={go}><strong>{label}</strong></button>
    : <strong>{label}</strong>);
  const repNames = (names: string[]) => names.join(' · ');

  // clinic → { reps, firms }  and  firm → { clinics, reps, flagged }
  const clinicIndex = useMemo(() => {
    const m = new Map<string, { reps: Set<string>; firms: Set<string> }>();
    for (const r of reps) for (const c of r.clinics) {
      if (c.name === '(clinic not listed)') continue;
      const e = m.get(c.name) ?? { reps: new Set(), firms: new Set() };
      e.reps.add(r.rep); c.lawFirms.forEach((f) => e.firms.add(f.name)); m.set(c.name, e);
    }
    return [...m.entries()].sort((a, b) => b[1].firms.size - a[1].firms.size || a[0].localeCompare(b[0]));
  }, [reps]);
  const firmIndex = useMemo(() => {
    const m = new Map<string, { name: string; clinics: Set<string>; reps: Set<string>; flagged: boolean }>();
    for (const r of reps) for (const c of r.clinics) for (const f of c.lawFirms) {
      const k = f.name.toLowerCase();
      const e = m.get(k) ?? { name: f.name, clinics: new Set(), reps: new Set(), flagged: false };
      e.clinics.add(c.name); e.reps.add(r.rep); e.flagged ||= f.doNotAccept; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.clinics.size - a.clinics.size || a.name.localeCompare(b.name));
  }, [reps]);

  const drillSpec = (): null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean; left?: boolean }[]; rows: Record<string, ReactNode>[] } => {
    if (drill === 'reps') return {
      title: 'Reps', sub: `${reps.length} reps with a territory · click a rep to open their clinics`,
      columns: [{ key: 'rep', label: 'Rep', left: true }, { key: 'clinics', label: 'Clinics', num: true }, { key: 'firms', label: 'Law Firms', num: true }, { key: 'email', label: 'Email' }],
      rows: [...reps].sort((a, b) => b.clinicCount - a.clinicCount).map((r) => ({
        rep: link(r.rep, () => jump({ rep: r.rep })), clinics: r.clinicCount, firms: r.lawFirmCount, email: r.emails.join(', ') || '–',
      })),
    };
    if (drill === 'clinics') return {
      title: 'Clinics', sub: `${clinicIndex.length} clinics${isAdmin ? ' · click a clinic to find it in the list' : ''}`,
      columns: [{ key: 'clinic', label: 'Clinic', left: true }, { key: 'firms', label: 'Law Firms', num: true }, ...(isAdmin ? [{ key: 'reps', label: 'Rep(s)' }] : [])],
      rows: clinicIndex.map(([name, e]) => ({ clinic: link(name, () => jump({ search: name })), firms: e.firms.size, reps: repNames([...e.reps]) })),
    };
    if (drill === 'firms') {
      const list = firmIndex;
      return {
        title: 'Law Firms',
        sub: `${list.length} distinct law firms${isAdmin ? ' · click a firm to find it in the list' : ''}`,
        columns: [{ key: 'firm', label: 'Law Firm', left: true }, { key: 'n', label: 'Clinics', num: true }, { key: 'clinics', label: 'Clinic(s)' }, ...(isAdmin ? [{ key: 'reps', label: 'Rep(s)' }] : [])],
        rows: list.map((f) => ({
          firm: f.flagged ? <span className="pill-tag tag-none">{isAdmin ? <button className="btn ghost" style={{ padding: 0, border: 0, background: 'none', color: 'inherit', font: 'inherit' }} onClick={() => jump({ search: f.name })}>{f.name}</button> : f.name}</span> : link(f.name, () => jump({ search: f.name })),
          n: f.clinics.size, clinics: [...f.clinics].join(' · '), reps: repNames([...f.reps]),
        })),
      };
    }
    return null;
  };
  const spec = drillSpec();

  const title = isAdmin ? 'Reps & Territories' : 'My Territory';

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>{title}</h1>
          <div className="page-sub">
            <span className="live-dot" /> Clinics &amp; law firms · live from Master Data{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <button className="btn ghost" onClick={() => load(false, true)} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {data && !data.ok && <div className="error">{data.note}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data?.ok && (
        <div className="kpi-r-strip" style={{ gridTemplateColumns: `repeat(${isAdmin ? 3 : 2}, 1fr)` }}>
          {isAdmin && (
            <KpiR ico="users" tint="#0A369F" label="Reps" value={data.totals.reps}
              deltaText="with a territory in the sheet" foot="click to list them" onClick={() => setDrill('reps')} />
          )}
          <KpiR ico="bank" tint="#16A34A" label="Clinics" value={data.totals.clinics}
            deltaText={isAdmin ? 'across all reps' : 'you cover'} foot="click to list them" onClick={() => setDrill('clinics')} />
          <KpiR ico="doc" tint="#7C3AED" label="Law Firms" value={data.totals.lawFirms}
            deltaText={isAdmin ? 'distinct, across all clinics' : 'distinct, across your clinics'} foot="click to list them" onClick={() => setDrill('firms')} />
        </div>
      )}

      {data?.ok && !isAdmin && (
        reps.length === 0
          ? <div className="section chart-card"><div className="muted-note">{data.note ?? 'No territory is assigned to you yet.'}</div></div>
          : reps.map((r) => (
            <div key={r.rep} className="section chart-card" style={{ marginBottom: 14 }}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">{r.rep}</h2>
                  <div className="section-sub">{r.clinicCount} clinic{r.clinicCount === 1 ? '' : 's'} · {r.lawFirmCount} law firm{r.lawFirmCount === 1 ? '' : 's'}{r.emails.length ? ` · ${r.emails.join(', ')}` : ''}</div>
                </div>
              </div>
              <ClinicList rep={r} />
            </div>
          ))
      )}

      {data?.ok && isAdmin && (
        <div className="section chart-card" ref={listRef} style={{ scrollMarginTop: 16 }}>
          <div className="section-head">
            <div>
              <h2 className="section-title">All Reps</h2>
              <div className="section-sub">{shown.length} of {reps.length} reps · click a rep to see their clinics and law firms</div>
            </div>
            <div className="tbl-controls">
              <input className="tbl-search" style={{ width: 240 }} type="text" value={query}
                onChange={(e) => setQuery(e.target.value)} placeholder="Search rep, clinic or law firm…" />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>Rep</th>
                  <th className="num">Clinics</th>
                  <th className="num">Law Firms</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const isOpen = open === r.rep || (q !== '' && !r.rep.toLowerCase().includes(q));
                  return [
                    <tr key={r.rep} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.rep ? null : r.rep)}>
                      <td>{isOpen ? '▾' : '▸'}</td>
                      <td><strong>{r.rep}</strong></td>
                      <td className="num">{r.clinicCount}</td>
                      <td className="num">{r.lawFirmCount}</td>
                      <td>{r.emails.length ? r.emails.join(', ') : <span className="muted-note" style={{ margin: 0 }}>–</span>}</td>
                    </tr>,
                    isOpen && (
                      <tr key={`${r.rep}-detail`}>
                        <td />
                        <td colSpan={4} style={{ background: 'var(--bg)', padding: 12 }}><ClinicList rep={r} /></td>
                      </tr>
                    ),
                  ];
                })}
                {shown.length === 0 && (
                  <tr><td colSpan={5} className="muted-note">No rep, clinic or law firm matches your search.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {spec && (
        <DrillModal title={spec.title} sub={spec.sub} columns={spec.columns} rows={spec.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
