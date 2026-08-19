import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import {
  C, gridProps, axisProps, tooltipStyle, compactMoney, monthLabel as axisMonth,
  VERTICAL_COLORS, VERTICAL_ORDER, SERIES,
} from '../chartTheme';
import { formatCurrency } from '../format';
import { monthLabel, thisMonthKey } from './MonthSelect';
import type { RepRow, RepOverview } from '../strivenApi';

/**
 * PERFORMANCE, MONTH OVER MONTH — on the board a rep lands on after login.
 *
 * That dashboard could say what a rep has booked and where they sit on the
 * team, but not whether they were climbing or sliding. Every figure on it was a
 * LEVEL — orders, devices, commission, rank — and a level answers "how much",
 * never "which way". A rep who booked 30 orders this month against 45 last read
 * exactly the same tile as one who booked 30 against 12, and that comparison is
 * the one they open a dashboard to make.
 *
 * WHY A CHART AND NOT ANOTHER TABLE. The roster below already reads a month at a
 * time, one period per look, behind a selector. Getting a trend out of it means
 * choosing twelve months in turn and holding the numbers in your head. Direction
 * is a shape, so it is drawn as one.
 *
 * BARS FOR COUNTS, A LINE FOR MONEY, on two axes, because they are not the same
 * quantity: 40 orders and $40,000 cannot share a scale without one of them lying
 * flat along the floor. Bars rather than an area for the counts — a month's
 * orders are a discrete total, and the slope an area draws between two months is
 * not a rate of anything (the same reasoning as MonthBars in chartKit).
 *
 * THE TWO BASES ARE STATED, as everywhere else on this page. Orders and devices
 * are cut by the ORDER's own date; commission is cut by the PAYOUT CYCLE it
 * settles in, which is what the Commission tab reports and what the roster's own
 * pay columns use. The same lines bucketed by order date put Jillian's July at
 * $6,646 against Commission's $21,946, so the basis is not a detail to leave to
 * a footnote — it is in the subtitle.
 *
 * THE MONEY LINE IS COMMISSION ON BOTH BOARDS. It was team REVENUE on the
 * manager's, for one reason only: `teamByMonth` carries revenue and does not
 * carry pay. That made the manager's card answer a different question from the
 * rep's — what the book billed, rather than what it cost to sell — on a page
 * whose subject is the reps. The team figure is summed from the roster rows
 * instead, exactly as The team table's own footer sums them ("Money and counts
 * are re-summed here from the rows on screen"): commission is a plain sum, so
 * unlike the distinct-payer Accounts count it adds up correctly on the client.
 * Checked against the payload: the months sum to teamTotals.commission, to the
 * cent.
 */

/** One month on the chart, whichever board built it. */
type MoMPoint = {
  month: string;
  orders: number;
  units: number | null;
  /** Commission settling in that payout cycle — the rep's own, or the roster's
   *  summed. Null where the payload withheld it, never coalesced to 0: a zero
   *  would claim nothing was earned. */
  money: number | null;
  /** Board position that month, rep boards only. Drawn nowhere: it rides in the
   *  tooltip, where "you were 3rd in June" is the sentence a bar cannot say. */
  rank: number | null;
  /** The month still running. Its bars are drawn faint and it is kept out of
   *  every comparison — see the note on `complete` below. */
  partial: boolean;
};

/** How many months fit before the axis labels collide. Twelve is a year, which
 *  is also the comparison people ask for ("versus last August"). */
const WINDOW = 12;

/**
 * A month-on-month change, honest about its base.
 *
 * Percentages need a base to be a percentage OF. Coming off a zero month there
 * is none — every rise is an infinite one — so the change is reported in whole
 * units instead of as "+∞%" or, worse, as a quietly dropped chip.
 */
type Delta = { up: boolean; text: string } | null;
const deltaOf = (cur: number | null, prev: number | null): Delta => {
  if (cur == null || prev == null) return null;
  if (cur === prev) return { up: true, text: 'level' };
  const up = cur > prev;
  if (!prev) return { up, text: `+${Math.round(cur).toLocaleString()}` };
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  // Capped the way pctText caps it: a 4-order month against a 400-order one
  // prints a number that says more about the small base than about the move.
  return { up, text: Math.abs(pct) > 999 ? '999%+' : `${Math.abs(pct)}%` };
};

function DeltaChip({ delta, label }: { delta: Delta; label: string }) {
  if (!delta) return null;
  const level = delta.text === 'level';
  const tone = level ? C.muted : delta.up ? C.positive : C.negative;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 5,
      padding: '4px 10px', borderRadius: 999, background: 'var(--panel-2)',
      fontSize: 12, color: C.sub, fontVariantNumeric: 'tabular-nums',
    }}>
      <b style={{ color: tone, fontWeight: 800 }}>
        {level ? '=' : delta.up ? '▲' : '▼'} {delta.text}
      </b>
      {label}
    </span>
  );
}

/**
 * ── THE BREAKDOWN, ADMIN ONLY ────────────────────────────────────────────────
 *
 * The team line answers "which way did the book move". It cannot answer "who
 * moved it" or "which programme moved it", and on an owner's board that is the
 * next question every time: a 131% month is a different conversation depending
 * on whether one rep doubled or all four rose together.
 *
 * STACKED, not grouped. The segments have to add up to the team total the card
 * already states two inches above — a grouped chart puts four short bars side by
 * side and leaves the reader summing them by eye against a figure that is
 * already on screen. Stacking makes the total the bar height, so the breakdown
 * and the headline are visibly the same number.
 *
 * WHY ONE METRIC AT A TIME. The team view draws three at once (two bar series
 * plus a line) because there are only three. Split five ways that is fifteen
 * marks per month, which is not a chart. The metric picker is the price of the
 * split, not an oversight.
 *
 * NOT OFFERED, AND CHECKED RATHER THAN ASSUMED — the payload simply does not
 * carry these, so the picker does not pretend otherwise:
 *   · REVENUE BY VERTICAL. `byMonth[].byVertical` rows carry `vertical`,
 *     `orders` and `units` and no revenue field at all.
 *   · COMMISSION BY VERTICAL. `commissionDue.byMonth[].byVertical` is OWED
 *     commission, and owed is 0 in every month that has settled — all four of
 *     Jillian's months read {PI:0, VA:0, DOL:0, TriCare:0} against real paid
 *     figures. Plotting it would draw a flat zero and call it performance.
 * Both stay available on Team and By rep, where they are real.
 */
type Split = 'team' | 'rep' | 'vertical';
type Metric = 'orders' | 'units' | 'revenue' | 'commission';

/** The band that catches order types outside the configured verticals (DEMO and
 *  the like). Named, not silent — see where it is filled. */
const OTHER = 'Other';

const METRIC_LABEL: Record<Metric, string> = {
  orders: 'Orders', units: 'Devices', revenue: 'Revenue', commission: 'Commission',
};
/** Money metrics get the currency axis and the currency tooltip. */
const isMoney = (m: Metric) => m === 'revenue' || m === 'commission';
/** What each split can honestly plot. See the note above. */
const METRICS_FOR: Record<Split, Metric[]> = {
  team: ['orders', 'units', 'revenue', 'commission'],
  rep: ['orders', 'units', 'revenue', 'commission'],
  vertical: ['orders', 'units'],
};

/** The colours this card draws with: the hues the KPI tiles directly above it
 *  already gave these metrics (HUE.ar teal for orders, HUE.ap purple for
 *  devices, HUE.po amber for pay), so nobody has to relearn the palette between
 *  the strip and the chart three inches below it. */
const INK = { orders: '#0D9488', units: '#7C3AED', money: '#D97706' };

export function MonthOverMonth({ months, rep, team, reps }: {
  /** Every month the shown book touches, oldest first. */
  months: string[];
  /** THE VIEWER'S OWN ROW — the rep board. Money is their commission, by cycle. */
  rep?: RepRow | null;
  /** Team ORDER AND DEVICE totals by month — the manager board. Server-side
   *  because `accounts` is a distinct-payer count that cannot be summed; the
   *  two figures this card takes from it are ordinary sums, but they are taken
   *  from here anyway so the card and the roster footer cite one source. */
  team?: RepOverview['teamByMonth'];
  /** The roster, for the manager board's MONEY only. `teamByMonth` carries no
   *  commission, so the pay line is summed from these rows — the same thing The
   *  team table's footer does with the same field. */
  reps?: RepRow[];
}) {
  const nowYm = thisMonthKey();
  const isRep = Boolean(rep);
  // ONE metric on both boards: what the book PAID. See the header note.
  const moneyName = 'Commission';
  // NO SOURCE IS NOT AN EMPTY BOOK. Without this, a manager payload that
  // carries no `teamByMonth` — an older server, a failed rollup — falls through
  // to a series of zeros and the card states "Nothing booked in the last 12
  // months", which is a claim about the business made from a missing field.
  //
  // An EMPTY array is not a missing one: a rep who has booked nothing yet has
  // `byMonth: []`, and they should get the "nothing booked" line rather than a
  // card that quietly vanishes off their dashboard. Only an absent field counts
  // as no source.
  const noSource = isRep
    ? (rep?.byMonth == null && rep?.commissionByCycle == null)
    : team == null;

  const series: MoMPoint[] = useMemo(() => {
    // BUILT OFF `months`, NOT off the row's own history. `byMonth` carries only
    // the months a rep booked in, so a month they sat out would not appear at
    // all — and a chart that silently omits a quiet month draws an unbroken
    // climb straight over the gap where the dip belongs. A missing month is a
    // zero here, which is what it was.
    const window = months.slice(-WINDOW);
    if (rep) {
      const byMonth = rep.byMonth ?? [];
      const cycles = rep.commissionByCycle ?? null;
      return window.map((m) => {
        const b = byMonth.find((x) => x.month === m) ?? null;
        const c = cycles?.find((x) => x.month === m) ?? null;
        return {
          month: m,
          orders: b?.orders ?? 0,
          // Redaction is preserved: `units` is null on a row the server stripped,
          // while the absence of a month on an unstripped row is a real zero.
          units: rep.units == null ? null : (b ? b.units : 0),
          money: cycles == null ? null : (c?.total ?? 0),
          // `boardRank` is the position over the rows this viewer was actually
          // sent — the number it is safe to DRAW. See RepRow.
          rank: b?.boardRank ?? b?.rank ?? null,
          partial: m === nowYm,
        };
      });
    }
    // ── The manager board ────────────────────────────────────────────────────
    // Counts from `teamByMonth`; PAY summed from the roster, because that is
    // the only place it exists per month. Summing is safe here and is not for
    // `accounts`: commission is money, and two reps' cheques are two cheques,
    // where two reps billing one law firm are one payer.
    const rows = team ?? [];
    const paid = new Map<string, number>();
    // A row whose pay was withheld contributes nothing rather than a zero —
    // and if EVERY row is withheld there is no line to draw at all, which is
    // what `anyPay` decides below.
    const anyPay = (reps ?? []).some((r) => r.commissionByCycle != null);
    for (const r of reps ?? []) {
      for (const c of r.commissionByCycle ?? []) paid.set(c.month, (paid.get(c.month) ?? 0) + (Number(c.total) || 0));
    }
    return window.map((m) => {
      const t = rows.find((x) => x.month === m) ?? null;
      return {
        month: m,
        orders: t?.orders ?? 0,
        units: t?.units ?? 0,
        money: anyPay ? (paid.get(m) ?? 0) : null,
        rank: null,
        partial: m === nowYm,
      };
    });
  }, [months, rep, team, reps, nowYm]);

  // ── The breakdown ──────────────────────────────────────────────────────────
  // Offered only where every row arrived unredacted, which is the admin board.
  // On a rep's login the peer rows carry order counts and nothing else, so a
  // "by rep" split would draw their colleagues' volume beside their own — more
  // than the server intends them to read off one screen, and for Revenue and
  // Commission it would be a column of nulls.
  const canSplit = !isRep && (reps?.length ?? 0) > 0;
  const [splitRaw, setSplit] = useState<Split>('team');
  const [metricRaw, setMetric] = useState<Metric>('orders');
  const split: Split = canSplit ? splitRaw : 'team';
  // A metric the ACTIVE split cannot honestly draw falls back to Orders rather
  // than rendering an empty chart — switching to By vertical while Revenue is
  // selected must not blank the card.
  const metric: Metric = METRICS_FOR[split].includes(metricRaw) ? metricRaw : 'orders';

  const stack = useMemo(() => {
    if (split === 'team') return null;
    const window = months.slice(-WINDOW);
    const rows = reps ?? [];

    // ONE VALUE, for one series, in one month.
    const repValue = (r: RepRow, m: string): number => {
      if (metric === 'commission') {
        // Payout cycle, exactly as the team line and the roster's pay columns.
        return Number((r.commissionByCycle ?? []).find((x) => x.month === m)?.total) || 0;
      }
      const b = (r.byMonth ?? []).find((x) => x.month === m) ?? null;
      if (metric === 'orders') return b?.orders ?? 0;
      if (metric === 'units') return Number(b?.units) || 0;
      return Number(b?.revenue) || 0;
    };
    const vertValue = (m: string, v: string): number => rows.reduce((s, r) => {
      const bv = ((r.byMonth ?? []).find((x) => x.month === m)?.byVertical ?? []).find((x) => x.vertical === v);
      return s + (metric === 'orders' ? (bv?.orders ?? 0) : (Number(bv?.units) || 0));
    }, 0);
    /** The month's whole rep-attributed figure — what the Team view draws. */
    const monthTotal = (m: string): number => rows.reduce((s, r) => {
      const b = (r.byMonth ?? []).find((x) => x.month === m) ?? null;
      return s + (metric === 'orders' ? (b?.orders ?? 0) : (Number(b?.units) || 0));
    }, 0);

    // The series, and the order they stack in.
    let keys: string[];
    if (split === 'rep') {
      // Biggest at the bottom: a stack whose segments jump order between months
      // is unreadable, and the eye tracks the base most reliably.
      keys = rows.map((r) => r.rep)
        .sort((a, b) => window.reduce((s, m) => s + repValue(rows.find((r) => r.rep === b)!, m), 0)
          - window.reduce((s, m) => s + repValue(rows.find((r) => r.rep === a)!, m), 0));
    } else {
      // VERTICAL_ORDER, the app's one display order — clinical programmes first
      // — so this card stacks them the way every other breakdown lists them.
      const present = new Set<string>();
      for (const r of rows) for (const b of r.byMonth ?? []) for (const v of b.byVertical ?? []) if (v.orders) present.add(v.vertical);
      keys = [...VERTICAL_ORDER.filter((v) => present.has(v)),
        ...[...present].filter((v) => !VERTICAL_ORDER.includes(v)).sort()];
    }

    const data = window.map((m) => {
      const row: Record<string, number | string | boolean> = { month: m, partial: m === nowYm };
      for (const k of keys) {
        row[k] = split === 'rep' ? repValue(rows.find((r) => r.rep === k)!, m) : vertValue(m, k);
      }
      // ── THE STACK MUST EQUAL THE HEADLINE ──────────────────────────────────
      // `byVertical` enumerates the CONFIGURED verticals only (VERTS — VA, PI,
      // DOL, TriCare), so an order booked as any other type is in the month's
      // total and in no vertical. It is not hypothetical: July 2026 carries
      // DEMO orders, and the vertical stack summed to 142 against the 143 this
      // very card states two inches above, with nothing on screen to explain
      // the missing one.
      //
      // The remainder is drawn rather than dropped. A breakdown that quietly
      // fails to add up to its own total is worse than one with an "Other"
      // band, because the first looks correct.
      if (split === 'vertical') {
        const known = keys.reduce((s, k) => s + (Number(row[k]) || 0), 0);
        const rest = monthTotal(m) - known;
        if (rest > 0) row[OTHER] = rest;
      }
      return row;
    });
    // `OTHER` joins the key list only where a month actually has a remainder,
    // and always last: it is the residue, not a programme.
    if (split === 'vertical' && data.some((d) => Number(d[OTHER]) > 0)) keys = [...keys, OTHER];
    // A rep who booked nothing all year, or a vertical with no volume, is not a
    // series — it is a legend entry with no mark, and it steals a colour.
    const live = keys.filter((k) => data.some((d) => Number(d[k]) > 0));
    const color = (k: string, i: number) => (split === 'vertical'
      ? (VERTICAL_COLORS[k] ?? SERIES[i % SERIES.length])
      : SERIES[i % SERIES.length]);
    return { data, keys: live, colors: Object.fromEntries(live.map((k, i) => [k, color(k, i)])) };
  }, [split, metric, months, reps, nowYm]);

  // ── The comparison ─────────────────────────────────────────────────────────
  // COMPLETE MONTHS ONLY. Comparing a month that is four days old against a full
  // one manufactures a collapse every 1st, and a rep opening the page would be
  // told they were down 80% on a month that has barely started. The running
  // month is still DRAWN — it is the one they care most about — but faint,
  // labelled, and out of the arithmetic. Same rule as the company Overview's
  // momDelta.
  const complete = series.filter((p) => !p.partial);
  const cur = complete[complete.length - 1] ?? null;
  const prev = complete[complete.length - 2] ?? null;
  const last = series[series.length - 1];
  const running = last?.partial ? last : null;

  const hasMoney = series.some((p) => p.money != null);
  const hasUnits = series.some((p) => p.units != null);
  // The money line gets its own scale, so the right axis only earns its width
  // when there is a line to read against it.
  const moneyMax = Math.max(0, ...series.map((p) => p.money ?? 0));

  // A best month is worth stating outright: it is the bar a reader hunts for by
  // eye anyway, and naming it turns the chart into a target.
  const best = complete.reduce<MoMPoint | null>((b, p) => (b == null || p.orders > b.orders ? p : b), null);

  if (!series.length || noSource) return null;

  const nothingYet = series.every((p) => p.orders === 0 && !p.money);

  return (
    <div className="section chart-card" style={{ marginBottom: 14 }}>
      <div className="section-head">
        <div>
          <h2 className="section-title">Month over month</h2>
          <div className="section-sub">
            {isRep ? 'How your book has moved.' : "How the team's book has moved."}
            {split === 'team'
              ? <> Orders and devices by order date; commission by payout cycle, matching Commission.</>
              : <> <b>{METRIC_LABEL[metric]}</b> {split === 'rep' ? 'per rep' : 'per vertical'}, stacked to the team total
                  {/* THE BASIS, PER METRIC — the split does not change it, but
                      which one applies depends on what is being drawn. */}
                  {metric === 'commission' ? ', by payout cycle (matching Commission).' : ', by order date.'}</>}
            {running && <> <b>{monthLabel(running.month)}</b> is still running, so it is drawn faint and left out of the comparison.</>}
            {/* Said once, where the choice is made, rather than leaving someone
                to wonder why two metrics vanish on this view. */}
            {split === 'vertical' && <> Revenue and commission are not split by vertical: the payload carries neither per vertical per month.</>}
          </div>
        </div>

        {/* THE CONTROLS, ADMIN ONLY. `.ov-filter` is the app's existing filter
            chip — the same control MonthSelect uses — so these read as the same
            KIND of thing as the Period picker elsewhere on the page. */}
        {canSplit && (
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <label className="ov-filter" style={{ flex: 'none' }}>
              <span className="fl">View</span>
              <select value={split} onChange={(e) => setSplit(e.target.value as Split)}
                title="Read the book as one total, or split it by who booked it / which programme"
                style={{ color: C.ink }}>
                <option value="team">Team total</option>
                <option value="rep">By rep</option>
                <option value="vertical">By vertical</option>
              </select>
            </label>
            {split !== 'team' && (
              <label className="ov-filter" style={{ flex: 'none' }}>
                <span className="fl">Metric</span>
                <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}
                  title="A split can only draw one metric at a time" style={{ color: C.ink }}>
                  {METRICS_FOR[split].map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      {/* The legend keys the marks. On the team view it also keys the two AXES —
          counts left, dollars right — without which the line reads as a third
          count. On a split it names the stack, in stacking order. */}
      <div className="mini-legend" style={{ marginBottom: 10 }}>
        {stack
          ? stack.keys.map((k) => (
            <span key={k} className="ml-i"><span className="ml-dot" style={{ background: stack.colors[k] }} />{k}</span>
          ))
          : <>
            <span className="ml-i"><span className="ml-dot" style={{ background: INK.orders }} />Orders</span>
            {hasUnits && <span className="ml-i"><span className="ml-dot" style={{ background: INK.units }} />Devices</span>}
            {hasMoney && <span className="ml-i"><span className="ml-dot" style={{ background: INK.money }} />{moneyName}</span>}
          </>}
      </div>

      {/* THE HEADLINE: the sentence this card exists to say, above the chart that
          evidences it. A reader who takes nothing else from the panel should
          still leave knowing which way they moved. */}
      {cur && prev ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
          <DeltaChip delta={deltaOf(cur.orders, prev.orders)} label="orders" />
          {hasUnits && <DeltaChip delta={deltaOf(cur.units, prev.units)} label="devices" />}
          {hasMoney && <DeltaChip delta={deltaOf(cur.money, prev.money)} label={moneyName.toLowerCase()} />}
          <span style={{ fontSize: 12, color: C.muted }}>
            {monthLabel(cur.month)} vs {monthLabel(prev.month)}
          </span>
        </div>
      ) : (
        // One month on the book is not a failure to render — it is a FIRST
        // month, and saying so beats an empty strip that reads as a broken load.
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
          {complete.length === 1
            ? <>{monthLabel(complete[0].month)} is the first complete month on this book — there is nothing yet to compare it against.</>
            : <>No complete month on the book yet. The comparison appears once one closes.</>}
        </div>
      )}

      {nothingYet ? (
        <div style={{ fontSize: 13, color: C.muted, padding: '18px 0' }}>
          Nothing booked in the last {series.length} month{series.length === 1 ? '' : 's'}.
        </div>
      ) : (
        // `.chart-card` is `display:flex; flex-direction:column` (cashflow.css),
        // so this box is a FLEX ITEM and `height` alone is a starting size a
        // shrink can take back to nothing — and a ResponsiveContainer measured
        // at zero draws an empty card, header and all, with no error to explain
        // it. minHeight plus flex:none is what actually holds the 300px.
        <div className="chart-box" style={{ height: 300, minHeight: 300, flex: 'none' }}>
          <ResponsiveContainer width="100%" height="100%">
          {stack ? (
            // ── THE SPLIT ────────────────────────────────────────────────────
            // One stack per month, one segment per rep / vertical, one metric.
            <ComposedChart data={stack.data} margin={{ top: 14, right: 16, left: 0, bottom: 2 }} barCategoryGap="26%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => axisMonth(String(m))} />
              <YAxis {...axisProps} width={isMoney(metric) ? 54 : 44} allowDecimals={false}
                tickFormatter={isMoney(metric) ? compactMoney : undefined} />
              <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                content={<StackTooltip metric={metric} colors={stack.colors} />} />
              {stack.keys.map((k, i) => (
                <Bar key={k} dataKey={k} name={k} stackId="s" fill={stack.colors[k]} maxBarSize={54}
                  // Only the TOP segment gets the rounded cap, or every band in
                  // the stack draws its own corners and the bar reads as a pile
                  // of separate bars rather than one total.
                  radius={i === stack.keys.length - 1 ? [4, 4, 0, 0] : undefined}>
                  {stack.data.map((d) => <Cell key={String(d.month)} fillOpacity={d.partial ? 0.38 : 1} />)}
                </Bar>
              ))}
            </ComposedChart>
          ) : (
            <ComposedChart data={series} margin={{ top: 14, right: hasMoney ? 8 : 16, left: 0, bottom: 2 }} barGap={3} barCategoryGap="26%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" {...axisProps} tickFormatter={(m: string) => axisMonth(String(m))} />
              {/* allowDecimals off: half an order is not a thing, and recharts
                  will happily tick 0.5 on a book of two. */}
              <YAxis yAxisId="count" {...axisProps} width={40} allowDecimals={false} />
              {hasMoney && (
                <YAxis yAxisId="money" orientation="right" {...axisProps} width={54}
                  tickFormatter={compactMoney}
                  // A window with no money in it would otherwise draw a
                  // "$0 … $0" axis beside a live count axis.
                  domain={[0, moneyMax > 0 ? 'auto' : 1]} />
              )}
              <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} content={<MoMTooltip moneyName={moneyName} />} />
              {/* The previous complete month, carried across the chart. It is
                  what "month over month" measures against, and a bar is far
                  easier to judge against a line than against another bar six
                  columns to its left. */}
              {prev && prev.orders > 0 && (
                <ReferenceLine yAxisId="count" y={prev.orders} stroke={INK.orders} strokeDasharray="4 4" strokeOpacity={0.55}
                  label={{ value: `${monthLabel(prev.month).split(' ')[0]}: ${prev.orders}`, position: 'insideTopLeft', fill: C.muted, fontSize: 10.5 }} />
              )}
              <Bar yAxisId="count" dataKey="orders" name="Orders" fill={INK.orders} radius={[4, 4, 0, 0]} maxBarSize={26}>
                {series.map((p) => <Cell key={p.month} fillOpacity={p.partial ? 0.38 : 1} />)}
              </Bar>
              {hasUnits && (
                <Bar yAxisId="count" dataKey="units" name="Devices" fill={INK.units} radius={[4, 4, 0, 0]} maxBarSize={26}>
                  {series.map((p) => <Cell key={p.month} fillOpacity={p.partial ? 0.38 : 1} />)}
                </Bar>
              )}
              {hasMoney && (
                <Line yAxisId="money" type="monotone" dataKey="money" name={moneyName} stroke={INK.money} strokeWidth={2.5}
                  dot={{ r: 3, fill: INK.money, strokeWidth: 0 }} connectNulls />
              )}
            </ComposedChart>
          )}
          </ResponsiveContainer>
        </div>
      )}

      {best && best.orders > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: C.muted }}>
          Best month so far: <b style={{ color: C.sub }}>{monthLabel(best.month)}</b>
          {' — '}<b style={{ color: C.sub }}>{best.orders}</b> order{best.orders === 1 ? '' : 's'}
          {best.units != null && <>, <b style={{ color: C.sub }}>{best.units}</b> device{best.units === 1 ? '' : 's'}</>}
          {/* CENTS, as everywhere commission is printed on this page — the rates
              are not whole dollars and the figure is reconciled line by line. */}
          {best.money != null && best.money > 0 && <>, <b style={{ color: C.sub }}>{formatCurrency(best.money, true)}</b> {moneyName.toLowerCase()}</>}
          {cur && best.month === cur.month && <> — the month just closed.</>}
        </div>
      )}
    </div>
  );
}

/**
 * The tooltip, hand-rolled rather than left to the default one, for two reasons:
 * the counts and the money need different formatters on the same card, and the
 * BOARD POSITION has no mark of its own to hover. A rank is a large part of why
 * a rep opens this page and it fits nowhere on a two-axis chart, so it rides
 * here.
 */
function MoMTooltip({ active, payload, label, moneyName }: {
  active?: boolean;
  payload?: { payload?: MoMPoint }[];
  label?: string | number;
  moneyName: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: '9px 12px', fontVariantNumeric: 'tabular-nums' }}>
      <div style={{ ...tooltipStyle.labelStyle, marginBottom: 5 }}>
        {monthLabel(String(label ?? p.month))}
        {p.partial && <span style={{ color: C.muted, fontWeight: 600 }}> · still running</span>}
      </div>
      <TipRow color={INK.orders} name="Orders" value={String(p.orders)} />
      {p.units != null && <TipRow color={INK.units} name="Devices" value={String(p.units)} />}
      {p.money != null && <TipRow color={INK.money} name={moneyName} value={formatCurrency(p.money, true)} />}
      {p.rank != null && (
        <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C.grid}`, fontSize: 11.5, color: C.muted }}>
          Board position that month: <b style={{ color: C.ink }}>#{p.rank}</b>
        </div>
      )}
      {/* PAY WITH NO ORDERS BEHIND IT, EXPLAINED WHERE IT IS SEEN.
          March 2026 reads "0 orders · 0 devices · $9,350" and looks broken. It
          is not: the two figures are cut on different bases, which the card's
          subtitle says, but a subtitle three inches above a tooltip is not
          where the question gets asked.
          The case is real and checked. Striven's order book starts 2026-04-27 —
          there is no order dated March anywhere in the company book — while the
          commission workbook carries a March cycle ("Paid ~Apr/May 26") for work
          done before Striven held it, against orders that were back-entered
          later and so carry a May date. Bucketing that money by order date is
          exactly what used to strand $28,526 of Jillian's in no month at all. */}
      {p.orders === 0 && p.money != null && p.money > 0 && (
        <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C.grid}`, fontSize: 11.5, color: C.muted, maxWidth: 230, lineHeight: 1.45 }}>
          Settled in this payout cycle, but no order in the book is dated this
          month — pay is cut by cycle, orders by order date.
        </div>
      )}
    </div>
  );
}

/**
 * The split's tooltip: every segment, then the TOTAL.
 *
 * The total is the point. A stacked bar shows composition well and absolute
 * height badly — nobody reads 148 off a stack of four — and the total is the
 * figure the delta chips above the chart are quoting, so leaving it out would
 * put the breakdown and the headline on different terms.
 *
 * Zero segments are dropped. In a four-rep month where one booked nothing, a
 * "0" row is a line of noise with no mark on the chart to match it.
 */
function StackTooltip({ active, payload, label, metric, colors }: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number; payload?: Record<string, unknown> }[];
  label?: string | number;
  metric: Metric;
  colors: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const fmt = (v: number) => (isMoney(metric) ? formatCurrency(v, metric === 'commission') : String(Math.round(v)));
  const rows = payload
    .map((p) => ({ key: String(p.dataKey ?? ''), value: Number(p.value) || 0 }))
    .filter((r) => r.value > 0)
    // Recharts hands these back in stacking order (bottom first); the tooltip
    // reads top-down, matching how the bar is seen.
    .reverse();
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  const partial = Boolean(payload[0]?.payload?.partial);
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: '9px 12px', fontVariantNumeric: 'tabular-nums', minWidth: 190 }}>
      <div style={{ ...tooltipStyle.labelStyle, marginBottom: 5 }}>
        {monthLabel(String(label ?? ''))}
        <span style={{ color: C.muted, fontWeight: 600 }}> · {METRIC_LABEL[metric].toLowerCase()}</span>
        {partial && <span style={{ color: C.muted, fontWeight: 600 }}> · still running</span>}
      </div>
      {rows.length
        ? rows.map((r) => <TipRow key={r.key} color={colors[r.key] ?? C.muted} name={r.key} value={fmt(r.value)} />)
        : <div style={{ fontSize: 12, color: C.muted }}>Nothing booked.</div>}
      <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C.grid}`, display: 'flex', fontSize: 12, color: C.sub }}>
        Total<b style={{ marginLeft: 'auto', color: C.ink, fontWeight: 800 }}>{fmt(total)}</b>
      </div>
    </div>
  );
}

function TipRow({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.sub, lineHeight: 1.7 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: 'none' }} />
      {name}
      <b style={{ marginLeft: 'auto', color: C.ink, fontWeight: 800 }}>{value}</b>
    </div>
  );
}
