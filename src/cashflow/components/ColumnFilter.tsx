import { useEffect, useState } from 'react';
import { C } from '../chartTheme';

export type FilterOption = { value: string; count: number; tint?: string };

/**
 * A per-column filter: pick an exact set of values to keep.
 *
 * Complements a free-text search — search narrows by what you type, this pins a
 * set you want to keep comparing as other filters change. An empty selection
 * means "all", so the filter stays off until something is deliberately chosen.
 */
export function ColumnFilter({ label, options, picked, onChange, align = 'left' }: {
  label: string;
  options: FilterOption[];
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  const shown = options.filter((o) => !q.trim() || o.value.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (v: string) => {
    const next = new Set(picked);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };
  const on = picked.size > 0;

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 6 }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={`Filter by ${label.toLowerCase()}`} aria-expanded={open}
        title={on ? `${picked.size} selected — click to change` : `Filter by ${label.toLowerCase()}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          border: `1px solid ${on || open ? C.brand : `${C.muted}66`}`,
          background: on ? C.brand : (open ? `${C.brand}14` : 'var(--panel)'),
          color: on ? '#fff' : (open ? C.brand : C.sub),
          borderRadius: 999, padding: '4px 11px', cursor: 'pointer',
          fontSize: 12, fontWeight: 700, lineHeight: 1.4, textTransform: 'none', letterSpacing: 0,
          boxShadow: on ? `0 1px 3px ${C.brand}55` : '0 1px 2px rgba(15,27,46,.08)',
        }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
        {on ? picked.size : 'Filter'}
      </button>

      {open && (
        <>
          <span onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 41, width: 272,
              background: 'var(--panel)', border: `1px solid ${C.muted}33`, borderRadius: 10,
              boxShadow: '0 18px 40px rgba(15,27,46,.22)', padding: 10, textTransform: 'none', letterSpacing: 0,
            }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a ${label.toLowerCase()}`} aria-label={`Find a ${label.toLowerCase()}`}
              style={{ width: '100%', padding: '6px 9px', borderRadius: 7, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, fontWeight: 500 }} />
            <div style={{ display: 'flex', gap: 8, margin: '8px 0 6px' }}>
              <button className="btn ghost" style={{ fontSize: 11.5, padding: '3px 8px' }}
                onClick={() => onChange(new Set(shown.map((o) => o.value)))}>Select shown</button>
              <button className="btn ghost" style={{ fontSize: 11.5, padding: '3px 8px' }}
                onClick={() => onChange(new Set())} disabled={!on}>Clear</button>
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto', borderTop: `1px solid ${C.muted}22`, paddingTop: 6 }}>
              {shown.length === 0 && <div style={{ fontSize: 12.5, color: C.muted, padding: '6px 2px' }}>Nothing matches.</div>}
              {shown.map((o) => (
                <label key={o.value}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', fontSize: 12.5, fontWeight: 500, color: C.ink, cursor: 'pointer' }}>
                  <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} />
                  {o.tint && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: o.tint, flex: 'none' }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.value}</span>
                  <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{o.count}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

/** Sortable column header. The arrow shows which column is sorted and which way. */
export function SortHead<K extends string>({ label, col, sort, onSort, num = false, width, children }: {
  label: string; col: K; sort: { key: K; dir: 'asc' | 'desc' };
  onSort: (k: K) => void; num?: boolean; width?: string; children?: React.ReactNode;
}) {
  const on = sort.key === col;
  return (
    <th className={num ? 'num' : undefined} style={{ width, whiteSpace: 'nowrap' }}
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span onClick={() => onSort(col)} title={`Sort by ${label.toLowerCase()}`} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {label}
        <span style={{ marginLeft: 5, opacity: on ? 1 : 0.25, fontSize: 10 }}>{on && sort.dir === 'asc' ? '▲' : '▼'}</span>
      </span>
      {children}
    </th>
  );
}
