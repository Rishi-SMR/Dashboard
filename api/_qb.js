// SMR ⇄ QuickBooks Online — OAuth 2.0 + a thin API client (dependency-free).
// Env (striven-server/.env locally, Vercel env vars in prod):
//   QB_ENV=sandbox|production    QB_CLIENT_ID / QB_CLIENT_SECRET (Intuit app keys)
//   QB_REDIRECT_URI              must EXACTLY match a URI registered on the Intuit app
// Tokens persist in Supabase striven_cache (key 'qb_tokens'). Intuit ROTATES the
// refresh token on every refresh, so the newest pair must always be persisted.
import crypto from 'node:crypto';
import { sbCacheRead, sbCacheWrite, readConfigTable, striven, allCustomers, allVendors, allItems, allInvoicesList } from './_striven.js';

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

// HIPAA: QuickBooks holds the PT-<id> REFERENCE as the customer, never a patient
// name — Intuit does not sign a BAA for QBO, so no PHI may be written there.
async function qbFindCustomer(ref) {
  const n = String(ref ?? '').trim();
  if (!n) return null;
  const exact = (await qbQuery(`select * from Customer where DisplayName = '${qE(n)}'`)).Customer ?? [];
  return exact[0] ?? null;
}
async function qbCreateCustomer(ref) {
  const r = await qbApi('customer', { method: 'POST', body: { DisplayName: cap(String(ref).trim(), 100) } });
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

// Fetch EVERY QuickBooks customer (paged) → normalized-name set + display list.
const normName = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
async function qbAllCustomers() {
  const out = [];
  for (let start = 1; start < 10000; start += 1000) {
    const rows = (await qbQuery(`select Id, DisplayName, Balance from Customer startposition ${start} maxresults 1000`)).Customer ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// HIPAA: patient names are PHI and never leave the server. Everything — the
// browser AND QuickBooks — identifies a patient by this reference alone.
const patientRef = (id) => `PT-${id}`;

// Reconcile Striven customers against QuickBooks: matched / missing-in-QB.
// Identified by reference only — no names cross the wire.
export async function qbReconcileCustomers() {
  const [striRows, qbRows] = await Promise.all([allCustomers(), qbAllCustomers()]);
  const qbSet = new Set(qbRows.map((c) => normName(c.DisplayName)));
  const stri = striRows
    .filter((r) => r.id && (r.name ?? '').trim())
    .map((r) => ({ ref: patientRef(r.id), inQb: qbSet.has(normName(patientRef(r.id))) }));
  const missingInQb = stri.filter((c) => !c.inQb);
  return {
    strivenCount: stri.length,
    qbCount: qbRows.length,
    matchedCount: stri.length - missingInQb.length,
    missingCount: missingInQb.length,
    // `name` carries the REFERENCE for customers (the UI table is generic).
    missingInQb: missingInQb.slice(0, 500).map((c) => ({ name: c.ref })),
    phi: true,
  };
}

// ── Generic reconcile (vendors, items) + chunked bulk create ────────────────
async function qbAllOf(entity, nameField) {
  const out = [];
  for (let start = 1; start < 20000; start += 1000) {
    const rows = (await qbQuery(`select Id, ${nameField} from ${entity} startposition ${start} maxresults 1000`))[entity] ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function reconcileKind(strivenRows, qbEntity, qbNameField) {
  const qbRows = await qbAllOf(qbEntity, qbNameField);
  const qbSet = new Set(qbRows.map((r) => normName(r[qbNameField])));
  const stri = strivenRows.filter((r) => (r.name ?? '').trim()).map((r) => ({ name: r.name, inQb: qbSet.has(normName(r.name)) }));
  const missing = stri.filter((c) => !c.inQb);
  return {
    strivenCount: stri.length, qbCount: qbRows.length,
    matchedCount: stri.length - missing.length, missingCount: missing.length,
    missingInQb: missing.slice(0, 500).map((c) => ({ name: c.name })),
  };
}
export async function qbReconcileVendors() { return reconcileKind(await allVendors(), 'Vendor', 'DisplayName'); }
export async function qbReconcileItems() { return reconcileKind((await allItems()).map((i) => ({ name: i.name })), 'Item', 'Name'); }

// QuickBooks item names cannot contain ':' (sub-item separator).
const itemName = (s) => String(s ?? '').replace(/:/g, '-').trim();
const cap = (s, n) => String(s ?? '').slice(0, n);

// Batch-create up to 30 entities in one QuickBooks call.
async function qbBatchCreate(entity, items) {
  const body = { BatchItemRequest: items.map((it, i) => ({ bId: String(i + 1), operation: 'create', [entity]: it.payload })) };
  const res = await qbApi('batch', { method: 'POST', body });
  const out = res?.BatchItemResponse ?? [];
  const created = [], failed = [];
  for (let i = 0; i < items.length; i++) {
    const r = out.find((x) => x.bId === String(i + 1)) ?? out[i];
    if (r && r[entity]) created.push({ name: items[i].name, id: r[entity].Id });
    else { const f = r?.Fault?.Error?.[0]; failed.push({ name: items[i].name, error: f ? f.Message : 'unknown error' }); }
  }
  return { created, failed };
}

// Create the NEXT chunk of Striven records missing from QuickBooks. The UI loops
// this (progress bar) until `remaining` hits 0. Chunk capped at QB's batch max.
export async function qbCreateMissing(kind, limit = 30) {
  const CHUNK = Math.min(Math.max(1, Number(limit) || 30), 30);
  let strivenRows, qbEntity, qbNameField, buildPayload;
  if (kind === 'customers') {
    // label = PT-reference (what the browser sees); payload carries the real name.
    // name is kept only to skip blank rows; the QB payload carries the reference.
    strivenRows = (await allCustomers()).filter((r) => r.id).map((r) => ({ name: patientRef(r.id), label: patientRef(r.id) }));
    qbEntity = 'Customer'; qbNameField = 'DisplayName';
    buildPayload = (r) => ({ DisplayName: cap(r.label, 100) });
  } else if (kind === 'vendors') {
    strivenRows = (await allVendors()).map((r) => ({ name: r.name })); qbEntity = 'Vendor'; qbNameField = 'DisplayName';
    buildPayload = (r) => ({ DisplayName: cap(r.name, 100) });
  } else if (kind === 'items') {
    const inc = await defaultIncomeAccountRef();
    strivenRows = (await allItems()).map((r) => ({ name: r.name, price: Number(r.price || 0) })); qbEntity = 'Item'; qbNameField = 'Name';
    buildPayload = (r) => ({ Name: cap(itemName(r.name), 100), Type: 'Service', IncomeAccountRef: { value: inc.value }, ...(r.price ? { UnitPrice: money(r.price) } : {}) });
  } else throw new Error('unknown kind: ' + kind);

  const qbRows = await qbAllOf(qbEntity, qbNameField);
  const qbSet = new Set(qbRows.map((r) => normName(r[qbNameField])));
  const seen = new Set(); const missing = [];
  for (const r of strivenRows) {
    const n = (r.name || '').trim(); if (!n) continue;
    const key = normName(n); if (qbSet.has(key) || seen.has(key)) continue;
    seen.add(key); missing.push(r);
  }
  const totalMissing = missing.length;
  const batch = missing.slice(0, CHUNK).map((r) => ({ name: r.label ?? r.name, payload: buildPayload(r) }));
  if (!batch.length) return { kind, created: [], createdCount: 0, failed: [], remaining: 0, totalMissing: 0 };
  const { created, failed } = await qbBatchCreate(qbEntity, batch);
  return { kind, created, createdCount: created.length, failed, remaining: Math.max(0, totalMissing - created.length), totalMissing };
}

// Create only the records the user selected (each ≤30-item QB batch).
// For customers the browser sends PT-<id> REFERENCES — resolved to real names here.
export async function qbCreateSelected(kind, names) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n)).filter((n) => n.trim());
  if (!list.length) return { kind, created: [], createdCount: 0, failed: [] };
  let qbEntity, entries;
  if (kind === 'customers') {
    qbEntity = 'Customer';
    entries = list.map((ref) => ({ name: ref, payload: { DisplayName: cap(ref, 100) } }));
  } else if (kind === 'vendors') {
    qbEntity = 'Vendor';
    entries = list.map((n) => ({ name: n, payload: { DisplayName: cap(n, 100) } }));
  } else if (kind === 'items') {
    const inc = await defaultIncomeAccountRef();
    const priceByName = new Map((await allItems()).map((r) => [normName(r.name), Number(r.price || 0)]));
    qbEntity = 'Item';
    entries = list.map((n) => {
      const p = priceByName.get(normName(n)) || 0;
      return { name: n, payload: { Name: cap(itemName(n), 100), Type: 'Service', IncomeAccountRef: { value: inc.value }, ...(p ? { UnitPrice: money(p) } : {}) } };
    });
  } else throw new Error('unknown kind: ' + kind);
  const created = [], failed = [];
  for (let i = 0; i < entries.length; i += 30) {
    const r = await qbBatchCreate(qbEntity, entries.slice(i, i + 30));
    created.push(...r.created); failed.push(...r.failed);
  }
  return { kind, created, createdCount: created.length, failed };
}

// ── Striven Invoices → QuickBooks Invoices (ORIGINAL date preserved) ────────
// Keyed by Striven invoice id in striven_cache 'qb_posted_inv' (separate from the
// SO-based map). This is the accurate revenue path per the migration research.
async function postedInvMap() { return (await sbCacheRead('qb_posted_inv'))?.data ?? {}; }
async function recordPostedInv(invId, rec) { const m = await postedInvMap(); m[String(invId)] = rec; await sbCacheWrite('qb_posted_inv', m); }

async function strivenInvoiceRaw(invId) {
  const r = await striven('GET', `/v1/invoices/${invId}`);
  const lines = (r.lineItems ?? []).map((l, i) => ({
    name: l.item?.name ?? `Line ${i + 1}`, description: l.description ?? '',
    qty: Number(l.qty ?? l.quantity ?? 0), unit: Number(l.price ?? 0),
  })).filter((l) => l.qty > 0 || l.unit > 0);
  return {
    invId: Number(invId), number: String(r.txnNumber ?? invId),
    txnDate: (String(r.txnDate ?? r.dateCreated ?? '').slice(0, 10)) || null,   // ← the real invoice date
    dueDate: (String(r.dueDate ?? '').slice(0, 10)) || null,
    // name stays server-side (needed for QuickBooks); ref is what the browser sees.
    customer: { name: r.customer?.name ?? '', ref: r.customer?.id ? patientRef(r.customer.id) : '(unassigned)' },
    order: r.order?.name ?? (r.order?.id ? `SO-${r.order.id}` : ''),
    lines,
  };
}

// Create a QB invoice; if the Striven invoice number collides, retry without it.
async function createQbInvoice(body) {
  try { return (await qbApi('invoice', { method: 'POST', body })).Invoice; }
  catch (e) {
    if (/duplicate document number/i.test(e.message) && body.DocNumber) {
      const { DocNumber, ...rest } = body; // eslint-disable-line no-unused-vars
      return (await qbApi('invoice', { method: 'POST', body: rest })).Invoice;
    }
    throw e;
  }
}

export async function qbInvoiceList() {
  const [invs, posted] = await Promise.all([allInvoicesList(), postedInvMap()]);
  const rows = invs.map((r) => ({
    id: r.id, number: String(r.txnNumber ?? r.id),
    customer: r.customer?.id ? patientRef(r.customer.id) : '(unassigned)',   // reference, never the name
    date: (String(r.txnDate ?? r.dateCreated ?? '').slice(0, 10)) || null,
    total: Number(r.invoiceTotal ?? 0), open: Number(r.openBalance ?? 0),
    posted: posted[String(r.id)] ?? null,
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { count: rows.length, postedCount: rows.filter((r) => r.posted).length, invoices: rows };
}

export async function qbPrepareInvoiceDoc(invId) {
  if (!invId) throw new Error('missing invoice id');
  const inv = await strivenInvoiceRaw(invId);
  const already = (await postedInvMap())[String(invId)] ?? null;
  const cust = await qbFindCustomer(inv.customer.ref);
  const lines = [];
  for (const l of inv.lines) {
    const found = await qbFindItem(l.name);
    lines.push({ name: l.name, qty: l.qty, unit: l.unit, amount: money(l.qty * l.unit), item: found ? { status: 'matched', id: found.Id, qbName: found.Name } : { status: 'create' } });
  }
  return {
    invoice: { id: inv.invId, number: inv.number, date: inv.txnDate, dueDate: inv.dueDate, customerRef: inv.customer.ref, order: inv.order },
    // Reference only — the real name is resolved server-side when posting.
    customer: cust ? { status: 'matched', ref: inv.customer.ref, id: cust.Id } : { status: 'create', ref: inv.customer.ref },
    lines, computedTotal: money(lines.reduce((s, l) => s + l.amount, 0)),
    alreadyPosted: already,
    warnings: [...(inv.lines.length === 0 ? ['This invoice has no line items.'] : []), ...(!inv.customer.name ? ['This invoice has no customer on it.'] : [])],
  };
}

export async function qbPostInvoiceDoc(invId, { force = false } = {}) {
  if (!invId) throw new Error('missing invoice id');
  const prior = (await postedInvMap())[String(invId)];
  if (prior && !force) return { ok: false, alreadyPosted: prior, message: `Invoice ${prior.docNumber || invId} was already posted to QuickBooks.` };
  const inv = await strivenInvoiceRaw(invId);
  if (!inv.customer.name) throw new Error('Invoice has no customer — cannot post.');
  if (!inv.lines.length) throw new Error('Invoice has no line items — cannot post.');
  const steps = [];
  let cust = await qbFindCustomer(inv.customer.ref);
  if (cust) steps.push({ step: 'customer', action: 'matched', name: inv.customer.ref, id: cust.Id });
  else { cust = await qbCreateCustomer(inv.customer.ref); steps.push({ step: 'customer', action: 'created', name: inv.customer.ref, id: cust.Id }); }
  const Line = [];
  for (const l of inv.lines) {
    let it = await qbFindItem(l.name);
    if (it) steps.push({ step: 'item', action: 'matched', name: it.Name, id: it.Id });
    else { it = await qbCreateItem({ name: l.name, unitPrice: l.unit }); steps.push({ step: 'item', action: 'created', name: it.Name, id: it.Id }); }
    Line.push({ DetailType: 'SalesItemLineDetail', Amount: money(l.qty * l.unit), Description: l.description || l.name, SalesItemLineDetail: { ItemRef: { value: it.Id }, Qty: l.qty, UnitPrice: money(l.unit) } });
  }
  const body = {
    CustomerRef: { value: cust.Id }, Line,
    ...(inv.number ? { DocNumber: cap(inv.number, 21) } : {}),
    ...(inv.txnDate ? { TxnDate: inv.txnDate } : {}),   // ← ORIGINAL Striven invoice date
    ...(inv.dueDate ? { DueDate: inv.dueDate } : {}),
    PrivateNote: `Created from Striven Invoice ${inv.number}${inv.order ? ` (${inv.order})` : ''}.`,
  };
  const created = await createQbInvoice(body);
  const rec = { invoiceId: created.Id, docNumber: created.DocNumber ?? inv.number, total: money(created.TotalAmt ?? 0), customer: inv.customer.ref, txnDate: inv.txnDate, at: new Date().toISOString() };
  await recordPostedInv(inv.invId, rec);
  return { ok: true, invoice: rec, steps, number: inv.number };
}

// ── route glue (shared by the local server and the Vercel function) ─────────
export async function qbHandle(pathname, q, method = 'GET', body = null) {
  if (pathname === '/api/qb/status') return { json: await qbStatus() };
  if (pathname === '/api/qb/connect') return { redirect: await qbAuthUrl() };
  if (pathname === '/api/qb/disconnect') return { json: await qbDisconnect() };
  if (pathname === '/api/qb/callback') {
    try { await qbCallback(q); return { redirect: '/?qb=connected' }; }
    catch (e) { return { redirect: `/?qb=error&reason=${encodeURIComponent(e.message)}` }; }
  }
  if (pathname === '/api/qb/reconcile-customers') return { json: await qbReconcileCustomers() };
  if (pathname === '/api/qb/reconcile-vendors') return { json: await qbReconcileVendors() };
  if (pathname === '/api/qb/reconcile-items') return { json: await qbReconcileItems() };
  if (pathname === '/api/qb/create-missing') {
    if (method !== 'POST') return { json: { error: 'POST required' }, status: 405 };
    return { json: await qbCreateMissing(q.kind, q.limit) };
  }
  if (pathname === '/api/qb/create-selected') {
    if (method !== 'POST') return { json: { error: 'POST required' }, status: 405 };
    return { json: await qbCreateSelected(q.kind, body?.names || []) };
  }
  if (pathname === '/api/qb/invoices') return { json: await qbInvoiceList() };
  if (pathname === '/api/qb/prepare-invoice-doc') return { json: await qbPrepareInvoiceDoc(q.inv) };
  if (pathname === '/api/qb/post-invoice-doc') {
    if (method !== 'POST') return { json: { error: 'POST required' }, status: 405 };
    return { json: await qbPostInvoiceDoc(q.inv, { force: q.force === 'true' || q.force === '1' }) };
  }
  return null;
}
