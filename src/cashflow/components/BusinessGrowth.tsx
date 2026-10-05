import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { C, gridProps, axisProps, tooltipStyle, compactMoney, monthLabel as axisMonth } from '../chartTheme';
import { LegendDots } from '../chartKit';
import { formatCurrency } from '../format';
import { monthLabel, thisMonthKey } from './MonthSelect';
import { fetchQbPL, fetchStrivenPL } from '../strivenApi';

/**
 * BUSINESS GROWTH, MONTH BY MONTH — the company's own line on the team board.
 *
 * The dashboard answers "how much" (the tiles) and "which way, per rep" (Reps
 * growth). Neither says whether the BUSINESS is growing: those cards draw
 * orders, devices and commission — volume and the cost of selling it — and a
 * month can book more orders while earning less on them.
 *
 * REVENUE AND NET PROFIT COME OFF THE SAME STATEMENT, and that is the whole
 * design of this card. Net margin is net ÷ revenue, so the two figures have to
 * be cut from one book or the ratio is meaningless: putting P&L profit over the
 * ORDER BOOK's revenue (the number in the tiles above, $1.38M against the
 * accounting book's $564k) would print a margin no statement supports. So this
 * card reads the P&L — QuickBooks, the accounting system of record — for both,
 * and says so in its own subtitle rather than leaving the reader to assume it
 * matches the tiles. It does not, and it is not meant to.
 *
 * ONE AXIS, BECAUSE EVERYTHING PLOTTED IS MONEY. Margin is a percentage and is
 * NOT drawn: it would need a second scale, which is the one chart mistake this
 * app's charts never make. It is reported instead — per month in the tooltip,
 * and for the period in the chips above the plot, which is where a ratio is
 * read anyway.
 *
 * BARS FOR REVENUE, A CURVE FOR PROFIT. A month's revenue is a discrete total,
 * so it is a bar: the slope an area would draw between two months is not a rate
 * of anything (the same reasoning MonthOverMonth and MonthBars follow). Net
 * profit rides over them as a monotone curve, because the question asked of it
 * is the SHAPE — which way the business is going — and a second row of bars
 * makes the reader trace that shape themselves. Both are money, so they share
 * the one axis honestly.
 *
 * THE RUNNING MONTH IS DRAWN FAINT AND LEFT OUT OF EVERY COMPARISON. It is a
 * part-month against whole ones; ranking it, averaging it in, or calling it a
 * decline would all be wrong in the same way. Same convention, same wording, as
 * Reps growth directly above it.
 *
 * ADMIN ONLY. The P&L endpoints are company-wide and the server refuses them to
 * a rep, so the card reports nothing rather than half a statement; the caller
 * gates it as well.
 */

type Row = {
  month: string; revenue: number; net: number; running: boolean;
  /**
   * NET PROFIT AS THE CURVE PLOTS IT: the same figure, but null on the running
   * month so the line ENDS at the last complete one. Left in, a part-month drags
   * the curve down to a floor it has not actually hit and draws a collapse that
   * has not happened — the exact misreading the faint bar exists to prevent.
   * The bar still shows what the running month has earned so far.
   */
  netLine: number | null;
};

/** One readout: the figure in tone, the basis beside it. Mirrors DeltaChip in
 *  MonthOverMonth so the two cards on this board carry one chip, not two. */
function Chip({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <span className="bg-chip">
      <b style={{ color: tone ?? C.ink }}>{value}</b>
      {label}
    </span>
  );
}

export function BusinessGrowth() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [source, setSource] = useState<'quickbooks' | 'striven' | null>(null);
  const [basis, setBasis] = useState<string>('Accrual');
  const now = thisMonthKey();

  useEffect(() => {
    let alive = true;
    (async () => {
      const asRows = (series: { month: string; revenue: number; net: number }[]) => series
        .map((m) => {
          const running = m.month === now;
          const net = Number(m.net) || 0;
          return { month: m.month, revenue: Number(m.revenue) || 0, net, running, netLine: running ? null : net };
        });
      try {
        const q = await fetchQbPL();
        if (!alive) return;
        setRows(asRows(q.series ?? [])); setSource('quickbooks'); setBasis(q.basis || 'Accrual');
      } catch {
        // QUICKBOOKS FIRST, STRIVEN AS THE FALLBACK — never a blank card. If the
        // books are disconnected or the token has expired, the operational view
        // still answers the question, and the subtitle names which one is on
        // screen so the figures are never read as the other's.
        try {
          const p = await fetchStrivenPL();
          if (!alive) return;
          setRows(asRows(p.series ?? [])); setSource('striven');
        } catch { if (alive) setRows([]); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing to draw: no statement, or a book with no month in it yet. Silent by
  // design — this card is an addition to the board, not a thing to apologise for.
  if (!rows || rows.length === 0) return null;

  const complete = rows.filter((r) => !r.running);
  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  const totalNet = rows.reduce((s, r) => s + r.net, 0);
  const avgRev = complete.length ? complete.reduce((s, r) => s + r.revenue, 0) / complete.length : 0;
  const marginOf = (rev: number, net: number) => (rev > 0 ? (net / rev) * 100 : null);

  const last = complete[complete.length - 1] ?? null;
  const prev = complete[complete.length - 2] ?? null;
  const step = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : null);
  const revDelta = last && prev ? step(prev.revenue, last.revenue) : null;
  const netDelta = last && prev ? step(prev.net, last.net) : null;
  const lastMargin = last ? marginOf(last.revenue, last.net) : null;
  const periodMargin = marginOf(totalRev, totalNet);

  const pct = (n: number) => `${n >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(n))}%`;
  const tone = (n: number) => (n >= 0 ? C.positive : C.negative);
  /** A loss is red wherever it appears — bar, chip or tooltip. */
  const netColor = (n: number) => (n >= 0 ? C.positive : C.negative);
  const anyLoss = rows.some((r) => r.net < 0);

  return (
    <div className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">Business growth</h2>
          <div className="section-sub">
            Revenue and net profit each month, {basis.toLowerCase()} basis, from{' '}
            {source === 'quickbooks'
              ? <>the <b>QuickBooks</b> P&amp;L — the accounting system of record</>
              : <>the <b>Striven</b> P&amp;L — invoices as revenue, bills as expense</>}.
            Both come off the same statement, so the margin is the statement's own.
            Bars are each month's revenue; the curve is net profit across them.
            This is a different book from the order counts above and will not match them.
            {rows.some((r) => r.running) && <> <b>{monthLabel(now)}</b> is still running, so it is drawn faint and left out of every comparison.</>}
          </div>
        </div>
      </div>

      {/* THE READOUT SITS ABOVE THE CHART, because the number is the answer and
          the shape is the evidence. Same pill as Reps growth's delta chips
          directly above — a value in tone, its basis in muted text beside it —
          so the two cards read as one board rather than two designs. Deliberately
          NOT the filter chip: nothing here is a control. */}
      <div className="bg-chips">
        {revDelta != null && last && prev && (
          <Chip tone={tone(revDelta)} value={pct(revDelta)} label={`revenue · ${monthLabel(last.month)} vs ${monthLabel(prev.month)}`} />
        )}
        {netDelta != null && <Chip tone={tone(netDelta)} value={pct(netDelta)} label="net profit, same two months" />}
        {lastMargin != null && last && (
          <Chip tone={netColor(last.net)} value={`${lastMargin.toFixed(1)}%`} label={`net margin · ${monthLabel(last.month)}`} />
        )}
        <Chip tone={netColor(totalNet)} value={formatCurrency(totalNet)}
          label={`net profit across ${rows.length} month${rows.length === 1 ? '' : 's'}${periodMargin != null ? ` · ${periodMargin.toFixed(1)}% margin` : ''}`} />
        <Chip value={formatCurrency(avgRev)} label="average month, revenue" />
      </div>

      {/* TWO SERIES, SO A LEGEND IS ALWAYS PRESENT: identity never rests on
          colour alone. Same dots component the P&L charts use. */}
      <LegendDots items={[{ name: 'Revenue', color: C.brand }, { name: 'Net profit', color: C.positive }]} />

      <div className="bg-plot">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 6, right: 8, left: 4, bottom: 2 }} barGap={2}>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => axisMonth(m)} />
            <YAxis {...axisProps} tickFormatter={(v: number) => compactMoney(v)} width={58} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: 'rgba(10,54,159,0.05)' }}
              formatter={(v: number, name: string) => [formatCurrency(v), name]}
              labelFormatter={(m: string) => {
                const r = rows.find((x) => x.month === m);
                const mg = r ? marginOf(r.revenue, r.net) : null;
                // The margin rides on the tooltip label, where it names the month
                // it belongs to — a percentage in the value list would read as a
                // third money figure on a money axis.
                const sofar = r && r.running ? ` · net so far ${formatCurrency(r.net)}` : '';
                return `${monthLabel(m)}${mg != null ? ` · ${mg.toFixed(1)}% net margin` : ''}${m === now ? ` · still running${sofar}` : ''}`;
              }}
            />
            {/* Only drawn when the period actually holds a loss: a zero rule on an
                all-profit chart is a line that says nothing. */}
            {anyLoss && <ReferenceLine y={0} stroke={C.sub} />}
            <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]} maxBarSize={40}>
              {rows.map((r) => <Cell key={r.month} fill={C.brand} fillOpacity={r.running ? 0.28 : 1} />)}
            </Bar>
            {/* THE CURVE THROUGH THE MONTHS. Net profit was a second bar beside
                revenue, which drew two discrete totals and left the reader to
                trace the shape themselves. A monotone line does the tracing:
                `monotone`, not `natural`, because a natural spline overshoots
                between points and can bend a line below zero on a month that
                never lost money.

                REVENUE KEEPS ITS BARS. Drawing both as curves would say the
                book moves smoothly from one month's total to the next, and it
                does not — a month's revenue is a discrete total, not a rate.
                The bars are the totals; the curve is profit's path across them.
                Drawn with Reps growth's own line styling — same monotone
                curve, same 2.5px stroke, same dots — so the two cards on this
                board read as one chart language. */}
            <Line type="monotone" dataKey="netLine" name="Net profit" stroke={C.positive} strokeWidth={2.5}
              dot={{ r: 3, fill: C.positive, strokeWidth: 0 }} activeDot={{ r: 5 }}
              connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
