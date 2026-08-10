import { useMemo, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, ChartCard, AgingBar, MonthBars, DrillModal } from '../chartKit';
import { fetchArRegister, type ArRegister, type ArRegisterInvoice } from '../strivenApi';
import { ColumnFilter } from './ColumnFilter';
import { downloadXlsx, printToPdf, stamped } from '../export';

// ─────────────────────────────────────────────────────────────────────────────
// AR REGISTER — the invoice book, as its own page.
//
// Striven supplies the BOOK (which invoices exist, what is still open); the
// accountant's Sales_Activity_Report sheet supplies the DETAIL (invoice date,
// patient, PO memo, GL account). Driven off Striven deliberately: an invoice the
// sheet has not caught up with then shows as a row missing its detail — the
// `sheet ✗` badge — rather than silently shrinking the total. Invoice #116 is
// that row today.
//
// This tab's OUTSTANDING figure ties exactly to the AR Open tile on the AR / AP
// tab. Both net unapplied customer credits through one shared server-side rule
// (netOpenByInvoice). If the two ever disagree on screen, that is the first
// thing to look at — reading raw balances instead put $50,109.94 across 17
// invoices next to the tab's $35,075.99 across 11.
//
// PHI: every row names a patient. The name is reduced to initial + surname
// server-side before serialization; the full name never reaches this component.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 14;
type SortKey = 'no' | 'date' | 'due' | 'total' | 'open';
type Segment = 'all' | 'open' | 'paid' | 'zero-value';

const fmtDate = (s: string) => {
  if (!s) return '-';
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const monthLabel = (m: string) => {
  const d = new Date(m + '-01T00:00:00');
  return Number.isNaN(d.getTime()) ? m : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};
const trunc = (v: string, n = 26) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);

/**
 * How a settled invoice was settled, read DEFENSIVELY.
 *
 * `cashPaid` / `creditApplied` are recent additions to the payload. A browser
 * holding a response fetched before the server carried them — an open tab across
 * a deploy is the everyday case — has `undefined` in both, and the naive read
 * turned every sum into NaN: the breakdown rendered "0 invoices / $0.00" under a
 * total of $250,883.33, which is worse than useless because it looks like an
 * answer.
 *
 * Missing credit reads as NO credit and cash falls back to `paid`, so an old
 * payload degrades to a correct-but-undetailed split that still adds up to the
 * total, rather than to zeros. `num()` also absorbs a null or a string amount,
 * either of which would poison the same sums.
 */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const PART = {
  creditApplied: (i: ArRegisterInvoice) => num(i.creditApplied),
  cashPaid: (i: ArRegisterInvoice) =>
    (typeof i.cashPaid === 'number' && Number.isFinite(i.cashPaid) ? i.cashPaid : num(i.paid) - num(i.creditApplied)),
  total: (i: ArRegisterInvoice) => num(i.total),
};

/**
 * Status → pill. `kind` decides before the amount does, because neither a
 * zero-value invoice nor one settled by an unapplied credit can be told apart
 * from an ordinary paid row by its balance alone.
 */
function statusTag(i: ArRegisterInvoice): ReactNode {
  if (i.status === 'zero-value') return <span className="pill-tag tag-muted">Zero value</span>;
  if (i.status === 'open') return <span className="pill-tag tag-danger">Open</span>;
  // Settled by a customer credit rather than by a payment against this invoice.
  // Six rows, and the reason the raw balances and the AR tile differ by
  // $15,033.95 until the credits are netted — worth naming rather than folding
  // into "Paid".
  if (i.status === 'credited') return <span className="pill-tag tag-warn">Credit applied</span>;
  return <span className="pill-tag tag-ok" style={{ fontWeight: 700 }}>✓ Paid</span>;
}

export function ArSheetTab() {
  const [reg, setReg] = useState<ArRegister | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [pickPayer, setPickPayer] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'no', dir: -1 });
  const [page, setPage] = useState(1);
  const [drill, setDrill] = useState<null | {
    title: string; sub: string;
    columns: { key: string; label: string; num?: boolean }[];
    rows: Record<string, ReactNode>[];
  }>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchArRegister()
      .then((r) => { setReg(r); if (r && r.ok === false) setLoadErr(r.note ?? 'AR register unavailable.'); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Could not reach the AR register.'));
  }, []);

  const INV: ArRegisterInvoice[] = useMemo(() => reg?.invoices ?? [], [reg]);
  const t = reg?.totals;

  // Payer options come from the rows themselves, so the filter can never offer
  // a payer with nothing behind it. Unassigned is a real bucket here — most
  // patient invoices carry no payer until the order is classified.
  const payerOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of INV) m.set(i.payer || 'Unassigned', (m.get(i.payer || 'Unassigned') ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [INV]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INV.filter((i) => {
      // 'paid' means SETTLED, so it has to include the credit-settled rows —
      // otherwise the segments do not add back to the register.
      if (segment === 'paid' && !(i.status === 'paid' || i.status === 'credited')) return false;
      if (segment === 'open' && i.status !== 'open') return false;
      if (segment === 'zero-value' && i.status !== 'zero-value') return false;
      if (pickPayer.size && !pickPayer.has(i.payer || 'Unassigned')) return false;
      return !q || i.no.includes(q) || i.patient.toLowerCase().includes(q)
        || i.payer.toLowerCase().includes(q) || i.memo.toLowerCase().includes(q);
    });
  }, [INV, query, segment, pickPayer]);

  const sorted = useMemo(() => {
    const v = (i: ArRegisterInvoice) => (sort.key === 'no' ? Number(i.no) || 0
      : sort.key === 'total' ? i.total : sort.key === 'open' ? i.open
        : new Date((sort.key === 'due' ? i.dueDate : i.date) + 'T00:00:00').getTime() || 0);
    return [...filtered].sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const fBilled = filtered.reduce((s, i) => s + i.total, 0);
  const fOpen = filtered.reduce((s, i) => s + i.open, 0);

  const setKey = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
    setPage(1);
  };
  const ind = (key: SortKey) => <span className="sort-ind">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>;

  /** Excel of the rows AS FILTERED AND SORTED on screen. Amounts stay NUMERIC —
   *  formatCurrency would ship "$1,998.00" as text and break every sum. */
  function exportExcel() {
    const money = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
    const scope = [
      'AR Register',
      filtered.length === INV.length ? `all ${INV.length}` : `filtered: ${filtered.length} of ${INV.length}`,
      segment === 'all' ? 'all statuses' : segment === 'zero-value' ? 'zero value only' : `${segment} only`,
      pickPayer.size ? `payers: ${[...pickPayer].join(', ')}` : 'all payers',
    ].join(' · ');
    const rows: (string | number)[][] = [
      [scope],
      [],
      ['Invoice number', 'Invoice date', 'Due date', 'Patient', 'Payer', 'Patient PO / memo',
        'Billed', 'Settled', 'Outstanding', 'Status', 'In accountant sheet'],
      ...sorted.map((i) => [i.no, i.date, i.dueDate, i.patient, i.payer, i.memo,
        money(i.total), money(i.paid), money(i.open),
        i.status === 'credited' ? 'Paid (credit applied)' : i.status === 'zero-value' ? 'Zero value'
          : i.status === 'open' ? 'Open' : 'Paid',
        i.inSheet ? 'yes' : 'NO — Striven only']),
      [],
      ['Total', '', '', `${filtered.length} invoices`, '', '', money(fBilled), money(fBilled - fOpen), money(fOpen), '', ''],
    ];
    downloadXlsx([{ name: 'AR register', rows }], stamped('smr-ar-register', 'xlsx'));
  }

  // The category key MUST be `month` — the shared axis formatter reads that name,
  // and passing anything else renders a chart with no labels on its x-axis at
  // all, which is exactly what this was doing.
  const monthSeries = (reg?.byMonth ?? []).map((m) => ({ month: m.month, billed: m.billed, n: m.invoices }));

  /** One month's invoices, from clicking its bar. */
  const explainMonth = (month: string) => {
    if (!month) return;
    const rows = INV.filter((i) => (i.date || '').slice(0, 7) === month)
      .sort((a, b) => Number(b.no) - Number(a.no));
    if (!rows.length) return;
    setDrill({
      title: monthLabel(month),
      sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} raised · ${formatCurrency(rows.reduce((s, i) => s + i.total, 0), true)}`,
      columns: [
        { key: 'no', label: 'INVOICE NUMBER' }, { key: 'd', label: 'INVOICE DATE' },
        { key: 'p', label: 'PATIENT' }, { key: 'a', label: 'BILLED', num: true },
        { key: 'o', label: 'OUTSTANDING', num: true }, { key: 's', label: 'STATUS' },
      ],
      rows: rows.map((i) => ({
        no: <strong>#{i.no}</strong>, d: fmtDate(i.date), p: i.patient || '-',
        a: formatCurrency(i.total, true),
        o: i.open > 0.005 ? formatCurrency(i.open, true) : '—',
        s: statusTag(i),
      })),
    });
  };

  /**
   * Total Billed → the invoice book below it.
   *
   * Clears every filter first, because the tile is a count of ALL invoices and
   * the table it scrolls to may be showing a subset. The scroll is deferred a
   * frame so it measures the table AFTER the reset has re-rendered it — resetting
   * a filter usually makes the table taller, and scrolling first lands short.
   *
   * `scroll-flash` is a brief outline on arrival: on a tall page the jump is
   * otherwise ambiguous about which card you were sent to.
   */
  const showBook = () => {
    setQuery(''); setSegment('all'); setPickPayer(new Set()); setPage(1);
    requestAnimationFrame(() => {
      const el = printRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('scroll-flash');
      void el.offsetWidth;             // restart the animation if it is still running
      el.classList.add('scroll-flash');
      window.setTimeout(() => el.classList.remove('scroll-flash'), 1400);
    });
  };

  /**
   * COLLECTED, BROKEN DOWN BY WHERE THE MONEY CAME FROM.
   *
   * Two ways an invoice stops being outstanding, and they are not the same
   * money: cash banked against the invoice itself, or an unapplied credit
   * sitting on the customer's account being applied to it. Every column here is
   * summed off the SAME rows the register renders — `cashPaid`, `creditApplied`
   * and `open` add back to `total` on every row — so the drill cannot drift from
   * the tile that opened it. The TOTAL line is computed from the two rows above
   * it rather than read from `totals`, which is what makes the tie a fact rather
   * than a claim.
   */
  const explainCollected = () => {
    const settled = INV.filter((i) => i.status === 'paid' || i.status === 'credited');
    const S = (rows: ArRegisterInvoice[], k: 'cashPaid' | 'creditApplied' | 'total') =>
      rows.reduce((s, i) => s + PART[k](i), 0);
    const pure = settled.filter((i) => PART.creditApplied(i) <= 0.005);
    const mixed = settled.filter((i) => PART.creditApplied(i) > 0.005);
    const money = (n: number) => (n > 0.005 ? formatCurrency(n, true) : '—');
    const line = (label: ReactNode, rows: ArRegisterInvoice[]) => ({
      k: label,
      n: String(rows.length),
      cash: money(S(rows, 'cashPaid')),
      cr: money(S(rows, 'creditApplied')),
      tot: formatCurrency(S(rows, 'total'), true),
    });
    return setDrill({
      title: 'Collected',
      sub: `${settled.length} settled invoices · cash + credit = the collected total`,
      columns: [
        { key: 'k', label: 'HOW IT WAS SETTLED' }, { key: 'n', label: 'INVOICES' },
        { key: 'cash', label: 'CASH', num: true }, { key: 'cr', label: 'CREDIT', num: true },
        { key: 'tot', label: 'TOTAL', num: true },
      ],
      rows: [
        line('Paid in cash, no credit involved', pure),
        line('Part cash, remainder cleared by a customer credit', mixed),
        {
          k: <strong>TOTAL COLLECTED</strong>,
          n: <strong>{settled.length}</strong>,
          cash: <strong>{formatCurrency(S(settled, 'cashPaid'), true)}</strong>,
          cr: <strong>{formatCurrency(S(settled, 'creditApplied'), true)}</strong>,
          tot: <strong>{formatCurrency(S(settled, 'total'), true)}</strong>,
        },
        // The mixed rows one by one, so the credit column is auditable rather
        // than a figure you have to take on trust.
        ...(mixed.length
          ? [{ k: <span style={{ color: C.muted, fontSize: 12 }}>The {mixed.length} invoices a credit was applied to</span>, n: '', cash: '', cr: '', tot: '' }]
          : []),
        ...mixed.sort((a, b) => PART.creditApplied(b) - PART.creditApplied(a)).map((i) => ({
          k: <span style={{ paddingLeft: 10 }}>#{i.no} · {i.patient || '-'}</span>,
          n: '',
          cash: money(PART.cashPaid(i)),
          cr: money(PART.creditApplied(i)),
          tot: formatCurrency(i.total, true),
        })),
      ],
    });
  };

  return (
    // `ar-register` scopes this tab's own typography, the way `ap-register`
    // does — `exec-deck` is shared by a dozen tabs.
    <div className="exec-deck ar-register" style={{ padding: '4px 2px' }}>
      <div className="page-head deck-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 24, fontWeight: 800 }}>AR Register</h1>
          <div className="page-sub">
            Every invoice raised · <b>{t?.invoices ?? 0}</b> invoices · book from Striven, detail from the <b>Sales Activity</b> sheet
            {reg?.fetchedAt && <> · read {new Date(reg.fetchedAt).toLocaleTimeString()}</>}
          </div>
        </div>
      </div>

      {loadErr && <div className="error" style={{ marginBottom: 12 }}>{loadErr}</div>}
      {!reg && !loadErr && <div className="page-sub" style={{ padding: 16 }}>Reading the invoice book…</div>}

      {reg?.ok && t && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            {/* Straight to the invoice book. The tile counts EVERY invoice, so
                it clears the filters on the way down — landing on a table
                showing 12 rows under a headline of 164 would read as a
                contradiction rather than as a filter someone left on. */}
            <KpiR ico="doc" tint="#0A369F" label="Total Billed" value={t.billed} format={formatCurrency}
              deltaText={`${t.invoices} invoices`} foot="every invoice raised · click to open the book"
              onClick={showBook} />
            {/* Clickable: the split between cash banked and credit applied is
                the question this tile invites, and $17,687 of it is not what it
                looks like on the face of the card. */}
            <KpiR ico="wallet" tint="#16A34A" label="Collected" value={t.collected} format={formatCurrency}
              deltaText={`${t.collectedInvoices} settled`}
              // Same guard as the drill: an older payload has neither figure,
              // and `$- cash · $- credit` under a real total reads as breakage.
              foot={num(t.creditCollected) > 0
                ? `${formatCurrency(num(t.cashCollected))} cash · ${formatCurrency(num(t.creditCollected))} credit`
                : `${t.collectedInvoices} paid in full`}
              onClick={explainCollected} />
            <KpiR ico="cash" tint="#DC2626" label="Outstanding" value={t.outstanding} format={formatCurrency}
              deltaText={`${t.openInvoices} open invoices`} foot="net of customer credits" />
            <KpiR ico="clip" tint="#D97706" label="Open Invoices" value={t.openInvoices}
              deltaText="awaiting payment" foot="from the invoice book" />
            <KpiR ico="pie" tint="#7C3AED" label="Collection Rate" value={t.collectionRate}
              format={(n) => `${n.toFixed(1)}%`} deltaText="collected ÷ billed" foot="of everything invoiced" />
          </div>

          <div className="exec-grid12">
            <ChartCard className="g12-5" title="AR AGING" sub="Open receivables by days past due">
              <AgingBar aging={reg.aging} />
            </ChartCard>

            <ChartCard className="g12-7" title="BILLED BY MONTH"
              sub={`Invoice value raised each month · ${t.invoices} invoices · click a month for its invoices`}>
              <MonthBars data={monthSeries} bars={[{ key: 'billed', name: 'Billed', color: C.brand }]}
                onSelect={explainMonth} />
            </ChartCard>

            <div className="section chart-card g12-12" ref={printRef}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">INVOICE BOOK</h2>
                  <div className="section-sub">
                    <b>{t.invoices}</b> invoices · billed <b>{formatCurrency(t.billed, true)}</b> ·
                    {' '}outstanding <b style={{ color: C.negative }}>{formatCurrency(t.outstanding, true)}</b>
                  </div>
                </div>
                {/* Controls, not content: `no-print` keeps them off the PDF. */}
                <div className="tbl-controls no-print">
                  <input className="tbl-search" placeholder="Search invoice / patient / payer / PO"
                    value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
                  {/* A filter left on is easy to forget and makes the totals look
                      wrong, so the way out is on screen whenever one applies. */}
                  {(query || segment !== 'all' || pickPayer.size > 0) && (
                    <button className="btn ghost" style={{ padding: '7px 11px' }}
                      onClick={() => { setQuery(''); setSegment('all'); setPickPayer(new Set()); setPage(1); }}>Reset</button>
                  )}
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={exportExcel}
                    title="Download these rows as an Excel workbook. Amounts stay numeric so they total in Excel.">⤓ Excel</button>
                  <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={() => printToPdf(printRef.current)}
                    title="Open the print dialog: choose “Save as PDF” for a PDF of this table">⎙ PDF</button>
                </div>
              </div>

              {/* Open / Settled / Zero value are exhaustive and disjoint, so the
                  three counts always add back to the register. */}
              <div className="smr-seg no-print" style={{ marginBottom: 10 }}>
                {([['all', `All ${t.invoices}`], ['open', `Open ${t.openInvoices}`],
                  ['paid', `Settled ${t.collectedInvoices}`], ['zero-value', `Zero value ${t.zeroValue}`]] as [Segment, string][])
                  .map(([k, label]) => (
                    <button key={k} className={segment === k ? 'active' : ''}
                      onClick={() => { setSegment(k); setPage(1); }}>{label}</button>
                  ))}
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('no')}>INVOICE NUMBER {ind('no')}</th>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('date')}>INVOICE DATE {ind('date')}</th>
                      <th className="sortable" style={{ whiteSpace: 'nowrap' }} onClick={() => setKey('due')}>DUE DATE {ind('due')}</th>
                      <th>PATIENT</th>
                      {/* Only the LABEL sorts — the filter chip shares the cell
                          and must not toggle a sort when opened. */}
                      <th style={{ whiteSpace: 'nowrap' }}>
                        PAYER
                        <ColumnFilter label="Payer" options={payerOpts} picked={pickPayer}
                          onChange={(next) => { setPickPayer(next); setPage(1); }} />
                      </th>
                      <th className="num sortable" onClick={() => setKey('total')}>BILLED {ind('total')}</th>
                      <th className="num sortable" onClick={() => setKey('open')}>OUTSTANDING {ind('open')}</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* ALL sorted rows render; off-page ones are hidden on screen
                        and revealed in print, so the PDF is the whole register
                        rather than page 1 of 12. */}
                    {sorted.map((i, n) => (
                      <tr key={i.no}
                        className={n >= (pageSafe - 1) * PAGE_SIZE && n < pageSafe * PAGE_SIZE ? undefined : 'pg-off'}>
                        <td>
                          <strong>#{i.no}</strong>
                          {/* Striven has it, the accountant's sheet does not.
                              Shown rather than hidden: making this visible is the
                              whole reason the book comes from Striven. */}
                          {!i.inSheet && (
                            <span className="pill-tag tag-warn" style={{ marginLeft: 6 }}
                              title="In Striven but not in the accountant's sheet">sheet ✗</span>
                          )}
                        </td>
                        <td>{fmtDate(i.date)}</td>
                        <td>{fmtDate(i.dueDate)}</td>
                        <td>{i.patient || '-'}</td>
                        <td title={i.payer || undefined}>{trunc(i.payer || '-')}</td>
                        <td className="num">{formatCurrency(i.total, true)}</td>
                        <td className={i.open > 0.005 ? 'num cell-neg' : 'num'}>
                          {i.open > 0.005 ? formatCurrency(i.open, true) : '-'}
                        </td>
                        <td>{statusTag(i)}</td>
                      </tr>
                    ))}
                    {sorted.length === 0 && <tr><td colSpan={8} style={{ color: C.muted }}>No invoices match.</td></tr>}
                    {filtered.length > 0 && (
                      <tr className="total-row">
                        <td>TOTAL</td>
                        <td>{filtered.length} invoice{filtered.length === 1 ? '' : 's'}</td>
                        <td /><td /><td />
                        <td className="num">{formatCurrency(fBilled, true)}</td>
                        <td className="num">{formatCurrency(fOpen, true)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {pages > 1 && (
                <div className="pgn no-print">
                  <span className="pgn-info">Showing {sorted.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {Math.min(pageSafe * PAGE_SIZE, sorted.length)} of {sorted.length} entries</span>
                  <div className="pgn-pages">
                    <button disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>‹</button>
                    {Array.from({ length: pages }, (_, i) => i + 1).slice(0, 8).map((p) => (
                      <button key={p} className={p === pageSafe ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                    ))}
                    <button disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>›</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Where the register and the accountant's sheet disagree. At the FOOT
              of the tab: a caveat about the SOURCE, not something to read before
              the register itself — and stated rather than reconciled, since the
              difference is data entry, not a rule this code could apply. */}
          {(t.missingFromSheet > 0 || t.variances > 0 || t.apRowsExcluded > 0) && (
            <div className="qb-flash warn" style={{ marginTop: 12 }}>
              ⚠️ Against the accountant's sheet ({t.sheetRows} rows read):
              {t.missingFromSheet > 0 && <> <b>{t.missingFromSheet}</b> invoice{t.missingFromSheet === 1 ? '' : 's'} in Striven but not in the sheet ({formatCurrency(t.missingAmount, true)}), badged <b>sheet ✗</b> above.</>}
              {t.variances > 0 && <> <b>{t.variances}</b> amount{t.variances === 1 ? '' : 's'} disagree by {formatCurrency(t.varianceAmount, true)}.</>}
              {t.apRowsExcluded > 0 && <> <b>{t.apRowsExcluded}</b> rows on that sheet offset <i>Accounts Payable</i>, not receivable ({formatCurrency(Math.abs(t.apAmountExcluded), true)}) — excluded, since counting them would understate AR by exactly that.</>}
              {t.unappliedCredits > 0 && <> Outstanding is net of <b>{formatCurrency(t.unappliedCredits, true)}</b> in unapplied customer credits, the same basis the AR / AP tab reports on.</>}
            </div>
          )}
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub} columns={drill.columns} rows={drill.rows}
          onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
