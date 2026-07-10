// Shared chart components for every SMR tab — guarantees one consistent look
// (no donuts, no clipping, integer count axes, Recharts animation off so charts
// render instantly and reliably). Import these instead of hand-rolling charts.
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
} from 'recharts';
import type { ReactNode } from 'react';
import { formatCurrency } from './format';
import { C, SERIES, SEVERITY, AGING_LABELS, gridProps, axisProps, tooltipStyle, compactMoney, monthLabel, statusTone } from './chartTheme';

const NOANIM = { isAnimationActive: false as const };
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

export function ChartCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="section chart-card">
      <div className="section-head"><div><h2 className="section-title">{title}</h2>{sub && <div className="section-sub">{sub}</div>}</div></div>
      {children}
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

// Vertical aging bar — accepts the shared aging object; per-bucket severity color.
export function AgingBar({ aging, onSelect }: { aging: Record<string, number>; onSelect?: (label: string) => void }) {
  const data = AGING_LABELS.map((b) => ({ label: b.label, value: aging[b.key] || 0 }));
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 16, left: 4, bottom: 2 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={54} tickFormatter={compactMoney} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.10)' }} formatter={(v: number | string) => formatCurrency(Number(v))} />
          <Bar {...NOANIM} dataKey="value" radius={[6, 6, 0, 0]} barSize={46} cursor={onSelect ? 'pointer' : undefined} onClick={onSelect ? (p: any) => onSelect(p?.label) : undefined}>
            {data.map((d) => <Cell key={d.label} fill={SEVERITY[d.label] ?? C.brand} />)}
            <LabelList dataKey="value" position="top" formatter={(v: number) => (v ? compactMoney(Number(v)) : '')} style={{ fill: C.muted, fontSize: 10.5, fontWeight: 600 }} />
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
export function TrendArea({ data, series, idPrefix }: { data: Record<string, number | string>[]; series: { key: string; name: string; color: string }[]; idPrefix: string }) {
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
            <Area key={s.key} {...NOANIM} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5} fill={`url(#${idPrefix}-${s.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
