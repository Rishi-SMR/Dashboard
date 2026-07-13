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

// US phone: "9566275137" -> "(956) 627-5137"; 11-digit "1..." -> "+1 (…) …".
// Leaves anything that isn't a 10/11-digit US number as-is (trimmed).
export function formatPhone(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}
