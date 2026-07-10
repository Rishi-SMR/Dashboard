import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  fetchQbPlReport, fetchMappedExpenses, fetchCategoryOverrides,
  setCategoryOverride, clearCategoryOverride,
  type QbPlReport, type AllCategoryOverrides,
} from '../api';
import { formatCurrency } from '../format';
import { BillDrillModal } from './BillDrillModal';

const AUTO = '__auto__';

/**
 * P&L Mapping. The full QuickBooks P&L (cash basis), head-wise, with a dropdown
 * next to each expense head to put it into one of your expense categories.
 *
 * IMPORTANT: every selection AUTO-SAVES immediately (optimistic; reverts if the
 * server call fails). There is no draft / Save button on purpose: with the
 * flaky preview tunnel, a draft can be lost on reload, so we persist each change
 * the instant it's made. The "What you've mapped" summary up top is built only
 * from QB P&L + your saved mapping (no sheet) and updates live.
 */
export function PnlMappingPage() {
  const [pl, setPl] = useState<QbPlReport | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<AllCategoryOverrides>({});
  const [q, setQ] = useState('');
  const [monthSel, setMonthSel] = useState<number | 'all' | null>(null); // null = default to latest month
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [billAccount, setBillAccount] = useState<string | null>(null); // account whose QB bills are open
  const toggleBucket = (name: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });

  useEffect(() => {
    // Cash basis: the amount as it actually hits cash (what you map against).
    void fetchQbPlReport({ method: 'Cash' }).then(setPl).catch(() => {});
    // Only used for the dropdown's category options (the list of boxes).
    void fetchMappedExpenses('Combined').then((m) => setCats(m.rows.map((r) => r.category))).catch(() => {});
    void fetchCategoryOverrides().then(setOverrides).catch(() => {});
  }, []);

  // Mappable expense heads = detail rows under the COGS + Expenses sections
  // (skip Income). Track the depth-0 section as we walk the flat report.
  const heads = useMemo(() => {
    if (!pl) return [];
    let section = '';
    const out: { name: string; total: number; monthly: number[]; section: string }[] = [];
    for (const r of pl.rows) {
      if (r.kind === 'section' && r.depth === 0) section = r.name;
      if (r.kind === 'detail' && section && !/income/i.test(section)) {
        out.push({ name: r.name, total: r.total, monthly: r.monthly ?? [], section });
      }
    }
    return out;
  }, [pl]);

  const months = pl?.monthLabels ?? [];
  const effSel: number | 'all' = monthSel === null ? months.length - 1 : monthSel;
  const amountFor = (h: { total: number; monthly: number[] }) =>
    effSel === 'all' ? h.total : (h.monthly[effSel] ?? 0);
  const periodLabel = effSel === 'all' ? `all ${months.length} months (total)` : (months[effSel] ?? '');

  const filtered = heads.filter((h) => h.name.toLowerCase().includes(q.trim().toLowerCase()));
  const mappedCount = heads.filter((h) => overrides[h.name]?.lineItem).length;

  // "What you've mapped": only heads YOU assigned (no auto, no sheet). Heads you
  // have not mapped sit in "Not yet mapped". Updates live as you map, per month.
  type Bucket = { name: string; total: number; accounts: { name: string; amount: number }[] };
  const { buckets, unmapped, mappedTotal, unmappedTotal } = (() => {
    const m = new Map<string, Bucket>();
    const un: { name: string; amount: number }[] = [];
    for (const h of heads) {
      const ov = overrides[h.name]?.lineItem;
      const amount = amountFor(h);
      if (!ov) { un.push({ name: h.name, amount }); continue; }
      if (!m.has(ov)) m.set(ov, { name: ov, total: 0, accounts: [] });
      const b = m.get(ov)!;
      b.total += amount;
      b.accounts.push({ name: h.name, amount });
    }
    for (const b of m.values()) b.accounts.sort((a, c) => c.amount - a.amount);
    un.sort((a, c) => c.amount - a.amount);
    const list = [...m.values()].sort((a, b) => b.total - a.total);
    return {
      buckets: list, unmapped: un,
      mappedTotal: list.reduce((s, b) => s + b.total, 0),
      unmappedTotal: un.reduce((s, a) => s + a.amount, 0),
    };
  })();

  // Auto-save one head's box. Optimistic so it stays instantly; reverts + flags
  // if the server rejects it. Each change persists on its own (no Save button).
  async function assign(name: string, value: string) {
    const prev = overrides;
    setOverrides((o) => {
      const nx = { ...o };
      if (value === AUTO) delete nx[name];
      else nx[name] = { ...(nx[name] ?? {}), lineItem: value };
      return nx;
    });
    setSavingKey(name);
    setErrorKey(null);
    try {
      const fresh = value === AUTO
        ? await clearCategoryOverride(name)
        : await setCategoryOverride(name, { lineItem: value });
      setOverrides(fresh);
    } catch {
      setOverrides(prev);   // keep the UI honest about what's actually saved
      setErrorKey(name);
    } finally {
      setSavingKey(null);
    }
  }

  if (!pl) return <div className="page-sub">Loading P&L…</div>;

  const inputStyle = {
    padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, background: '#fff', color: 'var(--text)',
  } as const;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">P&L Mapping</h1>
          <div className="page-sub">
            Every P&L expense head (cash basis) with a dropdown to put it in one of your expense categories. Pick a
            month to see that head's cash-basis amount so you can match it against QuickBooks. Every selection saves
            automatically and is stored right away. {mappedCount} of {heads.length} heads mapped so far.
          </div>
        </div>
      </div>

      {/* What you've mapped: only YOUR selections, from QB P&L (cash basis), no sheet. */}
      <div className="section">
        <div className="section-head">
          <div>
            <div className="section-title">What you've mapped ({periodLabel})</div>
            <div className="section-sub">
              Only the heads YOU assign show up here (no auto, no sheet). As you pick a box for a head below, it lands
              in that box's list here. Click a box to see its heads and how much each.
            </div>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>Box (your category)</th><th className="num">Heads</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const open = expanded.has(b.name);
              return (
                <Fragment key={b.name}>
                  <tr onClick={() => toggleBucket(b.name)} style={{ cursor: 'pointer' }}>
                    <td><span style={{ color: 'var(--muted)' }}>{open ? '▾ ' : '▸ '}</span><strong>{b.name}</strong></td>
                    <td className="num">{b.accounts.length}</td>
                    <td className="num"><strong>{formatCurrency(Math.round(b.total))}</strong></td>
                  </tr>
                  {open && b.accounts.map((a) => (
                    <tr
                      key={b.name + a.name}
                      style={{ background: 'var(--panel-2)', cursor: 'pointer' }}
                      onClick={() => setBillAccount(a.name)}
                      title="Click to see every QuickBooks bill behind this amount"
                    >
                      <td style={{ paddingLeft: 30, color: 'var(--accent)' }}>{a.name}</td>
                      <td />
                      <td className="num">{formatCurrency(Math.round(a.amount))}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {buckets.length === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>Nothing mapped yet. Assign a box to any head below and it appears here.</td></tr>
            )}
            <tr className="total-row">
              <td>Mapped total</td>
              <td className="num">{heads.length - unmapped.length}</td>
              <td className="num"><strong>{formatCurrency(Math.round(mappedTotal))}</strong></td>
            </tr>
            <tr onClick={() => toggleBucket('__unmapped__')} className="row-none" style={{ cursor: 'pointer' }}>
              <td>
                <span style={{ color: 'var(--muted)' }}>{expanded.has('__unmapped__') ? '▾ ' : '▸ '}</span>
                <strong style={{ color: 'var(--danger)' }}>Not yet mapped</strong>
              </td>
              <td className="num">{unmapped.length}</td>
              <td className="num"><strong>{formatCurrency(Math.round(unmappedTotal))}</strong></td>
            </tr>
            {expanded.has('__unmapped__') && unmapped.map((a) => (
              <tr key={'un' + a.name} style={{ background: 'var(--panel-2)', cursor: 'pointer' }} onClick={() => setBillAccount(a.name)} title="Click to see its QuickBooks bills">
                <td style={{ paddingLeft: 30, color: 'var(--accent)' }}>{a.name}</td>
                <td />
                <td className="num">{formatCurrency(Math.round(a.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input
            placeholder="Search heads"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ ...inputStyle, flex: 1, minWidth: 220, maxWidth: 360 }}
          />
          <label style={{ fontSize: 12, color: 'var(--muted-strong)', fontWeight: 600 }}>
            Amount for:{' '}
            <select
              value={String(effSel)}
              onChange={(e) => setMonthSel(e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10))}
              style={{ ...inputStyle }}
            >
              <option value="all">All months (total)</option>
              {months.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
          </label>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>P&L head</th>
              <th>Section</th>
              <th className="num">Amount ({periodLabel})</th>
              <th>Currently in</th>
              <th>Goes into</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((h) => {
              const ov = overrides[h.name]?.lineItem;
              const cur = ov ?? AUTO;
              const isSet = !!ov;
              const opts = ov && !cats.includes(ov) ? [ov, ...cats] : cats;
              return (
                <tr key={h.name}>
                  <td>{h.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{h.section}</td>
                  <td className="num">{formatCurrency(Math.round(amountFor(h)))}</td>
                  <td style={{ color: isSet ? 'var(--accent)' : 'var(--muted)', fontWeight: isSet ? 700 : 400 }}>
                    {isSet ? ov : 'Not mapped'}
                  </td>
                  <td>
                    <select
                      value={cur}
                      onChange={(e) => assign(h.name, e.target.value)}
                      style={{ ...inputStyle, minWidth: 220, fontWeight: isSet ? 700 : 400, color: isSet ? 'var(--accent)' : 'var(--muted)' }}
                    >
                      <option value={AUTO}>(auto / default)</option>
                      {opts.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    {savingKey === h.name && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>saving…</span>}
                    {errorKey === h.name && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--danger)' }}>save failed, try again</span>}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No heads match "{q}".</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {billAccount && <BillDrillModal account={billAccount} onClose={() => setBillAccount(null)} />}
    </>
  );
}
