// Shared chart components for every SMR tab — guarantees one consistent look
// (no clipping, integer count axes, one palette). Import these instead of
// hand-rolling charts. Charts animate on mount (ease-out) so the dashboard
// feels live rather than a printed image.
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
  PieChart, Pie, RadialBarChart, RadialBar, PolarAngleAxis,
  ComposedChart, Line,
} from 'recharts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatCurrency } from './format';
import { C, SERIES, SEVERITY, AGING_LABELS, gridProps, axisProps, tooltipStyle, compactMoney, monthLabel, statusTone } from './chartTheme';

// Skip animations for reduced-motion users AND automated (webdriver/headless)
// sessions — Recharts mount animations are flaky under headless capture.
const REDUCED = typeof window !== 'undefined' &&
  (!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !!navigator.webdriver);
const NOANIM = REDUCED
  ? { isAnimationActive: false as const }
  : { isAnimationActive: true as const, animationDuration: 1100, animationEasing: 'ease-out' as const };

// Count-up number — animates 0 → value on mount and between value changes.
export function AnimatedNumber({ value, format, duration = 1300 }: {
  value: number; format?: (n: number) => string; duration?: number;
}) {
  const [shown, setShown] = useState(REDUCED ? value : 0);
  const fromRef = useRef(REDUCED ? value : 0);
  useEffect(() => {
    if (REDUCED) { setShown(value); return; }
    const from = fromRef.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      setShown(from + (value - from) * e);
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString());
  return <>{fmt(shown)}</>;
}

// Icon KPI tile (reference-screenshot style): tinted icon square, label,
// count-up value, honest delta line, pinned foot note. Shared by the
// Receivables / Payables tabs. Click = tap-to-explain (open a drill).
const kIcon = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
export const KPI_ICONS = {
  doc: kIcon(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></>),
  clip: kIcon(<><rect x="7" y="4" width="10" height="17" rx="2" /><path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" /><line x1="10" y1="11" x2="14" y2="11" /><line x1="10" y1="15" x2="14" y2="15" /></>),
  cash: kIcon(<><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2a2.6 2.6 0 0 0-2.5-1.4c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.7.9 2.7 2.1-1.2 2-2.7 2a2.7 2.7 0 0 1-2.6-1.5" /><line x1="12" y1="6.2" x2="12" y2="7.8" /><line x1="12" y1="16.2" x2="12" y2="17.8" /></>),
  users: kIcon(<><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20a6.4 6.4 0 0 1 12.4 0" /><path d="M16 5a3.4 3.4 0 0 1 0 6.4" /><path d="M17.6 14.6a6.4 6.4 0 0 1 3.6 5.4" /></>),
  clock: kIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 1.8" /></>),
  box: kIcon(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 20 7.5" /><path d="M12 12v9" /><path d="M12 12 4 7.5" /></>),
  wallet: kIcon(<><path d="M20 7H5a2 2 0 0 1 0-4h13v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16V7" /><path d="M16 14h.01" /></>),
  trend: kIcon(<><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></>),
  pie: kIcon(<><path d="M21.2 15.9A10 10 0 1 1 8 2.8" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></>),
  bag: kIcon(<><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 0 1-8 0" /></>),
  shield: kIcon(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>),
  bank: kIcon(<><path d="m3 9 9-6 9 6" /><path d="M5 9v9" /><path d="M9.7 9v9" /><path d="M14.3 9v9" /><path d="M19 9v9" /><path d="M3 21h18" /></>),
};
export function KpiR({ ico, tint, label, value, format, delta, deltaInvert = false, deltaText, foot, onClick }: {
  ico: keyof typeof KPI_ICONS; tint: string; label: string;
  value: number; format?: (n: number) => string;
  // deltaInvert: metric where UP is bad (expenses) — flips the delta color only.
  delta?: { pct: number; up: boolean } | null; deltaInvert?: boolean; deltaText?: string; foot: string; onClick?: () => void;
}) {
  return (
    <div className={`kpi-r${onClick ? ' clickable' : ''}`} onClick={onClick}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}>
      <div className="kr-head">
        <span className="kr-ico" style={{ background: `color-mix(in srgb, ${tint} 11%, #fff)`, color: tint }}>{KPI_ICONS[ico]}</span>
        <span className="kr-label">{label}{onClick && <span className="kpi-info-icon">i</span>}</span>
      </div>
      <div className="kr-value"><AnimatedNumber value={value} format={format} /></div>
      <div className="kr-delta">
        {delta
          ? <><b className={(delta.up !== deltaInvert) ? 'up' : 'down'}>{delta.up ? '▲' : '▼'} {pctText(delta.pct)}</b><span> vs prior month</span></>
          : <span>{deltaText ?? '—'}</span>}
      </div>
      <div className="kr-foot">{foot}</div>
    </div>
  );
}

// Delta % for display — caps silly-looking spikes from tiny base months.
export const pctText = (p: number): string => (Math.abs(p) > 999 ? '999%+' : `${Math.abs(p)}%`);

// Live-sync heartbeat: re-renders every second and returns "Xs ago" for the
// header pill, so the page visibly ticks between silent data refreshes.
export function useSyncAgo(lastSync: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!lastSync) return '';
  const s = Math.max(0, Math.round((Date.now() - lastSync) / 1000));
  return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}
const trunc = (v: string, n = 18) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);

// Compact status/category cards — a small, scannable alternative to a bar chart
// for a handful of categories (e.g. patients/vendors by status). Colour-coded by
// status tone; pass onSelect to make each card a clickable drill.
export function StatCards({ data, total, onSelect }: {
  data: { name: string; value: number; sub?: string; tone?: 'ok' | 'warn' | 'none' | 'info'; primary?: boolean }[];
  total?: number;
  onSelect?: (name: string) => void;
}) {
  return (
    <div className="stat-cards">
      {data.map((d, i) => {
        const pctOf = total && total > 0 ? Math.round((d.value / total) * 100) : null;
        const subText = d.sub ?? (pctOf != null ? `${pctOf}% of total` : undefined);
        const clickable = !!onSelect;
        return (
          <div
            key={i}
            className={`stat-card${clickable ? ' clickable' : ''}${d.primary ? ' primary' : ''}`}
            data-tone={d.tone ?? statusTone(d.name)}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onSelect!(d.name) : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect!(d.name); } } : undefined}
          >
            <span className="stat-card-label" title={d.name}>{d.name}</span>
            <span className="stat-card-value">{d.value.toLocaleString()}</span>
            {subText && <span className="stat-card-sub">{subText}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ChartCard({ title, sub, span, right, className, children }: { title: string; sub?: string; span?: number; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`section chart-card${span ? ` span-${span}` : ''}${className ? ` ${className}` : ''}`}>
      <div className="section-head"><div><h2 className="section-title">{title}</h2>{sub && <div className="section-sub">{sub}</div>}</div>{right}</div>
      {children}
    </div>
  );
}

// Tiny inline legend row (colored dot + label) for combo charts.
export function LegendDots({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="mini-legend">
      {items.map((i) => (
        <span key={i.name} className="ml-i"><span className="ml-dot" style={{ background: i.color }} />{i.name}</span>
      ))}
    </div>
  );
}

// Monthly bars (up to 2 series) + an overlay line (e.g. net cash / profit) —
// the executive "flows + running result" combo chart.
export function BarsLine({ data, bars, line }: {
  data: Record<string, number | string>[];
  bars: { key: string; name: string; color: string }[];
  line: { key: string; name: string; color: string };
}) {
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 2 }} barGap={3} barCategoryGap="28%">
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => monthLabel(String(m))} />
          <YAxis {...axisProps} width={54} tickFormatter={compactMoney} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.08)' }} formatter={(v: number | string, n: string) => [formatCurrency(Number(v)), n]} />
          {bars.map((b) => (
            <Bar key={b.key} {...NOANIM} dataKey={b.key} name={b.name} fill={b.color} radius={[4, 4, 0, 0]} maxBarSize={22} />
          ))}
          <Line {...NOANIM} type="monotone" dataKey={line.key} name={line.name} stroke={line.color} strokeWidth={2.5} dot={{ r: 3, fill: line.color, strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Donut + itemised legend rows (name · $ · share) + a total footer — the
// "aging summary" card. Rows are the legend, so no floating legend below.
export function DonutList({ data, totalLabel = 'Total', money = true }: {
  data: { name: string; value: number; color: string }[];
  totalLabel?: string; money?: boolean;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = (v: number) => (money ? formatCurrency(v) : v.toLocaleString());
  return (
    <div className="donut-list">
      <div className="dl-chart">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="none" {...NOANIM}>
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [fmt(Number(v)), n]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="dl-legend">
        {data.map((d) => (
          <div key={d.name} className="dl-item">
            <span className="donut-dot" style={{ background: d.color }} />
            <span className="dl-name">{d.name}</span>
            <span className="dl-val">{fmt(d.value)}</span>
            <span className="dl-pct">{total > 0 ? Math.round((d.value / total) * 100) : 0}%</span>
          </div>
        ))}
        <div className="dl-total"><span>{totalLabel}</span><b>{fmt(total)}</b></div>
      </div>
    </div>
  );
}

// CSS progress-bar ranking (label · share bar · value) — for program splits and
// top-N vendor spend, matching the exec board-deck look without an SVG chart.
export function BarList({ data, money = true, showPct = true, onSelect }: {
  data: { name: string; value: number; color: string; meta?: string; dim?: boolean }[];
  money?: boolean; showPct?: boolean; onSelect?: (name: string) => void;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="hbar-list">
      {data.map((d) => {
        const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
        return (
          <div key={d.name} className={`hbar-row${onSelect ? ' clickable' : ''}`}
            style={d.dim ? { opacity: 0.35 } : undefined}
            onClick={onSelect ? () => onSelect(d.name) : undefined}
            role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined}
            onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.name); } } : undefined}>
            <div className="hb-top">
              <span className="hb-name">{d.name}</span>
              <span className="hb-meta">
                {showPct && <b>{pct}%</b>}
                {d.meta
                  ? <span className="hb-sub">{d.meta}</span>
                  : <span className={showPct ? 'hb-sub' : 'hb-val'}>{money ? formatCurrency(d.value) : d.value.toLocaleString()}</span>}
              </span>
            </div>
            <div className="hb-track"><div className="hb-fill" style={{ width: `${Math.max(3, (d.value / max) * 100)}%`, background: d.color }} /></div>
          </div>
        );
      })}
    </div>
  );
}

// Grouped vertical bars per month — e.g. revenue vs expenses side-by-side.
export function GroupedBars({ data, series }: { data: Record<string, number | string>[]; series: { key: string; name: string; color: string }[] }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 14, right: 16, left: 4, bottom: 2 }} barGap={3} barCategoryGap="26%">
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => monthLabel(String(m))} />
          <YAxis {...axisProps} width={54} tickFormatter={compactMoney} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.08)' }} formatter={(v: number | string, n: string) => [formatCurrency(Number(v)), n]} />
          {series.map((s) => (
            <Bar key={s.key} {...NOANIM} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={26} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Horizontal ranked bar — the ONLY chart for category/status/ranking data (no pies).
// Pass onSelect to make bars clickable (drill).
export function RankBar({ data, money = false, colorAt, onSelect }: { data: { name: string; value: number }[]; money?: boolean; colorAt?: (i: number) => string; onSelect?: (name: string) => void }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const domainMax = money ? max * 1.15 : Math.max(1, Math.ceil(max * 1.12));
  const color = colorAt ?? ((i: number) => SERIES[i % SERIES.length]);
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, left: 4, bottom: 4 }}>
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" domain={[0, domainMax]} {...axisProps} tickFormatter={money ? compactMoney : undefined} allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={132} tickLine={false} axisLine={false} tick={{ fill: C.sub, fontSize: 11.5 }} tickFormatter={(v: string) => trunc(v)} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.10)' }} formatter={(v: number | string) => (money ? formatCurrency(Number(v)) : String(v))} />
          <Bar {...NOANIM} dataKey="value" radius={[0, 6, 6, 0]} barSize={18} cursor={onSelect ? 'pointer' : undefined} onClick={onSelect ? (p: any) => onSelect(p?.name) : undefined}>
            {data.map((_, i) => <Cell key={i} fill={color(i)} />)}
            <LabelList dataKey="value" position="right" formatter={(v: number) => (money ? compactMoney(Number(v)) : String(v))} style={{ fill: C.sub, fontSize: 11, fontWeight: 600 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Vertical aging bar — accepts the shared aging object; per-bucket severity
// color. money=false renders counts (integer axis) instead of $.
export function AgingBar({ aging, onSelect, money = true }: { aging: Record<string, number>; onSelect?: (label: string) => void; money?: boolean }) {
  const data = AGING_LABELS.map((b) => ({ label: b.label, value: aging[b.key] || 0 }));
  const fmt = (v: number) => (money ? formatCurrency(v) : v.toLocaleString());
  const tick = (v: number) => (money ? compactMoney(v) : String(v));
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 16, left: 4, bottom: 2 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={54} tickFormatter={tick} allowDecimals={false} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.10)' }} formatter={(v: number | string) => fmt(Number(v))} />
          <Bar {...NOANIM} dataKey="value" radius={[6, 6, 0, 0]} barSize={46} cursor={onSelect ? 'pointer' : undefined} onClick={onSelect ? (p: any) => onSelect(p?.label) : undefined}>
            {data.map((d) => <Cell key={d.label} fill={SEVERITY[d.label] ?? C.brand} />)}
            <LabelList dataKey="value" position="top" formatter={(v: number) => (v ? (money ? compactMoney(Number(v)) : String(v)) : '')} style={{ fill: C.muted, fontSize: 10.5, fontWeight: 600 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Generic drill modal — dark header + a rows table. Use for chart/row click-throughs.
export function DrillModal({ title, sub, columns, rows, onClose }: {
  title: string; sub?: string; columns: { key: string; label: string; num?: boolean }[];
  rows: Record<string, ReactNode>[]; onClose: () => void;
}) {
  return (
    <div className="drill-backdrop" onClick={onClose}>
      <div className="drill" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drill-head">
          <div><div className="title">{title}</div>{sub && <div className="sub">{sub}</div>}</div>
          <button className="drill-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drill-body">
          <div className="section" style={{ margin: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={columns.length} style={{ color: C.muted }}>No rows.</td></tr>}
                  {rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : undefined}>{r[c.key]}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Money trend over months. series: which keys to draw (green revenue, red expenses, …).
// dots=true marks each month with a filled point (reference "P&L" look).
export function TrendArea({ data, series, idPrefix, dots = false }: { data: Record<string, number | string>[]; series: { key: string; name: string; color: string }[]; idPrefix: string; dots?: boolean }) {
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, left: 4, bottom: 2 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${idPrefix}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={s.color} stopOpacity={0.35} /><stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => monthLabel(String(m))} />
          <YAxis {...axisProps} width={54} tickFormatter={compactMoney} />
          <Tooltip {...tooltipStyle} formatter={(v: number | string) => formatCurrency(Number(v))} />
          {series.map((s) => (
            <Area key={s.key} {...NOANIM} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5}
              fill={`url(#${idPrefix}-${s.key})`} dot={dots ? { r: 3.5, fill: s.color, strokeWidth: 0 } : false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Donut with a value in the hole. For share-of-total breakdowns (revenue mix, etc.).
export function Donut({ data, centerValue, centerLabel, onSelect }: {
  data: { name: string; value: number; color: string }[];
  centerValue?: string; centerLabel?: string; onSelect?: (name: string) => void;
}) {
  return (
    <div className="chart-box" style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="88%" paddingAngle={2} stroke="none"
            cursor={onSelect ? 'pointer' : undefined} onClick={onSelect ? (p: any) => onSelect(p?.name) : undefined} {...NOANIM}>
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [formatCurrency(Number(v)), n]} />
        </PieChart>
      </ResponsiveContainer>
      {(centerValue || centerLabel) && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          {centerValue && <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>{centerValue}</div>}
          {centerLabel && <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginTop: 2 }}>{centerLabel}</div>}
        </div>
      )}
      <div className="donut-legend">
        {data.map((d) => (
          <div key={d.name} className="donut-legend-item"><span className="donut-dot" style={{ background: d.color }} />{d.name}</div>
        ))}
      </div>
    </div>
  );
}

// A single radial gauge (0–max) with a big value in the centre.
// arc='full' is a closed ring; arc='semi' is the dial/health-score shape.
export function GaugeRing({ value, max = 100, color, centerValue, centerLabel, height = 150, arc = 'full' }: {
  value: number; max?: number; color: string; centerValue: string; centerLabel: string; height?: number; arc?: 'full' | 'semi';
}) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const semi = arc === 'semi';
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          innerRadius={semi ? '86%' : '72%'} outerRadius={semi ? '118%' : '100%'}
          cy={semi ? '72%' : '50%'}
          data={[{ value: pct, fill: color }]}
          startAngle={semi ? 205 : 90} endAngle={semi ? -25 : -270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar background={{ fill: 'var(--gauge-track)' }} dataKey="value" cornerRadius={20} {...NOANIM} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: semi ? 16 : 0, pointerEvents: 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>{centerValue}</div>
        <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2, textAlign: 'center' }}>{centerLabel}</div>
      </div>
    </div>
  );
}
