import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchRepTerritories, fetchTerritoryLawFirms, type RepTerritories, type TerritoryRep, type TerritoryLawFirmHit } from '../strivenApi';
import { KpiR, DrillModal, useSyncAgo } from '../chartKit';

// Reps & Territories, from the Master Data sheet's "Reps With Its Clinics &
// Law Firms" tab. The SERVER decides what each viewer gets: an admin receives
// every rep, a rep receives only their own blocks — nothing here filters for
// privacy, it only filters for the admin's search.
//
// LAW FIRMS ARE LOOKED UP ON DEMAND (5 Oct 2026, on request). The territories
// payload carries each clinic's firm COUNT only; the names stay on the server
// and are fetched when someone asks — the "Find law firms" search, or a
// clinic's "Show law firms" — through the same viewer scoping.

/** A small firm table: firm, plus clinic and rep where the context needs them. */
function FirmTable({ rows, showClinic, showRep }: { rows: TerritoryLawFirmHit[]; showClinic: boolean; showRep: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 40 }} className="num">#</th>
            <th>Law Firm</th>
            {showClinic && <th>Clinic</th>}
            {showRep && <th>Rep</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.rep}|${r.clinic}|${r.firm}`}>
              <td className="num muted-note" style={{ margin: 0 }}>{i + 1}</td>
              <td>{r.doNotAccept
                ? <span className="pill-tag tag-none" title="Flagged in the sheet: do not accept orders">{r.firm}</span>
                : r.firm}</td>
              {showClinic && <td>{r.clinic}</td>}
              {showRep && <td>{r.rep}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One clinic's firms, fetched the first time it is opened. */
function ClinicFirms({ rep, clinic }: { rep: string; clinic: string }) {
  const [rows, setRows] = useState<TerritoryLawFirmHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchTerritoryLawFirms({ rep, clinic })
      .then((r) => { if (alive) setRows(r.results ?? []); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Lookup failed'); });
    return () => { alive = false; };
  }, [rep, clinic]);
  if (err) return <div className="error">{err}</div>;
  if (!rows) return <div className="muted-note">Looking up law firms…</div>;
  if (!rows.length) return <div className="muted-note">No law firms linked to this clinic.</div>;
  return <FirmTable rows={rows} showClinic={false} showRep={false} />;
}

// One row per clinic, with its firm COUNT; the firms themselves open on demand.
function ClinicList({ rep }: { rep: TerritoryRep }) {
  const [openClinic, setOpenClinic] = useState<string | null>(null);
  if (rep.clinics.length === 0) return <div className="muted-note">No clinics listed for this rep yet.</div>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Clinic</th>
            <th className="num" style={{ width: 110 }}>Law Firms</th>
            <th style={{ width: 170 }} />
          </tr>
        </thead>
        <tbody>
          {rep.clinics.map((c) => {
            const isOpen = openClinic === c.name;
            return [
              <tr key={c.name}>
                <td><strong>{c.name}</strong>{c.flaggedCount > 0 && (
                  <span className="pill-tag tag-none" style={{ marginLeft: 8 }} title="Firms flagged in the sheet: do not accept orders">{c.flaggedCount} do-not-accept</span>
                )}</td>
                <td className="num">{c.lawFirmCount}</td>
                <td>{c.lawFirmCount > 0 && (
                  <button className="btn ghost" style={{ padding: '3px 10px' }} onClick={(e) => { e.stopPropagation(); setOpenClinic(isOpen ? null : c.name); }}>
                    {isOpen ? 'Hide law firms' : 'Show law firms'}
                  </button>
                )}</td>
              </tr>,
              isOpen && (
                <tr key={`${c.name}-firms`}>
                  <td colSpan={3} style={{ background: 'var(--panel-2)', padding: 10 }}><ClinicFirms rep={rep.rep} clinic={c.name} /></td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * FIND LAW FIRMS — the on-demand lookup. Type a firm, a clinic or a rep (2+
 * characters) and the server returns every matching firm × clinic link within
 * the viewer's own territories.
 */
function LawFirmSearch({ isAdmin, inputRef }: { isAdmin: boolean; inputRef: React.RefObject<HTMLInputElement> }) {
  const [term, setTerm] = useState('');
  const [res, setRes] = useState<{ rows: TerritoryLawFirmHit[]; count: number; firms: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = term.trim();
    if (t.length < 2) { setRes(null); setErr(null); return; }
    let alive = true;
    setBusy(true);
    const h = setTimeout(() => {
      fetchTerritoryLawFirms({ q: t })
        .then((r) => { if (alive) { setRes({ rows: r.results ?? [], count: r.count ?? 0, firms: r.firms ?? 0, truncated: Boolean(r.truncated) }); setErr(null); } })
        .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Lookup failed'); })
        .finally(() => { if (alive) setBusy(false); });
    }, 300);
    return () => { alive = false; clearTimeout(h); };
  }, [term]);
  return (
    <div className="section chart-card" style={{ marginBottom: 14, scrollMarginTop: 16 }}>
      <div className="section-head">
        <div>
          <h2 className="section-title">Find law firms</h2>
          <div className="section-sub">
            Look up which law firms are linked to a clinic{isAdmin ? ' or a rep' : ''}, or where a firm is linked · type a firm, clinic{isAdmin ? ' or rep' : ''} name
          </div>
        </div>
        <div className="tbl-controls">
          <input ref={inputRef} className="tbl-search" style={{ width: 300 }} type="text" value={term}
            onChange={(e) => setTerm(e.target.value)} placeholder={isAdmin ? 'Law firm, clinic or rep…' : 'Law firm or clinic…'} />
        </div>
      </div>
      {term.trim().length < 2 && <div className="muted-note">Type at least 2 characters to search.</div>}
      {term.trim().length >= 2 && busy && !res && <div className="muted-note">Searching…</div>}
      {err && <div className="error">{err}</div>}
      {res && term.trim().length >= 2 && (
        res.rows.length === 0
          ? <div className="muted-note">No law firm, clinic{isAdmin ? ' or rep' : ''} matches “{term.trim()}”.</div>
          : (<>
            <div className="muted-note" style={{ marginBottom: 8 }}>
              {res.firms} law firm{res.firms === 1 ? '' : 's'} · {res.count} link{res.count === 1 ? '' : 's'}
              {res.truncated ? ` · showing the first ${res.rows.length} — narrow the search` : ''}
            </div>
            <FirmTable rows={res.rows} showClinic showRep={isAdmin} />
          </>)
      )}
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
  const [drill, setDrill] = useState<null | 'reps' | 'clinics'>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const firmSearchRef = useRef<HTMLInputElement>(null);
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

  // Admin search over what the list holds: a rep matches on their own label,
  // email or any clinic. Law firms are searched in "Find law firms" above, on
  // the server, because the list no longer carries them.
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (!q ? reps : reps.filter((r) =>
    r.rep.toLowerCase().includes(q) || r.emails.some((e) => e.includes(q)) ||
    r.clinics.some((c) => c.name.toLowerCase().includes(q)))), [reps, q]);

  // ── Card drills ────────────────────────────────────────────────────────────
  const jump = (opts: { rep?: string; search?: string }) => {
    setDrill(null);
    setQuery(opts.search ?? '');
    setOpen(opts.rep ?? null);
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const link = (label: string, go: () => void): ReactNode => (isAdmin
    ? <button className="btn ghost" style={{ padding: '2px 8px', textAlign: 'left' }} onClick={go}><strong>{label}</strong></button>
    : <strong>{label}</strong>);

  // clinic → { reps, firm count }
  const clinicIndex = useMemo(() => {
    const m = new Map<string, { reps: Set<string>; firms: number }>();
    for (const r of reps) for (const c of r.clinics) {
      if (c.name === '(clinic not listed)') continue;
      const e = m.get(c.name) ?? { reps: new Set(), firms: 0 };
      e.reps.add(r.rep); e.firms = Math.max(e.firms, c.lawFirmCount); m.set(c.name, e);
    }
    return [...m.entries()].sort((a, b) => b[1].firms - a[1].firms || a[0].localeCompare(b[0]));
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
      rows: clinicIndex.map(([name, e]) => ({ clinic: link(name, () => jump({ search: name })), firms: e.firms, reps: [...e.reps].join(' · ') })),
    };
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
          {/* The firms themselves are looked up on demand, so this card opens
              the search rather than a list. */}
          <KpiR ico="doc" tint="#7C3AED" label="Law Firms" value={data.totals.lawFirms}
            deltaText={isAdmin ? 'distinct, across all clinics' : 'distinct, across your clinics'} foot="click to search them"
            onClick={() => { firmSearchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); firmSearchRef.current?.focus(); }} />
        </div>
      )}

      {data?.ok && <LawFirmSearch isAdmin={isAdmin} inputRef={firmSearchRef} />}

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
              <div className="section-sub">{shown.length} of {reps.length} reps · click a rep to see their clinics · law firms open per clinic</div>
            </div>
            <div className="tbl-controls">
              <input className="tbl-search" style={{ width: 240 }} type="text" value={query}
                onChange={(e) => setQuery(e.target.value)} placeholder="Search rep or clinic…" />
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
                  <tr><td colSpan={5} className="muted-note">No rep or clinic matches your search. To find a law firm, use Find law firms above.</td></tr>
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
