// ── METRIC DETAIL CARD ───────────────────────────────────────────────────────
// The shape the AR Expected card established, made reusable: headline, a
// composition rail, a row of supporting facts, and an optional caveat line.
//
// THE RAIL IS A COMPOSITION, NOT A TREND. Its segments must be parts of the
// headline and add up to it — ageing bands, months within the period, and so on.
// Feeding it a series that does not sum to the total would draw a picture that
// silently contradicts the number above it.
//
// Styles are the `.ard-*` block in cashflow.css, all token-derived.
import type { ReactNode } from 'react';
import { AnimatedNumber } from '../chartKit';

export type RailSeg = { name: string; value: number; color: string };
export type Fact = { label: string; value: string; note?: string; warn?: boolean; title?: string };

export function MetricDetail({ value, format, sub, rail, facts, note }: {
  value: number;
  format: (n: number) => string;
  sub: ReactNode;
  rail?: RailSeg[];
  facts?: Fact[];
  note?: ReactNode;
}) {
  const railTotal = (rail ?? []).reduce((s, r) => s + r.value, 0);
  const live = (rail ?? []).filter((r) => r.value > 0);
  return (
    <div className="ard">
      <div className="ard-top"><AnimatedNumber value={value} format={format} duration={700} /></div>
      <div className="ard-sub">{sub}</div>

      {live.length > 0 && (
        <>
          {/* Scaled against the RAIL's own total, not the headline: where a
              composition covers only part of the figure, the segments still fill
              the bar honestly instead of leaving an unexplained gap. */}
          <div className="ard-rail">
            {live.map((r, i) => (
              <span key={r.name} className="seg" title={`${r.name}: ${format(r.value)}`}
                style={{ width: `${(r.value / Math.max(1, railTotal)) * 100}%`, background: r.color, animationDelay: `${i * 0.07}s` }} />
            ))}
          </div>
          <div className="ard-key">
            {live.map((r) => (
              <span key={r.name} className="k">
                <span className="d" style={{ background: r.color }} />{r.name} <b>{format(r.value)}</b>
              </span>
            ))}
          </div>
        </>
      )}

      {facts && facts.length > 0 && (
        <div className="ard-facts">
          {facts.map((f) => (
            <div key={f.label} className="ard-f" title={f.title}>
              <div className="l">{f.label}</div>
              <div className={`v${f.warn ? ' warn' : ''}`}>{f.value}</div>
              {f.note && <div className="n">{f.note}</div>}
            </div>
          ))}
        </div>
      )}

      {note && <div className="ard-note">{note}</div>}
    </div>
  );
}
