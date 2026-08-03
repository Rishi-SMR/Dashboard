/**
 * Export helpers — real .xlsx, Excel-safe CSV, and print-to-PDF.
 *
 * NO third-party dependency. SheetJS/jsPDF would add several hundred kB to a
 * bundle currently around 23kB, for two buttons. The .xlsx writer lives in
 * ./xlsx.js (plain JS so the tests exercise the shipped code directly); PDF
 * comes from the browser's own print pipeline, which renders the charts as
 * drawn.
 *
 * Deliberately NOT a CSV renamed to .xls — Excel warns about the format
 * mismatch on every open, which is fine for a developer and not for a file that
 * goes to a client.
 */
import { buildXlsx } from './xlsx.js';

export type Cell = string | number | null | undefined;
export type Sheet = { name: string; rows: Cell[][] };

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadXlsx(sheets: Sheet[], filename: string) {
  const bytes = buildXlsx(sheets);
  save(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

export function downloadCsv(rows: Cell[][], filename: string) {
  const cell = (v: Cell) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // The BOM is what makes Excel read this as UTF-8 instead of mangling accents.
  const body = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  save(new Blob([body], { type: 'text/csv;charset=utf-8' }), filename);
}

/**
 * PDF via the browser's print pipeline — "Save as PDF" in the print dialog.
 *
 * This prints the live DOM, so charts appear exactly as drawn. A canvas capture
 * library would not reproduce the SVG any better and would cost a dependency.
 * The `printing` class on <html> lets the print stylesheet strip the shell.
 */
export function printToPdf(scopeEl?: HTMLElement | null) {
  const root = document.documentElement;
  if (scopeEl) scopeEl.setAttribute('data-print-scope', '');
  root.classList.add('printing');

  const cleanup = () => {
    root.classList.remove('printing');
    if (scopeEl) scopeEl.removeAttribute('data-print-scope');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Let the class apply before the dialog snapshots the page.
  setTimeout(() => window.print(), 60);
  // Safety net: some browsers never fire afterprint if the dialog is dismissed.
  setTimeout(cleanup, 60_000);
}

/** `smr-orders-2026-08-03.xlsx` — sorts chronologically, no spaces to quote. */
export const stamped = (base: string, ext: string): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${base}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
};
