import { useState, type ReactNode } from 'react';

/**
 * HEALTH REMARKS — plain-English findings, grouped by how much they matter.
 *
 * Shared by the Balance Sheet and the P&L (27 Oct 2026) so the two read the same
 * way. A remark is worked out by the page from its own figures; this component
 * only orders them, writes the verdict and lays them out:
 *
 *   Concern  red,   open by default — the things to act on
 *   Watch    amber, folded          — worth keeping an eye on
 *   Healthy  green, folded          — what is going well
 *
 * A folded group still shows its count and the titles inside, so nothing is
 * hidden without a trace. `book` marks a book-keeping finding (a balance or
 * posting that cannot be right): the verdict separates those from findings
 * about the business itself, because they decide how far the figures can be
 * trusted rather than how the business is doing.
 */
export type HealthTone = 'good' | 'watch' | 'concern';
export type HealthRemark = { tone: HealthTone; book?: boolean; title: string; text: ReactNode };

const NAME: Record<HealthTone, string> = { concern: 'Concern', watch: 'Watch', good: 'Healthy' };

export function HealthRemarks({ title, remarks, subject, footnote }: {
  title: string; remarks: HealthRemark[];
  /** What the verdict is about: "the balance sheet", "the P&L". */
  subject: string;
  footnote?: ReactNode;
}) {
  const [open, setOpen] = useState<Set<HealthTone>>(new Set(['concern']));
  const toggle = (k: HealthTone) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  if (!remarks.length) return null;

  const rank: Record<HealthTone, number> = { concern: 0, watch: 1, good: 2 };
  const list = [...remarks].sort((a, b) => rank[a.tone] - rank[b.tone] || Number(Boolean(b.book)) - Number(Boolean(a.book)));
  const nGood = list.filter((r) => r.tone === 'good').length;
  const nConcern = list.filter((r) => r.tone === 'concern').length;
  const nBizConcern = list.filter((r) => r.tone === 'concern' && !r.book).length;
  const nBizWatch = list.filter((r) => r.tone === 'watch' && !r.book).length;
  const nBook = list.filter((r) => r.book && r.tone !== 'good').length;
  const tone: HealthTone = nConcern === 0 && nBizWatch === 0 && nBook === 0 ? 'good' : nBizConcern === 0 ? 'watch' : 'concern';
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const verdict = nConcern === 0 && nBook === 0 && nBizWatch === 0
    ? `Healthy: ${subject} shows no warning signs.`
    : nBizConcern === 0
      ? `The business itself looks sound (${plural(nGood, 'healthy sign')}${nBizWatch ? `, ${plural(nBizWatch, 'point')} to watch` : ''})${nBook ? `, but the books need clean-up in ${plural(nBook, 'place')} before these figures can be fully relied on` : ''}.`
      : `${plural(nBizConcern, 'concern')} in ${subject} need${nBizConcern === 1 ? 's' : ''} attention${nBook ? `, and the books need clean-up in ${plural(nBook, 'place')}` : ''}.`;

  return (
    <div className="bh">
      <h3 className="bh-title">{title}</h3>
      <div className={`bh-verdict ${tone}`}>{verdict}</div>
      {(['concern', 'watch', 'good'] as const).map((t) => {
        const group = list.filter((r) => r.tone === t);
        if (!group.length) return null;
        const isOpen = open.has(t);
        return (
          <div key={t} className={`bh-group ${t}`}>
            <div className={`bh-ghead${isOpen ? ' open' : ''}`} role="button" tabIndex={0} aria-expanded={isOpen}
              onClick={() => toggle(t)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(t); } }}>
              <span className="bs-chev" aria-hidden>▸</span>
              <span className="bh-tag">{NAME[t]}</span>
              <span className="bh-gcount">{plural(group.length, 'remark')}</span>
              {!isOpen && <span className="bh-gpeek">{group.map((r) => r.title).join(' · ')}</span>}
            </div>
            {isOpen && (
              <ul className="bh-list">
                {group.map((r, i) => (
                  <li key={i} className={`bh-item ${r.tone}`}>
                    <div><b>{r.title}.</b> {r.text}{r.book ? <span className="bh-book"> · book-keeping</span> : null}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {footnote && <div className="muted-note" style={{ marginTop: 10 }}>{footnote}</div>}
    </div>
  );
}
