import { useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { Cashflow13 } from '../api';
import { formatCurrency } from '../format';

/** Tooltip that shows ONLY the segment the cursor is on (not the whole stack). */
function oneSegTooltip(activeKey: string | null) {
  return ({ active, payload, label }: { active?: boolean; payload?: Array<Record<string, unknown>>; label?: string }) => {
    if (!active || !payload || payload.length === 0) return null;
    const item = (activeKey ? payload.find((p) => p.dataKey === activeKey) : null) ?? payload[payload.length - 1];
    if (!item) return null;
    const color = (item.color ?? item.fill ?? item.stroke) as string | undefined;
    return (
      <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, padding: '8px 10px' }}>
        <div style={{ color: '#6b7280', marginBottom: 4 }}>Week of {label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
          <span>{String(item.name)}: <strong>{formatCurrency(Math.abs(Number(item.value)))}</strong></span>
        </div>
      </div>
    );
  };
}

type Props = { data: Cashflow13 };

// Inflow categories: green / teal family (money coming in).
const INFLOW_COLORS: Record<string, string> = {
  'AR Collections': '#15803d',                  // forest green
  'Past AR Collections (lag-curve)': '#22c55e', // green
  'Collected from sales (this week)': '#14b8a6', // teal
};
// Outflow categories: warm / distinct family (money going out).
const OUTFLOW_COLORS: Record<string, string> = {
  'Payroll': '#dc2626',                   // red (usually the largest)
  'Inventory & Raw Materials': '#16a34a', // green
  'COGS': '#f59e0b',                       // amber
  'Rent': '#0891b2',                       // cyan
  'Other Expenses': '#64748b',            // slate
  'Credit Card Payments': '#ec4899',      // pink
  'Software & Subscriptions': '#8b5cf6',  // violet
};
const INFLOW_FALLBACK = ['#15803d', '#22c55e', '#14b8a6', '#0891b2', '#65a30d'];
const OUTFLOW_FALLBACK = ['#dc2626', '#f59e0b', '#64748b', '#ec4899', '#8b5cf6', '#0891b2'];
const inColorFor = (label: string, i: number) => INFLOW_COLORS[label] ?? INFLOW_FALLBACK[i % INFLOW_FALLBACK.length];
const outColorFor = (label: string, i: number) => OUTFLOW_COLORS[label] ?? OUTFLOW_FALLBACK[i % OUTFLOW_FALLBACK.length];

/**
 * 13-week cash projection chart, starting at the CURRENT week (Wk1 = this week).
 * Per week: an Inflow stack and an Outflow stack side by side (both up), each
 * split by category colour. The Closing-cash runway line (blue) is on the
 * right axis so both scale cleanly.
 */
export function Projection13WeekChart({ data }: Props) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const { weeks, totals } = data;
  const inLines = data.inflows.filter((o) => !o.displayOnly);
  const outLines = data.outflows.filter((o) => !o.displayOnly);

  const chartData = weeks.map((w, i) => {
    const row: Record<string, number | string> = {
      label: w.label,
      'Closing cash': Math.round(totals.closingCash[i] ?? 0),
    };
    for (const o of inLines) row[o.label] = Math.round(Math.abs(o.values[i] ?? 0));
    for (const o of outLines) row[o.label] = Math.round(Math.abs(o.values[i] ?? 0));
    return row;
  });
  const currentLabel = weeks[0]?.label;

  return (
    <div style={{ width: '100%', height: 380 }}>
      <ResponsiveContainer>
        <ComposedChart data={chartData} margin={{ top: 18, right: 12, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" stroke="#6b7280" tick={{ fontSize: 11 }} />
          <YAxis
            yAxisId="left"
            stroke="#6b7280"
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatCurrency(Number(v))}
            width={88}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#2563eb"
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatCurrency(Number(v))}
            width={88}
          />
          <Tooltip cursor={{ fill: 'transparent' }} content={oneSegTooltip(activeKey)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine yAxisId="left" y={0} stroke="#9ca3af" />
          {currentLabel && (
            <ReferenceLine
              yAxisId="left"
              x={currentLabel}
              stroke="#2563eb"
              strokeDasharray="4 4"
              label={{ value: 'This week', position: 'top', fontSize: 10, fill: '#2563eb' }}
            />
          )}
          {inLines.map((o, i) => (
            <Bar
              key={o.label}
              yAxisId="left"
              dataKey={o.label}
              stackId="inflow"
              fill={inColorFor(o.label, i)}
              maxBarSize={22}
              onMouseEnter={() => setActiveKey(o.label)}
            />
          ))}
          {outLines.map((o, i) => (
            <Bar
              key={o.label}
              yAxisId="left"
              dataKey={o.label}
              stackId="outflow"
              fill={outColorFor(o.label, i)}
              maxBarSize={22}
              onMouseEnter={() => setActiveKey(o.label)}
            />
          ))}
          <Line yAxisId="right" type="monotone" dataKey="Closing cash" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5, onMouseEnter: () => setActiveKey('Closing cash') }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
