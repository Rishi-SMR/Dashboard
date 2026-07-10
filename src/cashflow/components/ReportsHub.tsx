import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { LivePLPage } from './LivePLPage';
import { LiveBSPage } from './LiveBSPage';
import { TillerTransactionsPage } from './TillerTransactionsPage';

type Tab = 'pl' | 'bs' | 'bank' | 'cc';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pl', label: 'P&L' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'bank', label: 'Bank Transactions' },
  { key: 'cc', label: 'Credit Card Transactions' },
];

export function ReportsHub() {
  const [tab, setTab] = useState<Tab>('pl');
  // Keep-alive: a tab mounts on FIRST visit, then stays mounted (hidden) so
  // switching back is instant - no re-fetch, no flash. Landing only mounts the
  // default tab, so opening Reports doesn't fire every report's QB/Tiller pull.
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set<Tab>(['pl']));
  useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))); }, [tab]);

  // CFO Copilot "show me" - switch to the report tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (['pl', 'bs', 'bank', 'cc'].includes(d.tab)) setTab(d.tab as Tab);
  }), []);

  const show = (k: Tab): React.CSSProperties => ({ display: tab === k ? 'block' : 'none' });

  return (
    <>
      <div className="expenses-tabs" data-cfo-anchor="reports-tabs">
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

      {seen.has('pl') && <div style={show('pl')}><LivePLPage /></div>}
      {seen.has('bs') && <div style={show('bs')}><LiveBSPage /></div>}
      {seen.has('bank') && (
        <div style={show('bank')}>
          <TillerTransactionsPage
            entity="Business"
            title="Bank Transactions"
            subtitle="Live from Tiller · all business bank accounts"
          />
        </div>
      )}
      {seen.has('cc') && (
        <div style={show('cc')}>
          <TillerTransactionsPage
            entity="CC"
            title="Credit Card Transactions"
            subtitle="Live from Tiller · all corporate credit cards"
          />
        </div>
      )}
    </>
  );
}
