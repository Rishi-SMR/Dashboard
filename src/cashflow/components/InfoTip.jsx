import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Small ⓘ button shown in the top-right of a KPI card, table, or chart.
//   • HOVER → a short tooltip with the purpose + data source.
//   • CLICK → a full popover with the plain-language explanation (purpose,
//     how it's calculated, and source).
// The popover is rendered in a PORTAL with fixed positioning so it is never
// clipped by a card's `overflow: hidden` or a horizontally-scrolling KPI row.
// Pass any subset of { title, purpose, detail, source }.
export default function InfoTip({ title, purpose, detail, source, style }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const btnRef = useRef(null)
  const panelRef = useRef(null)
  const [pos, setPos] = useState(null)

  const visible = open || (hover && !open && (purpose || source))
  const width = open ? 290 : 230

  // Position the portal panel just below the ⓘ button, right-aligned, clamped
  // to the viewport; flip above if there isn't room below. Recompute on
  // scroll/resize so it tracks the button.
  useLayoutEffect(() => {
    if (!visible) return
    const compute = () => {
      const el = btnRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = r.right - width
      if (left < 8) left = 8
      if (left + width > vw - 8) left = vw - 8 - width
      let top = r.bottom + 6
      const estH = open ? 210 : 92
      if (top + estH > vh - 8 && r.top - estH - 6 > 8) top = r.top - estH - 6
      setPos({ top, left })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [visible, open, width])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return
      if (panelRef.current && panelRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  const panelBase = {
    position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width,
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
    boxShadow: '0 12px 32px rgba(15,23,42,0.18)', textAlign: 'left', cursor: 'default',
    fontWeight: 400, whiteSpace: 'normal', zIndex: 9999,
  }

  return (
    <span
      ref={btnRef}
      className="info-tip"
      style={{ position: 'absolute', top: 8, right: 8, zIndex: 6, ...style }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label="What is this?"
        onClick={(e) => { e.stopPropagation(); setHover(false); setOpen((v) => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setHover(false); setOpen((v) => !v) } }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, borderRadius: '50%', border: `1px solid ${open ? '#15803d' : '#cbd5e1'}`,
          background: open ? '#15803d' : '#fff', color: open ? '#fff' : '#64748b', fontSize: 11.5, fontWeight: 700,
          cursor: 'pointer', fontStyle: 'italic', fontFamily: 'Georgia, serif', userSelect: 'none',
        }}
      >i</span>

      {visible && pos && createPortal(
        open ? (
          <div ref={panelRef} role="dialog" onClick={(e) => e.stopPropagation()} style={{ ...panelBase, padding: 14 }}>
            {title && <div style={{ fontWeight: 700, fontSize: 13.5, color: '#0f172a', marginBottom: 6 }}>{title}</div>}
            {purpose && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#334155', lineHeight: 1.45 }}>{purpose}</p>}
            {detail && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#334155', lineHeight: 1.45 }}>{detail}</p>}
            {source && (
              <div style={{ fontSize: 11.5, color: '#64748b', borderTop: '1px solid #f1f5f9', paddingTop: 6 }}>
                <strong>Source:</strong> {source}
              </div>
            )}
          </div>
        ) : (
          <div style={{ ...panelBase, padding: 10, pointerEvents: 'none' }}>
            {purpose && <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.4 }}>{purpose}</div>}
            {source && <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}><strong>Source:</strong> {source}</div>}
            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 6 }}>Click for full explanation →</div>
          </div>
        ),
        document.body
      )}
    </span>
  )
}
