import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type KpiInfo = { formula: string };
export type KpiBreakdownRow = { label: string; value: string; sub?: string; strong?: boolean };

type Props = {
  label: string;
  value: string;
  period?: string;
  sub?: string;
  trend?: 'up' | 'down' | 'neutral';
  active?: boolean;       // green/selected state (follows the last-clicked card)
  info?: KpiInfo;         // methodology shown in the tap modal
  breakdown?: KpiBreakdownRow[];                      // static line-items (shown immediately)
  loadBreakdown?: () => Promise<KpiBreakdownRow[]>;   // lazy line-items (fetched when modal opens)
  open?: boolean;         // is this card's modal currently open
  onClick?: () => void;
  onClose?: () => void;
};

export function KpiCard({
  label, value, period, sub, trend = 'neutral', active,
  info, breakdown, loadBreakdown, open, onClick, onClose,
}: Props) {
  const subClass = trend === 'up' ? 'kpi-sub up' : trend === 'down' ? 'kpi-sub down' : 'kpi-sub';
  const clickable = !!onClick;
  const cls = `kpi${active ? ' active' : ''}${clickable ? ' clickable' : ''}${open ? ' open' : ''}`;

  // Lazy breakdown: fetched the first time the modal opens, then cached.
  const [rows, setRows] = useState<KpiBreakdownRow[] | null>(breakdown ?? null);
  const [bLoading, setBLoading] = useState(false);
  const [bError, setBError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !loadBreakdown || rows || bLoading) return;
    let cancelled = false;
    setBLoading(true);
    setBError(null);
    loadBreakdown()
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setBError(e?.message ?? 'Could not load breakdown'); })
      .finally(() => { if (!cancelled) setBLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={cls}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={info ? !!open : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
              if (e.key === 'Escape' && open) { e.preventDefault(); onClose?.(); }
            }
          : undefined
      }
    >
      <div className="kpi-label">
        {label}
        {info && <span className="kpi-info-icon" aria-hidden="true">i</span>}
      </div>
      {period && <div className="kpi-period">{period}</div>}
      <div className="kpi-value">{value}</div>
      {sub && <div className={subClass}>{sub}</div>}

      {info && open && createPortal(
        <div
          className="kpi-modal-backdrop"
          /* React portals bubble events through the React tree, so without
             stopPropagation this click would also hit the card's onClick and
             immediately re-open the modal. */
          onClick={(e) => { e.stopPropagation(); onClose?.(); }}
        >
          <div className="kpi-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="kpi-modal-head">
              <span className="kpi-modal-title">{label}</span>
              <button
                type="button"
                className="kpi-modal-x"
                aria-label="Close"
                onClick={(e) => { e.stopPropagation(); onClose?.(); }}
              >
                ×
              </button>
            </div>

            <div className="kpi-modal-value">{value}</div>
            <div className="kpi-modal-formula">{info.formula}</div>

            {(rows || bLoading || bError) && (
              <div className="kpi-modal-rows">
                {bLoading && <div className="kpi-modal-note">Loading live breakdown…</div>}
                {bError && <div className="kpi-modal-note error">{bError}</div>}
                {rows && rows.map((r, i) => (
                  <div key={i} className={`kpi-modal-row${r.strong ? ' strong' : ''}`}>
                    <span className="kpi-modal-row-label">
                      {r.label}
                      {r.sub && <span className="kpi-modal-row-sub">{r.sub}</span>}
                    </span>
                    <span className="kpi-modal-row-value">{r.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
