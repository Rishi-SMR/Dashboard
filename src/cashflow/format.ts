const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currencyDetailed = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export function formatCurrency(n: number, detailed = false): string {
  return (detailed ? currencyDetailed : currency).format(n);
}

export function formatSigned(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatCurrency(n)}`;
}

export function formatMonths(n: number | null): string {
  if (n === null) return '∞';
  if (!Number.isFinite(n)) return '∞';
  return `${n.toFixed(1)} mo`;
}
