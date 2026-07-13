// Shared chart theme for the SMR dashboard — one palette + animation config so
// every tab's charts read as one system (matching the forest-green house style).

// Brand + semantic colors.
// Sports Med Recovery brand: royal blue primary, lime-green + teal accents.
// Dark premium theme — bright, high-contrast hues that read on a near-black bg.
export const C = {
  brand: '#5B8DEF',       // luminous blue (primary / interactive)
  brandDark: '#4C86F5',
  brandLight: 'rgba(91,141,239,0.14)',
  positive: '#86E05C',    // lime-green (money in / good)
  negative: '#F76C7A',    // rose
  warning: '#F5A524',     // amber
  info: '#2ED3E8',        // teal
  purple: '#B58CFB',
  ink: '#EAF0FA',
  sub: '#B4C1D6',
  muted: '#7E8CA6',
  grid: '#1E2A40',
  surface: '#121A2B',
};

// Categorical series palette — vivid hues for a dark canvas.
export const SERIES = ['#5B8DEF', '#86E05C', '#2ED3E8', '#F5A524', '#F76C7A', '#B58CFB', '#EC4899', '#EAB308', '#2DD4BF', '#818CF8'];

// AR/AP aging ramp: current → 90+ (brightened for dark).
export const AGING = ['#38BDF8', '#4ADE80', '#A3E635', '#FBBF24', '#F87171'];
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
  contentStyle: { borderRadius: 10, border: '1px solid #2C3B57', background: '#0E1626', boxShadow: '0 12px 30px rgba(0,0,0,0.5)', fontSize: 12 },
  labelStyle: { color: C.ink, fontWeight: 600 },
  itemStyle: { color: C.sub },
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
  Current: '#38BDF8', '1–30': '#4ADE80', '31–60': '#A3E635', '61–90': '#FBBF24', '90+': '#F87171',
};
// Generic 6-color categorical ramp when keys are arbitrary.
export const CAT6 = ['#5B8DEF', '#86E05C', '#2ED3E8', '#F5A524', '#F76C7A', '#B58CFB'];

// Map any Striven status string to a pill tone: ok | warn | none | info.
export const statusTone = (status: string): 'ok' | 'warn' | 'none' | 'info' => {
  const s = String(status || '').toLowerCase();
  if (/paid|approved|active|complete|completed|done|reconciled|accepted/.test(s)) return 'ok';
  if (/open|pending|progress|to ?do|partial|review|sent|awaiting/.test(s)) return 'warn';
  if (/cancel|void|fail|overdue|deleted|lost|denied|rejected/.test(s)) return 'none';
  return 'info';
};
