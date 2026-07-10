import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { SalesForecastPage } from './SalesForecastPage';
import { ArProjectionPage } from './ArProjectionPage';
import { WeeklyRowEdit } from './WeeklyRowEdit';
import { ExpenseEditPage } from './ExpenseEditPage';

// "Projections" section: Sales (forecast + editable weekly sales), AR (how AR
// collections are derived + editable weekly AR), and Expense (editable weekly
// outflow lines). Each lives in its own tab and is edited in place — every edit
// flows into the 13-Week projection.
type Tab = 'sales' | 'ar' | 'expense';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'sales', label: 'Sales' },
  { key: 'ar', label: 'AR' },
  { key: 'expense', label: 'Expense' },
];

export function SalesHub() {
  const [tab, setTab] = useState<Tab>('sales');

  // CFO Copilot "show me" - jump to the tab it points at (accept legacy keys).
  useEffect(() => onCfoNav((d) => {
    if (d.tab === 'sales' || d.tab === 'forecast' || d.tab === 'edit') setTab('sales');
    else if (d.tab === 'ar') setTab('ar');
    else if (d.tab === 'expense' || d.tab === 'expenses') setTab('expense');
  }), []);

  return (
    <>
      <div className="expenses-tabs" data-cfo-anchor="sales-tabs">
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

      <div style={{ display: tab === 'sales' ? 'block' : 'none' }}>
        {tab === 'sales' && (
          <>
            <SalesForecastPage />
            <WeeklyRowEdit rowRx={/^sales \(this week/i} heading="Edit weekly sales" sub="Gross sales that feed the 13-Week cashflow" />
          </>
        )}
      </div>
      <div style={{ display: tab === 'ar' ? 'block' : 'none' }}>
        {tab === 'ar' && <ArProjectionPage />}
      </div>
      <div style={{ display: tab === 'expense' ? 'block' : 'none' }}>
        {tab === 'expense' && <ExpenseEditPage />}
      </div>
    </>
  );
}
