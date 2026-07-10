import { useEffect, useMemo, useRef, useState } from 'react';
import { askCopilot } from '../api';
import { cfoNavigate } from '../cfoNav';

type NavTarget = { view: string; tab: string; anchor: string; where: string };

type Msg = { role: 'user'; text: string } | { role: 'bot'; title: string; lines: string[]; note?: string; warning?: string; nav?: NavTarget; suggestions?: string[] };

const STARTERS = [
  'How are we doing?',
  'How much cash do we have?',
  'What is our runway?',
  'Who owes us the most?',
  'Biggest expense?',
  'What if customers pay late?',
];

/** Time-of-day greeting in the browser's local time. */
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Read the signed-in person from sessionStorage (set by the AR login shell). */
function readMe(): { name: string; title: string } {
  try {
    const name = sessionStorage.getItem('lt_name') || '';
    const title = sessionStorage.getItem('lt_title') || (name.toLowerCase() === 'joey' ? 'CEO' : name.toLowerCase() === 'rishi' ? 'CFO' : '');
    return { name, title };
  } catch {
    return { name: '', title: '' };
  }
}

export function CfoCopilot() {
  const me = useMemo(readMe, []);
  const firstName = me.name ? me.name.split(/\s+/)[0] : '';

  const greeting = useMemo<Msg>(() => ({
    role: 'bot',
    title: firstName ? `${timeGreeting()}, ${firstName} 👋` : `${timeGreeting()} 👋`,
    lines: [`What would you like to know?`],
    suggestions: STARTERS,
  }), [firstName]);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([greeting]);
  const [waving, setWaving] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs, busy, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 80); }, [open]);

  // Inject the wave keyframes once.
  useEffect(() => {
    const id = 'cfo-wave-style';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      @keyframes cfoWave {
        0% { transform: rotate(0deg); }
        15% { transform: rotate(15deg); }
        30% { transform: rotate(-9deg); }
        45% { transform: rotate(15deg); }
        60% { transform: rotate(-9deg); }
        75% { transform: rotate(11deg); }
        100% { transform: rotate(0deg); }
      }
      @keyframes cfoBubblePop {
        0% { opacity: 0; transform: translateY(8px) scale(0.6); }
        18% { opacity: 1; transform: translateY(0) scale(1); }
        82% { opacity: 1; transform: translateY(0) scale(1); }
        100% { opacity: 0; transform: translateY(-5px) scale(0.9); }
      }`;
    document.head.appendChild(s);
  }, []);

  // The robot waves to greet: on arrival, then every ~8s while idle (closed).
  useEffect(() => {
    if (open) { setWaving(false); return; }
    setWaving(true);
    const stop = setTimeout(() => setWaving(false), 1300);
    const iv = setInterval(() => {
      setWaving(true);
      setTimeout(() => setWaving(false), 1300);
    }, 8000);
    return () => { clearTimeout(stop); clearInterval(iv); };
  }, [open]);

  // Greeting only - no proactive "what changed" on open. The user gets the
  // time-of-day hello and asks whatever they want; "what changed" is available
  // on demand (just ask), not pushed.

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const res = await askCopilot(question, me.name ? me : undefined);
      setMsgs((m) => [...m, { role: 'bot', title: res.title, lines: res.lines, note: res.note, warning: res.warning, nav: res.nav, suggestions: res.suggestions }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'bot', title: `Sorry, I couldn't reach the data just now.`, lines: [`(${e instanceof Error ? e.message : 'error'}) Make sure the backend is running and try again.`] }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Greeting bubble - pops up while the robot waves */}
      {!open && waving && (
        <div
          style={{
            position: 'fixed', right: 22, bottom: 104, zIndex: 9998,
            background: '#fff', color: '#065f46', fontWeight: 700, fontSize: 14,
            padding: '8px 14px', borderRadius: 16, borderBottomRightRadius: 4,
            boxShadow: '0 8px 22px rgba(0,0,0,0.18)', border: '1px solid #d1fae5',
            animation: 'cfoBubblePop 1.3s ease-in-out', pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          👋 {firstName ? `Hi ${firstName}!` : 'Hi there!'}
        </div>
      )}

      {/* Launcher */}
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => { if (!open) setWaving(true); }}
        aria-label="CFO Copilot"
        style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 9998,
          width: 72, height: 72, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
          background: open ? 'linear-gradient(135deg, #047857, #10b981)' : 'transparent',
          color: '#fff',
          boxShadow: open ? '0 8px 28px rgba(4,120,87,0.45)' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'transform .15s ease',
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.94)')}
        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {open ? (
          <span style={{ fontSize: 24 }}>✕</span>
        ) : (
          <img
            src="/Bot.png"
            alt=""
            style={{
              width: 72, height: 72, objectFit: 'contain',
              filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.32))',
              transformOrigin: 'bottom center',
              animation: waving ? 'cfoWave 1.25s ease-in-out' : 'none',
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'fixed', right: 24, bottom: 96, zIndex: 9999,
            width: 'min(430px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 130px))',
            background: '#fff', borderRadius: 18, overflow: 'hidden',
            boxShadow: '0 24px 70px rgba(0,0,0,0.28)', border: '1px solid #e5e7eb',
            display: 'flex', flexDirection: 'column', fontSize: 14,
          }}
        >
          {/* Header */}
          <div style={{ background: 'linear-gradient(135deg, #047857, #10b981)', color: '#fff', padding: '14px 18px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img src="/Bot.png" alt="" style={{ width: 42, height: 42, objectFit: 'contain', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))' }} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>CFO Copilot</div>
                <div style={{ fontSize: 11, opacity: 0.9 }}>{firstName ? `For ${firstName}${me.title ? ` · ${me.title}` : ''}` : 'Live data · plain answers'}</div>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#f8fafc' }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {m.role === 'user' ? (
                  <div style={{ maxWidth: '88%', padding: '10px 13px', borderRadius: 14, borderBottomRightRadius: 4, background: 'linear-gradient(135deg, #047857, #059669)', color: '#fff', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {m.text}
                  </div>
                ) : (
                  <>
                    <div style={{ maxWidth: '92%', padding: '11px 14px', borderRadius: 14, borderBottomLeftRadius: 4, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                      {m.warning && (
                        <div style={{ display: 'flex', gap: 6, background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 12.5 }}>
                          <span style={{ flexShrink: 0 }}>⚠️</span><span>{m.warning}</span>
                        </div>
                      )}
                      <div style={{ fontWeight: 700, color: '#065f46', marginBottom: m.lines.length ? 6 : 0 }}>{m.title}</div>
                      {m.lines.map((ln, j) => {
                        const bullet = ln.trimStart().startsWith('•');
                        return (
                          <div key={j} style={{ margin: '3px 0', paddingLeft: bullet ? 6 : 0, color: '#1f2937' }}>
                            {bullet ? ln.replace(/^\s*•\s*/, '• ') : ln}
                          </div>
                        );
                      })}
                      {m.note && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e5e7eb', fontSize: 12, color: '#64748b', display: 'flex', gap: 6 }}>
                          <span style={{ flexShrink: 0 }}>ⓘ</span>
                          <span>{m.note}</span>
                        </div>
                      )}
                    </div>
                    {m.nav && (
                      <button
                        onClick={() => { cfoNavigate({ view: m.nav!.view, tab: m.nav!.tab, anchor: m.nav!.anchor }); setOpen(false); }}
                        title={m.nav.where}
                        style={{ marginTop: 8, alignSelf: 'flex-start', fontSize: 12.5, fontWeight: 600, padding: '7px 12px', borderRadius: 999, border: 'none', background: 'linear-gradient(135deg, #047857, #10b981)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        📍 Show me on the dashboard
                      </button>
                    )}
                    {m.suggestions && m.suggestions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {m.suggestions.map((s) => (
                          <button key={s} onClick={() => send(s)} disabled={busy}
                            style={{ fontSize: 12, padding: '5px 10px', borderRadius: 999, border: '1px solid #a7f3d0', background: '#ecfdf5', color: '#047857', cursor: busy ? 'default' : 'pointer', fontWeight: 500 }}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ display: 'flex', gap: 4, padding: '8px 4px' }}>
                {[0, 1, 2].map((d) => (
                  <span key={d} style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', animation: `cfoblink 1s ${d * 0.15}s infinite` }} />
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(input); }}
                placeholder="Ask me anything about your cash…"
                style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1px solid #d1d5db', fontSize: 14, outline: 'none' }}
              />
              <button onClick={() => send(input)} disabled={busy || !input.trim()}
                style={{ padding: '0 16px', borderRadius: 12, border: 'none', background: busy || !input.trim() ? '#9ca3af' : 'linear-gradient(135deg, #047857, #10b981)', color: '#fff', cursor: busy || !input.trim() ? 'default' : 'pointer', fontWeight: 700, fontSize: 16 }}>
                ➤
              </button>
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', marginTop: 6 }}>
              Answers come live from your own cashflow data
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes cfoblink { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }
        @keyframes cfoPulse {
          0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); }
          70%  { box-shadow: 0 0 0 16px rgba(16,185,129,0); }
          100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        .cfo-highlight {
          animation: cfoPulse 1.3s ease-out 2;
          outline: 2px solid #10b981;
          outline-offset: 3px;
          border-radius: 10px;
          scroll-margin-top: 80px;
        }
      `}</style>
    </>
  );
}
