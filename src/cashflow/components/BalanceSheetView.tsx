import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { fetchQbBalanceSheet, type QbBalanceSheet, type QbBsNode } from '../strivenApi';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { KpiR, DrillModal } from '../chartKit';
import { HealthRemarks, type HealthRemark } from './HealthRemarks';

/**
 * THE BALANCE SHEET, AS QUICKBOOKS REPORTS IT (27 Oct 2026, on request).
 *
 * The P&L page's second view: what the company owns and owes AS OF the end of
 * the period picked on that page — today for year-to-date, the last day for a
 * closed month. Every figure, subtotal included, is QuickBooks' own; the page
 * adds nothing up except the ratios it labels as such.
 *
 * Read top to bottom like the statement it is: Assets, then Liabilities and
 * Equity, each section collapsible down to the account. The one check a
 * balance sheet must pass — assets equal liabilities plus equity — is stated
 * on the page from QuickBooks' two grand totals, as is the tie to the P&L: the
 * Net Income line inside Equity is the year's P&L net income.
 */
/** The P&L figures the health remarks need, for the period on the P&L page. */
type PlFacts = { label: string; income: number; net: number; margin: number; costsPerMonth: number; costsBasis?: string; months: number };
type Remark = HealthRemark;

export function BalanceSheetView({ asOf, asOfLabel, plNetYtd, pl }: {
  asOf: string; asOfLabel: string;
  /** The P&L's net income for the same year to date, when the P&L page is on
   *  "Year to date" — the cross-check against Equity's Net Income line. */
  plNetYtd?: number | null;
  pl?: PlFacts | null;
}) {
  const [bs, setBs] = useState<QbBalanceSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Sections the reader has folded, by path. Everything starts open: the book
  // is small enough to read whole, and folding is for focusing.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<null | { title: string; sub: string; rows: Record<string, ReactNode>[] }>(null);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setBs(await fetchQbBalanceSheet(asOf)); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load the QuickBooks balance sheet.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => {
    setBs(null);
    load();
    const t = setInterval(() => load(true), 90_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);

  const toggle = (k: string) => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const t = bs?.totals;
  const v = (n: number | null | undefined) => n ?? 0;
  const money = (n: number) => (n < 0 ? <span className="neg">−{formatCurrency(Math.abs(n))}</span> : formatCurrency(n));
  const leaves = (n: QbBsNode): QbBsNode[] => (n.children ? n.children.flatMap(leaves) : [n]);

  /**
   * One node of the statement, laid out as an accountant's statement: one
   * amount column, a fixed indent per level, headings without an amount, a
   * single rule above each subtotal and a double rule under each grand total.
   * Its own `bs-` classes — the P&L's row style (tall rows, a rule under every
   * line, boxed subtotals) made a nested statement read as a stack of cards.
   */
  /**
   * THE STATEMENT AS ONE TABLE (27 Oct 2026, on request): Assets on the left,
   * Liabilities & Equity on the right, row for row, the shorter side padded
   * with blank rows so both grand totals land on the SAME bottom row — the
   * equated balance a two-sided balance sheet is read for. Each side is the
   * QuickBooks tree flattened to rows: a group heading, its accounts, its
   * subtotal; the top-level heading becomes the column header and the
   * top-level total becomes the bottom row.
   */
  type BsRow = { kind: 'head' | 'acct' | 'sub'; label: string; amount?: number; depth: number; key: string; node?: QbBsNode; open?: boolean };
  const flatten = (n: QbBsNode, path: string, depth: number, out: BsRow[]) => {
    const key = `${path}/${n.label}`;
    if (!n.children) { out.push({ kind: 'acct', label: n.label, amount: v(n.value), depth, key }); return; }
    const open = !closed.has(key);
    if (depth > 0) out.push({ kind: 'head', label: n.label, depth, key, node: n, open, amount: open ? undefined : v(n.total) });
    if (open || depth === 0) {
      for (const c of n.children) flatten(c, key, depth + 1, out);
      if (depth > 0) out.push({ kind: 'sub', label: `Total ${n.label}`, amount: v(n.total), depth, key: `${key}#total`, node: n });
    }
  };
  const openDrill = (n: QbBsNode) => {
    const accounts = leaves(n);
    setDrill({
      title: n.label, sub: `QuickBooks Balance Sheet · as of ${asOfLabel} · every account under it`,
      rows: [
        ...accounts.map((a) => ({ k: a.label, v: money(v(a.value)) })),
        { k: `Total ${n.label.toLowerCase()}`, v: money(v(n.total)), rowClass: 'total-row' },
      ],
    });
  };
  const cells = (r: BsRow | undefined, side: 'l' | 'r') => {
    const split = side === 'r' ? ' bt-split' : '';
    if (!r) return [<td key={`${side}a`} className={`bt-lbl bt-empty${split}`} />, <td key={`${side}b`} className="bt-amt bt-empty" />];
    const pad = { paddingLeft: 12 + (r.depth - 1) * 18 };
    const click = r.kind === 'head' ? () => toggle(r.key) : r.kind === 'sub' && r.node ? () => openDrill(r.node!) : undefined;
    return [
      <td key={`${side}a`} className={`bt-lbl bt-${r.kind}${click ? ' bt-click' : ''}${split}`} style={pad} onClick={click}
        title={r.kind === 'sub' ? 'See every account under it' : r.kind === 'head' ? (r.open ? 'Fold' : 'Show the accounts') : undefined}>
        {r.kind === 'head' && <span className={`bs-chev${r.open ? ' open' : ''}`} aria-hidden>▸</span>}
        {r.label}
      </td>,
      <td key={`${side}b`} className={`bt-amt bt-${r.kind}`} onClick={click}>
        {r.amount != null ? money(r.amount) : ''}
      </td>,
    ];
  };

  const renderNode = (n: QbBsNode, path: string, depth: number): ReactNode => {
    const key = `${path}/${n.label}`;
    const indent = { ['--d' as string]: depth } as CSSProperties;
    if (!n.children) {
      return (
        <div key={key} className="bs-row bs-acct" style={indent}>
          <span className="bs-lbl">{n.label}</span>
          <span className="bs-amt">{money(v(n.value))}</span>
        </div>
      );
    }
    const open = !closed.has(key);
    const accounts = leaves(n);
    const top = depth === 0;
    return (
      <div key={key} className={top ? 'bs-block' : undefined}>
        <div className={`bs-row ${top ? 'bs-top' : 'bs-head'}`} style={indent} role="button" tabIndex={0}
          aria-expanded={open} onClick={() => toggle(key)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); } }}>
          <span className="bs-lbl"><span className={`bs-chev${open ? ' open' : ''}`} aria-hidden>▸</span>{n.label}</span>
          {/* Folded, the heading carries its total so nothing goes missing. */}
          <span className="bs-amt">{open ? '' : money(v(n.total))}</span>
        </div>
        {open && n.children.map((c) => renderNode(c, key, depth + 1))}
        {open && (
          <div className={`bs-row ${top ? 'bs-grand' : 'bs-sub'}`} style={indent} role="button" tabIndex={0}
            title="See every account under it"
            onClick={() => setDrill({
              title: n.label, sub: `QuickBooks Balance Sheet · as of ${asOfLabel} · every account under it`,
              rows: [
                ...accounts.map((a) => ({ k: a.label, v: money(v(a.value)) })),
                { k: `Total ${n.label.toLowerCase()}`, v: money(v(n.total)), rowClass: 'total-row' },
              ],
            })}>
            <span className="bs-lbl">Total {top ? n.label.toLowerCase() : n.label}</span>
            <span className="bs-amt">{money(v(n.total))}</span>
          </div>
        )}
      </div>
    );
  };

  const currentRatio = t && v(t.currentLiabilities) > 0 ? v(t.currentAssets) / v(t.currentLiabilities) : null;
  const debtToEquity = t && v(t.equity) !== 0 ? v(t.liabilities) / v(t.equity) : null;
  const tiesToPl = plNetYtd != null && t?.netIncome != null ? Math.abs(plNetYtd - t.netIncome) < 0.01 : null;

  // ── BUSINESS HEALTH, IN WORDS (27 Oct 2026, on request) ────────────────────
  // Every remark is worked out from the figures on this page (and the P&L for
  // the same period), with its threshold stated here, so any remark can be
  // traced to a number. Three tones: healthy, worth watching, a concern.
  // BOOK-KEEPING remarks (`book`) are balances that cannot be true; they decide
  // how far the ratios can be trusted, so the verdict leads with them.
  const remarks: Remark[] = [];
  const leavesUnder = (n: QbBsNode | null): QbBsNode[] => (!n ? [] : n.children ? n.children.flatMap(leavesUnder) : [n]);
  const groupOf = (g: string): QbBsNode | null => {
    let hit: QbBsNode | null = null;
    const walk = (n: QbBsNode) => { if (!hit && n.group === g) hit = n; (n.children ?? []).forEach(walk); };
    (bs?.sections ?? []).forEach(walk);
    return hit;
  };
  if (bs && t) {
    // 1. LIQUIDITY — current ratio. >= 2 strong, 1-2 adequate, < 1 a concern.
    if (currentRatio != null) {
      remarks.push(currentRatio >= 2
        ? { tone: 'good', title: 'Short-term bills are well covered', text: <>Current assets are <b>{currentRatio.toFixed(1)}×</b> current liabilities: {formatCurrency(v(t.currentAssets))} available against {formatCurrency(v(t.currentLiabilities))} due within a year. Anything above 2× is comfortable.</> }
        : currentRatio >= 1
          ? { tone: 'watch', title: 'Short-term bills are covered, without much room', text: <>Current ratio <b>{currentRatio.toFixed(2)}</b>: {formatCurrency(v(t.currentAssets))} against {formatCurrency(v(t.currentLiabilities))} due within a year. Below 2× leaves little buffer for a slow month of collections.</> }
          : { tone: 'concern', title: 'Not enough current assets to meet short-term bills', text: <>Current ratio <b>{currentRatio.toFixed(2)}</b>: {formatCurrency(v(t.currentLiabilities))} is due within a year against {formatCurrency(v(t.currentAssets))} in current assets.</> });
    }
    // 2. DEBT — liabilities / equity. < 0.5 low, 0.5-1.5 moderate, > 1.5 high.
    if (debtToEquity != null && v(t.equity) > 0) {
      remarks.push(debtToEquity < 0.5
        ? { tone: 'good', title: 'Very little debt', text: <>The business owes <b>{Math.round(debtToEquity * 100)}¢</b> for every $1 the owners hold in it ({formatCurrency(v(t.liabilities))} against {formatCurrency(v(t.equity))} of equity). It is funded mostly by its own earnings, not by borrowing.</> }
        : debtToEquity <= 1.5
          ? { tone: 'watch', title: 'Moderate debt', text: <>${debtToEquity.toFixed(2)} of liabilities for every $1 of equity. Manageable, but borrowing is a real part of how the business is funded.</> }
          : { tone: 'concern', title: 'Heavily funded by debt', text: <>${debtToEquity.toFixed(2)} of liabilities for every $1 of equity: creditors have more in the business than the owners.</> });
    } else if (v(t.equity) <= 0) {
      remarks.push({ tone: 'concern', title: 'Equity is negative', text: <>Liabilities exceed assets: the business owes more than it owns.</> });
    }
    // 3. CASH RUNWAY — bank / average monthly costs from the P&L.
    //    >= 3 months healthy, 1-3 watch, < 1 concern.
    if (pl && pl.costsPerMonth > 0) {
      const runway = v(t.bank) / pl.costsPerMonth;
      remarks.push({
        tone: runway >= 3 ? 'good' : runway >= 1 ? 'watch' : 'concern',
        title: runway >= 3 ? 'Several months of costs in the bank' : runway >= 1 ? 'A thin cash cushion' : 'Less than a month of costs in the bank',
        text: <>{formatCurrency(v(t.bank))} in the bank covers about <b>{runway.toFixed(1)} months</b> of costs at {pl.costsBasis ?? `the ${pl.label}`} average of {formatCurrency(pl.costsPerMonth)} a month (cost of goods + expenses). Three months or more is the usual comfort level.</>,
      });
    }
    // 4. PROFITABILITY — net margin for the period on the P&L page.
    //    >= 15% healthy, 0-15% thin, below 0 a loss.
    if (pl && pl.income > 0) {
      remarks.push({
        tone: pl.margin >= 15 ? 'good' : pl.margin > 0 ? 'watch' : 'concern',
        title: pl.margin >= 15 ? 'Profitable, with a healthy margin' : pl.margin > 0 ? 'Profitable, on a thin margin' : 'Losing money',
        text: <>{pl.label}: net income {formatCurrency(pl.net)} on {formatCurrency(pl.income)} of sales, so <b>{pl.margin.toFixed(1)}%</b> of every dollar is kept. That profit is what is building equity on this balance sheet.</>,
      });
    }
    // 5. BOOK-KEEPING — balances that cannot be true.
    for (const a of leavesUnder(groupOf('BankAccounts')).filter((x) => v(x.value) < 0)) {
      remarks.push({ tone: 'concern', book: true, title: `"${a.label}" shows a negative balance`, text: <>{formatCurrency(v(a.value))}. A bank account cannot hold less than nothing unless it is overdrawn; usually this means payments were recorded against it in QuickBooks that came out of another account, or deposits were not recorded. Reconcile it against the bank statement; until then the cash figure ({formatCurrency(v(t.bank))}) is not reliable.</> });
    }
    for (const a of leavesUnder(groupOf('Liabilities')).filter((x) => v(x.value) < -0.5)) {
      remarks.push({ tone: 'concern', book: true, title: `"${a.label}" is negative`, text: <>{formatCurrency(v(a.value))}. A liability below zero means more was paid against it than was ever owed, or a payment was posted to the wrong account. It lowers total liabilities by that amount, which flatters the debt and liquidity figures above.</> });
    }
    if (v(t.longTermLiabilities) < 0) {
      remarks.push({ tone: 'concern', book: true, title: 'Long-term liabilities add up to less than zero', text: <>{formatCurrency(v(t.longTermLiabilities))} overall, a direct result of the negative loan balance above.</> });
    }
    if (pl && pl.income > 0 && v(t.ar) < pl.income * 0.01) {
      remarks.push({ tone: 'watch', book: true, title: 'Accounts receivable is almost empty in QuickBooks', text: <>{formatCurrency(v(t.ar))} on the books against {formatCurrency(pl.income)} of sales. QuickBooks records the sales but not the invoices still unpaid, so it does not show what customers owe. The real receivable is on the dashboard's AR Due and Receivables pages (Striven and the Master File).</> });
    }
    const re = leavesUnder(groupOf('Equity')).find((a) => /retained earnings/i.test(a.label));
    if (re && v(re.value) === 0) {
      remarks.push({ tone: 'watch', book: true, title: 'No retained earnings carried forward', text: <>Retained earnings is blank, so no profit or loss from earlier years is on the books. That is expected if the business started trading this year; otherwise it is a sign the prior year was not closed in QuickBooks.</> });
    }
  }

  return (
    <>
      {error && (
        <div className="qb-banner warn">
          <span><b>The QuickBooks balance sheet could not be read.</b> {error}</span>
          {/not connected|reconnect|token|invalid_grant/i.test(error) && <a className="btn" href="/api/qb/connect">Connect QuickBooks →</a>}
        </div>
      )}
      {loading && !bs && <div className="page-sub" style={{ padding: 16 }}>Loading the balance sheet from QuickBooks…</div>}

      {bs && t && (
        <>
          <div className="kpi-r-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <KpiR ico="cash" tint="#16A34A" label="Total assets" value={v(t.assets)} format={formatCurrency}
              deltaText={`as of ${asOfLabel}`} foot={`${formatCurrency(v(t.currentAssets))} current · ${formatCurrency(v(t.fixedAssets))} fixed`} />
            <KpiR ico="trend" tint="#DC2626" label="Total liabilities" value={v(t.liabilities)} format={formatCurrency}
              deltaText={`${formatCurrency(v(t.ap))} accounts payable`} foot={`${formatCurrency(v(t.currentLiabilities))} current · ${formatCurrency(v(t.longTermLiabilities))} long-term`} />
            <KpiR ico="pie" tint="#0A369F" label="Equity" value={v(t.equity)} format={formatCurrency}
              deltaText={`incl. ${formatCurrency(v(t.netIncome))} net income`} foot="what the owners hold in the business" />
            <KpiR ico="wallet" tint="#4F46E5" label="Cash in bank" value={v(t.bank)} format={formatCurrency}
              deltaText="bank accounts, net" foot={`${formatCurrency(v(t.ar))} accounts receivable`} />
          </div>

          <div className="section chart-card" style={{ marginTop: 16 }}>
            <div className="section-head">
              <div>
                <h2 className="section-title">Balance Sheet · as of {asOfLabel}</h2>
                <div className="section-sub">QuickBooks' statement, {bs.basis.toLowerCase()} basis. Click a heading to fold it, or a total to see every account under it.</div>
              </div>
            </div>
            {/* THE CHECK EVERY BALANCE SHEET MUST PASS, from QuickBooks' own totals. */}
            <div className={bs.balanced ? 'qb-banner ok' : 'qb-banner warn'}>
              <span>
                {bs.balanced
                  ? <><b>Balanced.</b> Assets {formatCurrency(v(t.assets))} = liabilities {formatCurrency(v(t.liabilities))} + equity {formatCurrency(v(t.equity))}.</>
                  : <><b>Does not balance.</b> Assets {formatCurrency(v(t.assets))} against liabilities and equity {formatCurrency(v(t.liabilitiesAndEquity))} — check the books in QuickBooks.</>}
                {tiesToPl != null && (tiesToPl
                  ? <> Net income in equity ties to the P&amp;L ({formatCurrency(v(t.netIncome))}).</>
                  : <> Net income in equity ({formatCurrency(v(t.netIncome))}) differs from the P&amp;L ({formatCurrency(plNetYtd!)}).</>)}
              </span>
            </div>
            {(() => {
              const [L, R] = [bs.sections[0], bs.sections[1]];
              if (!L || !R) return <div className="bs-columns">{bs.sections.map((sc) => <div key={sc.label} className="bs-statement">{renderNode(sc, '', 0)}</div>)}</div>;
              const left: BsRow[] = []; const right: BsRow[] = [];
              flatten(L, '', 0, left); flatten(R, '', 0, right);
              const n = Math.max(left.length, right.length);
              const diff = Math.round((v(L.total) - v(R.total)) * 100) / 100;
              return (
                <div className="bt-wrap">
                  <table className="bt">
                    <colgroup><col /><col className="bt-colamt" /><col /><col className="bt-colamt" /></colgroup>
                    <thead>
                      <tr>
                        <th className="bt-lbl">{L.label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</th><th className="bt-amt">Amount</th>
                        <th className="bt-lbl bt-split">{R.label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).replace(/ and /, ' & ').replace(/& equity/, '& Equity')}</th><th className="bt-amt">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: n }, (_, i) => (
                        <tr key={i}>{cells(left[i], 'l')}{cells(right[i], 'r')}</tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bt-grand">
                        <td className="bt-lbl bt-click" onClick={() => openDrill(L)}>Total {L.label.toLowerCase()}</td>
                        <td className="bt-amt bt-click" onClick={() => openDrill(L)}>{money(v(L.total))}</td>
                        <td className="bt-lbl bt-split bt-click" onClick={() => openDrill(R)}>Total {R.label.toLowerCase()}</td>
                        <td className="bt-amt bt-click" onClick={() => openDrill(R)}>{money(v(R.total))}</td>
                      </tr>
                      <tr className={`bt-check ${diff === 0 ? 'ok' : 'bad'}`}>
                        <td colSpan={4}>
                          {diff === 0
                            ? <>✓ Balanced: total assets equal total liabilities and equity at {formatCurrency(v(L.total))} · difference $0.00</>
                            : <>✗ Not balanced: assets {formatCurrency(v(L.total))} against liabilities and equity {formatCurrency(v(R.total))} · difference {formatCurrency(diff)}</>}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}
            <div className="pl-meta">
              <div><span>Current ratio</span><strong>{currentRatio != null ? currentRatio.toFixed(2) : '-'}</strong></div>
              <div><span>Debt to equity</span><strong>{debtToEquity != null ? debtToEquity.toFixed(2) : '-'}</strong></div>
              <div><span>Working capital</span><strong>{formatCurrency(v(t.currentAssets) - v(t.currentLiabilities))}</strong></div>
              <div><span>Accounts receivable</span><strong>{formatCurrency(v(t.ar))}</strong></div>
              <div><span>Accounts payable</span><strong>{formatCurrency(v(t.ap))}</strong></div>
            </div>
            <HealthRemarks title={`Business health · as of ${asOfLabel}`} subject="the balance sheet" remarks={remarks} />
            <div className="muted-note">
              QuickBooks Balance Sheet as of {asOfLabel}{bs.generatedAt ? `, generated ${new Date(bs.generatedAt).toLocaleString()}` : ''}.
              Current ratio = current assets ÷ current liabilities; debt to equity = total liabilities ÷ equity; working capital = current assets − current liabilities. Health remarks use these thresholds: current ratio 2× and 1×; debt to equity 0.5 and 1.5; cash runway 3 months and 1 month; net margin 15%.
            </div>
          </div>
        </>
      )}

      {drill && (
        <DrillModal title={drill.title} sub={drill.sub}
          columns={[{ key: 'k', label: 'Account' }, { key: 'v', label: 'Balance', num: true }]}
          rows={drill.rows} onClose={() => setDrill(null)} />
      )}
    </>
  );
}
