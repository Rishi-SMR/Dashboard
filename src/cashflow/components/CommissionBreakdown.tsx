// ── COMMISSION DUE, INTERACTIVE ──────────────────────────────────────────────
// The tile said "$208,515" and stopped. Every question that number prompts —
// who is owed it, for which programme, off the back of what — needed a different
// tab to answer. This answers them in place.
//
// Two views over the same total, because "who is owed" and "what earned it" are
// different questions and neither is a subset of the other:
//   By rep       ranked bars, click one to open their programme split and the
//                orders behind it
//   By programme the same total split PI / VA / TriCare
//
// OFF-ROSTER IS SHOWN, not hidden. Non-producing reps are off the Reps dashboard
// by request, but the money is still owed; a "Commission Due" figure that
// silently omits $8.3k understates a liability.
import { useMemo, useState } from 'react';
import { AnimatedNumber } from '../chartKit';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS } from '../chartTheme';

export type CommRep = {
  rep: string;
  payable: number;
  orders: number;
  units: number;
  pi: number; va: number; tricare: number;
  onRoster: boolean;
  lines: { ref: string; patient: string; item: string; prog: string; comm: number }[];
};

const PROGS = ['PI', 'VA', 'TriCare'] as const;

export function CommissionBreakdown({ reps, onOpen }: {
  reps: CommRep[];
  onOpen?: () => void;
}) {
  const [mode, setMode] = useState<'rep' | 'prog'>('rep');
  const [pick, setPick] = useState<string | null>(null);

  const onRoster = useMemo(() => reps.filter((r) => r.onRoster && r.payable > 0)
    .sort((a, b) => b.payable - a.payable), [reps]);
  const offRoster = useMemo(() => reps.filter((r) => !r.onRoster && r.payable > 0)
    .sort((a, b) => b.payable - a.payable), [reps]);

  const rosterTotal = onRoster.reduce((s, r) => s + r.payable, 0);
  const offTotal = offRoster.reduce((s, r) => s + r.payable, 0);

  // Programme totals across the ROSTER only, so the split reconciles to the
  // headline rather than to a different population.
  const progTotals = PROGS.map((p) => ({
    name: p,
    value: onRoster.reduce((s, r) => s + (p === 'PI' ? r.pi : p === 'VA' ? r.va : r.tricare), 0),
    color: VERTICAL_COLORS[p] ?? C.muted,
  })).filter((p) => p.value > 0);

  const rows = mode === 'rep'
    ? onRoster.map((r, i) => ({ key: r.rep, label: r.rep, value: r.payable, color: SER[i % SER.length] }))
    : progTotals.map((p) => ({ key: p.name, label: p.name, value: p.value, color: p.color }));
  const max = Math.max(1, ...rows.map((r) => r.value));

  const sel = pick ? reps.find((r) => r.rep === pick) ?? null : null;
  // Top earning lines for the selected rep. Commission per line, never the
  // order's value — this card is about what is owed, not what was sold.
  const topLines = useMemo(() => (sel?.lines ?? [])
    .filter((l) => l.comm > 0)
    .sort((a, b) => b.comm - a.comm)
    .slice(0, 5), [sel]);

  return (
    <div className="cmb">
      <div className="cmb-head">
        <div>
          <div className="cmb-total"><AnimatedNumber value={rosterTotal} format={formatCurrency} duration={700} /></div>
          <div className="cmb-sub">
            payable to {onRoster.length} producing rep{onRoster.length === 1 ? '' : 's'}
            {offTotal > 0 && <> · <b className="off">{formatCurrency(offTotal)}</b> owed to {offRoster.length} off roster</>}
          </div>
        </div>
        <span className="ins-qtabs cmb-tabs">
          <button className={`ins-qtab${mode === 'rep' ? ' on' : ''}`} onClick={() => { setMode('rep'); setPick(null); }}>By rep</button>
          <button className={`ins-qtab${mode === 'prog' ? ' on' : ''}`} onClick={() => { setMode('prog'); setPick(null); }}>By programme</button>
        </span>
      </div>

      <div className="cmb-bars">
        {rows.map((r) => {
          const on = pick === r.key;
          // Only rep rows drill: a programme has no single owner to open.
          const clickable = mode === 'rep';
          return (
            <div key={r.key}
              className={`cmb-row${on ? ' pinned' : ''}${pick && !on ? ' dim' : ''}${clickable ? ' clickable' : ''}`}
              onClick={clickable ? () => setPick(on ? null : r.key) : undefined}
              role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(on ? null : r.key); } } : undefined}
              title={`${r.label} · ${formatCurrency(r.value)} · ${Math.round((r.value / rosterTotal) * 100)}% of the total`}>
              <span className="nm">{r.label}</span>
              <span className="track"><i style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: r.color }} /></span>
              <span className="amt">{formatCurrency(r.value)}</span>
              <span className="pc">{Math.round((r.value / rosterTotal) * 100)}%</span>
            </div>
          );
        })}
      </div>

      {sel && (
        <div className="cmb-detail">
          <div className="cmb-dh">
            <b>{sel.rep}</b>
            <span>{sel.orders} order{sel.orders === 1 ? '' : 's'}</span>
            <span>{sel.units} unit{sel.units === 1 ? '' : 's'}</span>
            <span>{formatCurrency(sel.payable)} due</span>
            {onOpen && <button className="card-link" style={{ marginTop: 0, marginLeft: 'auto' }} onClick={onOpen}>Open commission</button>}
          </div>
          {/* Programme split for this rep: one stacked rail, so a rep who works
              a single programme reads as one solid bar at a glance. */}
          <div className="cmb-split">
            {PROGS.map((p) => {
              const v = p === 'PI' ? sel.pi : p === 'VA' ? sel.va : sel.tricare;
              if (v <= 0) return null;
              return (
                <span key={p} className="seg" title={`${p}: ${formatCurrency(v)}`}
                  style={{ width: `${(v / Math.max(1, sel.payable)) * 100}%`, background: VERTICAL_COLORS[p] ?? C.muted }}>
                  <em>{p}</em>
                </span>
              );
            })}
          </div>
          {topLines.length > 0 && (
            <div className="cmb-lines">
              <div className="lh">Top earning orders</div>
              {topLines.map((l) => (
                <div key={l.ref} className="ln">
                  <span className="r">{l.ref}</span>
                  {/* Surname only, as everywhere else this data appears. */}
                  <span className="p">{l.patient || '-'}</span>
                  <span className="i" title={l.item}>{l.item}</span>
                  <span className="c">{formatCurrency(l.comm)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Rep bar colours: the shared categorical palette, so a rep keeps one colour
// wherever they appear on the board.
const SER = ['#0A369F', '#16A34A', '#0D9488', '#D97706', '#DC2626', '#7C3AED', '#DB2777', '#0891B2'];
