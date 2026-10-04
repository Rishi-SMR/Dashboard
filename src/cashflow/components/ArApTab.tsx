import { useState } from 'react';
import { ReceivablesTab } from './ReceivablesTab';
import { PayablesTab } from './PayablesTab';
import { ArSheetTab } from './ArSheetTab';
import { ApSheetTab } from './ApSheetTab';

type Mode = 'overview' | 'register';

// ONE PAGE PER SIDE (2 Oct 2026, on request). Receivables = the AR overview +
// the AR Register; Payables = the AP overview + the AP Register. They used to be
// one "AR / AP" page plus two separate register entries, which split each side's
// figures across two places. Each sub-view keeps its own header (as-of picker,
// refresh, KPIs), exactly as before.
function SideTabs({ mode, setMode, labels }: { mode: Mode; setMode: (m: Mode) => void; labels: [string, string] }) {
  return (
    <div className="exec-deck" style={{ padding: '4px 2px 0' }}>
      <div className="ov-tabs" style={{ marginBottom: 4 }}>
        <button className={`ov-tab${mode === 'overview' ? ' active' : ''}`} onClick={() => setMode('overview')}>{labels[0]}</button>
        <button className={`ov-tab${mode === 'register' ? ' active' : ''}`} onClick={() => setMode('register')}>{labels[1]}</button>
      </div>
    </div>
  );
}

export function ReceivablesGroup({ initialMode = 'overview' }: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  return (
    <>
      <SideTabs mode={mode} setMode={setMode} labels={['AR Overview', 'AR Register']} />
      {mode === 'overview' ? <ReceivablesTab /> : <ArSheetTab />}
    </>
  );
}

export function PayablesGroup({ initialMode = 'overview' }: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  return (
    <>
      <SideTabs mode={mode} setMode={setMode} labels={['AP Overview', 'AP Register']} />
      {mode === 'overview' ? <PayablesTab /> : <ApSheetTab />}
    </>
  );
}
