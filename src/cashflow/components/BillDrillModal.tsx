import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchAccountTransactions, type AccountTransactionsResult } from '../api';
import { formatCurrency } from '../format';

/**
 * Click any account (a person in Payroll, a vendor, a card, anything) and see
 * every bill/transaction straight from QuickBooks that makes up its amount:
 * date, type, vendor, memo, who paid, amount. Portaled modal so
 * it closes on outside-click / Escape like the rest of the app.
 */
export function BillDrillModal({ account, onClose }: { account: string; onClose: () => void }) {
  const [data, setData] = useState<AccountTransactionsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    fetchAccountTransactions(account)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? 'Could not load transactions'); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { cancelled = true; document.removeEventListener('keydown', onKey); };
  }, [account, onClose]);

  const txns = data?.transactions ?? [];

  return createPortal(
    <div className="cm-modal-backdrop" style={{ zIndex: 10000 }} onClick={onClose}>
      <div className="cm-modal" style={{ width: 'min(760px, 100%)', margin: 'auto' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cm-modal-head">
          <div className="cm-head-left">
            <div>
              <div className="cm-title">{account}</div>
              <div className="cm-sub">
                {err
                  ? 'Could not load from QuickBooks'
                  : data
                    ? `${txns.length} bills · total ${formatCurrency(Math.round(data.total))}`
                    : 'Loading bills from QuickBooks…'}
              </div>
            </div>
          </div>
          <button className="cm-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
          {err && <div className="error" style={{ margin: 16 }}>{err}</div>}
          {data && txns.length === 0 && !err && (
            <div className="page-sub" style={{ padding: 16 }}>No QuickBooks bills found for this account.</div>
          )}
          {txns.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Vendor</th>
                  <th>Memo</th>
                  <th>Paid by</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t, i) => (
                  <tr key={t.txnId || i}>
                    <td>{t.date}</td>
                    <td>{t.txnType}</td>
                    <td>{t.vendor || ''}</td>
                    <td>{t.memo ? <span className="vendor-note">{t.memo}</span> : null}</td>
                    <td style={{ color: 'var(--muted)' }}>{t.paidBy}</td>
                    <td className="num">{formatCurrency(Math.round(t.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
