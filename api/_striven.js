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
// Username match is case-insensitive and tolerant of a trailing ".com".
const normUser = (s) => String(s ?? '').trim().toLowerCase().replace(/\.com$/, '');

// Login users live in the Supabase `dashboard_users` table (username, password)
// — the ONLY source of truth. Read over PostgREST with the service-role key (RLS
// keeps the table private to the server). HIPAA §164.312(a)(2)(i): there is no
// env-var/shared-password fallback, so no credential can exist outside the
// hashed table. If the table is unreachable the gate FAILS CLOSED — logins are
// refused rather than silently dropping to a weaker credential.
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
async function resolveUsers() {
  const now = Date.now();
  if (_usersCache.users && now - _usersCache.at < 60_000) return _usersCache.users;
  const users = (await readUsersTable()) ?? [];
  if (!users.length) console.error('[auth] dashboard_users empty or unreachable — refusing all logins (fail closed)');
  _usersCache = { at: now, users };
  return users;
}

const SB_URL = () => (process.env.SUPABASE_URL || process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SB_KEY = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// Striven creds + access password live in the Supabase `app_config` table (key,value).
export async function readConfigTable() {
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

// HIPAA §164.308(a)(5)(ii)(C) — log-in monitoring. Brute force is throttled off
// the same `login_events` audit trail (serverless has no shared memory, so the
// table is the only counter every instance agrees on): LOCK_MAX consecutive
// failures for a username inside LOCK_WINDOW_MIN minutes refuses further
// attempts until the window passes. A successful login clears the count because
// only rows newer than the last success are examined.
const LOCK_MAX = 5, LOCK_WINDOW_MIN = 15;
async function isLockedOut(username) {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key || !username) return false;
  try {
    const since = new Date(Date.now() - LOCK_WINDOW_MIN * 60_000).toISOString();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(
      `${url}/rest/v1/login_events?select=success&username=eq.${encodeURIComponent(username)}&at=gte.${since}&order=at.desc&limit=${LOCK_MAX}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= LOCK_MAX && rows.every((r) => r.success === false);
  } catch { return false; }   // never lock people out because the audit table hiccuped
}

// ---- HIPAA §164.312(a)(2)(i)/(d): password storage + per-user identity -----
// Passwords are stored scrypt-hashed. Legacy plaintext rows still authenticate
// once and are then transparently upgraded to a hash, so nobody is locked out.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const s = String(stored ?? '');
  if (!s.startsWith('scrypt$')) return { ok: Boolean(s) && s === String(pw), legacy: true };
  try {
    const [, saltB64, hashB64] = s.split('$');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length);
    return { ok: expected.length === actual.length && crypto.timingSafeEqual(expected, actual), legacy: false };
  } catch { return { ok: false, legacy: false }; }
}
async function upgradeStoredPassword(username, pw) {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/dashboard_users?username=eq.${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ password: hashPassword(pw) }),
    });
    _usersCache = { at: 0, users: null };   // force a re-read next time
  } catch { /* best effort — never block login */ }
}

// Per-user signed session (replaces the old single token shared by everyone, so
// the server can attribute every PHI read to a named user).
function sessionSecret() {
  const s = process.env.SESSION_SECRET || SB_KEY() || process.env.STRIVEN_CLIENT_SECRET || '';
  return crypto.createHash('sha256').update(`${s}::smr-session-v2`).digest();
}
const b64u = (b) => Buffer.from(b).toString('base64url');
export function makeSession(username, hours = 12) {
  const payload = b64u(JSON.stringify({ u: String(username), exp: Date.now() + hours * 3600_000 }));
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
/** → { user } for a valid, unexpired token, else null. */
export function verifySession(token) {
  const t = String(token ?? '');
  const dot = t.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = t.slice(0, dot), sig = t.slice(dot + 1);
  const want = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!p.u || !p.exp || Date.now() > Number(p.exp)) return null;
    return { user: String(p.u) };
  } catch { return null; }
}

// HIPAA §164.312(b): record every read of patient data — who, what, when.
export async function logPhiAccess(user, pathname, ip) {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(`${url}/rest/v1/phi_access_events`, {
      method: 'POST', signal: ctrl.signal,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ username: String(user ?? '').slice(0, 200), path: String(pathname ?? '').slice(0, 300), ip: ip ? String(ip).slice(0, 100) : null }),
    });
    clearTimeout(t);
  } catch { /* audit is best-effort — never block a request */ }
}

// Static config (Striven creds + access password) — resolved once and cached.
async function getStatic() {
  if (_cfg) return _cfg;
  _cfg = (async () => {
    const t = await readConfigTable();   // Supabase app_config = source of truth
    let clientId = t.STRIVEN_CLIENT_ID || process.env.STRIVEN_CLIENT_ID || '';
    let clientSecret = t.STRIVEN_CLIENT_SECRET || process.env.STRIVEN_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      try {
        const v = await readVault(['STRIVEN_CLIENT_ID', 'STRIVEN_CLIENT_SECRET']);
        clientId = clientId || v.STRIVEN_CLIENT_ID || '';
        clientSecret = clientSecret || v.STRIVEN_CLIENT_SECRET || '';
      } catch (e) { console.error('[config] Supabase Vault read failed:', e.message); }
    }
    return { clientId, clientSecret };
  })();
  return _cfg;
}
async function getConfig() {
  const s = await getStatic();
  const users = await resolveUsers();                    // live from the table (60s cache)
  return { clientId: s.clientId, clientSecret: s.clientSecret, users };
}
// Gate info for the request handlers. The dashboard serves PHI, so the login
// gate is mandatory and never switches itself off.
export async function getAuth() {
  return { gateEnabled: true };
}
// Validate a login → { ok, session, user }. `session` is a per-user signed token.
// Every attempt is recorded in the Supabase `login_events` audit table.
export async function login(username, password, meta = {}) {
  const { users } = await getConfig();
  const pw = String(password ?? '');
  const row = users.find((x) => normUser(x.u) === normUser(username));
  // Attribute the attempt to the canonical username so attempts cannot be
  // spread across spellings ("Rishi@…", "rishi") to dodge the lockout counter.
  const who = row ? row.u : String(username ?? '').trim();
  if (await isLockedOut(who)) {
    await logLoginEvent(who, false, meta.ip);
    return { ok: false, locked: true, session: '', user: '' };
  }
  let ok = false;
  if (row) {
    const v = verifyPassword(pw, row.p);
    ok = v.ok;
    if (ok && v.legacy) await upgradeStoredPassword(row.u, pw);   // migrate plaintext → scrypt
  }
  await logLoginEvent(who, ok, meta.ip);
  return { ok, session: ok ? makeSession(who) : '', user: ok ? who : '' };
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

export async function striven(method, endpoint, jsonBody) {
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
  // Cap the Retry-After wait: Striven can send a large value, and 3× a big wait
  // would blow past Vercel's 60s function limit (→ 504). Fail fast instead.
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const waitS = Math.min(Number(res.headers.get('retry-after')) || 2, 6);
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

// HIPAA §164.502(b) minimum necessary: patient names are NEVER persisted in our
// cache. At write time each name is replaced by its PT-<id> reference; the name
// itself lives only in Striven and is re-read from there when truly required.

// Names live in Striven only. Build a name → PT-<id> lookup by reading customers
// straight from the API — NOT via allCustomers(), which returns the already
// scrubbed cache and would map names to themselves. Held in memory, never written.
let _refMap = { at: 0, map: null };
export async function customerRefMap() {
  if (_refMap.map && Date.now() - _refMap.at < CACHE_TTL) return _refMap.map;
  const map = new Map();
  try {
    for (let page = 0; page < 20; page++) {
      const body = await striven('POST', '/v1/customers/search', { PageIndex: page, PageSize: 100 });
      const rows = body.data ?? body.Data ?? [];
      for (const r of rows) {
        const n = String(r.name ?? r.Name ?? '').trim();
        if (n && r.id && !/^PT-\d+$/.test(n)) map.set(n.toLowerCase(), `PT-${r.id}`);
      }
      if (rows.length < 100) break;
    }
    _refMap = { at: Date.now(), map };
  } catch { /* keep whatever we had; callers fall back to structural scrubbing */ }
  return _refMap.map ?? map;
}

// Fields outside the four primary datasets that can carry a patient's identity.
// Targeted by field NAME so nesting is handled without brittle paths — and so
// siblings like `rep` (a sales rep) and `createdBy` (staff) are left untouched,
// because workforce names are business data, not PHI.
const PHI_NAME_FIELDS = {
  qb_posted: ['customer'],
  qb_posted_inv: ['customer'],
  so_detail: ['payer'],
  order_chain: ['payer'],
  auto_po_state: ['dropShipTo'],
};
// Free-text fields where a patient's name is EMBEDDED rather than being the whole
// value — "Temple - Fidel Castillo", "Jan Vaiz AFO- L1971" (that L-code is an
// orthotic device, so name + code is health information). Exact matching misses
// these, so the known names are substituted wherever they occur.
const PHI_FREETEXT_FIELDS = { tasks: ['title'], projects: ['name'] };
const _rxCache = new Map();
function redactFreeText(str, refMap) {
  if (!refMap?.size) return str;
  let out = String(str);
  const low = out.toLowerCase();
  for (const [name, ref] of refMap) {
    if (name.length < 6 || !low.includes(name)) continue;   // length guard: avoid matching inside unrelated words
    let rx = _rxCache.get(name);
    if (!rx) { rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'); _rxCache.set(name, rx); }
    out = out.replace(rx, ref);
  }
  return out;
}
// Internal automation log fields that embed a patient's name or an abbreviation
// of it (Striven order numbers look like "ADubberly DEMO Hidow"). Nothing in the
// UI reads them, so they are dropped rather than mapped.
const PHI_DROP_FIELDS = { auto_po_state: ['title', 'soNumber'] };

function redactNode(node, nameFields, dropFields, refMap, freeFields = []) {
  if (Array.isArray(node)) return node.map((v) => redactNode(v, nameFields, dropFields, refMap, freeFields));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (dropFields.includes(k)) continue;
    if (freeFields.includes(k) && typeof v === 'string') { out[k] = redactFreeText(v, refMap); continue; }
    // { id, name } under a `customer` key → resolve by id, no lookup needed
    if (k === 'customer' && v && typeof v === 'object' && !Array.isArray(v) && 'name' in v) {
      out[k] = { ...v, name: v.id ? `PT-${v.id}` : '(unassigned)' };
      continue;
    }
    if (nameFields.includes(k) && typeof v === 'string' && v.trim()) {
      const hit = refMap?.get(v.trim().toLowerCase());
      out[k] = hit ?? v;
      continue;
    }
    out[k] = redactNode(v, nameFields, dropFields, refMap, freeFields);
  }
  return out;
}

// HIPAA §164.502(b) minimum necessary: patient names are NEVER persisted in our
// cache. At write time each name is replaced by its PT-<id> reference; the name
// itself lives only in Striven and is re-read from there when truly required.
export function scrubPhi(key, data, refMap = null) {
  const ref = (id) => (id ? `PT-${id}` : '(unassigned)');
  if (Array.isArray(data)) {
    if (key === 'customers') return data.map((r) => (r && r.name ? { ...r, name: ref(r.id) } : r));
    if (key === 'invoices' || key === 'so' || key === 'payments') {
      return data.map((r) => (r && r.customer && r.customer.name
        ? { ...r, customer: { ...r.customer, name: ref(r.customer.id) } } : r));
    }
  }
  const nameFields = PHI_NAME_FIELDS[key] ?? [];
  const dropFields = PHI_DROP_FIELDS[key] ?? [];
  const freeFields = PHI_FREETEXT_FIELDS[key] ?? [];
  // Every dataset still gets the `{ customer: { id, name } }` rule.
  if (data && typeof data === 'object') return redactNode(data, nameFields, dropFields, refMap, freeFields);
  return data;
}

// Shared, durable cache in the Supabase `striven_cache` table. Cold serverless
// instances and Striven rate-limit/outage never break loading — we always fall
// back to the last-known-good copy instead of hanging or erroring.
export async function sbCacheRead(key) {
  const url = SB_URL(), sk = SB_KEY();
  if (!url || !sk) return null;
  try {
    const res = await fetch(`${url}/rest/v1/striven_cache?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, { headers: { apikey: sk, Authorization: `Bearer ${sk}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
export function sbCacheWrite(key, data) {
  const url = SB_URL(), sk = SB_KEY();
  if (!url || !sk) return Promise.resolve();
  return fetch(`${url}/rest/v1/striven_cache`, {
    method: 'POST',
    headers: { apikey: sk, Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}
// Dashboard requests read ONLY the Supabase copy — they NEVER call Striven, so
// user traffic can never hit Striven's rate limit. The copy is refreshed out of
// band every 6h by /api/refresh (a Supabase pg_cron job). A one-time Striven
// bootstrap runs only if the cache is completely empty.
function persistentCached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit.value);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const sb = await sbCacheRead(key);
    if (sb) {                                                  // serve the Supabase copy (any age)
      _cache.set(key, { value: sb.data, expiresAt: Date.now() + CACHE_TTL });
      return sb.data;
    }
    try {                                                      // cache empty → one-time bootstrap
      const value = scrubPhi(key, await fn(), await customerRefMap());
      _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
      sbCacheWrite(key, value);
      return value;
    } catch (e) { if (hit) return hit.value; throw e; }
  })();
  _inflight.set(key, p);
  p.catch(() => {}).finally(() => _inflight.delete(key));
  return p;
}
// Out-of-band refresh: force-fetch every base dataset from Striven and write it
// to Supabase. Called by /api/refresh (pg_cron every 6h). Never on the hot path.
async function refreshAll() {
  const jobs = [
    ['invoices', '/v1/invoices/search'], ['bills', '/v1/bills/search'], ['so', '/v1/sales-orders/search'],
    ['po', '/v1/purchase-orders/search'], ['customers', '/v1/customers/search'], ['vendors', '/v1/vendors/search'],
    ['items', '/v1/items/search'], ['payments', '/v1/payments/search'], ['billpaycc', '/v2/bill-payment-cc-charges/search'],
    ['tasks', '/v2/tasks/search'], ['projects', '/v1/projects/search'],
  ];
  const out = {};
  const refMap = await customerRefMap();
  for (const [key, ep] of jobs) {
    try { const data = scrubPhi(key, await searchAll(ep), refMap); await sbCacheWrite(key, data); _cache.set(key, { value: data, expiresAt: Date.now() + CACHE_TTL }); out[key] = data.length; }
    catch (e) { out[key] = `FAIL ${e.message}`; }
  }
  try { const b = await striven('POST', '/v1/gl-accounts/search', { Active: true }); const gl = b.data ?? b.Data ?? []; await sbCacheWrite('gl', gl); _cache.set('gl', { value: gl, expiresAt: Date.now() + CACHE_TTL }); out.gl = gl.length; } catch (e) { out.gl = `FAIL ${e.message}`; }
  try { const c = await striven('GET', '/v1/company/profile'); await sbCacheWrite('company', c); _cache.set('company', { value: c, expiresAt: Date.now() + CACHE_TTL }); out.company = 'ok'; } catch (e) { out.company = `FAIL ${e.message}`; }
  return out;
}
const allInvoices = () => persistentCached('invoices', () => searchAll('/v1/invoices/search', {}));
const allBills = () => persistentCached('bills', () => searchAll('/v1/bills/search', {}));
const allSO = () => persistentCached('so', () => searchAll('/v1/sales-orders/search', {}));
const allPO = () => persistentCached('po', () => searchAll('/v1/purchase-orders/search', {}));
const allCustomers = () => persistentCached('customers', () => searchAll('/v1/customers/search', {}));
export { allCustomers };
const allVendors = () => persistentCached('vendors', () => searchAll('/v1/vendors/search', {}));
const allItems = () => persistentCached('items', () => searchAll('/v1/items/search', {}));
const allInvoicesList = () => persistentCached('invoices', () => searchAll('/v1/invoices/search', {}));
export { allVendors, allItems, allInvoicesList };
const allPayments = () => persistentCached('payments', () => searchAll('/v1/payments/search', {}));
const allBillPayCC = () => persistentCached('billpaycc', () => searchAll('/v2/bill-payment-cc-charges/search', {}));
const allTasks = () => persistentCached('tasks', () => searchAll('/v2/tasks/search', {}));
const allProjects = () => persistentCached('projects', () => searchAll('/v1/projects/search', {}));
const glAccountsRaw = () => persistentCached('gl', async () => { const b = await striven('POST', '/v1/gl-accounts/search', { Active: true }); return b.data ?? b.Data ?? []; });
const companyProfile = () => persistentCached('company', () => striven('GET', '/v1/company/profile'));
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

// PHI: patient names/initials must NEVER leave the backend. When masking is on we
// emit nothing — the UI references transactions by invoice/order number, sales rep,
// clinic/hospital and payer instead (per the data-privacy requirement).
function maskName(name, mask = MASK_PHI) {
  const v = String(name ?? '');
  if (/^PT-\d+$/.test(v)) return v;   // already a de-identified reference — safe to show
  if (!mask) return v;
  return '';
}
const safeRef = (prefix, id, rawNumber) => (MASK_PHI || /[a-zA-Z]/.test(String(rawNumber ?? '')) ? `${prefix}-${id}` : String(rawNumber));

// Striven's salesRep field holds "Referral group- Person" (e.g.
// "Maverick Medical- Jillian Colin", "CVT Medical - Christy Tan"). The actual
// sales rep is the PERSON — strip the leading referral-group/vendor and any
// trailing "(Striven)" tag so the rep name shows on its own.
function cleanRep(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();            // drop trailing "(Striven)" etc.
  const i = s.indexOf('-');                                 // "Group- Person" → keep Person
  if (i > 0 && i < s.length - 1) { const person = s.slice(i + 1).trim(); if (person) return person; }
  return s;
}
// A rep is effectively unassigned when it's blank or the placeholder "House Account".
const repIsUnassigned = (raw) => { const r = cleanRep(raw); return !r || /^house account$/i.test(r); };
// Who pays the invoice for an order. PI (personal-injury) orders are paid by the
// attorney's office → the "Payer"/"Law Firm" custom field on the SO. VA orders are
// paid by Veterans Affairs; Tri-Care by the TriCare program — both read straight
// off the order type. All grounded in Striven, nothing fabricated. `d` is either a
// live SO detail (with customFields) or a cached so_detail row (with .payer set).
const cfVal = (d, name) => (Array.isArray(d?.customFields) ? d.customFields.find((f) => f.name === name)?.valueText : undefined);
function payerOf(d) {
  const type = d?.type?.name ?? d?.type ?? '';
  const explicit = String(d?.payer ?? cfVal(d, 'Payer') ?? '').trim();
  if (explicit) return explicit;
  if (/tri.?care/i.test(type)) return 'TriCare';
  if (/\bva\b|veteran/i.test(type)) return 'Veterans Affairs';
  if (/\bpi\b|personal injury/i.test(type)) return String(cfVal(d, 'Law Firm') ?? '').trim();
  return '';
}

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
  // Payer per invoice: each invoice links to a sales order, and the order carries
  // the payer (law firm for PI, VA / TriCare by type). Map invoice # → payer via
  // the order_chain cache so we can show WHO pays each invoice (patient stays masked).
  const payerByInv = await invoicePayerMap();

  const invoices = netRows.filter((r) => r.netOpen > 0.005).map((r) => ({
    id: r.id, number: r.txnNumber ?? String(r.id),
    customer: maskName(r.customer?.name), customerId: r.customer?.id ?? null,
    payer: payerByInv[String(r.txnNumber ?? r.id)] || '',
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
// SO type/rep/value come from the offline 'so_detail' enrichment (search omits them).
async function soDetailMap() { const sb = await sbCacheRead('so_detail'); return (sb && sb.data) || {}; }
// invoice # → payer, built from the SO→invoice order_chain (each order carries its payer).
async function invoicePayerMap() {
  const sb = await sbCacheRead('order_chain');
  const chain = (sb && sb.data) || {};
  const out = {};
  for (const o of Object.values(chain)) {
    const payer = payerOf(o);
    if (!payer) continue;
    for (const inv of (o.invoices || [])) { const num = String(inv.ref || '').replace(/^#/, ''); if (num) out[num] = payer; }
  }
  return out;
}
const soClass = (t) => { const s = (t || '').toLowerCase(); if (/pi/.test(s)) return 'PI'; if (/\bva\b|veteran/.test(s)) return 'VA'; if (/tri.?care/.test(s)) return 'TriCare'; return 'Other'; };
const isDemoType = (t) => /demo|test|sample/i.test(t || '');
// Cancelled / completed / active(open) status grouping — cancelled orders must
// never inflate the order book (same rule the PO side already follows).
const soStatusOf = (r) => r.status?.name ?? r.d?.status ?? 'Unknown';
const soGroupOf = (status) => {
  const s = String(status || '').toLowerCase();
  if (/cancel|void|lost|denied|rejected/.test(s)) return 'cancelled';
  if (/complete|closed|done/.test(s)) return 'completed';
  return 'active';
};
async function getSO() {
  const rows = await allSO();
  const det = await soDetailMap();
  const enriched = rows.map((r) => ({ ...r, d: det[r.id] || {} }));
  const live = enriched.filter((r) => !isDemoType(r.d.type));        // exclude DEMO / test orders

  // Explicit status groups (counts + value) — the source of truth for KPIs.
  const statusGroups = { active: { count: 0, value: 0 }, completed: { count: 0, value: 0 }, cancelled: { count: 0, value: 0 } };
  for (const r of live) { const g = statusGroups[soGroupOf(soStatusOf(r))]; g.count++; g.value = round2(g.value + Number(r.d.total || 0)); }

  // Order book = live minus cancelled. Every aggregate below uses `book` so no
  // figure silently contains cancelled orders.
  const book = live.filter((r) => soGroupOf(soStatusOf(r)) !== 'cancelled');
  const totalValue = round2(book.reduce((s, r) => s + Number(r.d.total || 0), 0));

  const piva = { PI: { count: 0, value: 0 }, VA: { count: 0, value: 0 }, TriCare: { count: 0, value: 0 }, Other: { count: 0, value: 0 } };
  for (const r of book) { const c = soClass(r.d.type); piva[c].count++; piva[c].value = round2(piva[c].value + Number(r.d.total || 0)); }
  // raw type breakdown (PI Order / VA Order / Tri-Care …) minus demo + cancelled
  const byTypeMap = {};
  for (const r of book) { const t = r.d.type || 'Unclassified'; byTypeMap[t] = byTypeMap[t] || { count: 0, value: 0 }; byTypeMap[t].count++; byTypeMap[t].value += Number(r.d.total || 0); }
  const byType = Object.entries(byTypeMap).map(([type, v]) => ({ type, count: v.count, value: round2(v.value) })).sort((a, b) => b.value - a.value);

  // Status mix keeps ALL live orders (that chart is exactly about status).
  const byStatusMap = {};
  for (const r of live) { const s = soStatusOf(r); byStatusMap[s] = (byStatusMap[s] || 0) + 1; }
  const byStatus = Object.entries(byStatusMap).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);

  const byRepMap = {};
  for (const r of book) { const rep = cleanRep(r.d.rep) || 'Unassigned'; byRepMap[rep] = (byRepMap[rep] || 0) + Number(r.d.total || 0); }
  const byRep = Object.entries(byRepMap).map(([rep, value]) => ({ rep, value: round2(value) })).sort((a, b) => b.value - a.value).slice(0, 15);

  // The COMPLETE live order list (each row carries its status for filtering).
  const recent = live.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => ({ id: r.id, ref: safeRef('SO', r.id, r.number), type: soClass(r.d.type), rep: cleanRep(r.d.rep), payer: payerOf(r.d), value: Number(r.d.total || 0), status: soStatusOf(r), invStatus: r.d.invStatus || '', date: r.dateCreated ?? null }));

  return {
    count: book.length, totalValue, piva, byType, byStatus, byRep, recent, statusGroups,
    liveCount: live.length, demoCount: enriched.length - live.length,
    enriched: Object.keys(det).length > 0, phiMasked: MASK_PHI,
  };
}
// Order-to-cash chain (SO -> linked POs + invoices), keyed by order number, no PHI.
async function getOrders() {
  const sb = await sbCacheRead('order_chain');
  const chain = (sb && sb.data) || {};
  const orders = Object.values(chain)
    .filter((o) => !isDemoType(o.type))
    .map((o) => ({
      ref: o.ref, pi: soClass(o.type), type: o.type, rep: cleanRep(o.rep), payer: payerOf(o), value: round2(Number(o.value || 0)),
      status: o.status || '', invStatus: o.invStatus || '',
      pos: (o.pos || []).map((p) => ({ ...p, value: round2(Number(p.value || 0)) })),
      invoices: (o.invoices || []).map((i) => ({ ...i, total: round2(Number(i.total || 0)), open: round2(Number(i.open || 0)) })),
      poValue: round2((o.pos || []).reduce((s, p) => s + Number(p.value || 0), 0)),
      invOpen: round2((o.invoices || []).reduce((s, i) => s + Number(i.open || 0), 0)),
    }))
    .sort((a, b) => b.value - a.value);
  return { count: orders.length, orders, enriched: Object.keys(chain).length > 0, phiMasked: MASK_PHI };
}
const poIsVoid = (r) => /cancel|void|denied|rejected|fail/i.test(r.statusName || '');
// Reverse map PO ref → the sales order it was raised for (from the order_chain
// cache — Striven's own line-item order link, no guessing).
async function poToSoMap() {
  const sb = await sbCacheRead('order_chain');
  const chain = (sb && sb.data) || {};
  const rev = {};
  for (const [soId, o] of Object.entries(chain)) {
    for (const p of (o.pos ?? [])) rev[p.ref] = `SO-${soId}`;
  }
  return rev;
}
async function getPO() {
  const all = await poStatusMap();                       // each PO enriched with statusName / classified
  const rows = all.filter((r) => r.classified && !poIsVoid(r));   // active, known-good
  const cancelled = all.filter((r) => r.classified && poIsVoid(r));
  const pending = all.filter((r) => !r.classified);      // not yet classified this session
  const sum = (list) => round2(list.reduce((s, r) => s + Number(r.poTotal ?? 0), 0));
  const byVendorMap = {};
  for (const r of rows) { const v = r.vendor?.name ?? 'Unknown'; byVendorMap[v] = (byVendorMap[v] || 0) + Number(r.poTotal ?? 0); }
  const byVendor = Object.entries(byVendorMap).map(([vendor, total]) => ({ vendor, total: round2(total) })).sort((a, b) => b.total - a.total).slice(0, 12);
  const rev = await poToSoMap();
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => { const ref = safeRef('PO', r.id, r.poNumber); return { id: r.id, ref, vendor: r.vendor?.name ?? '', total: Number(r.poTotal ?? 0), date: r.dateCreated ?? null, status: r.statusName ?? '', so: rev[ref] ?? '' }; });
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
    // full operational detail (addresses/notes withheld under PHI)
    linkedSo: (await poToSoMap())[safeRef('PO', r.id, r.poNumber)] ?? '',
    shipVia: nm(r.shipVia), lastUpdatedDate: r.lastUpdatedDate ?? null,
    notesLogCount: Number(r.notesLogCount ?? 0), attachmentCount: Number(r.attachmentCount ?? 0),
    isDropShip: !!r.dropShipPO, isBlanket: !!r.isBlanketPO, isFixedCost: !!r.isFixedCostPO,
    allowPartial: !!r.allowPartialFulfilment, isRecurring: !!r.isRecurring, needsReview: !!r.requiresInternalReview,
    total: Number(r.poTotal ?? 0), lineItems: mapLineItems(r.lineItems),
  };
}
// FULL sales-order detail — every operational field Striven returns. Under
// MASK_PHI: patient name → initials, addresses/notes/line descriptions dropped;
// products, prices, dates, people-who-worked-it and logistics stay visible.
async function getSODetail(id) {
  const r = await cached(`so-${id}`, () => striven('GET', `/v1/sales-orders/${id}`));
  const nm = (o) => o?.name ?? '';
  const orderedFlag = (li) => {
    const c = (li.customColumns ?? []).find((x) => /ordered/i.test(x?.name ?? ''));
    return c ? /^true$/i.test(String(c.value ?? c.valueText ?? '')) : null;
  };
  const lineItems = (r.lineItems ?? []).map((li) => ({
    item: li.item?.name ?? '',
    description: MASK_PHI ? '' : (li.description ?? ''),
    qty: Number(li.qty ?? 0),
    unit: Number(li.price ?? 0),
    amount: round2(Number(li.qty ?? 0) * Number(li.price ?? 0) + Number(li.shippingPrice ?? 0)),
    shipping: Number(li.shippingPrice ?? 0),
    taxable: !!li.taxable,
    ordered: orderedFlag(li),
  }));
  return {
    id: r.id, ref: safeRef('SO', r.id, r.orderNumber ?? r.number), customer: maskName(r.customer?.name),
    date: r.orderDate ?? r.dateCreated ?? null, total: Number(r.orderTotal ?? 0),
    status: r.status?.name ?? '', lineItemCount: lineItems.length,
    // full operational detail
    type: nm(r.type), program: soClass(nm(r.type)), invoiceStatus: nm(r.invoiceStatus),
    rep: cleanRep(nm(r.salesRep)), payer: payerOf(r),
    orderDate: r.orderDate ?? null, targetDate: r.targetDate ?? null,
    createdDate: r.dateCreated ?? null, createdBy: typeof r.createdBy === 'string' ? r.createdBy : nm(r.createdBy),
    lastUpdatedDate: r.lastUpdatedDate ?? null, lastUpdatedBy: typeof r.lastUpdatedBy === 'string' ? r.lastUpdatedBy : nm(r.lastUpdatedBy),
    paymentTerm: nm(r.paymentTerm), shipVia: nm(r.shipVia), trackingNumber: r.trackingNumber ?? '',
    customerPONumber: r.customerPONumber ?? '', arAccount: nm(r.arglAccount),
    salesTax: nm(r.salesTax), invoiceFormat: nm(r.invoiceFormat),
    isChangeOrder: !!r.isChangeOrder, isRecurring: !!r.isRecurring,
    notesLogCount: Number(r.notesLogCount ?? 0), attachmentCount: Number(r.attachmentCount ?? 0),
    lineItems, phiMasked: MASK_PHI,
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
// Data-quality / reconciliation exceptions — all computed from the cached datasets.
async function getExceptions() {
  const groups = [];
  const push = (o) => { if (o.count > 0) groups.push(o); };

  const payments = await allPayments();
  const unapplied = payments.filter((p) => Number(p.openBalance || 0) > 0);
  push({ key: 'unapplied_payments', severity: 'warn', title: 'Unapplied customer payments', count: unapplied.length, value: round2(unapplied.reduce((s, p) => s + Number(p.openBalance || 0), 0)), note: 'Customer paid but the payment is not applied to a specific invoice — inflates open AR until applied.', columns: ['ref', 'paid', 'unapplied', 'date'], rows: unapplied.slice(0, 25).map((p) => ({ ref: `PMT-${p.id}`, paid: round2(Number(p.paymentAmount || 0)), unapplied: round2(Number(p.openBalance || 0)), date: (p.paymentDate || p.dateCreated || '').slice(0, 10) })) });

  const invs = await allInvoices();
  const voidedOpen = invs.filter((r) => Number(r.openBalance || 0) > 0 && isVoidStatus(INVOICE_STATUS[r.id]));
  push({ key: 'voided_open_invoices', severity: 'high', title: 'Voided invoices still carrying an open balance', count: voidedOpen.length, value: round2(voidedOpen.reduce((s, r) => s + Number(r.openBalance || 0), 0)), note: 'Voided in Striven but still shows open — excluded from AR here. Should be cleared in Striven.', columns: ['ref', 'open', 'status'], rows: voidedOpen.slice(0, 25).map((r) => ({ ref: `#${r.txnNumber || r.id}`, open: round2(Number(r.openBalance || 0)), status: 'Voided' })) });

  const po = await poStatusMap();
  const cancelledPO = po.filter((r) => r.classified && poIsVoid(r));
  push({ key: 'cancelled_pos', severity: 'info', title: 'Cancelled POs excluded from PO spend', count: cancelledPO.length, value: round2(cancelledPO.reduce((s, r) => s + Number(r.poTotal || 0), 0)), note: 'Correctly excluded from PO Spend — listed for transparency.', columns: ['ref', 'vendor', 'value'], rows: cancelledPO.slice(0, 25).map((r) => ({ ref: `PO-${r.id}`, vendor: r.vendor?.name || '—', value: round2(Number(r.poTotal || 0)) })) });

  // Active POs whose line items carry no sales-order link — cannot be traced
  // to an order (may be stock/bulk purchases; worth reviewing in Striven).
  const revMap = await poToSoMap();
  const activePos = po.filter((r) => r.classified && !poIsVoid(r));
  const unlinked = activePos.filter((r) => !revMap[`PO-${r.id}`] && !revMap[String(r.poNumber ?? '')]);
  push({ key: 'unlinked_pos', severity: 'warn', title: 'Active POs not linked to a sales order', count: unlinked.length, value: round2(unlinked.reduce((s, r) => s + Number(r.poTotal || 0), 0)), note: 'No sales order on the PO line items — untraceable in Order Tracking. Some may be legitimate stock purchases.', columns: ['ref', 'vendor', 'value', 'status'], rows: unlinked.slice(0, 25).map((r) => ({ ref: `PO-${r.id}`, vendor: r.vendor?.name || '—', value: round2(Number(r.poTotal || 0)), status: r.statusName || '' })) });

  const sos = await allSO(); const det = await soDetailMap();
  const demo = sos.filter((r) => isDemoType(det[r.id]?.type));
  push({ key: 'demo_orders', severity: 'warn', title: 'DEMO / test sales orders', count: demo.length, value: round2(demo.reduce((s, r) => s + Number(det[r.id]?.total || 0), 0)), note: 'Test orders — excluded from sales totals. Should be archived in Striven.', columns: ['ref', 'type', 'value'], rows: demo.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, type: det[r.id]?.type || '', value: round2(Number(det[r.id]?.total || 0)) })) });
  const noRep = sos.filter((r) => { const t = det[r.id]?.type; return t && !isDemoType(t) && repIsUnassigned(det[r.id]?.rep); });
  push({ key: 'missing_rep', severity: 'warn', title: 'Sales orders with no sales rep', count: noRep.length, note: 'Rep is blank or "House Account" — needed for rep reporting.', columns: ['ref', 'rep', 'type'], rows: noRep.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, rep: cleanRep(det[r.id]?.rep) || '(none)', type: det[r.id]?.type || '' })) });
  const unclassified = sos.filter((r) => { const t = det[r.id]?.type; return t && !isDemoType(t) && soClass(t) === 'Other'; });
  push({ key: 'missing_pi_va', severity: 'warn', title: 'Sales orders not classified PI / VA / Tri-Care', count: unclassified.length, note: 'Order type does not map to PI, VA or Tri-Care.', columns: ['ref', 'type'], rows: unclassified.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, type: det[r.id]?.type || '(none)' })) });

  const items = await allItems();
  const noPrice = items.filter((i) => (i.active ?? false) && (Number(i.price || 0) === 0 || Number(i.cost || 0) === 0));
  push({ key: 'item_price', severity: 'info', title: 'Active items missing a cost or price', count: noPrice.length, note: 'Needed for margin / COGS. Not every missing value is an error.', columns: ['item', 'cost', 'price'], rows: noPrice.slice(0, 25).map((i) => ({ item: i.name || '—', cost: round2(Number(i.cost || 0)), price: round2(Number(i.price || 0)) })) });

  const totalOpen = groups.reduce((s, g) => s + g.count, 0);
  return { totalOpen, groups, note: 'Reconciliation with bank/card, QuickBooks, the 9 emailed AP invoices, and the Evo Health $9,375 item requires those sources — pending client input.' };
}
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
// Aggregation reports (vendor→items from POs, patient→items from SOs). Computed
// offline by scripts/gen-reports.mjs into these cache keys; cancelled excluded.
async function getReportVendorItems() {
  const r = await sbCacheRead('report_vendor_items');
  return r?.data ?? { vendors: [], count: 0, generatedAt: null, note: 'Report not generated yet.' };
}
async function getReportPatientItems() {
  const r = await sbCacheRead('report_patient_items');
  return r?.data ?? { patients: [], count: 0, generatedAt: null, note: 'Report not generated yet.' };
}

export const ROUTES = {
  '/api/health': async () => { const { clientId, clientSecret } = await getConfig(); return { ok: true, configured: Boolean(clientId && clientSecret), phiMasked: MASK_PHI }; },
  '/api/reports/vendor-items': getReportVendorItems,
  '/api/reports/patient-items': getReportPatientItems,
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
  '/api/exceptions': getExceptions,
  '/api/orders': getOrders,
};
export const DYNAMIC = [
  { re: /^\/api\/po\/(\d+)$/, handler: (m) => getPODetail(m[1]) },
  { re: /^\/api\/so\/(\d+)$/, handler: (m) => getSODetail(m[1]) },
];
// Out-of-band cache refresh (called by pg_cron every 6h). Guarded by a secret token.
export { refreshAll };
export const refreshTokenOk = (t) => { const want = process.env.REFRESH_TOKEN || ''; return Boolean(want) && String(t ?? '') === want; };

// ============================================================================
// AUTO-PO — raise a vendor Purchase Order automatically when a Sales Order is
// placed. DEMO-gated pilot + dry-run by default; nothing is created unless
// AUTO_PO_MODE=live (or ?mode=live) AND the order passes the gate.
// Trigger:  /api/auto-po?key=<AUTO_PO_KEY>[&so=<id>][&mode=dry|live]
// State:    striven_cache key 'auto_po_state' { lastSoId, processed[], log[] }
// ============================================================================
export const autoPoTokenOk = (t) => { const want = process.env.AUTO_PO_KEY || ''; return Boolean(want) && String(t ?? '') === want; };
const autoPoDemoOnly = () => (process.env.AUTO_PO_DEMO_ONLY ?? 'true') !== 'false';

async function autoPoState() {
  const sb = await sbCacheRead('auto_po_state');
  const s = (sb && sb.data) || {};
  return {
    lastSoId: Number(s.lastSoId || 0),
    processed: Array.isArray(s.processed) ? s.processed : [],
    log: Array.isArray(s.log) ? s.log : [],
  };
}

// Latest active PO that actually CONTAINS this item → vendor + a template line.
// The containment check means we stay correct even if the search filter is
// ignored by the API — we just scan the most recent POs.
async function previousPoForItem(itemId) {
  const b = await striven('POST', '/v1/purchase-orders/search', {
    ItemId: Number(itemId), PageIndex: 0, PageSize: 25, SortExpression: 'PurchaseOrderDate', SortOrder: '2',
  });
  const rows = b.data ?? b.Data ?? [];
  for (const r of rows.slice(0, 25)) {
    try {
      const po = await striven('GET', `/v1/purchase-orders/${r.id}`);
      if (/cancel|void|reject|denied/i.test(po.status?.name ?? '')) continue;
      const lines = po.lineItems ?? [];
      const line = lines.find((l) => Number(l.item?.id ?? l.itemId ?? 0) === Number(itemId));
      if (line && po.vendor?.id) return { po, line };
    } catch { /* skip unreadable PO */ }
  }
  return null;
}

function buildAutoPoPayload(prevPo, prevLine, { itemId, itemName, qty, soNumber, soCustomer }) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const p = clone(prevPo);
  p.id = 0;
  for (const k of ['purchaseOrderNumber', 'poNumber', 'number', 'dateCreated', 'createdDate', 'createdBy',
    'lastUpdatedDate', 'lastUpdatedBy', 'total', 'subTotal', 'subtotal', 'taxTotal', 'balance', 'customFields']) delete p[k];
  const now = new Date();
  p.purchaseOrderDate = now.toISOString();
  p.promiseDate = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  // Drop-ship to the CURRENT order's customer — never the previous order's.
  if (soCustomer && 'dropShipCustomer' in p) p.dropShipCustomer = clone(soCustomer);
  p.title = `Auto PO for SO ${soNumber}`;
  if ('memo' in p) p.memo = `Auto-created from Sales Order ${soNumber}`;
  const nl = clone(prevLine);
  nl.id = 0;
  for (const k of ['purchaseOrderLineItemId', 'purchaseOrderId', 'quantityReceived', 'quantityBilled',
    'amountReceived', 'amountBilled']) delete nl[k];
  nl.item = { ...(nl.item ?? {}), id: Number(itemId), name: String(itemName ?? nl.item?.name ?? '') };
  nl.quantity = Number(qty);
  p.lineItems = [nl];
  return p;
}

async function autoPoProcessSo(soId, mode) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const soNumber = String(so.orderNumber ?? so.number ?? soId);
  const typeName = so.type?.name ?? '';
  // soNumber is NOT logged: Striven order numbers embed the patient's surname
  // ("ADubberly DEMO Hidow"). soId identifies the order without carrying a name.
  const entry = { at: new Date().toISOString(), soId: Number(soId), type: typeName, mode, lines: [] };
  const testy = isDemoType(typeName) || /demo|test/i.test(so.customer?.name ?? '') || /demo|test/i.test(so.name ?? '');
  if (autoPoDemoOnly() && !testy) { entry.skipped = 'not a DEMO/test order (pilot gate)'; return entry; }
  const chainSb = await sbCacheRead('order_chain');
  const chain = (chainSb && chainSb.data) || {};
  if ((chain[String(soId)]?.pos ?? []).length) { entry.skipped = 'SO already has a linked PO'; return entry; }
  const lines = so.lineItems ?? [];
  if (!lines.length) { entry.skipped = 'no line items on SO'; return entry; }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const itemId = l.item?.id ?? l.itemId ?? null;
    const itemName = l.item?.name ?? l.itemName ?? `Line ${i + 1}`;
    const qty = Number(l.quantity ?? l.qty ?? 0);
    const li = { itemId, itemName, qty };
    entry.lines.push(li);
    if (!itemId || qty <= 0) { li.result = 'skipped: missing item id or quantity'; continue; }
    const prev = await previousPoForItem(itemId);
    if (!prev) { li.result = 'no previous PO contains this item — vendor unknown (add mapping later)'; continue; }
    li.vendor = prev.po.vendor?.name ?? '';
    const payload = buildAutoPoPayload(prev.po, prev.line, { itemId, itemName, qty, soNumber, soCustomer: so.customer ?? null });
    if (mode === 'live') {
      const created = await striven('POST', '/v1/purchase-orders', payload);
      li.result = 'PO CREATED';
      li.poId = created?.id ?? created?.data?.id ?? null;
    } else {
      li.result = 'DRY-RUN: PO would be created';
      // The payload sent to Striven keeps the real name — Striven is the system
      // of record. What we persist in our own log never does.
      li.plan = {
        vendor: li.vendor, qty,
        unitPrice: payload.lineItems?.[0]?.unitPrice ?? payload.lineItems?.[0]?.price ?? null,
        dropShipTo: payload.dropShipCustomer?.id ? `PT-${payload.dropShipCustomer.id}` : null,
      };
    }
  }
  return entry;
}

// Recent sales orders for the UI to pick from — ONE live search call (no per-SO
// detail fetch, so it stays fast and can't time out). PHI stays server-side:
// only the id-based ref, date, a non-PHI class and two booleans leave the server.
async function autoPoCandidates() {
  const b = await striven('POST', '/v1/sales-orders/search', { PageIndex: 0, PageSize: 25, SortExpression: 'DateCreated', SortOrder: '2' });
  const rows = b.data ?? b.Data ?? [];
  const chainSb = await sbCacheRead('order_chain');
  const chain = (chainSb && chainSb.data) || {};
  return rows.map((r) => {
    const soId = Number(r.id);
    const c = chain[String(soId)] || {};
    const type = c.type || '';
    // 'testy' is derived from PHI-bearing fields (order number embeds the patient
    // surname, customer name) here on the server — only the boolean is emitted.
    const testy = isDemoType(type)
      || /demo|test|sample/i.test(r.number ?? r.orderNumber ?? '')
      || /demo|test/i.test(r.customerName ?? r.customer?.name ?? '');
    return {
      soId,
      ref: safeRef('SO', soId, r.number ?? r.orderNumber),
      date: r.dateCreated ?? r.orderDate ?? null,
      kind: testy ? 'DEMO / test' : (type ? soClass(type) : '—'),
      testy,
      hasPo: (c.pos ?? []).length > 0,
    };
  });
}

export async function autoPoRun(params = {}) {
  const mode = params.mode === 'live' ? 'live' : (process.env.AUTO_PO_MODE === 'live' ? 'live' : 'dry');
  const state = await autoPoState();
  if (params.action === 'candidates') {
    return { ok: true, mode, demoOnly: autoPoDemoOnly(), candidates: await autoPoCandidates() };
  }
  if (params.action === 'status') {
    return {
      ok: true, mode, demoOnly: autoPoDemoOnly(), checkpoint: state.lastSoId,
      processedCount: state.processed.length, log: state.log.slice(0, 20),
    };
  }
  const results = [];
  if (params.so) {
    // Debug/demo: push ONE specific SO through the pipeline.
    const soId = Number(params.so);
    if (mode === 'live' && state.processed.includes(soId)) {
      return { ok: true, mode, note: `SO ${soId} already processed — idempotency guard`, checkpoint: state.lastSoId };
    }
    const entry = await autoPoProcessSo(soId, mode);
    results.push(entry);
    if (mode === 'live' && !entry.skipped) state.processed.push(soId);
  } else {
    // Poll: process new SOs beyond the checkpoint (max 3 per run).
    const b = await striven('POST', '/v1/sales-orders/search', { PageIndex: 0, PageSize: 25, SortExpression: 'DateCreated', SortOrder: '2' });
    const ids = (b.data ?? b.Data ?? []).map((r) => Number(r.id)).filter((n) => n > 0);
    if (!ids.length) return { ok: true, mode, note: 'no sales orders returned' };
    if (!state.lastSoId) {
      state.lastSoId = Math.max(...ids);
      await sbCacheWrite('auto_po_state', state);
      return { ok: true, mode, note: `baselined checkpoint at SO id ${state.lastSoId} — nothing processed, older orders are safe` };
    }
    const fresh = ids.filter((n) => n > state.lastSoId && !state.processed.includes(n)).sort((a, b) => a - b).slice(0, 3);
    for (const soId of fresh) {
      const entry = await autoPoProcessSo(soId, mode);
      results.push(entry);
      state.lastSoId = Math.max(state.lastSoId, soId);
      if (mode === 'live' && !entry.skipped) state.processed.push(soId);
    }
  }
  state.processed = state.processed.slice(-500);
  state.log = [...results, ...state.log].slice(0, 50);
  await sbCacheWrite('auto_po_state', state);
  return { ok: true, mode, demoOnly: autoPoDemoOnly(), processed: results, checkpoint: state.lastSoId };
}
