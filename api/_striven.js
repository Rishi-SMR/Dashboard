// SMR ⇄ Striven — shared server logic (single source of truth).
// Used by BOTH the local dev server (striven-server/index.js) and the Vercel
// serverless function (api/[...path].js). It holds the Striven credentials and
// NEVER sends them to the browser — the frontend only ever calls /api/*.
//
// Credentials come from environment variables:
//   - Locally: striven-server/.env (loaded below).
//   - On Vercel: Project → Settings → Environment Variables.
// Exposes ROUTES (exact paths), DYNAMIC (regex paths), and the auth constants.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PO_STATUS } from './po-status.js';
import { INVOICE_STATUS } from './invoice-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config -------------------------------------------------------------
// Local convenience: load striven-server/.env if present. On Vercel this file
// doesn't exist (gitignored) — the platform injects the vars into process.env.
function loadEnv() {
  for (const p of [path.join(__dirname, '..', 'striven-server', '.env'), path.join(__dirname, '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const MASK_PHI = (process.env.MASK_PHI ?? 'true') !== 'false';

// ---- credential resolution (env → Supabase Vault) -----------------------
// Creds resolve lazily & are cached. Priority:
//   1. Environment variables (local striven-server/.env, or Vercel env vars).
//   2. Supabase Vault — read over the Postgres connection the Vercel↔Supabase
//      integration injects as POSTGRES_URL. So you can keep secrets in Supabase
//      and Vercel just reads them; no per-secret env vars needed on Vercel.
let _cfg = null;
async function readVault(names) {
  const conn = process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING
    || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_PRISMA_URL;
  if (!conn) return {};
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(
      'select name, decrypted_secret from vault.decrypted_secrets where name = any($1::text[])',
      [names],
    );
    const out = {};
    for (const r of rows) out[r.name] = r.decrypted_secret;
    return out;
  } finally { await client.end().catch(() => {}); }
}
// APP_USERS: JSON [{u,p},…] or compact "user:pass,user:pass". Username match is
// case-insensitive and tolerant of a trailing ".com".
function parseUsers(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map((x) => ({ u: String(x.u ?? x.username ?? ''), p: String(x.p ?? x.password ?? '') })).filter((x) => x.u && x.p); } catch { /* not JSON */ }
  return s.split(',').map((pair) => { const i = pair.indexOf(':'); return i < 0 ? null : { u: pair.slice(0, i).trim(), p: pair.slice(i + 1).trim() }; }).filter((x) => x && x.u && x.p);
}
const normUser = (s) => String(s ?? '').trim().toLowerCase().replace(/\.com$/, '');

// Login users live in the Supabase `dashboard_users` table (username, password) —
// the human-editable source of truth. Read over PostgREST with the service-role
// key (RLS keeps the table private to the server). Falls back to the APP_USERS
// env var if the table is empty/unreachable, so login never breaks.
let _usersCache = { at: 0, users: null };
async function readUsersTable() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_REST_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/dashboard_users?select=username,password`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({ u: String(r.username ?? ''), p: String(r.password ?? '') })).filter((x) => x.u && x.p);
  } catch { return null; }
}
async function resolveUsers(envAppUsers) {
  const now = Date.now();
  if (_usersCache.users && now - _usersCache.at < 60_000) return _usersCache.users;
  const fromTable = await readUsersTable();
  const users = fromTable && fromTable.length ? fromTable : parseUsers(envAppUsers);
  _usersCache = { at: now, users };
  return users;
}

const SB_URL = () => (process.env.SUPABASE_URL || process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SB_KEY = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// Striven creds + access password live in the Supabase `app_config` table (key,value).
async function readConfigTable() {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key) return {};
  try {
    const res = await fetch(`${url}/rest/v1/app_config?select=key,value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) return {};
    const rows = await res.json();
    if (!Array.isArray(rows)) return {};
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch { return {}; }
}
// Audit every login attempt into the Supabase `login_events` table (best-effort).
async function logLoginEvent(username, success, ip) {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch(`${url}/rest/v1/login_events`, {
      method: 'POST', signal: ctrl.signal,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ username: String(username ?? '').slice(0, 200), success: !!success, ip: ip ? String(ip).slice(0, 100) : null }),
    });
    clearTimeout(t);
  } catch { /* audit is best-effort — never block or break login */ }
}

// Static config (Striven creds + access password) — resolved once and cached.
async function getStatic() {
  if (_cfg) return _cfg;
  _cfg = (async () => {
    const t = await readConfigTable();   // Supabase app_config = source of truth
    let clientId = t.STRIVEN_CLIENT_ID || process.env.STRIVEN_CLIENT_ID || '';
    let clientSecret = t.STRIVEN_CLIENT_SECRET || process.env.STRIVEN_CLIENT_SECRET || '';
    let accessPw = t.ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || '';
    let appUsers = process.env.APP_USERS || '';
    if (!clientId || !clientSecret) {
      try {
        const v = await readVault(['STRIVEN_CLIENT_ID', 'STRIVEN_CLIENT_SECRET', 'ACCESS_PASSWORD', 'APP_USERS']);
        clientId = clientId || v.STRIVEN_CLIENT_ID || '';
        clientSecret = clientSecret || v.STRIVEN_CLIENT_SECRET || '';
        accessPw = accessPw || v.ACCESS_PASSWORD || '';
        appUsers = appUsers || v.APP_USERS || '';
      } catch (e) { console.error('[config] Supabase Vault read failed:', e.message); }
    }
    return { clientId, clientSecret, accessPw, appUsers };
  })();
  return _cfg;
}
async function getConfig() {
  const s = await getStatic();
  const users = await resolveUsers(s.appUsers);          // live from the table (60s cache)
  const gateEnabled = users.length > 0 || Boolean(s.accessPw);
  const basis = users.length ? JSON.stringify(users.map((u) => u.u).sort()) + s.accessPw : s.accessPw;
  const sessionToken = gateEnabled ? crypto.createHash('sha256').update(`${basis}::smr-session`).digest('hex') : '';
  return { clientId: s.clientId, clientSecret: s.clientSecret, accessPw: s.accessPw, users, gateEnabled, sessionToken };
}
// Gate info for the request handlers.
export async function getAuth() {
  const { gateEnabled, sessionToken } = await getConfig();
  return { gateEnabled, sessionToken };
}
// Validate a login (username + password, or password-only fallback). → { ok, sessionToken }.
// Every attempt is recorded in the Supabase `login_events` audit table.
export async function login(username, password, meta = {}) {
  const { users, accessPw, sessionToken } = await getConfig();
  const pw = String(password ?? '');
  let ok = false;
  if (users.length) ok = users.some((x) => normUser(x.u) === normUser(username) && x.p === pw);
  else if (accessPw) ok = pw === accessPw;
  await logLoginEvent(username, ok, meta.ip);
  return { ok, sessionToken };
}

const BASE = 'https://api.striven.com';
// Striven sits behind Cloudflare, which returns "Error 1010 / Access denied" to
// non-browser User-Agents. A normal browser UA is required on every call.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- token manager ------------------------------------------------------
let tokenCache = { token: null, expiresAt: 0 };
async function getToken(force = false) {
  const now = Date.now();
  if (!force && tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;
  const { clientId, clientSecret } = await getConfig();
  if (!clientId || !clientSecret) throw new Error('Striven credentials not configured (env vars or Supabase Vault).');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const res = await fetch(`${BASE}/accesstoken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`Striven token request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 - 60_000 };
  return tokenCache.token;
}

async function striven(method, endpoint, jsonBody) {
  const doCall = async () => {
    const token = await getToken();
    return fetch(`${BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/json',
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    });
  };
  let res = await doCall();
  if (res.status === 401) { await getToken(true); res = await doCall(); }
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const waitS = Number(res.headers.get('retry-after')) || 5;
    await new Promise((r) => setTimeout(r, waitS * 1000));
    res = await doCall();
  }
  if (!res.ok) throw new Error(`Striven ${method} ${endpoint} → HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function searchAll(endpoint, filter = {}, cap = 2000) {
  const pageSize = 100;
  let pageIndex = 0;
  const rows = [];
  for (;;) {
    const body = await striven('POST', endpoint, { ...filter, PageIndex: pageIndex, PageSize: pageSize });
    const data = body.data ?? body.Data ?? [];
    rows.push(...data);
    const total = body.totalCount ?? body.TotalCount ?? rows.length;
    pageIndex += 1;
    if (data.length < pageSize || rows.length >= total || rows.length >= cap) break;
  }
  return rows;
}

// ---- cache --------------------------------------------------------------
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 300_000);
const _cache = new Map();
const _inflight = new Map();
function cached(key, fn, ttl = CACHE_TTL) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit.value);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn)
    .then((value) => { _cache.set(key, { value, expiresAt: Date.now() + ttl }); _inflight.delete(key); return value; })
    .catch((e) => { _inflight.delete(key); if (hit) return hit.value; throw e; });
  _inflight.set(key, p);
  return p;
}
const allInvoices = () => cached('invoices', () => searchAll('/v1/invoices/search', {}));
const allBills = () => cached('bills', () => searchAll('/v1/bills/search', {}));
const allSO = () => cached('so', () => searchAll('/v1/sales-orders/search', {}));
const allPO = () => cached('po', () => searchAll('/v1/purchase-orders/search', {}));
const allCustomers = () => cached('customers', () => searchAll('/v1/customers/search', {}));
const allVendors = () => cached('vendors', () => searchAll('/v1/vendors/search', {}));
const allItems = () => cached('items', () => searchAll('/v1/items/search', {}));
const allPayments = () => cached('payments', () => searchAll('/v1/payments/search', {}));
const allBillPayCC = () => cached('billpaycc', () => searchAll('/v2/bill-payment-cc-charges/search', {}));
const allTasks = () => cached('tasks', () => searchAll('/v2/tasks/search', {}));
const allProjects = () => cached('projects', () => searchAll('/v1/projects/search', {}));
const glAccountsRaw = () => cached('gl', async () => { const b = await striven('POST', '/v1/gl-accounts/search', { Active: true }); return b.data ?? b.Data ?? []; });
const companyProfile = () => cached('company', () => striven('GET', '/v1/company/profile'));
const openOnly = (rows) => rows.filter((r) => Number(r.openBalance ?? 0) > 0);
const isVoid = (r) => /cancel|void|denied|rejected|fail/i.test(r?.status?.name || '');
const notVoid = (r) => !isVoid(r);

// The PO *search* endpoint omits `status`, so notVoid() can never exclude
// cancelled POs from it — status is only on the detail endpoint. The shared
// striven() honours Striven's Retry-After (5–30s), which made classifying all
// POs take ~80s. Instead we hit the detail endpoint directly at high concurrency
// with a short fixed back-off: all ~140 statuses classify in ~11s — comfortably
// inside Vercel's 60s limit — so every request returns the COMPLETE, correct set.
// Cached per warm instance for 6h (statuses rarely change).
// PO status comes from a shipped snapshot (PO_STATUS, id -> status). The search
// endpoint omits status and fetching ~140 details live can't finish inside
// Vercel's 60s limit under Striven's rate cap, so we resolve status from the
// baseline instantly. POs created after the snapshot aren't in it → treated as
// active (a brand-new PO is virtually never cancelled). Regenerate the snapshot
// (scripts/gen-po-status) when cancellations change materially.
async function poStatusMap() {
  const list = await allPO();
  return list.map((r) => {
    const known = Object.prototype.hasOwnProperty.call(PO_STATUS, r.id);
    return { ...r, statusName: known ? PO_STATUS[r.id] : '', classified: true, fromSnapshot: known };
  });
}

// ---- helpers ------------------------------------------------------------
const emptyAging = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 });
function bucketAging(rows, dueField, openField) {
  const now = Date.now();
  const a = emptyAging();
  for (const r of rows) {
    const open = Number(r[openField] ?? 0);
    if (!open) continue;
    const due = r[dueField] ? new Date(r[dueField]).getTime() : now;
    const daysPast = Math.floor((now - due) / 86_400_000);
    if (daysPast <= 0) a.current += open;
    else if (daysPast <= 30) a.d1_30 += open;
    else if (daysPast <= 60) a.d31_60 += open;
    else if (daysPast <= 90) a.d61_90 += open;
    else a.d90plus += open;
  }
  return a;
}
const round2 = (n) => Math.round(n * 100) / 100;

function maskName(name, mask = MASK_PHI) {
  if (!name) return '';
  if (!mask) return String(name);
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0][0].toUpperCase() + '.';
  return `${parts[0][0].toUpperCase()}.${parts[parts.length - 1][0].toUpperCase()}.`;
}
const safeRef = (prefix, id, rawNumber) => (MASK_PHI || /[a-zA-Z]/.test(String(rawNumber ?? '')) ? `${prefix}-${id}` : String(rawNumber));

// ---- endpoints ----------------------------------------------------------
async function getStatus() {
  const { clientId, clientSecret } = await getConfig();
  if (!clientId || !clientSecret) return { connected: false, company: null, reason: 'not_configured' };
  // The app's auth check waits on this call, so it must NEVER hang — cap the
  // profile lookup at 4s and fall back to a null company name if Striven is slow.
  const profile = await Promise.race([
    companyProfile().catch(() => null),
    new Promise((res) => setTimeout(() => res(null), 4000)),
  ]);
  return { connected: true, company: profile?.companyName ?? null, subdomain: profile?.subdomain ?? null, currency: null, phiMasked: MASK_PHI };
}
const isVoidStatus = (s) => /cancel|void|denied|rejected|fail/i.test(s || '');
// Invoice status is only on the detail endpoint (search omits it) and fetching
// it live per request times out on Vercel, so voided invoices are resolved from a
// shipped snapshot (INVOICE_STATUS). Invoices missing from it default to active.
async function getAR() {
  const openInv = openOnly(await allInvoices());                          // openBalance > 0
  const statusOf = (r) => INVOICE_STATUS[r.id] ?? '';
  const live = openInv.filter((r) => !isVoidStatus(statusOf(r)));         // drop VOIDED invoices
  const voidedExcluded = round2(openInv.filter((r) => isVoidStatus(statusOf(r))).reduce((s, r) => s + Number(r.openBalance || 0), 0));

  // Unapplied customer credits (payment.openBalance) — money the customer has paid
  // that isn't applied to a specific invoice. Striven nets these against the
  // customer's open invoices in the aging, so we do the same.
  const payments = await allPayments();
  const creditByCust = new Map();
  for (const p of payments) { const c = p.customer?.id; const un = Number(p.openBalance || 0); if (c && un > 0) creditByCust.set(c, (creditByCust.get(c) || 0) + un); }
  const unappliedCredits = round2([...creditByCust.values()].reduce((s, v) => s + v, 0));

  // Net each customer's credit against their open invoices, oldest due first.
  const byCust = new Map();
  for (const r of live) { const c = r.customer?.id ?? 0; if (!byCust.has(c)) byCust.set(c, []); byCust.get(c).push(r); }
  const netRows = [];
  for (const [, invs] of byCust) {
    let credit = creditByCust.get(invs[0].customer?.id) || 0;
    invs.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    for (const r of invs) {
      const open = Number(r.openBalance || 0);
      const applied = Math.min(open, credit); credit -= applied;
      netRows.push({ ...r, netOpen: round2(open - applied) });
    }
  }
  const invoices = netRows.filter((r) => r.netOpen > 0.005).map((r) => ({
    id: r.id, number: r.txnNumber ?? String(r.id),
    customer: maskName(r.customer?.name), customerId: r.customer?.id ?? null,
    dueDate: r.dueDate ?? null, total: Number(r.invoiceTotal ?? 0), open: r.netOpen,
    currency: r.currency?.currencyISOCode ?? 'USD',
  }));
  const totalOpen = round2(invoices.reduce((s, i) => s + i.open, 0));
  const aging = bucketAging(invoices, 'dueDate', 'open');
  for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);
  return {
    totalOpen, count: invoices.length, aging,
    unappliedCredits, voidedExcluded,
    invoices: invoices.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')),
  };
}
async function getAP() {
  const bills = openOnly(await allBills()).filter(notVoid);
  const rows = bills.map((r) => ({
    id: r.id, number: r.number ?? String(r.id),
    vendor: r.vendor?.name ?? '', vendorId: r.vendor?.id ?? null,
    dueDate: r.dueDate ?? null, total: Number(r.totalAmount ?? 0), open: Number(r.openBalance ?? 0),
    currency: r.currency?.currencyISOCode ?? 'USD',
  }));
  const totalOpen = round2(rows.reduce((s, b) => s + b.open, 0));
  const aging = bucketAging(bills, 'dueDate', 'openBalance');
  for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);
  return { totalOpen, count: rows.length, aging, bills: rows.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')) };
}
const ACCT_TYPE = { 1: 'Income', 2: 'Expense', 3: 'Fixed Asset', 4: 'Bank', 5: 'Loan', 6: 'Credit Card', 7: 'Equity', 8: 'Accounts Receivable', 9: 'Accounts Payable', 10: 'COGS', 11: 'Other Asset', 12: 'Other Current Asset', 13: 'Other Current Liability', 14: 'Long Term Liability', 15: 'Other Income', 16: 'Other Expense' };
async function getAccounts() {
  const data = await glAccountsRaw();
  const accounts = data.map((r) => ({
    id: r.id,
    name: r.accountName ?? r.name ?? '',
    extendedName: r.accountExtendedName ?? '',
    type: r.accountType?.name ?? ACCT_TYPE[r.accountType?.id ?? r.accountTypeId] ?? String(r.accountType ?? ''),
    number: r.accountNumber ?? '',
    parent: r.parent?.accountName ?? r.parent?.name ?? '',
    canPost: !(r.doNotAllowPosting ?? false),
    reconcilable: r.isReconcilable ?? false,
    active: r.active ?? true,
  }));
  return {
    count: accounts.length,
    accounts,
    balancesAvailable: false,
    note: "Striven's API does not expose GL account balances — running balances live only inside Striven's Report Builder. Shown here is the complete chart of accounts with every field the API returns.",
  };
}
async function getPL() {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const inYear = (r) => String(r.dateCreated ?? '').slice(0, 10) >= yearStart;
  const inv = (await allInvoices()).filter((r) => inYear(r) && notVoid(r));
  const bills = (await allBills()).filter((r) => inYear(r) && notVoid(r));
  const payments = (await allPayments()).filter((r) => notVoid(r) && String(r.paymentDate ?? r.dateCreated ?? '').slice(0, 10) >= yearStart);

  const revenue = round2(inv.reduce((s, r) => s + Number(r.invoiceTotal ?? 0), 0));
  const expenses = round2(bills.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0));
  const net = round2(revenue - expenses);
  const cashReceived = round2(payments.reduce((s, r) => s + Number(r.paymentAmount ?? 0), 0));

  // Monthly Revenue / Expenses / Net.
  const months = {};
  const bump = (dateStr, key, amt) => { if (!dateStr) return; const m = String(dateStr).slice(0, 7); months[m] = months[m] || { month: m, revenue: 0, expenses: 0 }; months[m][key] += amt; };
  for (const r of inv) bump(r.dateCreated, 'revenue', Number(r.invoiceTotal ?? 0));
  for (const r of bills) bump(r.dateCreated, 'expenses', Number(r.totalAmount ?? 0));
  const series = Object.values(months)
    .map((m) => ({ month: m.month, revenue: round2(m.revenue), expenses: round2(m.expenses), net: round2(m.revenue - m.expenses) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Expenses grouped by vendor (bill totals — not PHI).
  const vmap = {};
  for (const r of bills) { const v = r.vendor?.name ?? 'Unknown'; vmap[v] = (vmap[v] || 0) + Number(r.totalAmount ?? 0); }
  const byVendor = Object.entries(vmap).map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value).slice(0, 12);

  return {
    periodFrom: `${yearStart}T00:00:00`,
    revenue, expenses, net,
    margin: revenue ? round2((net / revenue) * 100) : 0,
    cashReceived,
    invoiceCount: inv.length, billCount: bills.length,
    avgInvoice: inv.length ? round2(revenue / inv.length) : 0,
    avgBill: bills.length ? round2(expenses / bills.length) : 0,
    series, byVendor,
    approximate: true,
  };
}
async function getSO() {
  const rows = await allSO();
  const byStatus = {};
  for (const r of rows) { const s = r.status?.name ?? 'Unknown'; byStatus[s] = (byStatus[s] || 0) + 1; }
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || '')).slice(0, 25)
    .map((r) => ({ id: r.id, ref: safeRef('SO', r.id, r.number), customer: maskName(r.customer?.name), status: r.status?.name ?? '', date: r.dateCreated ?? null }));
  return { count: rows.length, byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count), recent, phiMasked: MASK_PHI };
}
const poIsVoid = (r) => /cancel|void|denied|rejected|fail/i.test(r.statusName || '');
async function getPO() {
  const all = await poStatusMap();                       // each PO enriched with statusName / classified
  const rows = all.filter((r) => r.classified && !poIsVoid(r));   // active, known-good
  const cancelled = all.filter((r) => r.classified && poIsVoid(r));
  const pending = all.filter((r) => !r.classified);      // not yet classified this session
  const sum = (list) => round2(list.reduce((s, r) => s + Number(r.poTotal ?? 0), 0));
  const byVendorMap = {};
  for (const r of rows) { const v = r.vendor?.name ?? 'Unknown'; byVendorMap[v] = (byVendorMap[v] || 0) + Number(r.poTotal ?? 0); }
  const byVendor = Object.entries(byVendorMap).map(([vendor, total]) => ({ vendor, total: round2(total) })).sort((a, b) => b.total - a.total).slice(0, 12);
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => ({ id: r.id, ref: safeRef('PO', r.id, r.poNumber), vendor: r.vendor?.name ?? '', total: Number(r.poTotal ?? 0), date: r.dateCreated ?? null, status: r.statusName ?? '' }));
  return {
    count: rows.length, totalValue: sum(rows), byVendor, recent,
    cancelledCount: cancelled.length, cancelledValue: sum(cancelled),
    pendingCount: pending.length, pendingValue: sum(pending),
    totalCount: all.length,
    phiMasked: MASK_PHI,
  };
}
const CUST_STATUS = { 1: 'Prospect', 2: 'Active', 3: 'Deleted', 4: 'Lost' };
async function getCustomers() {
  const rows = await allCustomers();
  const customers = rows.map((r) => ({
    id: r.id, ref: `Cust-${r.id}`, name: maskName(r.name),
    status: r.status?.name ?? CUST_STATUS[r.status] ?? String(r.status ?? ''),
    since: r.customerSince ?? null,
  }));
  return { count: customers.length, customers, phiMasked: MASK_PHI };
}
async function getVendors() {
  const rows = await allVendors();
  const vendors = rows.map((r) => ({
    id: r.id, name: r.name ?? '', number: r.number ?? '',
    status: r.status?.name ?? String(r.status ?? ''), phone: r.phoneNumber ?? '', terms: r.paymentTerms?.name ?? '',
  }));
  return { count: vendors.length, vendors };
}
async function getItems() {
  const rows = await allItems();
  const items = rows.map((r) => ({
    id: r.id, name: r.name ?? '', number: r.itemNumber ?? '', type: r.itemType?.name ?? '',
    description: r.description ?? '', price: Number(r.price ?? 0), cost: Number(r.cost ?? 0), active: r.active ?? false,
  }));
  return { count: items.length, items };
}
const mapLineItems = (li) => (Array.isArray(li) ? li : []).map((x) => ({
  item: x.item?.name ?? x.name ?? '', description: x.description ?? '',
  qty: Number(x.quantity ?? x.qty ?? 0), unit: Number(x.cost ?? x.price ?? x.rate ?? 0),
  amount: Number(x.amount ?? x.total ?? x.extendedAmount ?? 0),
}));
async function getPODetail(id) {
  const r = await cached(`po-${id}`, () => striven('GET', `/v1/purchase-orders/${id}`));
  const nm = (x) => x?.name ?? '';
  return {
    id: r.id, ref: safeRef('PO', r.id, r.poNumber), vendor: nm(r.vendor),
    status: r.status?.name ?? '', vendorStatus: r.vendorStatus?.name ?? '', type: nm(r.type), title: r.title ?? '',
    poDate: r.poDate ?? r.dateCreated ?? null, promiseDate: r.promiseDate ?? null,
    requestedBy: nm(r.requestedBy), contact: nm(r.contact), createdBy: nm(r.createdBy), createdDate: r.dateCreated ?? null,
    approvedDate: r.approvedDate ?? null, reviewedDate: r.reviewedDate ?? null, acceptedBy: nm(r.acceptedByContact), lastUpdatedBy: nm(r.lastUpdatedBy),
    paymentTerm: nm(r.paymentTerm), account: nm(r.apglAccount),
    dropShipCustomer: r.dropShipCustomer ? maskName(r.dropShipCustomer.name) : '',
    total: Number(r.poTotal ?? 0), lineItems: mapLineItems(r.lineItems),
  };
}
async function getSODetail(id) {
  const r = await cached(`so-${id}`, () => striven('GET', `/v1/sales-orders/${id}`));
  const lineItems = mapLineItems(r.lineItems);
  return {
    id: r.id, ref: safeRef('SO', r.id, r.orderNumber ?? r.number), customer: maskName(r.customer?.name),
    date: r.orderDate ?? r.dateCreated ?? null, total: Number(r.orderTotal ?? 0),
    status: r.status?.name ?? '', lineItemCount: lineItems.length,
    lineItems: MASK_PHI ? [] : lineItems, phiMasked: MASK_PHI,
  };
}
async function getTrends() {
  const [invAll, billsAll] = await Promise.all([allInvoices(), allBills()]);
  const inv = invAll.filter(notVoid);
  const bills = billsAll.filter(notVoid);
  const months = {};
  const bump = (dateStr, key, amt) => { if (!dateStr) return; const m = String(dateStr).slice(0, 7); months[m] = months[m] || { month: m, revenue: 0, expenses: 0 }; months[m][key] += amt; };
  for (const r of inv) bump(r.dateCreated, 'revenue', Number(r.invoiceTotal ?? 0));
  for (const r of bills) bump(r.dateCreated, 'expenses', Number(r.totalAmount ?? 0));
  const series = Object.values(months).map((m) => ({ ...m, revenue: round2(m.revenue), expenses: round2(m.expenses), net: round2(m.revenue - m.expenses) })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  return { series };
}
async function getPayments() {
  const rows = (await allPayments()).filter(notVoid);
  const total = round2(rows.reduce((s, r) => s + Number(r.paymentAmount ?? 0), 0));
  const byMonthMap = {};
  for (const r of rows) { const m = String(r.paymentDate ?? r.dateCreated ?? '').slice(0, 7); if (!m) continue; byMonthMap[m] = (byMonthMap[m] || 0) + Number(r.paymentAmount ?? 0); }
  const byMonth = Object.entries(byMonthMap).map(([month, amount]) => ({ month, amount: round2(amount) })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  const recent = rows.slice().sort((a, b) => (b.paymentDate || '').localeCompare(a.paymentDate || '')).slice(0, 30)
    .map((r) => ({ id: r.id, ref: `PMT-${r.id}`, customer: maskName(r.customer?.name), date: r.paymentDate ?? null, amount: Number(r.paymentAmount ?? 0), status: r.status?.name ?? '' }));
  return { count: rows.length, total, byMonth, recent, phiMasked: MASK_PHI };
}
async function getBillPayments() {
  const rows = await allBillPayCC();
  const total = round2(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0));
  const recent = rows.slice().sort((a, b) => (b.chargeDate || '').localeCompare(a.chargeDate || ''))
    .map((r) => ({ id: r.id, ref: r.referenceNumber || `BP-${r.id}`, vendor: r.vendor?.name ?? '', account: r.creditCardAccount?.name ?? '', date: r.chargeDate ?? null, amount: Number(r.amount ?? 0), status: r.status?.name ?? '' }));
  return { count: rows.length, total, recent };
}
const countBy = (rows, field) => {
  const m = {};
  for (const r of rows) { const k = r[field]?.name ?? 'Unknown'; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
};
async function getTasks() {
  const rows = await allTasks();
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || '')).slice(0, 40)
    .map((r) => ({ id: r.id, title: MASK_PHI ? `Task #${r.id}` : (r.title || `Task #${r.id}`), type: r.type?.name ?? '', status: r.status?.name ?? '', date: r.dateCreated ?? null }));
  return { count: rows.length, byStatus: countBy(rows, 'status'), byType: countBy(rows, 'type'), recent, phiMasked: MASK_PHI };
}
async function getProjects() {
  const rows = await allProjects();
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => ({ id: r.id, name: MASK_PHI ? `Project #${r.id}` : (r.name || `Project #${r.id}`), type: r.type?.name ?? '', status: r.status?.name ?? '', date: r.dateCreated ?? null }));
  return { count: rows.length, byStatus: countBy(rows, 'status'), recent, phiMasked: MASK_PHI };
}

// ---- route tables (shared) ----------------------------------------------
export const ROUTES = {
  '/api/health': async () => { const { clientId, clientSecret } = await getConfig(); return { ok: true, configured: Boolean(clientId && clientSecret), phiMasked: MASK_PHI }; },
  '/api/status': getStatus,
  '/api/ar': getAR,
  '/api/ap': getAP,
  '/api/accounts': getAccounts,
  '/api/pl': getPL,
  '/api/so': getSO,
  '/api/po': getPO,
  '/api/customers': getCustomers,
  '/api/vendors': getVendors,
  '/api/items': getItems,
  '/api/trends': getTrends,
  '/api/payments': getPayments,
  '/api/billpayments': getBillPayments,
  '/api/tasks': getTasks,
  '/api/projects': getProjects,
};
export const DYNAMIC = [
  { re: /^\/api\/po\/(\d+)$/, handler: (m) => getPODetail(m[1]) },
  { re: /^\/api\/so\/(\d+)$/, handler: (m) => getSODetail(m[1]) },
];
