import { useEffect, useState } from 'react';
import { CashFlow13Week } from './CashFlow13Week';
import { CurrentPosition } from './CurrentPosition';
import { onCfoNav } from '../cfoNav';

type Props = {
  /** Renders the parent's existing dashboard view in the "Cash Flow" tab. */
  dashboardSlot: React.ReactNode;
};

type Tab = 'position' | 'dashboard' | 'cashflow13';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'position', label: 'Current Position' },
  { key: 'dashboard', label: 'Cash Flow' },
  { key: 'cashflow13', label: '13-Week Plan' },
];

export function CashflowHub({ dashboardSlot }: Props) {
  const [tab, setTab] = useState<Tab>('position');
  // Keep-alive: a tab mounts on FIRST visit, then stays mounted (just hidden) so
  // switching back is instant - no re-fetch, no loading flash. Landing still only
  // mounts the default tab, so the initial load stays light.
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set<Tab>(['position']));
  useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))); }, [tab]);

  // CFO Copilot "show me" - switch to the tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (d.tab === 'position' || d.tab === 'dashboard' || d.tab === 'cashflow13') setTab(d.tab);
  }), []);

  const show = (k: Tab): React.CSSProperties => ({ display: tab === k ? 'block' : 'none' });

  return (
    <>
      <div className="expenses-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`expenses-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {seen.has('position') && <div style={show('position')}><CurrentPosition /></div>}
      {seen.has('dashboard') && <div style={show('dashboard')}>{dashboardSlot}</div>}
      {seen.has('cashflow13') && <div style={show('cashflow13')}><CashFlow13Week /></div>}
    </>
  );
}
