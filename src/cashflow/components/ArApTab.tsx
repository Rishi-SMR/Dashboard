import { useState } from 'react';
import { ReceivablesTab } from './ReceivablesTab';
import { PayablesTab } from './PayablesTab';

type Mode = 'ar' | 'ap';

// AR / AP — one sidebar destination, two sub-views (same pattern as Orders).
// Each sub-view keeps its own header (as-of picker, refresh, KPIs).
export function ArApTab({ initialMode = 'ar' }: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  return (
    <>
      <div className="exec-deck" style={{ padding: '4px 2px 0' }}>
        <div className="ov-tabs" style={{ marginBottom: 4 }}>
          <button className={`ov-tab${mode === 'ar' ? ' active' : ''}`} onClick={() => setMode('ar')}>
            Receivables (AR)
          </button>
          <button className={`ov-tab${mode === 'ap' ? ' active' : ''}`} onClick={() => setMode('ap')}>
            Payables (AP)
          </button>
        </div>
      </div>
      {mode === 'ar' ? <ReceivablesTab /> : <PayablesTab />}
    </>
  );
}
