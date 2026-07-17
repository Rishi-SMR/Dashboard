import { useState } from 'react';
import { VendorsTab } from './VendorsTab';
import { CatalogTab } from './CatalogTab';

type Mode = 'vendors' | 'items';

// Vendors & Items — one sidebar destination, two sub-views (same pattern as
// Orders and AR/AP). Each sub-view keeps its own header and controls.
export function VendorsItemsTab({ initialMode = 'vendors' }: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  return (
    <>
      <div className="exec-deck" style={{ padding: '4px 2px 0' }}>
        <div className="ov-tabs" style={{ marginBottom: 4 }}>
          <button className={`ov-tab${mode === 'vendors' ? ' active' : ''}`} onClick={() => setMode('vendors')}>
            Vendors
          </button>
          <button className={`ov-tab${mode === 'items' ? ' active' : ''}`} onClick={() => setMode('items')}>
            Items &amp; Catalog
          </button>
        </div>
      </div>
      {mode === 'vendors' ? <VendorsTab /> : <CatalogTab />}
    </>
  );
}
