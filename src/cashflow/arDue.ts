import { programOfPayer } from './chartTheme';
import type { PiLienstar, VaRemittances } from './strivenApi';

/**
 * AR DUE — THE ONE RECEIVABLE FIGURE (5 Oct 2026, on request).
 *
 * Every screen that states what is owed to us reads it from here, so the
 * Overview's AR Due / AR Expected / Open Balances / Collection Rate and the
 * Receivables tab's AR Open cannot disagree. Each programme is judged by the
 * book that is the authority on it, and nothing is counted twice:
 *
 *   PI      invoiced in Striven − funded by Lienstar (Master File, Approved)
 *   VA      invoiced in Striven − remitted by the distributors (Master File)
 *   others  the Striven ledger's open balance (TriCare, DOL, unassigned, …)
 *
 * The ledger's own PI and VA balances are NOT added: those invoices are already
 * in the first two lines, judged against the money that actually arrived.
 *
 * `prog` narrows it the way the Overview's Program filter does: PI or VA alone
 * keeps that programme's line; the ledger part is whatever `ledgerInvoices`
 * the caller has already cut to the filter.
 */
export type ArDueParts = {
  pi: number; piCount: number;
  va: number; vaCount: number;
  other: number; otherCount: number;
  total: number;
  /** False while the Master File comparisons have not arrived (or failed). */
  piReady: boolean; vaReady: boolean;
};

type LedgerInvoice = { open: number; vertical?: string; payer?: string | null };

export function arDueParts(
  pi: PiLienstar | null | undefined,
  va: VaRemittances | null | undefined,
  ledgerInvoices: LedgerInvoice[],
  prog: string = 'All',
): ArDueParts {
  const recvPi = pi?.ok ? pi.receivable ?? null : null;
  const recvVa = va?.ok ? va.receivable ?? null : null;
  const usePi = prog === 'All' || prog === 'PI';
  const useVa = prog === 'All' || prog === 'VA';
  const progOf = (i: LedgerInvoice) => i.vertical || programOfPayer(i.payer);
  const other = ledgerInvoices.filter((i) => i.open > 0 && !['PI', 'VA'].includes(progOf(i)));
  const piAmt = usePi ? recvPi?.outstanding ?? 0 : 0;
  const vaAmt = useVa ? recvVa?.outstanding ?? 0 : 0;
  const otherAmt = other.reduce((s, i) => s + i.open, 0);
  return {
    pi: piAmt, piCount: usePi ? recvPi?.count ?? 0 : 0,
    va: vaAmt, vaCount: useVa ? recvVa?.count ?? 0 : 0,
    other: otherAmt, otherCount: other.length,
    total: piAmt + vaAmt + otherAmt,
    piReady: Boolean(recvPi), vaReady: Boolean(recvVa),
  };
}

/** One item of AR Due, with what is still owed on it and when it fell due. */
export type ArDueItem = { kind: 'PI' | 'VA' | 'Other'; label: string; ref: string; soId: string; dueDate: string; amount: number; days: number };
export type ArDueBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';
export const AR_DUE_BUCKETS: { key: ArDueBucket; label: string }[] = [
  { key: 'current', label: 'Current (not due)' }, { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' }, { key: 'd61_90', label: '61–90 days' }, { key: 'd90plus', label: '90+ days' },
];

/**
 * AR DUE, AGED BY DAYS PAST DUE — built from the SAME items arDueParts() sums,
 * so the buckets always add back to AR Due exactly:
 *   PI     each order invoiced and not yet funded, at its invoice's due date
 *   VA     each order invoiced and not yet remitted, at its invoice's due date
 *          (the order date where no invoice joins)
 *   Other  each open Striven ledger invoice of another programme
 */
export function arDueAging(
  pi: PiLienstar | null | undefined,
  va: VaRemittances | null | undefined,
  ledgerInvoices: (LedgerInvoice & { number?: string; dueDate?: string | null; payer?: string | null })[],
  refMs: number,
  prog: string = 'All',
): { items: ArDueItem[]; buckets: Record<ArDueBucket, number>; total: number } {
  const daysPast = (d: string) => (d ? Math.floor((refMs - new Date(`${d.slice(0, 10)}T00:00:00`).getTime()) / 86_400_000) : 0);
  const items: ArDueItem[] = [];
  if (pi?.ok && (prog === 'All' || prog === 'PI')) {
    for (const r of pi.receivable?.rows ?? []) {
      items.push({ kind: 'PI', label: r.patient, ref: r.ref, soId: r.soId, dueDate: r.dueDate ?? '', amount: r.outstanding, days: daysPast(r.dueDate ?? '') });
    }
  }
  if (va?.ok && (prog === 'All' || prog === 'VA')) {
    for (const r of va.receivable?.rows ?? []) {
      for (const o of r.orders) {
        const owed = Math.round(((o.invoiced ?? 0) - (o.remitted ?? 0)) * 100) / 100;
        if (owed <= 0.005) continue;
        const due = o.dueDate ?? o.date ?? '';
        items.push({ kind: 'VA', label: r.patient, ref: o.ref, soId: o.soId, dueDate: due, amount: owed, days: daysPast(due) });
      }
    }
  }
  const progOf = (i: LedgerInvoice) => i.vertical || programOfPayer(i.payer);
  for (const i of ledgerInvoices) {
    if (!(i.open > 0) || ['PI', 'VA'].includes(progOf(i))) continue;
    const due = String(i.dueDate ?? '').slice(0, 10);
    items.push({ kind: 'Other', label: i.payer || '-', ref: i.number ? `#${i.number}` : '', soId: '', dueDate: due, amount: i.open, days: daysPast(due) });
  }
  const buckets: Record<ArDueBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const it of items) {
    const k: ArDueBucket = it.days <= 0 ? 'current' : it.days <= 30 ? 'd1_30' : it.days <= 60 ? 'd31_60' : it.days <= 90 ? 'd61_90' : 'd90plus';
    buckets[k] += it.amount;
  }
  return { items: items.sort((a, b) => b.days - a.days || b.amount - a.amount), buckets, total: items.reduce((s, x) => s + x.amount, 0) };
}
