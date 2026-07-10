import { useEffect, useState } from 'react';
import { fetchCashflow13, type Cashflow13 } from '../api';
import { WeeklyRowEdit } from './WeeklyRowEdit';

/**
 * Expenses → Edit. Mirrors the 13-Week projection's outflow lines EXACTLY (same
 * lines, same order: Inventory, COGS, Payroll, Software, Rent, Other, Credit Card
 * Payments). Each line is broken down per payee and editable per week; overrides
 * flow into the 13-Week cashflow + dashboard. The list is driven by the live
 * 13-week model, so it always matches what shows on the 13-Week grid.
 */
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtUsd = (n: number) => '$' + Math.round(n).toLocaleString();

export function ExpenseEditPage() {
  const [outflows, setOutflows] = useState<{ label: string; total: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default - click a line to open its (heavy) per-payee weekly grid.
  // The grid only mounts when opened, so the page loads light instead of rendering
  // every line's full table at once.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (label: string) => setOpen((s) => { const n = new Set(s); if (n.has(label)) n.delete(label); else n.add(label); return n; });

  useEffect(() => {
    fetchCashflow13({ direction: 'future' })
      .then((d: Cashflow13) => setOutflows((d.outflows ?? []).filter((o) => !o.displayOnly).map((o) => ({ label: o.label, total: (o.values ?? []).reduce((s, v) => s + v, 0) }))))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Edit Expenses</h1>
          <div className="page-sub">
            Every 13-Week outflow line, broken down per payee and editable per week. Click a line to open its grid.
            Override any cell to change how the 13-Week cashflow + dashboard project that expense. Blank = the computed number.
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {!outflows && !error && <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading expense lines…</div>}

      {outflows?.map(({ label, total }) => {
        const isOpen = open.has(label);
        return (
          <div className="section" key={label} style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
            <button
              onClick={() => toggle(label)}
              aria-expanded={isOpen}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                <strong style={{ fontSize: 15 }}>{label}</strong>
              </span>
              <span style={{ fontWeight: 700 }}>{fmtUsd(total)} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>· 13 wk</span></span>
            </button>
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', padding: '0 18px 14px' }}>
                <WeeklyRowEdit
                  rowRx={new RegExp('^' + escapeRx(label) + '$', 'i')}
                  heading={label}
                  sub={`Weekly ${label} outflow`}
                  hideHeading
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
