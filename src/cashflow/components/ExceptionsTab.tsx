import { useEffect, useState, type ReactNode } from 'react';
import { fetchStrivenExceptions, type ExceptionsResult, type ExceptionGroup } from '../strivenApi';
import { formatCurrency } from '../format';
import { StatusPill } from './StatusPill';
import { C } from '../chartTheme';
import { DrillModal, useSyncAgo } from '../chartKit';

const PREVIEW_ROWS = 6;

const money = (v: unknown) => (typeof v === 'number' ? formatCurrency(v) : String(v ?? ''));
const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const tone = (s: string) => (s === 'high' ? 'danger' : s === 'warn' ? 'warn' : 'info');
const numericCol = (c: string) => /paid|unapplied|open|value|cost|price|amount/i.test(c);
const statusCol = (c: string) => /status/i.test(c);

function cell(g: ExceptionGroup, c: string, r: Record<string, string | number>): ReactNode {
  if (c === g.columns[0]) return <strong>{String(r[c] ?? '')}</strong>;
  if (statusCol(c)) return <StatusPill status={String(r[c] ?? '')} />;
  if (numericCol(c)) return money(r[c]);
  return String(r[c] ?? '—');
}

export function ExceptionsTab() {
  const [data, setData] = useState<ExceptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drill, setDrill] = useState<null | { title: string; sub: string; columns: { key: string; label: string; num?: boolean }[]; rows: Record<string, ReactNode>[] }>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const agoText = useSyncAgo(lastSync);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try {
      setData(await fetchStrivenExceptions());
      setLastSync(Date.now());
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to load exceptions.');
    } finally { if (!silent) setLoading(false); }
  }
  // Initial load + silent live refresh every 90s.
  useEffect(() => {
    load();
    const r = setInterval(() => load(true), 90_000);
    return () => clearInterval(r);
  }, []);

  const toggle = (key: string) => setCollapsed((m) => ({ ...m, [key]: !m[key] }));

  // "View all" → every row the API carries for this group, in the shared modal.
  function viewAll(g: ExceptionGroup) {
    setDrill({
      title: g.title,
      sub: `${g.count} item${g.count === 1 ? '' : 's'}${g.value != null ? ` · ${formatCurrency(g.value)}` : ''}${g.count > g.rows.length ? ` · first ${g.rows.length} listed` : ''}`,
      columns: g.columns.map((c) => ({ key: c, label: label(c), num: numericCol(c) })),
      rows: g.rows.map((r) => Object.fromEntries(g.columns.map((c) => [c, cell(g, c, r)]))),
    });
  }

  const asOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="exec-deck" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>Data Exceptions &amp; Reconciliation</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · data-quality checks computed from Striven{agoText ? ` · updated ${agoText}` : ''}
          </div>
        </div>
        <div className="ov-headright">
          <span className="ov-filter"><span className="fl">📅</span><b>{asOf}</b></span>
          <button className="btn ghost" onClick={() => load()} disabled={loading}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          <div className="info-banner">
            <span className="info-banner-icon">ℹ</span>
            <span>{data.note}</span>
          </div>

          {data.groups.length === 0 && (
            <div className="paid-banner"><span className="paid-banner-check">✓</span><span><strong>No exceptions found</strong> in the Striven-derived checks.</span></div>
          )}

          {data.groups.map((g) => {
            const closed = !!collapsed[g.key];
            const preview = g.rows.slice(0, PREVIEW_ROWS);
            return (
              <div className="section chart-card" key={g.key} style={{ marginBottom: 18 }}>
                <div className="section-head" style={{ marginBottom: closed ? 0 : undefined, cursor: 'pointer' }} onClick={() => toggle(g.key)}>
                  <div>
                    <h2 className="section-title">
                      <span className={`pill-tag tag-${tone(g.severity)}`} style={{ marginRight: 8, textTransform: 'uppercase', fontSize: 10 }}>{g.severity}</span>
                      {g.title}
                    </h2>
                    <div className="section-sub">{g.note}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: C.ink, lineHeight: 1.1 }}>{g.count}</div>
                      {g.value != null && <div style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>{formatCurrency(g.value)}</div>}
                    </div>
                    <button className="btn ghost" style={{ padding: '4px 9px', fontSize: 13 }} aria-label={closed ? 'Expand' : 'Collapse'}
                      onClick={(e) => { e.stopPropagation(); toggle(g.key); }}>
                      {closed ? '▾' : '▴'}
                    </button>
                  </div>
                </div>
                {!closed && (
                  <>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>{g.columns.map((c) => <th key={c} className={numericCol(c) ? 'num' : undefined}>{label(c)}</th>)}</tr>
                        </thead>
                        <tbody>
                          {preview.map((r, i) => (
                            <tr key={i}>
                              {g.columns.map((c) => (
                                <td key={c} className={numericCol(c) ? 'num' : undefined}>{cell(g, c, r)}</td>
                              ))}
                            </tr>
                          ))}
                          {preview.length === 0 && <tr><td colSpan={g.columns.length} className="muted-note">—</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    {(g.rows.length > PREVIEW_ROWS || g.count > preview.length) && (
                      <button className="card-link" style={{ margin: '12px auto 0' }} onClick={() => viewAll(g)}>
                        View all {g.count.toLocaleString()} →
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
