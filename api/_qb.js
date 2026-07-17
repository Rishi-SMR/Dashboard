// SMR ⇄ QuickBooks Online — OAuth 2.0 + a thin API client (dependency-free).
// Env (striven-server/.env locally, Vercel env vars in prod):
//   QB_ENV=sandbox|production    QB_CLIENT_ID / QB_CLIENT_SECRET (Intuit app keys)
//   QB_REDIRECT_URI              must EXACTLY match a URI registered on the Intuit app
// Tokens persist in Supabase striven_cache (key 'qb_tokens'). Intuit ROTATES the
// refresh token on every refresh, so the newest pair must always be persisted.
import crypto from 'node:crypto';
import { sbCacheRead, sbCacheWrite, readConfigTable, striven } from './_striven.js';

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
  if (!saved || saved !== state) throw new Error('state mismatch — restart the connect flow');
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
  if (!t?.refreshToken) throw new Error('QuickBooks not connected — open /api/qb/connect first');
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
    throw new Error(`QuickBooks ${res.status}: ${f ? `${f.Message}${f.Detail ? ` — ${f.Detail}` : ''}` : JSON.stringify(json).slice(0, 300)}`);
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
      error: 'ApplicationAuthorizationFailed — this token works with neither the sandbox nor the production API. Confirm the app keys (Development vs Production) match the company you authorized.' };
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

// ── QuickBooks entity helpers (query / find / create) ───────────────────────
const qE = (s) => String(s ?? '').replace(/'/g, "''");           // escape for QBO SQL
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
async function qbQuery(sql) {
  const r = await qbApi(`query?query=${encodeURIComponent(sql)}`);
  return r?.QueryResponse ?? {};
}

async function qbFindCustomer(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const exact = (await qbQuery(`select * from Customer where DisplayName = '${qE(n)}'`)).Customer ?? [];
  if (exact[0]) return exact[0];
  const like = (await qbQuery(`select * from Customer where DisplayName like '${qE(n)}%'`)).Customer ?? [];
  return like[0] ?? null;
}
async function qbCreateCustomer({ name, email, phone }) {
  const body = { DisplayName: String(name).trim() };
  if (email) body.PrimaryEmailAddr = { Address: email };
  if (phone) body.PrimaryPhone = { FreeFormNumber: String(phone) };
  const r = await qbApi('customer', { method: 'POST', body });
  return r.Customer;
}

let _incomeAcct = null;
async function defaultIncomeAccountRef() {
  if (_incomeAcct) return _incomeAcct;
  const accts = (await qbQuery("select Id, Name from Account where AccountType = 'Income' and Active = true")).Account ?? [];
  const pick = accts.find((a) => /sales|service|revenue|fees/i.test(a.Name)) ?? accts[0];
  if (!pick) throw new Error('No active Income account in QuickBooks — create one first (e.g. "Services").');
  _incomeAcct = { value: pick.Id, name: pick.Name };
  return _incomeAcct;
}
async function qbFindItem(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const exact = (await qbQuery(`select * from Item where Name = '${qE(n)}'`)).Item ?? [];
  if (exact[0]) return exact[0];
  const like = (await qbQuery(`select * from Item where Name like '${qE(n)}%'`)).Item ?? [];
  return like[0] ?? null;
}
async function qbCreateItem({ name, unitPrice }) {
  const inc = await defaultIncomeAccountRef();
  const body = {
    Name: String(name).trim().slice(0, 100),
    Type: 'Service',
    IncomeAccountRef: { value: inc.value },
    ...(unitPrice ? { UnitPrice: money(unitPrice) } : {}),
  };
  const r = await qbApi('item', { method: 'POST', body });
  return r.Item;
}

// ── Striven SO → QuickBooks Invoice (idempotent) ────────────────────────────
// Duplicate-proof: every posted SO is recorded in striven_cache key 'qb_posted'
// { [soId]: { invoiceId, docNumber, at, customer } }. A second post is refused.
async function postedMap() { return (await sbCacheRead('qb_posted'))?.data ?? {}; }
async function recordPosted(soId, rec) {
  const m = await postedMap();
  m[String(soId)] = rec;
  await sbCacheWrite('qb_posted', m);
}

async function strivenSoRaw(soId) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const soNumber = String(so.orderNumber ?? so.number ?? soId);
  const lines = (so.lineItems ?? []).map((l, i) => ({
    itemId: l.item?.id ?? l.itemId ?? null,
    name: l.item?.name ?? l.itemName ?? `Line ${i + 1}`,
    description: l.description ?? '',
    qty: Number(l.qty ?? l.quantity ?? 0),
    unit: Number(l.price ?? l.unitPrice ?? 0),
  })).filter((l) => l.qty > 0 || l.unit > 0);
  return {
    soId: Number(soId), soNumber,
    status: so.status?.name ?? '',
    type: so.type?.name ?? '',
    orderDate: so.orderDate ?? so.dateCreated ?? null,
    customer: { id: so.customer?.id ?? null, name: so.customer?.name ?? '', email: so.customer?.email ?? '', phone: so.customer?.phone ?? '' },
    total: Number(so.orderTotal ?? 0),
    lines,
  };
}

// Build a plan WITHOUT writing anything: resolve the customer + every line item
// against QuickBooks and report found / will-create so the user can confirm.
export async function qbPrepareInvoice(soId) {
  if (!soId) throw new Error('missing so id');
  const so = await strivenSoRaw(soId);
  const already = (await postedMap())[String(soId)] ?? null;
  const cust = await qbFindCustomer(so.customer.name);
  const lines = [];
  for (const l of so.lines) {
    const found = await qbFindItem(l.name);
    lines.push({
      name: l.name, qty: l.qty, unit: l.unit, amount: money(l.qty * l.unit),
      item: found ? { status: 'matched', id: found.Id, qbName: found.Name } : { status: 'create' },
    });
  }
  return {
    so: { id: so.soId, number: so.soNumber, status: so.status, type: so.type, date: so.orderDate, total: money(so.total) },
    customer: cust
      ? { status: 'matched', name: so.customer.name, id: cust.Id, qbName: cust.DisplayName }
      : { status: 'create', name: so.customer.name, email: so.customer.email, phone: so.customer.phone },
    lines,
    computedTotal: money(lines.reduce((s, l) => s + l.amount, 0)),
    alreadyPosted: already,
    warnings: [
      ...(so.lines.length === 0 ? ['This sales order has no line items.'] : []),
      ...(!so.customer.name ? ['This sales order has no customer name.'] : []),
    ],
  };
}

// Actually create in QuickBooks: customer (if new) → missing items → invoice.
// Refuses if this SO was already posted (unless force).
export async function qbPostInvoice(soId, { force = false } = {}) {
  if (!soId) throw new Error('missing so id');
  const prior = (await postedMap())[String(soId)];
  if (prior && !force) return { ok: false, alreadyPosted: prior, message: `SO ${soId} was already posted to QuickBooks (Invoice ${prior.docNumber || prior.invoiceId}).` };

  const so = await strivenSoRaw(soId);
  if (!so.customer.name) throw new Error('Sales order has no customer — cannot post.');
  if (!so.lines.length) throw new Error('Sales order has no line items — cannot post.');

  const steps = [];
  // 1) customer
  let cust = await qbFindCustomer(so.customer.name);
  if (cust) { steps.push({ step: 'customer', action: 'matched', name: cust.DisplayName, id: cust.Id }); }
  else {
    cust = await qbCreateCustomer({ name: so.customer.name, email: so.customer.email, phone: so.customer.phone });
    steps.push({ step: 'customer', action: 'created', name: cust.DisplayName, id: cust.Id });
  }
  // 2) items → invoice lines
  const Line = [];
  for (const l of so.lines) {
    let it = await qbFindItem(l.name);
    if (it) steps.push({ step: 'item', action: 'matched', name: it.Name, id: it.Id });
    else { it = await qbCreateItem({ name: l.name, unitPrice: l.unit }); steps.push({ step: 'item', action: 'created', name: it.Name, id: it.Id }); }
    Line.push({
      DetailType: 'SalesItemLineDetail',
      Amount: money(l.qty * l.unit),
      Description: l.description || l.name,
      SalesItemLineDetail: { ItemRef: { value: it.Id }, Qty: l.qty, UnitPrice: money(l.unit) },
    });
  }
  // 3) invoice
  const body = {
    CustomerRef: { value: cust.Id },
    Line,
    PrivateNote: `Created from Striven Sales Order ${so.soNumber} (SO-${so.soId}).`,
    CustomerMemo: { value: `Ref: SO ${so.soNumber}` },
    ...(so.orderDate ? { TxnDate: String(so.orderDate).slice(0, 10) } : {}),
  };
  const inv = (await qbApi('invoice', { method: 'POST', body })).Invoice;
  const rec = { invoiceId: inv.Id, docNumber: inv.DocNumber ?? '', total: money(inv.TotalAmt ?? 0), customer: cust.DisplayName, at: new Date().toISOString() };
  await recordPosted(so.soId, rec);
  return { ok: true, invoice: rec, steps, soNumber: so.soNumber };
}

// Lightweight customer search / create used by the QB tab's Customers panel.
export async function qbCustomerSearch(q) {
  const term = String(q ?? '').trim();
  const sql = term
    ? `select Id, DisplayName, PrimaryEmailAddr, Balance from Customer where DisplayName like '${qE(term)}%' orderby DisplayName`
    : 'select Id, DisplayName, PrimaryEmailAddr, Balance from Customer orderby DisplayName';
  const rows = (await qbQuery(`${sql} maxresults 25`)).Customer ?? [];
  return { count: rows.length, customers: rows.map((c) => ({ id: c.Id, name: c.DisplayName, email: c.PrimaryEmailAddr?.Address ?? '', balance: money(c.Balance ?? 0) })) };
}

// ── route glue (shared by the local server and the Vercel function) ─────────
export async function qbHandle(pathname, q, method = 'GET') {
  if (pathname === '/api/qb/status') return { json: await qbStatus() };
  if (pathname === '/api/qb/connect') return { redirect: await qbAuthUrl() };
  if (pathname === '/api/qb/disconnect') return { json: await qbDisconnect() };
  if (pathname === '/api/qb/callback') {
    try { await qbCallback(q); return { redirect: '/?qb=connected' }; }
    catch (e) { return { redirect: `/?qb=error&reason=${encodeURIComponent(e.message)}` }; }
  }
  if (pathname === '/api/qb/customers') return { json: await qbCustomerSearch(q.q) };
  if (pathname === '/api/qb/prepare-invoice') return { json: await qbPrepareInvoice(q.so) };
  if (pathname === '/api/qb/post-invoice') {
    if (method !== 'POST') return { json: { error: 'POST required' }, status: 405 };
    return { json: await qbPostInvoice(q.so, { force: q.force === 'true' || q.force === '1' }) };
  }
  return null;
}
