// Entry point for the Cashflow Dashboard (mounted at / via index.html).
// The dashboard lives entirely inside CashflowApp.
import React from 'react';
import ReactDOM from 'react-dom/client';
import CashflowApp from './CashflowApp';
import './cashflow.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CashflowApp />
  </React.StrictMode>,
);
