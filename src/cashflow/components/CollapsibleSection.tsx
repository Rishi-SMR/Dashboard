import { useState, type ReactNode } from 'react';

/**
 * A collapsible <section>-style block. Pass a clear `title` + optional `sub`;
 * the body is hidden by default unless `defaultOpen` is set. Click the header
 * to toggle.
 *
 * Designed to match the existing `.section` / `.section-head` styling so
 * collapsible and always-open sections sit side-by-side on a page without
 * a visual jump.
 */
export function CollapsibleSection({
  title,
  sub,
  defaultOpen = false,
  rightSlot,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  defaultOpen?: boolean;
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section collapsible ${open ? 'open' : 'collapsed'}`}>
      <div
        className="section-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="section-title">
            <span style={{ width: 12, color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
            {title}
          </div>
          {sub && <div className="section-sub">{sub}</div>}
        </div>
        {rightSlot && <div onClick={(e) => e.stopPropagation()}>{rightSlot}</div>}
        <span className="section-toggle">{open ? 'hide' : 'show'}</span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}
