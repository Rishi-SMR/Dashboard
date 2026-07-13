// Shared chart theme for the SMR dashboard — one palette + animation config so
// every tab's charts read as one system (premium light "board-deck" house style).

// Brand + semantic colors.
// Sports Med Recovery brand: confident royal blue primary, disciplined
// data-viz secondaries. Tuned for a LIGHT (white) canvas — crisp, board-grade,
// AA-legible, no neon.
export const C = {
  brand: '#2563EB',        // royal blue (primary / interactive)
  brandDark: '#1D4ED8',
  brandLight: 'rgba(37,99,235,0.10)',
  positive: '#16A34A',     // green (money in / good)
  negative: '#DC2626',     // red
  warning: '#D97706',      // amber
  info: '#0E7490',         // cyan-700
  purple: '#7C3AED',
  ink: '#0E1B2E',          // deep ink-navy (headings / values)
  sub: '#475569',          // secondary text
  muted: '#64748B',        // tertiary / axis ticks
  grid: '#EAEEF4',         // near-invisible hairline gridlines
  surface: '#FFFFFF',
};

// Categorical series palette — the 7 KPI hues reused verbatim so the strip +
// charts read as one system (medium-saturation, print-safe on white).
export const SERIES = ['#2563EB', '#16A34A', '#0D9488', '#D97706', '#DC2626', '#7C3AED', '#DB2777', '#0891B2', '#CA8A04', '#4F46E5'];

// AR/AP aging ramp: current → 90+ (good → urgent, on white).
export const AGING = ['#16A34A', '#65A30D', '#CA8A04', '#EA580C', '#DC2626'];
export const AGING_LABELS: { key: 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus'; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30' },
  { key: 'd31_60', label: '31–60' },
  { key: 'd61_90', label: '61–90' },
  { key: 'd90plus', label: '90+' },
];

// Standard Recharts animation props — spread onto any chart primitive.
export const ANIM = { isAnimationActive: true, animationDuration: 900, animationEasing: 'ease-out' as const };

// Shared axis / grid / tooltip styling.
export const axisProps = { tick: { fill: C.muted, fontSize: 11 }, tickLine: false, axisLine: { stroke: C.grid } };
export const gridProps = { stroke: C.grid, strokeDasharray: '3 3', vertical: false };
export const tooltipStyle = {
  contentStyle: { borderRadius: 12, border: '1px solid #E2E8F0', background: '#FFFFFF', boxShadow: '0 12px 30px rgba(14,27,46,0.12)', fontSize: 12 },
  labelStyle: { color: '#1E293B', fontWeight: 600 },
  itemStyle: { color: '#475569' },
};

// Compact currency for axis ticks: 12345 -> "$12k".
export const kCurrency = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
};

// "2026-07" -> "Jul". For monthly axes.
export const monthLabel = (ym: string): string => {
  const m = Number(String(ym).slice(5, 7));
  return ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] || ym;
};

// Full currency (tooltips / values): $12,345 (no decimals).
export const money = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0);
export const compactMoney = kCurrency; // axis ticks

// Severity/aging ramp keyed by the visible bucket label (sky→green→…→red).
export const SEVERITY: Record<string, string> = {
  Current: '#16A34A', '1–30': '#65A30D', '31–60': '#CA8A04', '61–90': '#EA580C', '90+': '#DC2626',
};
// Generic 6-color categorical ramp when keys are arbitrary (mirrors the KPI hues).
export const CAT6 = ['#2563EB', '#16A34A', '#0D9488', '#D97706', '#7C3AED', '#DB2777'];

// Map any Striven status string to a pill tone: ok | warn | none | info.
export const statusTone = (status: string): 'ok' | 'warn' | 'none' | 'info' => {
  const s = String(status || '').toLowerCase();
  if (/paid|approved|active|complete|completed|done|reconciled|accepted/.test(s)) return 'ok';
  if (/open|pending|progress|to ?do|partial|review|sent|awaiting/.test(s)) return 'warn';
  if (/cancel|void|fail|overdue|deleted|lost|denied|rejected/.test(s)) return 'none';
  return 'info';
};
