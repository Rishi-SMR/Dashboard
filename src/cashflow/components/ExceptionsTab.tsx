import { useEffect, useState } from 'react';
import { fetchStrivenExceptions, type ExceptionsResult } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';

const money = (v: unknown) => (typeof v === 'number' ? formatCurrency(v) : String(v ?? ''));
const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const tone = (s: string) => (s === 'high' ? 'none' : s === 'warn' ? 'warn' : 'info');
const numericCol = (c: string) => /paid|unapplied|open|value|cost|price|amount/i.test(c);

export function ExceptionsTab() {
  const [data, setData] = useState<ExceptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try { setData(await fetchStrivenExceptions()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load exceptions.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: '4px 2px' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Data Exceptions &amp; Reconciliation</h1>
          <div className="page-sub">
            <span className="live-dot" /> Sports Med Recovery · data-quality checks computed from Striven
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {data && (
        <>
          <div className="info-banner" style={{ marginTop: 8 }}>
            <span className="info-banner-icon">ℹ</span>
            <span>{data.note}</span>
          </div>

          {data.groups.length === 0 && (
            <div className="paid-banner"><span className="paid-banner-check">✓</span><span><strong>No exceptions found</strong> in the Striven-derived checks.</span></div>
          )}

          {data.groups.map((g) => (
            <div className="section" key={g.key} style={{ marginTop: 16 }}>
              <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <h2 className="section-title">
                    <span className={`pill-tag tag-${tone(g.severity)}`} style={{ marginRight: 8, textTransform: 'uppercase', fontSize: 10 }}>{g.severity}</span>
                    {g.title}
                  </h2>
                  <div className="section-sub">{g.note}</div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>{g.count}</div>
                  {g.value != null && <div style={{ fontSize: 13, color: C.muted, fontWeight: 600 }}>{formatCurrency(g.value)}</div>}
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>{g.columns.map((c) => <th key={c} className={numericCol(c) ? 'num' : undefined}>{label(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r, i) => (
                      <tr key={i}>
                        {g.columns.map((c) => (
                          <td key={c} className={numericCol(c) ? 'num' : undefined}>
                            {c === g.columns[0] ? <strong>{String(r[c] ?? '')}</strong> : numericCol(c) ? money(r[c]) : String(r[c] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {g.rows.length === 0 && <tr><td colSpan={g.columns.length} className="muted-note">—</td></tr>}
                  </tbody>
                </table>
              </div>
              {g.count > g.rows.length && <div className="muted-note">Showing first {g.rows.length} of {g.count}.</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
