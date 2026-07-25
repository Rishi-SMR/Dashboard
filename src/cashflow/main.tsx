// Entry point for the Cashflow Dashboard (mounted at / via index.html).
// The dashboard lives entirely inside CashflowApp.
import React from 'react';
import ReactDOM from 'react-dom/client';
import CashflowApp from './CashflowApp';
import { initCardTilt } from './tilt';
import './cashflow.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CashflowApp />
  </React.StrictMode>,
);

// Premium 3D pointer-tilt on the hero KPI cards (no-op on touch / reduced-motion).
initCardTilt();
