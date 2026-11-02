import { useEffect, useState } from 'react';
import { fetchVerticalPl, type VerticalPl } from '../strivenApi';
import { formatCurrency } from '../format';
import { C, VERTICAL_COLORS } from '../chartTheme';
import { ChartCard, MonthBars, LegendDots } from '../chartKit';

/**
 * COMMISSION SPEND BY PROGRAMME (27 Oct 2026, on request) — Company Overview.
 *
 * Rep commission each month by payout run, per programme, from the vertical P&L
 * feed. The Profitability-by-programme table that sat above it was removed on
 * request (27 Oct 2026); the server still returns its figures.
 *
 * Admin only on the server; for anyone else the request is refused and the
 * panel simply does not render.
 */
export function VerticalProfit({ inPeriod, periodLabel }: { inPeriod: (ym: string) => boolean; periodLabel: string }) {
  const [data, setData] = useState<VerticalPl | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetchVerticalPl().then((d) => { if (alive && d?.ok) setData(d); }).catch(() => {});
    pull();
    const t = setInterval(pull, 90_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!data) return null;                                 // loading, not an admin, or the feed is down

  const rows = data.rows.filter((r) => inPeriod(r.month));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const commOf = (p: string) => rows.filter((r) => r.prog === p).reduce((t, r) => t + r.commission, 0);

  // Commission spend by programme, month by month.
  const commProgs = ['PI', 'VA', 'TriCare', 'DOL'].filter((p) => rows.some((r) => r.prog === p && r.commission));
  if (!commProgs.length) return null;
  const commData = months.map((m) => {
    const o: Record<string, number | string> = { month: m };
    for (const p of commProgs) o[p] = rows.filter((r) => r.month === m && r.prog === p).reduce((t, r) => t + r.commission, 0);
    return o;
  });
  const colorOf = (p: string) => VERTICAL_COLORS[p] ?? C.muted;
  const total = commProgs.reduce((t, p) => t + commOf(p), 0);

  return (
    <ChartCard className="g12-12" title={`Commission spend by programme · ${periodLabel}`} sub="Rep commission each month by payout run, paid and owed, from the commission book">
      <LegendDots items={commProgs.map((p) => ({ name: p, color: colorOf(p) }))} />
      <MonthBars data={commData} bars={commProgs.map((p) => ({ key: p, name: p, color: colorOf(p) }))} />
      <div className="cfoot">
        {commProgs.map((p) => (
          <div key={p} className="cf-i"><div className="l">{p}</div><div className="v">{formatCurrency(commOf(p))}</div></div>
        ))}
        <div className="cf-i"><div className="l">Total</div><div className="v accent">{formatCurrency(total)}</div></div>
      </div>
    </ChartCard>
  );
}
