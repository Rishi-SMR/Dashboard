import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { MappedExpensesPage } from './MappedExpensesPage';
import { MonthlySummary } from './MonthlySummary';
import { PnlMappingPage } from './PnlMappingPage';

// Expense editing now lives ONLY in Projections → Expense (per-week, flows into
// the 13-week cashflow), so it isn't duplicated here. This hub is view-only,
// except the Mapping tab which assigns P&L heads to expense categories.
export type ExpensesTab = 'monthly' | 'combined' | 'mapping';

const TABS: Array<{ key: ExpensesTab; label: string }> = [
 { key: 'monthly', label: 'Monthly Summary' },
 { key: 'combined', label: 'Expenses' },
 { key: 'mapping', label: 'P&L Mapping' },
];

export function ExpensesHub() {
 const [tab, setTab] = useState<ExpensesTab>('monthly');
 // Keep-alive: mount a tab on FIRST visit, then keep it mounted (hidden) so
 // switching back is instant (no re-fetch / loading flash). Initial load still
 // only mounts the default tab, so it stays light (each tab is a separate QB
 // pull - we don't fire them all at once).
 const [seen, setSeen] = useState<Set<ExpensesTab>>(() => new Set<ExpensesTab>(['monthly']));
 useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))); }, [tab]);

 // CFO Copilot "show me" - switch to the expenses sub-tab it points at.
 useEffect(() => onCfoNav((d) => {
 if (['monthly', 'combined', 'mapping'].includes(d.tab)) setTab(d.tab as ExpensesTab);
 }), []);

 const show = (k: ExpensesTab): React.CSSProperties => ({ display: tab === k ? 'block' : 'none' });

 return (
 <>
 <div className="expenses-tabs" data-cfo-anchor="expenses-tabs">
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

 {seen.has('monthly') && <div style={show('monthly')}><MonthlySummary /></div>}
 {seen.has('combined') && (
 <div style={show('combined')}>
 <MappedExpensesPage
 entity="Combined"
 title="Expenses"
 subtitle="Mapped expense categories · all accounts"
 totalLabel="TOTAL"
 />
 </div>
 )}
 {seen.has('mapping') && <div style={show('mapping')}><PnlMappingPage /></div>}
 </>
 );
}
