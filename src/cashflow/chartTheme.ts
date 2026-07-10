// Shared chart theme for the SMR dashboard — one palette + animation config so
// every tab's charts read as one system (matching the forest-green house style).

// Brand + semantic colors.
// Sports Med Recovery brand: royal blue primary, lime-green + teal accents.
export const C = {
  brand: '#0A369F',       // SMR royal blue (primary / interactive)
  brandDark: '#082B7F',
  brandLight: '#E6ECFA',
  positive: '#6EB60A',    // SMR lime green (money in / good)
  negative: '#dc2626',
  warning: '#d97706',
  info: '#009EB7',        // SMR teal
  purple: '#8b5cf6',
  ink: '#0f172a',
  sub: '#475569',
  muted: '#64748b',
  grid: '#e2e8f0',
  surface: '#ffffff',
};

// Categorical series palette — brand blue / green / teal lead, then distinct hues.
export const SERIES = ['#0A369F', '#6EB60A', '#009EB7', '#f59e0b', '#dc2626', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6', '#6366f1'];

// AR/AP aging ramp: current (green) → 90+ (red).
export const AGING = ['#15803d', '#65a30d', '#ca8a04', '#ea580c', '#dc2626'];
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
  contentStyle: { borderRadius: 10, border: `1px solid ${C.grid}`, boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12 },
  labelStyle: { color: C.ink, fontWeight: 600 },
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
  Current: '#0ea5e9', '1–30': '#16a34a', '31–60': '#84cc16', '61–90': '#f59e0b', '90+': '#dc2626',
};
// Generic 6-color categorical ramp when keys are arbitrary.
export const CAT6 = ['#0A369F', '#6EB60A', '#009EB7', '#d97706', '#dc2626', '#7c3aed'];

// Map any Striven status string to a pill tone: ok | warn | none | info.
export const statusTone = (status: string): 'ok' | 'warn' | 'none' | 'info' => {
  const s = String(status || '').toLowerCase();
  if (/paid|approved|active|complete|completed|done|reconciled|accepted/.test(s)) return 'ok';
  if (/open|pending|progress|to ?do|partial|review|sent|awaiting/.test(s)) return 'warn';
  if (/cancel|void|fail|overdue|deleted|lost|denied|rejected/.test(s)) return 'none';
  return 'info';
};
