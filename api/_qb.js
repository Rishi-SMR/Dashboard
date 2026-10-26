// SMR ⇄ QuickBooks Online — OAuth 2.0 + the Profit & Loss report (read-only).
// Env (striven-server/.env locally, Vercel env vars in prod):
//   QB_ENV=sandbox|production    QB_CLIENT_ID / QB_CLIENT_SECRET (Intuit app keys)
//   QB_REDIRECT_URI              must EXACTLY match a URI registered on the Intuit app
// Tokens persist in Supabase striven_cache (key 'qb_tokens'). Intuit ROTATES the
// refresh token on every refresh, so the newest pair must always be persisted.
import crypto from 'node:crypto';
import { sbCacheRead, sbCacheWrite, readConfigTable } from './_striven.js';

const QB_OAUTH = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

// Credentials live in the Supabase `app_config` table (same source of truth as
// the Striven creds) — env vars are only a fallback. So QB can be provisioned
// without ever touching the Vercel dashboard.
let _creds = null;
async function qbCreds() {
  if (_creds) return _creds;
  const t = await readConfigTable().catch(() => ({}));
  _creds = {
    id: (t.QB_CLIENT_ID || process.env.QB_CLIENT_ID || '').trim(),
    secret: (t.QB_CLIENT_SECRET || process.env.QB_CLIENT_SECRET || '').trim(),
    redirect: (t.QB_REDIRECT_URI || process.env.QB_REDIRECT_URI || '').trim(),
    env: (t.QB_ENV || process.env.QB_ENV || 'sandbox') === 'production' ? 'production' : 'sandbox',
  };
  return _creds;
}
async function qbEnvName() { return (await qbCreds()).env; }
const baseFor = (env) => (env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
async function basic() { const { id, secret } = await qbCreds(); return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'); }

// Which Intuit environment does this token/realm actually belong to? Intuit's
// authorize endpoint is shared, so a token minted with production keys (or a
// production company) returns 403 ApplicationAuthorizationFailed against the
// sandbox API base and vice-versa. Probe both and report the one that answers.
async function tryCompanyInfo(t, env) {
  try {
    const res = await fetch(`${baseFor(env)}/v3/company/${t.realmId}/companyinfo/${t.realmId}?minorversion=75`, {
      headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function probeEnv(t) {
  for (const env of ['production', 'sandbox']) { if (await tryCompanyInfo(t, env)) return env; }
  return null;
}

let _tok = null; // in-memory copy of the persisted token record

async function readTokens() {
  if (_tok?.refreshToken) return _tok;
  const row = await sbCacheRead('qb_tokens');
  _tok = row?.data ?? null;
  return _tok;
}
async function writeTokens(t) { _tok = t; await sbCacheWrite('qb_tokens', t); }

async function tokenRequest(form) {
  const res = await fetch(QB_OAUTH, {
    method: 'POST',
    headers: { Authorization: await basic(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Intuit token endpoint ${res.status}: ${json.error_description || json.error || 'unknown error'}`);
  return json;
}

// ── OAuth flow ──────────────────────────────────────────────────────────────
export async function qbAuthUrl() {
  const { id, redirect } = await qbCreds();
  if (!id || !redirect) throw new Error('QB_CLIENT_ID / QB_REDIRECT_URI not configured');
  const state = crypto.randomBytes(16).toString('hex');
  await sbCacheWrite('qb_oauth_state', { state });
  const q = new URLSearchParams({ client_id: id, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirect, state });
  return `https://appcenter.intuit.com/connect/oauth2?${q}`;
}

export async function qbCallback(q) {
  const { code, state, realmId } = q;
  if (!code || !realmId) throw new Error('missing code/realmId in callback');
  const saved = (await sbCacheRead('qb_oauth_state'))?.data?.state;
  if (!saved || saved !== state) throw new Error('state mismatch - restart the connect flow');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: (await qbCreds()).redirect });
  await writeTokens({
    realmId: String(realmId),
    env: await qbEnvName(),
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    refreshExpiresAt: Date.now() + (t.x_refresh_token_expires_in ?? 8_640_000) * 1000,
    connectedAt: new Date().toISOString(),
  });
  await sbCacheWrite('qb_oauth_state', {});
  // Detect the real environment for this token/realm and persist it, so all
  // later API calls hit the correct base URL regardless of the configured env.
  const fresh = await readTokens();
  const detected = await probeEnv(fresh);
  if (detected && detected !== fresh.env) await writeTokens({ ...fresh, env: detected });
  return { ok: true, realmId: String(realmId), env: detected ?? fresh.env };
}

async function accessToken() {
  const t = await readTokens();
  if (!t?.refreshToken) throw new Error('QuickBooks not connected - open /api/qb/connect first');
  if (Date.now() < (t.accessExpiresAt ?? 0) - 120_000) return t;
  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
  const next = {
    ...t,
    accessToken: r.access_token,
    refreshToken: r.refresh_token || t.refreshToken,
    accessExpiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
    refreshExpiresAt: Date.now() + (r.x_refresh_token_expires_in ?? 8_640_000) * 1000,
  };
  await writeTokens(next);
  return next;
}

// ── API client ──────────────────────────────────────────────────────────────
export async function qbApi(pathname, { method = 'GET', body } = {}) {
  const t = await accessToken();
  const env = t.env || (await qbCreds()).env;
  const sep = pathname.includes('?') ? '&' : '?';
  const res = await fetch(`${baseFor(env)}/v3/company/${t.realmId}/${pathname}${sep}minorversion=75`, {
    method,
    headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const f = json?.Fault?.Error?.[0];
    throw new Error(`QuickBooks ${res.status}: ${f ? `${f.Message}${f.Detail ? ` - ${f.Detail}` : ''}` : JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

export async function qbStatus() {
  const t0 = await readTokens();
  const cfgEnv = await qbEnvName();
  const configured = Boolean((await qbCreds()).id);
  if (!t0?.refreshToken) return { connected: false, env: cfgEnv, configured };
  let t;
  try { t = await accessToken(); } catch (e) { return { connected: false, env: t0.env ?? cfgEnv, configured, realmId: t0.realmId, error: e.message }; }

  // Try the token's stored env; on failure, probe the other env and persist the
  // one that works — so an env mismatch self-heals without a reconnect.
  let env = t.env || cfgEnv;
  let info = await tryCompanyInfo(t, env);
  if (!info) {
    const detected = await probeEnv(t);
    if (detected) { env = detected; await writeTokens({ ...t, env }); info = await tryCompanyInfo(t, env); }
  }
  if (!info) {
    return { connected: false, env, configured, realmId: t.realmId,
      error: 'ApplicationAuthorizationFailed - this token works with neither the sandbox nor the production API. Confirm the app keys (Development vs Production) match the company you authorized.' };
  }
  const c = info.CompanyInfo ?? {};
  return { connected: true, env, configured, realmId: t.realmId, company: c.CompanyName || c.LegalName || '', country: c.Country || '', connectedAt: t.connectedAt ?? null };
}

export async function qbDisconnect() {
  const t = await readTokens();
  if (t?.refreshToken) {
    await fetch(QB_REVOKE, {
      method: 'POST',
      headers: { Authorization: await basic(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.refreshToken }),
    }).catch(() => {});
  }
  await writeTokens(null);
  return { ok: true };
}

/**
 * ── PROFIT & LOSS, STRAIGHT FROM THE BOOKS ───────────────────────────────────
 *
 * The P&L tab computes its figures from Striven invoices and bills. That is an
 * OPERATIONAL view — what was sold and what was ordered — and it is not what the
 * accountant closes the year on. This reads the same statement from QuickBooks,
 * which is the system of record.
 *
 * QuickBooks answers with a nested report, not a total: Sections contain Rows
 * contain Sections, to arbitrary depth, and each level carries its own Summary.
 * The shape also differs per company, because it follows that company's own
 * chart of accounts — Sports Med Recovery has "Contract labor" and "Direct
 * supplies & materials" where another would have neither. So the sections are
 * found BY NAME from the summary rows QuickBooks itself labels, and the leaf
 * accounts are flattened for display rather than hard-coded.
 *
 * THE NUMBERS WILL NOT MATCH THE STRIVEN TAB, and the caller is told so rather
 * than left to discover it: `coverage` reports how much of the Striven book has
 * actually been posted into QuickBooks. Today that is 1 invoice of 171, which is
 * why the books show a large loss — the costs are entered but the revenue is
 * not. A P&L is only as complete as what has been posted to it.
 */
const plNum = (v) => {
  const n = Number(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Depth-first walk yielding every row with its label, value and depth. */
function plFlatten(rows, depth = 0, out = []) {
  for (const row of (rows?.Row ?? [])) {
    const cd = row.ColData ?? row.Summary?.ColData ?? null;
    const label = String(cd?.[0]?.value ?? row.group ?? '').trim();
    if (label) {
      out.push({
        label,
        value: plNum(cd?.[1]?.value),
        depth,
        // A Section's own line is its SUBTOTAL; a Data row is a real account.
        // Summing without this distinction double-counts every group.
        isTotal: row.type === 'Section' || Boolean(row.Summary),
        group: row.group ?? '',
      });
    }
    if (row.Rows) plFlatten(row.Rows, depth + 1, out);
  }
  return out;
}

/**
 * The money a section's subtotal claims that its named children do not account
 * for — one synthetic row per section that fails to add up.
 *
 * Returns `[{ label: '<section> (not itemised)', value, depth }]`. Recurses, so
 * a shortfall is attributed to the DEEPEST section that owns it: "Wages", not
 * "Payroll expenses" above it, which is the level a bookkeeper would go and fix.
 *
 * Only POSITIVE shortfalls are emitted. A section whose children exceed its
 * subtotal is a different fault — usually a sign the report was misread — and
 * inventing a negative row would paper over it; it is left to show up as a
 * reconciliation failure rather than be quietly balanced away.
 */
function plUnitemised(rows, depth = 0, out = []) {
  for (const row of (rows?.Row ?? [])) {
    const kids = row.Rows?.Row ?? [];
    if (!kids.length) continue;
    const summary = row.Summary?.ColData;
    if (summary) {
      // What the children actually account for: a child's own line if it has
      // one, otherwise that child's subtotal.
      const accounted = kids.reduce((s, k) => {
        const cd = k.ColData ?? k.Summary?.ColData;
        return s + plNum(cd?.[1]?.value);
      }, 0);
      const gap = plNum(summary[1]?.value) - accounted;
      if (gap > 0.005) {
        const name = String(summary[0]?.value ?? '').replace(/^Total\s+/i, '').trim() || 'Unnamed';
        out.push({ label: `${name} (not itemised)`, value: Math.round(gap * 100) / 100, depth: depth + 1 });
      }
    }
    plUnitemised(row.Rows, depth + 1, out);
  }
  return out;
}

/**
 * EXPENSES BY CATEGORY — grouped the way the chart of accounts groups them.
 *
 * The breakdown was a flat list of leaf accounts, which put "Direct supplies &
 * materials" ($185,059) beside "Bank and credit card fees" ($14) with nothing to
 * say that one is cost of goods and the other is a rounding error in office
 * overhead. Worse, it scattered payroll: three named people appeared as three
 * unrelated lines while the category they belong to — Payroll expenses, the
 * largest cost in the business at $203,848 — appeared nowhere at all.
 *
 * The CATEGORY is the top level under Cost of Goods Sold / Expenses, which is
 * exactly the level QuickBooks subtotals at:
 *
 *   Cost of goods sold      185,059.53   <- category (a Section)
 *   Payroll expenses        203,848.72   <- category (a Section)
 *     Wages -> Alle Ann Dubberley, Cassie Wates, Jillian Colin
 *   Office expenses            411.98    <- category (a bare Data row, its own)
 *
 * A direct Data child IS its own category; there is no group above it and
 * inventing one ("Other") would be a category this company does not have.
 *
 * EVERY CATEGORY'S ACCOUNTS SUM TO ITS SUBTOTAL, because the unitemised
 * remainder is carried down with them — see plUnitemised. So the drill reconciles
 * at both levels: accounts to category, categories to total expenses.
 */
export function plExpenseCategories(rows) {
  const out = [];
  const clean = (s) => String(s ?? '').replace(/^Total\s+/i, '').trim();

  /** Leaves under one subtree, plus any money its subtotals do not itemise. */
  const leavesOf = (node) => {
    const leaves = [];
    const walk = (n) => {
      for (const row of (n?.Row ?? [])) {
        if (!row.Rows && row.ColData) {
          const label = String(row.ColData[0]?.value ?? '').trim();
          const value = plNum(row.ColData[1]?.value);
          if (label && value !== 0) leaves.push({ label, value });
        }
        if (row.Rows) walk(row.Rows);
      }
    };
    walk(node);
    return leaves;
  };

  for (const top of (rows?.Row ?? [])) {
    if (top.group !== 'COGS' && top.group !== 'Expenses') continue;
    // WHICH SIDE OF THE STATEMENT THIS CATEGORY SITS ON. Without it a reader of
    // the list cannot tell cost of goods from overhead, and the statement can
    // only show cost as one lump — the exact thing splitting COGS out fixed.
    const section = top.group === 'COGS' ? 'cogs' : 'opex';
    for (const child of (top.Rows?.Row ?? [])) {
      if (child.Rows) {
        const total = plNum(child.Summary?.ColData?.[1]?.value);
        const accounts = [...leavesOf(child.Rows), ...plUnitemised({ Row: [child] })
          .map(({ label, value }) => ({ label, value }))];
        out.push({ category: clean(child.Summary?.ColData?.[0]?.value), section, total, accounts });
      } else if (child.ColData) {
        // A bare account at the top level: it is its own category.
        const label = String(child.ColData[0]?.value ?? '').trim();
        const value = plNum(child.ColData[1]?.value);
        if (label) out.push({ category: label, section, total: value, accounts: [{ label, value }] });
      }
    }
  }
  return out.sort((a, b) => b.total - a.total);
}

/** Find one group's ColData anywhere in the tree, at any depth. */
function plFindGroup(rows, group) {
  for (const row of (rows?.Row ?? [])) {
    if (row.group === group) {
      const cd = row.Summary?.ColData ?? row.ColData;
      if (cd) return cd;
    }
    if (row.Rows) { const hit = plFindGroup(row.Rows, group); if (hit) return hit; }
  }
  return null;
}

/**
 * The same statement, one column per month — for the trend chart.
 *
 * A SECOND REQUEST, not a re-slice of the first: QuickBooks decides the column
 * set server-side from `summarize_column_by`, and the totals-only report simply
 * does not carry per-month figures to derive. Column titles come back as
 * "Jan 2026" and, for the running month, "Aug 1-25, 2026" — parsed to a
 * YYYY-MM key so the chart's month axis matches every other series in the app.
 */
async function qbMonthlySeries(startDate, endDate, basis) {
  const r = await qbApi(`reports/ProfitAndLoss?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&accounting_method=${encodeURIComponent(basis)}&summarize_column_by=Month`);
  const cols = (r.Columns?.Column ?? []).map((c) => String(c.ColTitle ?? ''));
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // "Aug 1-25, 2026" and "Aug 2026" both reduce to 2026-08.
  const keyOf = (title) => {
    const m = /^([A-Za-z]{3})[^,]*,?\s*(\d{4})$/.exec(title.trim());
    if (!m) return null;
    const i = MON.indexOf(m[1].toLowerCase());
    return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  };
  const pick = (group) => plFindGroup(r.Rows, group) ?? [];
  const inc = pick('Income'); const cogs = pick('COGS'); const exp = pick('Expenses'); const net = pick('NetIncome');
  const otherInc = pick('OtherIncome'); const otherExp = pick('OtherExpenses');
  const out = [];
  for (let i = 1; i < cols.length; i += 1) {
    const month = keyOf(cols[i]);
    if (!month) continue;                       // skips the trailing "Total" column
    const revenue = plNum(inc[i]?.value);
    const cogsM = plNum(cogs[i]?.value);
    const opex = plNum(exp[i]?.value);
    // Other income / other expenses sit BELOW net operating income; carried
    // separately so the month's columns add across to its net income.
    const other = plNum(otherInc[i]?.value) - plNum(otherExp[i]?.value);
    const expenses = cogsM + opex;
    out.push({
      month, revenue, cogs: cogsM, grossProfit: revenue - cogsM, opex, other, expenses,
      net: net[i] ? plNum(net[i].value) : revenue - expenses + other,
    });
  }
  return out;
}

export async function qbProfitAndLoss({ start, end, basis = 'Accrual' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = start || `${today.slice(0, 4)}-01-01`;
  const endDate = end || today;
  const [r, series] = await Promise.all([
    qbApi(`reports/ProfitAndLoss?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&accounting_method=${encodeURIComponent(basis)}`),
    qbMonthlySeries(startDate, endDate, basis).catch(() => []),
  ]);
  const flat = plFlatten(r.Rows);

  // QuickBooks tags its own summary rows with a `group`, which is stable across
  // charts of accounts even when the visible labels are not — so the headline
  // figures are read from those rather than by matching on English text.
  const byGroup = (g) => flat.find((x) => x.group === g && x.isTotal)?.value ?? null;
  const income = byGroup('Income');
  const cogs = byGroup('COGS');
  const grossProfit = byGroup('GrossProfit');
  const expenses = byGroup('Expenses');
  const netIncome = byGroup('NetIncome');
  const netOperating = byGroup('NetOperatingIncome');
  const otherIncome = byGroup('OtherIncome');
  const otherExpenses = byGroup('OtherExpenses');

  // The leaf accounts, for the breakdown table: real accounts only, never the
  // subtotals — otherwise a group and its children both appear and the column
  // adds to twice the truth.
  //
  // PLUS THE MONEY THAT HAS NO LEAF. A QuickBooks section's subtotal does not
  // have to equal its named children: an amount posted directly to a PARENT
  // account shows in the subtotal and appears nowhere below it. Sports Med
  // Recovery's books do exactly that today —
  //
  //     Total Wages          372,341.27
  //       Alle Ann Dubberley  52,671.27
  //       Cassie Wates         7,025.00
  //       Christy Tan         31,825.00
  //       Jillian Colin       14,604.49   → children sum to 106,125.76
  //
  // leaving $266,215.51 with no row of its own. Listing only the leaves and
  // printing the true total beneath them produced a breakdown that visibly did
  // not add up, which reads as a broken page rather than as an incompletely
  // itemised ledger. `plUnitemised` walks the tree and names that remainder
  // against the section it belongs to, so the column always reconciles to the
  // total and the reader can see WHERE the unnamed money sits.
  const accounts = [
    ...flat.filter((x) => !x.isTotal && x.value !== 0).map(({ label, value, depth }) => ({ label, value, depth })),
    ...plUnitemised(r.Rows),
  ].sort((a, b) => b.value - a.value);

  return {
    ok: true,
    source: 'quickbooks',
    company: r.Header?.ReportName ? undefined : undefined,
    basis: r.Header?.ReportBasis ?? basis,
    currency: r.Header?.Currency ?? 'USD',
    periodFrom: r.Header?.StartPeriod ?? startDate,
    periodTo: r.Header?.EndPeriod ?? endDate,
    generatedAt: r.Header?.Time ?? null,
    income, cogs, grossProfit, expenses, netOperating, netIncome,
    /** Expenses grouped as the chart of accounts groups them — the level
     *  QuickBooks subtotals at. See plExpenseCategories. */
    /** Sales by income account — see plIncomeAccounts. */
    incomeAccounts: plIncomeAccounts(r.Rows),
    categories: plExpenseCategories(r.Rows),
    /** Below the operating line: other income and other expenses, by account.
     *  Null/empty when the company has none in the period. */
    otherIncome, otherExpenses,
    otherIncomeAccounts: plIncomeAccounts(r.Rows, 'OtherIncome'),
    otherExpenseAccounts: plIncomeAccounts(r.Rows, 'OtherExpenses'),
    /** One point per month, for the trend chart. Empty if QuickBooks refused
     *  the monthly variant — the headline figures still stand without it. */
    series,
    /** Income − (COGS + Expenses). Recomputed rather than trusted, so a chart of
     *  accounts that omits one of the summary rows still yields a net. */
    net: netIncome ?? ((income ?? 0) - ((cogs ?? 0) + (expenses ?? 0))),
    margin: income ? ((netIncome ?? 0) / income) * 100 : 0,
    accounts,
    rows: flat,
  };
}

/**
 * SALES, ACCOUNT BY ACCOUNT — the leaf accounts under QuickBooks' Income
 * section, plus any money a parent account carries that its children do not
 * itemise (see plUnitemised), so the lines always add to total income.
 * `group` reads another top-level section the same way (OtherIncome,
 * OtherExpenses).
 */
export function plIncomeAccounts(rows, group = 'Income') {
  const income = (rows?.Row ?? []).find((r) => r.group === group);
  if (!income) return [];
  const out = [];
  const walk = (n) => {
    for (const row of (n?.Row ?? [])) {
      if (!row.Rows && row.ColData) {
        const label = String(row.ColData[0]?.value ?? '').trim();
        const value = plNum(row.ColData[1]?.value);
        if (label && value !== 0) out.push({ name: label, value: Math.round(value * 100) / 100 });
      }
      if (row.Rows) walk(row.Rows);
    }
  };
  walk(income.Rows);
  for (const u of plUnitemised({ Row: [income] })) out.push({ name: u.label, value: u.value });
  return out.sort((a, b) => b.value - a.value);
}

/**
 * ── MONEY RECEIVED IN THE BANK, STRAIGHT FROM THE BOOKS (26 Oct 2026) ─────────
 *
 * Cash Received used Striven's customer-payment records, which are not the
 * bank: a Lienstar wire or a distributor payout lands in the account whether or
 * not anyone applied it to an invoice in Striven. This reads QuickBooks' General
 * Ledger for every BANK-type account and keeps the money coming IN — deposits,
 * received payments, sales receipts, anything that raised a bank balance.
 *
 * TRANSFERS ARE LEFT OUT: money moved between SMR's own accounts raises one
 * balance and lowers another, and counting it would report SMR paying itself.
 * They are totalled separately so the card can say what it excluded.
 *
 * Each line is named by its QuickBooks payee where the books have one, else by
 * the bank's own description with the wire/ACH boilerplate stripped
 * ("INCOMING WIRE TRANSFER LIENSTAR …" → "LIENSTAR").
 */
const BOILER = /\s+(incoming|wire|transfer|payroll|ach|misc|pay|quickbooks|distributor|payout|smr|xx\S*|\d{4,}\S*)\b.*$/i;
const sourceOf = (name, memo) => {
  if (String(name || '').trim()) return String(name).trim();
  const m = String(memo || '').replace(/\s+/g, ' ').trim()
    .replace(/^(incoming wire transfer|wire transfer|ach credit|ach|deposit|mobile deposit|remote deposit)\s+/i, '')
    .replace(BOILER, '').trim();
  const t = m.split(' ').slice(0, 3).join(' ');
  // Bank descriptions are SHOUTED; a payee name reads better in title case.
  return t ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : 'Unnamed deposit';
};
/** One payer however the bank spelled it: "Hi-Dow International Incorporated",
 *  "HI-DOW INTERNATI…" and "Hi Dow International" all key to "hidowi". */
const sourceKey = (src) => String(src || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'unnamed';
/** Borrowed money is not money received from customers. */
const isLoan = (d) => /\bloan\b/i.test(`${d.name} ${d.memo}`);

export async function qbBankDeposits({ start, end } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(start ?? '')) ? start : `${today.slice(0, 4)}-01-01`;
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(end ?? '')) ? end : today;
  const acc = await qbApi(`query?query=${encodeURIComponent("select Id, Name from Account where AccountType = 'Bank'")}`);
  const banks = acc.QueryResponse?.Account ?? [];
  if (!banks.length) return { ok: true, accounts: [], total: 0, count: 0, byMonth: [], bySource: [], deposits: [], transfersExcluded: 0, loansExcluded: 0, loans: [] };
  const gl = await qbApi(`reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account=${banks.map((a) => a.Id).join(',')}&columns=tx_date,txn_type,doc_num,name,memo,account_name,subt_nat_amount`);
  const cols = (gl.Columns?.Column ?? []).map((c) => String(c.MetaData?.find((m) => m.Name === 'ColKey')?.Value ?? c.ColTitle ?? ''));
  const at = (key, title) => { const i = cols.findIndex((c) => c === key || c.toLowerCase() === title); return i; };
  const iDate = at('tx_date', 'date'), iType = at('txn_type', 'transaction type'), iName = at('name', 'name'),
    iMemo = at('memo', 'memo/description'), iAcct = at('account_name', 'account'), iAmt = at('subt_nat_amount', 'amount');
  const deposits = [];
  let transfersExcluded = 0;
  const loans = [];
  const walk = (node) => {
    for (const r of node?.Row ?? []) {
      if (r.ColData) {
        const v = (i) => (i >= 0 ? String(r.ColData[i]?.value ?? '') : '');
        const date = v(iDate);
        const amount = plNum(v(iAmt));
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount > 0.005) {
          const type = v(iType);
          const d = { date, type, name: v(iName), memo: v(iMemo), account: v(iAcct), amount: Math.round(amount * 100) / 100, source: sourceOf(v(iName), v(iMemo)) };
          if (/^transfer$/i.test(type)) transfersExcluded = Math.round((transfersExcluded + amount) * 100) / 100;
          else if (isLoan(d)) loans.push(d);
          else deposits.push(d);
        }
      }
      if (r.Rows) walk(r.Rows);
    }
  };
  walk(gl.Rows);
  deposits.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const r2 = (n) => Math.round(n * 100) / 100;
  const group = (keyOf) => {
    const m = new Map();
    for (const d of deposits) { const k = keyOf(d); const e = m.get(k) ?? { amount: 0, count: 0 }; e.amount = r2(e.amount + d.amount); e.count += 1; m.set(k, e); }
    return m;
  };
  return {
    ok: true, periodFrom: startDate, periodTo: endDate,
    accounts: banks.map((a) => a.Name),
    total: r2(deposits.reduce((s, d) => s + d.amount, 0)), count: deposits.length,
    byMonth: [...group((d) => d.date.slice(0, 7))].map(([month, e]) => ({ month, ...e })).sort((a, b) => a.month.localeCompare(b.month)),
    // Grouped by payer key; named by the payee QuickBooks records, else the
    // first spelling seen.
    bySource: [...group((d) => sourceKey(d.source))].map(([k, e]) => {
      const named = deposits.find((d) => sourceKey(d.source) === k && d.name) ?? deposits.find((d) => sourceKey(d.source) === k);
      return { name: named?.source ?? k, ...e };
    }).sort((a, b) => b.amount - a.amount),
    deposits, transfersExcluded,
    /** Loan proceeds into the bank — real money in, but borrowed, so not
     *  counted as received; listed so the card can say so. */
    loansExcluded: r2(loans.reduce((s, d) => s + d.amount, 0)), loans,
  };
}

/**
 * Only the read side is routed. QuickBooks is the books; the portal reads its
 * statement and never writes into it.
 */
export async function qbHandle(pathname, q) {
  if (pathname === '/api/qb/pl') return { json: await qbProfitAndLoss({ start: q.start, end: q.end, basis: q.basis }) };
  if (pathname === '/api/qb/bank-deposits') return { json: await qbBankDeposits({ start: q.start, end: q.end }) };
  if (pathname === '/api/qb/status') return { json: await qbStatus() };
  if (pathname === '/api/qb/connect') return { redirect: await qbAuthUrl() };
  if (pathname === '/api/qb/disconnect') return { json: await qbDisconnect() };
  if (pathname === '/api/qb/callback') {
    try { await qbCallback(q); return { redirect: '/?qb=connected#pl' }; }
    catch (e) { return { redirect: `/?qb=error&reason=${encodeURIComponent(e.message)}#pl` }; }
  }
  return null;
}
