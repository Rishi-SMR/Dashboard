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
// Payer text → program bucket (mirrors the client's programOfPayer). PI = a law
// firm / attorney's office (anything not VA or TriCare); VA = Veterans Affairs;
// TriCare = the TriCare program. Empty payer → Unassigned.
const programOfPayer = (payer) => {
  const s = String(payer ?? '').trim();
  if (!s) return 'Unassigned';
  if (/tri.?care/i.test(s)) return 'TriCare';
  if (/veteran|\bva\b/i.test(s)) return 'VA';
  return 'PI';
};

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

  // By rep: order COUNT + dollar value + UNIT count. Client SOW: rank PI reps by
  // order count, VA reps by UNIT count (VA pays per unit) — dollar value misranks
  // (a VA rep can out-produce a PI rep on volume yet show a lower $ figure). The
  // UI toggles which metric to rank by. Units join from the SO-wise report cache.
  const repRep = await sbCacheRead('report_patient_items');
  const unitsBySo = new Map();
  for (const o of (repRep?.data?.orders || [])) unitsBySo.set(String(o.soId), (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0));
  const byRepMap = {};
  for (const r of book) {
    const rep = cleanRep(r.d.rep) || 'Unassigned';
    if (!byRepMap[rep]) byRepMap[rep] = { count: 0, value: 0, units: 0 };
    byRepMap[rep].count += 1;
    byRepMap[rep].value += Number(r.d.total || 0);
    byRepMap[rep].units += unitsBySo.get(String(r.id)) || 0;
  }
  const byRep = Object.entries(byRepMap).map(([rep, v]) => ({ rep, count: v.count, value: round2(v.value), units: v.units })).sort((a, b) => b.count - a.count || b.value - a.value);

  // The COMPLETE live order list (each row carries its status for filtering).
  const recent = live.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => ({ id: r.id, ref: safeRef('SO', r.id, r.number), type: soClass(r.d.type), rep: cleanRep(r.d.rep), payer: payerOf(r.d), value: Number(r.d.total || 0), status: soStatusOf(r), invStatus: r.d.invStatus || '', date: r.dateCreated ?? null }));

  // Commission engine base: month × program × rep volume (orders + units + value)
  // from the same enriched book. getCommission applies the rate card → $ (mirrors
  // Crystal's monthly workbook, but sourced from Striven instead of the sheet).
  const commAgg = {};
  for (const r of book) {
    const prog = soClass(r.d.type);
    if (prog === 'Other') continue;
    const month = (r.dateCreated || '').slice(0, 7) || 'unknown';
    const rep = cleanRep(r.d.rep) || 'Unassigned';
    const key = `${month}|${prog}|${rep}`;
    commAgg[key] = commAgg[key] || { month, program: prog, rep, orders: 0, units: 0, value: 0 };
    commAgg[key].orders += 1;
    commAgg[key].units += unitsBySo.get(String(r.id)) || 0;
    commAgg[key].value += Number(r.d.total || 0);
  }
  const commByMonth = Object.values(commAgg).map((x) => ({ ...x, value: round2(x.value) }));

  return {
    count: book.length, totalValue, piva, byType, byStatus, byRep, recent, statusGroups,
    commByMonth,
    liveCount: live.length, demoCount: enriched.length - live.length,
    enriched: Object.keys(det).length > 0, phiMasked: MASK_PHI,
  };
}
// Order-to-cash chain (SO -> linked POs + invoices), keyed by order number, no PHI.
async function getOrders() {
  const sb = await sbCacheRead('order_chain');
  const chain = (sb && sb.data) || {};
  // Join patient LAST NAME + item from the SO-wise report cache so reps (who lose
  // Striven access) can identify an order by SO# + last name + item. Minimum-
  // necessary PHI (client-authorized); the report cache already carries it.
  const rep = await sbCacheRead('report_patient_items');
  const bySo = new Map();
  for (const o of (rep?.data?.orders || [])) bySo.set(String(o.soId), o);
  const orders = Object.entries(chain)
    .filter(([, o]) => !isDemoType(o.type))
    .map(([soId, o]) => {
      const r = bySo.get(String(soId));
      const items = (r?.items || []).map((i) => i.item).filter(Boolean);
      return {
        ref: o.ref, pi: soClass(o.type), type: o.type, rep: cleanRep(o.rep), payer: payerOf(o), value: round2(Number(o.value || 0)),
        lastName: r?.lastName || '', item: items[0] || '', itemCount: items.length,
        status: o.status || '', invStatus: o.invStatus || '',
        pos: (o.pos || []).map((p) => ({ ...p, value: round2(Number(p.value || 0)) })),
        invoices: (o.invoices || []).map((i) => ({ ...i, total: round2(Number(i.total || 0)), open: round2(Number(i.open || 0)) })),
        poValue: round2((o.pos || []).reduce((s, p) => s + Number(p.value || 0), 0)),
        invOpen: round2((o.invoices || []).reduce((s, i) => s + Number(i.open || 0), 0)),
      };
    })
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
  const invs = await allInvoices();
  // Classify each customer's program from their invoices' payer so PI can be
  // excluded from the unapplied-payment check: a PI claim files a 15% advance
  // that ALWAYS leaves a residual by design, which would otherwise flood this
  // list. VA / TriCare / other payments should apply one-for-one, so an
  // unapplied balance there is a genuine anomaly worth surfacing.
  const payerByInv = await invoicePayerMap();
  const custProgram = new Map();
  for (const r of invs) {
    const cid = r.customer?.id; if (!cid || custProgram.has(cid)) continue;
    const prog = programOfPayer(payerByInv[String(r.txnNumber ?? r.id)] || '');
    if (prog !== 'Unassigned') custProgram.set(cid, prog);
  }
  const unapplied = payments.filter((p) => Number(p.openBalance || 0) > 0 && custProgram.get(p.customer?.id) !== 'PI');
  push({ key: 'unapplied_payments', severity: 'warn', title: 'Unapplied customer payments (excl. PI advances)', count: unapplied.length, value: round2(unapplied.reduce((s, p) => s + Number(p.openBalance || 0), 0)), note: 'VA / other payments should apply one-for-one, so an unapplied balance is a real anomaly. PI advances (15% retainer) always leave a residual by design and are excluded here.', columns: ['ref', 'paid', 'unapplied', 'date'], rows: unapplied.slice(0, 25).map((p) => ({ ref: `PMT-${p.id}`, paid: round2(Number(p.paymentAmount || 0)), unapplied: round2(Number(p.openBalance || 0)), date: (p.paymentDate || p.dateCreated || '').slice(0, 10) })) });

  const voidedOpen = invs.filter((r) => Number(r.openBalance || 0) > 0 && isVoidStatus(INVOICE_STATUS[r.id]));
  push({ key: 'voided_open_invoices', severity: 'high', title: 'Voided invoices still carrying an open balance', count: voidedOpen.length, value: round2(voidedOpen.reduce((s, r) => s + Number(r.openBalance || 0), 0)), note: 'Voided in Striven but still shows open — excluded from AR here. Should be cleared in Striven.', columns: ['ref', 'open', 'status'], rows: voidedOpen.slice(0, 25).map((r) => ({ ref: `#${r.txnNumber || r.id}`, open: round2(Number(r.openBalance || 0)), status: 'Voided' })) });

  // (Per client SOW) Cancelled POs and active POs not linked to a sales order
  // are intentionally NOT flagged here: cancelled POs are correctly excluded
  // from PO spend already, and unlinked POs are by design (true stock/bulk
  // purchases ordered outside an order) — surfacing them was just noise.

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

// AUTO-SO (recurring resupply) — READ-ONLY candidate preview. Reads the SO-wise
// order cache (built by scripts/gen-reports.mjs) and, per patient, surfaces their
// most recent order + how long ago it was, so staff can see who is due for a
// resupply and one-click-draft a repeat order. Creates NOTHING — live SO creation
// is a deliberate, separately-gated follow-up. Nothing is written to Striven here.
async function getAutoSoCandidates() {
  const r = await sbCacheRead('report_patient_items');
  const orders = r?.data?.orders || [];
  if (!orders.length) {
    return { ok: true, ready: false, candidates: [], count: 0, dueCount: 0,
      note: 'Run `node scripts/gen-reports.mjs` to build the sales-order-wise data this reads.' };
  }
  const DUE_DAYS = Number(process.env.AUTO_SO_DUE_DAYS || 30);
  const byPatient = new Map();
  for (const o of orders) {
    if (o.incomplete) continue;
    const key = o.custRef || o.ref || `SO-${o.soId}`;
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key).push(o);
  }
  const now = Date.now();
  const candidates = [];
  for (const [key, os] of byPatient) {
    os.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const last = os[0];
    const lastMs = last.date ? new Date(last.date).getTime() : NaN;
    const daysSince = Number.isFinite(lastMs) ? Math.floor((now - lastMs) / 86_400_000) : null;
    candidates.push({
      patient: key, lastName: last.lastName || '', program: last.program || '—',
      orderCount: os.length, lastSo: last.so, lastSoId: last.soId, lastDate: last.date || null, daysSince,
      due: daysSince != null && daysSince >= DUE_DAYS,
      items: (last.items || []).map((i) => ({ item: i.item, qty: i.qty })),
      value: last.value || 0,
    });
  }
  candidates.sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1));
  return { ok: true, ready: true, dueDays: DUE_DAYS, count: candidates.length, demoOnly: autoSoDemoOnly(),
    dueCount: candidates.filter((c) => c.due).length, generatedAt: r?.data?.generatedAt ?? null, candidates };
}

// ---- AUTO-SO: create a resupply Sales Order (dry-run default, DEMO-gated) ----
// Mirrors the Auto-PO safety model: cron-key OR UI-session, dry-run unless
// mode=live, and a pilot gate so only DEMO/test patients can create until the
// client flips AUTO_SO_DEMO_ONLY=false. Nothing is written to Striven unless
// mode=live AND the gate passes.
export const autoSoTokenOk = (t) => { const want = process.env.AUTO_SO_KEY || ''; return Boolean(want) && String(t ?? '') === want; };
const autoSoDemoOnly = () => (process.env.AUTO_SO_DEMO_ONLY ?? 'true') !== 'false';
async function autoSoState() { const sb = await sbCacheRead('auto_so_state'); return (sb && sb.data) || { created: [] }; }

// Build the new SO payload by cloning the patient's last order — reset every
// transaction/audit/status field and line id, keep customer + type + shipTo +
// case customFields + the line items, stamp today's order date.
function autoSoBuildPayload(lastSo) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const p = clone(lastSo);
  p.id = 0;
  for (const k of ['orderNumber', 'number', 'dateCreated', 'createdDate', 'createdBy', 'lastUpdatedDate',
    'lastUpdatedBy', 'total', 'subTotal', 'subtotal', 'taxTotal', 'balance', 'invoiceStatus', 'invoiceStatusName',
    'status', 'statusName', 'shippedDate', 'completedDate', 'closedDate']) delete p[k];
  p.orderDate = new Date().toISOString();
  p.title = 'Auto resupply';
  if ('memo' in p) p.memo = 'Auto-created resupply (repeat of the patient’s prior order)';
  p.lineItems = (lastSo.lineItems ?? []).map((l) => {
    const nl = clone(l);
    nl.id = 0;
    for (const k of ['salesOrderLineItemId', 'salesOrderId', 'quantityShipped', 'quantityInvoiced',
      'quantityBackordered', 'amountInvoiced', 'amountShipped']) delete nl[k];
    return nl;
  });
  return p;
}

const soIsTesty = (so) => isDemoType(so?.type?.name ?? '') || /demo|test/i.test(so?.customer?.name ?? '') || /demo|test/i.test(so?.name ?? '');

// Dry preview: what the resupply SO WOULD contain (no write, no patient name).
async function autoSoPreview(soId) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const payload = autoSoBuildPayload(so);
  const items = (payload.lineItems ?? []).map((l) => ({ itemName: l.item?.name ?? l.itemName ?? '', qty: Number(l.quantity ?? l.qty ?? 0) }));
  return {
    ok: true, mode: 'dry', demoOnly: autoSoDemoOnly(), testy: soIsTesty(so),
    templateSo: safeRef('SO', soId, so.orderNumber ?? so.number), customerId: so.customer?.id ?? null,
    type: so.type?.name ?? '', itemCount: items.length, items,
  };
}

// Create the resupply SO for the patient whose last order is `soId`.
async function autoSoCreate(soId, mode) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const testy = soIsTesty(so);
  const entry = { at: new Date().toISOString(), templateSoId: Number(soId), mode, testy, ref: safeRef('SO', soId, so.orderNumber ?? so.number) };
  if (autoSoDemoOnly() && !testy) { entry.skipped = 'not a DEMO/test patient (pilot gate)'; return { ok: true, mode, demoOnly: true, processed: [entry] }; }
  // Idempotency: don't re-create a resupply for the same customer within the window.
  const state = await autoSoState();
  const custId = so.customer?.id ?? 0;
  const dedupMs = Number(process.env.AUTO_SO_DEDUP_DAYS || 14) * 86_400_000;
  const recent = (state.created ?? []).find((c) => c.custId === custId && (Date.now() - new Date(c.at).getTime()) < dedupMs);
  if (recent) { entry.skipped = `resupply already created for this patient on ${String(recent.at).slice(0, 10)}`; return { ok: true, mode, demoOnly: autoSoDemoOnly(), processed: [entry] }; }
  const payload = autoSoBuildPayload(so);
  entry.itemCount = (payload.lineItems ?? []).length;
  if (mode !== 'live') { entry.dryRun = true; return { ok: true, mode: 'dry', demoOnly: autoSoDemoOnly(), processed: [entry] }; }
  const created = await striven('POST', '/v1/sales-orders', payload);
  const newId = created?.id ?? created?.Id ?? null;
  entry.createdSoId = newId;
  state.created = [...(state.created ?? []), { custId, at: entry.at, soId: newId }].slice(-1000);
  await sbCacheWrite('auto_so_state', state);
  return { ok: true, mode: 'live', demoOnly: autoSoDemoOnly(), processed: [entry], createdSoId: newId };
}

// Dispatcher for /api/auto-so — action=candidates (default) | preview | create.
export async function autoSoRun(params = {}) {
  const action = params.action || '';
  const soId = params.so;
  const mode = params.mode || (process.env.AUTO_SO_MODE || 'dry');
  if (action === 'preview' && soId) return autoSoPreview(soId);
  if (soId && action !== 'candidates') return autoSoCreate(soId, mode);
  return getAutoSoCandidates();
}

// ============================================================================
// SHIPMENT TRACKING — vendor tracking numbers matched to a patient (last name /
// ship-to), with LIVE carrier status via Shippo. Vendor invoices carry NO SO
// number, so entries are keyed by last name / ship-to (client-authorized min-
// necessary PHI). Store = Supabase cache `shipment_tracking`. Token read from
// app_config SHIPPO_TOKEN (or env) — never in code/git.
// ============================================================================
async function shippoToken() {
  const t = await readConfigTable().catch(() => ({}));
  return t.SHIPPO_TOKEN || process.env.SHIPPO_TOKEN || '';
}
// Heuristic carrier detection → Shippo carrier token (user can override in the UI).
function detectCarrier(tnRaw) {
  const tn = String(tnRaw || '').replace(/\s+/g, '').toUpperCase();
  if (!tn) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(tn)) return 'ups';
  if (/^9[0-5]\d{16,}$/.test(tn) || /^420\d{5}9[0-5]/.test(tn)) return 'usps';   // USPS: 9x… (19–22 digits)
  if (/^(96|61|77|79|98)\d{10,}$/.test(tn)) return 'fedex';
  if (/^\d{10}$/.test(tn)) return 'dhl_express';
  if (tn.length === 12 || tn.length === 15) return 'fedex';
  if (/^\d{18,22}$/.test(tn)) return 'usps';
  return null;
}
const CARRIER_NAME = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl_express: 'DHL' };
const CARRIER_URL = {
  ups: (tn) => `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`,
  fedex: (tn) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}`,
  usps: (tn) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tn)}`,
  dhl_express: (tn) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(tn)}`,
};
const SHIPPO_STATUS = { PRE_TRANSIT: 'Label created', TRANSIT: 'In transit', DELIVERED: 'Delivered', RETURNED: 'Returned', FAILURE: 'Exception', UNKNOWN: 'Unknown' };
async function shippoTrack(carrier, tn) {
  const token = await shippoToken();
  if (!token) return { ok: false, error: 'no_token', status: 'Shippo not configured' };
  if (!carrier) return { ok: false, error: 'no_carrier', status: 'Pick a carrier' };
  try {
    const r = await fetch(`https://api.goshippo.com/tracks/${carrier}/${encodeURIComponent(tn)}`, { headers: { Authorization: `ShippoToken ${token}` } });
    if (r.status === 401) return { ok: false, error: 'bad_token', status: 'Shippo token invalid' };
    if (!r.ok) return { ok: false, error: `http_${r.status}`, status: 'Lookup failed' };
    const j = await r.json();
    const ts = j.tracking_status || {};
    return {
      ok: true, raw: ts.status || 'UNKNOWN', status: SHIPPO_STATUS[ts.status] || ts.status || 'Unknown',
      detail: ts.status_details || '', eta: j.eta || null, updatedAt: ts.status_date || null,
      location: ts.location ? [ts.location.city, ts.location.state].filter(Boolean).join(', ') : '',
    };
  } catch { return { ok: false, error: 'fetch_failed', status: 'Lookup failed' }; }
}
async function trackingStore() { const sb = await sbCacheRead('shipment_tracking'); return (sb && sb.data) || { entries: [] }; }
async function trackingList() {
  const store = await trackingStore();
  const entries = store.entries || [];
  const configured = Boolean(await shippoToken());
  const out = await Promise.all(entries.map(async (e) => {
    const carrier = e.carrier || detectCarrier(e.tn) || '';
    const st = await shippoTrack(carrier, e.tn);
    return {
      id: e.id, patient: e.patient || '', vendor: e.vendor || '', tn: e.tn, addedAt: e.addedAt || null,
      carrier, carrierName: CARRIER_NAME[carrier] || (carrier ? carrier.toUpperCase() : '—'),
      trackingUrl: (CARRIER_URL[carrier] || (() => ''))(e.tn),
      status: st.status, statusRaw: st.raw || '', detail: st.detail || '', eta: st.eta || null,
      statusUpdatedAt: st.updatedAt || null, location: st.location || '', lookupError: st.ok ? null : st.error,
    };
  }));
  return { ok: true, configured, count: out.length, entries: out };
}
async function trackingAdd(body) {
  const tn = String(body?.tn || '').replace(/\s+/g, '').trim();
  if (!tn) return { ok: false, error: 'tracking number required' };
  const store = await trackingStore();
  const id = `TRK-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  const entry = { id, patient: String(body?.patient || '').trim(), vendor: String(body?.vendor || '').trim(),
    carrier: String(body?.carrier || '').trim() || detectCarrier(tn) || '', tn, addedAt: new Date().toISOString() };
  store.entries = [entry, ...(store.entries || [])].slice(0, 2000);
  await sbCacheWrite('shipment_tracking', store);
  return { ok: true, id };
}
async function trackingRemove(id) {
  const store = await trackingStore();
  store.entries = (store.entries || []).filter((e) => e.id !== String(id));
  await sbCacheWrite('shipment_tracking', store);
  return { ok: true };
}
export async function trackingRun(params = {}, body = null) {
  const action = params.action || 'list';
  if (action === 'add') return trackingAdd(body || {});
  if (action === 'remove') return trackingRemove(params.id);
  return trackingList();
}

// ============================================================================
// COMMISSION — reads Crystal's commission workbook(s) (Google Sheets, public CSV
// export) and aggregates accrual by rep + program. Rows are Patient | Rep |
// Device | Commission, under TRICARE / PERSONAL INJURY / VA section headers.
// The sheets carry FULL patient names (PHI) — we NEVER emit them, only per-rep /
// program / total aggregates. Configure via app_config COMMISSION_SHEETS = JSON
// array [{id,gid,label}] (defaults to the two known sheets / current-period tab).
// ============================================================================
// No sheet IDs are hardcoded — the commission workbook(s) live in Supabase
// app_config key COMMISSION_SHEETS (JSON array of {id,gid,label}), the same
// config-not-code pattern as the Striven / Shippo / QB creds. Empty = not set up.
const COMMISSION_DEFAULT = [];
const commMoney = (s) => Number(String(s || '').replace(/[$,]/g, '')) || 0;
const commRep = (r) => { const s = String(r || '').trim(); if (/cassie/i.test(s)) return 'Cassie'; if (/jillian/i.test(s)) return 'Jillian'; if (/all?e ?ann?e?/i.test(s)) return 'Alle Ann'; if (/christ/i.test(s)) return 'Christy'; return s || 'Unknown'; };
// Patient last name from either "Last, First" or "FIRST LAST" — normalized for join.
const commLastName = (name) => { let s = String(name || '').trim(); if (!s) return ''; if (s.includes(',')) s = s.split(',')[0]; else { const t = s.split(/\s+/); s = t[t.length - 1]; } return s.replace(/[^A-Za-z]/g, '').toUpperCase(); };
// Display last name — original case, HIPAA minimum-necessary (last name only, no
// first name), matching the authorized last-name pattern used in order-tracking.
const commLastDisp = (name) => { let s = String(name || '').trim(); if (!s) return ''; if (s.includes(',')) s = s.split(',')[0]; else { const t = s.split(/\s+/); s = t[t.length - 1]; } return s.replace(/[^A-Za-z\-']/g, '').trim(); };
function commParseRow(line) { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }
// Enumerate every tab (gid + name) of a workbook from its public htmlview.
// Tab names are pay-period dates like "6/15/2026" → surfaced as month labels.
async function commissionTabs(id) {
  try {
    const html = await (await fetch(`https://docs.google.com/spreadsheets/d/${id}/htmlview`)).text();
    const names = {};
    const re = /gid=(\d+)",\s*gid:\s*"\d+",initialSheet:[^}]*\}\);items\.push\(\{name:\s*"([^"]*)"/g;
    let m; while ((m = re.exec(html))) names[m[1]] = m[2].replace(/\\\//g, '/');
    const gids = [...new Set((html.match(/gid=(\d+)/g) || []).map((x) => x.slice(4)))];
    return (gids.length ? gids : ['0']).map((gid) => ({ gid, name: names[gid] || '' }));
  } catch { return [{ gid: '0', name: '' }]; }
}
// "6/15/2026" (pay date) → { label:'Jun 2026', key:'2026-06' } for clean tabs.
function commPeriodMeta(name, gid) {
  const M = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((name || '').trim());
  if (d) return { label: `${M[+d[1]] || d[1]} ${d[3]}`, key: `${d[3]}-${String(+d[1]).padStart(2, '0')}` };
  return { label: name || `Tab ${gid}`, key: name || gid };
}
function commParseCsv(csv) {
  let prog = null; const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    const c = commParseRow(line); const a = (c[0] || '').trim().toUpperCase();
    if (a.includes('TRICARE')) prog = 'TriCare'; else if (a.includes('PERSONAL INJURY')) prog = 'PI'; else if (a.includes('VA COMMISSION')) prog = 'VA';
    if (!prog || !c[1]) continue;
    const p = (c[0] || '').trim(); if (!/^[A-Za-z]/.test(p) || p.toUpperCase() === 'PATIENT') continue;
    const comm = commMoney(c[3]); if (!comm) continue;
    rows.push({ rep: commRep(c[1]), prog, comm, last: commLastName(p), lastDisp: commLastDisp(p), device: (c[2] || '').trim() });
  }
  return rows;
}
async function getCommission() {
  const cfg = await readConfigTable().catch(() => ({}));
  let sheets = COMMISSION_DEFAULT;
  try { if (cfg.COMMISSION_SHEETS) sheets = JSON.parse(cfg.COMMISSION_SHEETS); } catch { /* keep default */ }
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return { ok: true, configured: false, note: 'No commission sheet configured — set COMMISSION_SHEETS in app_config (JSON array of {id,gid,label}).', grandTotal: 0, byProgram: { TriCare: 0, PI: 0, VA: 0 }, reps: [], itemCount: 0, sheetsRead: 0, sheetsConfigured: 0, errors: [], sources: [] };
  }
  const agg = {};
  const allLines = [];
  const byProgram = { TriCare: 0, PI: 0, VA: 0 };
  const periods = [];
  let grandTotal = 0, rowCount = 0, sheetsRead = 0;
  const errors = [];
  const progKey = (p) => (p === 'TriCare' ? 'tricare' : p === 'VA' ? 'va' : 'pi');
  for (const sh of sheets) {
    const tabs = await commissionTabs(sh.id);
    let anyTab = false;
    for (const t of tabs) {
      const gid = t.gid;
      let csv;
      try { csv = await (await fetch(`https://docs.google.com/spreadsheets/d/${sh.id}/export?format=csv&gid=${gid}`)).text(); } catch { continue; }
      if (/^\s*<(!doctype|html)/i.test(csv)) continue;
      const rows = commParseCsv(csv);
      if (!rows.length) continue;
      anyTab = true;
      const ptot = rows.reduce((s, r) => s + r.comm, 0);
      const meta = commPeriodMeta(t.name, gid);
      // per-rep within this pay period
      const prMap = {};
      for (const r of rows) {
        prMap[r.rep] = prMap[r.rep] || { rep: r.rep, tricare: 0, va: 0, pi: 0, total: 0, count: 0 };
        prMap[r.rep][progKey(r.prog)] += r.comm; prMap[r.rep].total += r.comm; prMap[r.rep].count++;
        agg[r.rep] = agg[r.rep] || { TriCare: 0, PI: 0, VA: 0, count: 0 };
        agg[r.rep][r.prog] += r.comm; agg[r.rep].count++;
        byProgram[r.prog] += r.comm; grandTotal += r.comm; rowCount++;
        allLines.push({ rep: r.rep, last: r.last, lastDisp: r.lastDisp, device: r.device, prog: r.prog, comm: r.comm });
      }
      const preps = Object.values(prMap).map((x) => ({ ...x, tricare: round2(x.tricare), va: round2(x.va), pi: round2(x.pi), total: round2(x.total) })).sort((a, b) => b.total - a.total);
      periods.push({ workbook: sh.label || 'sheet', gid, label: meta.label, key: meta.key, lines: rows.length, total: round2(ptot), reps: preps });
    }
    if (anyTab) sheetsRead++; else errors.push(`${sh.label || sh.id} (no readable tabs — share as "anyone with the link can view")`);
  }
  // CFO reconciliation vs Striven order attribution.
  let byRep = [], commByMonth = [], recent = [];
  try { const so = await getSO(); byRep = so.byRep || []; commByMonth = so.commByMonth || []; recent = so.recent || []; } catch { /* Striven optional */ }
  const findSr = (rep) => byRep.find((x) => commRep(x.rep) === rep);
  // Patient-level join: last name → which rep Striven books the order under.
  // Names stay backend-only; only per-rep aggregates leave this function (PHI-safe).
  const nameIdx = new Map();
  try {
    for (const o of ((await getOrders()).orders || [])) {
      const ln = commLastName(o.lastName); if (!ln) continue;
      if (!nameIdx.has(ln)) nameIdx.set(ln, []);
      nameIdx.get(ln).push(commRep(o.rep));
    }
  } catch { /* Striven optional */ }
  const reconOf = (rep) => {
    const R = { same: 0, diff: 0, none: 0, commSame: 0, commDiff: 0, commNone: 0, under: {} };
    const lines = [];
    for (const L of allLines) {
      if (L.rep !== rep) continue;
      const cand = L.last ? nameIdx.get(L.last) : null;
      let status, under = null;
      if (!cand || !cand.length) { R.none++; R.commNone += L.comm; status = 'none'; }
      else if (cand.includes(rep)) { R.same++; R.commSame += L.comm; status = 'same'; }
      else { R.diff++; R.commDiff += L.comm; under = cand[0]; R.under[under] = (R.under[under] || 0) + 1; status = 'diff'; }
      // line detail — last name only (HIPAA minimum-necessary), device, program, $
      lines.push({ last: L.lastDisp || '', device: L.device || '', prog: L.prog, comm: round2(L.comm), status, under });
    }
    lines.sort((a, b) => b.comm - a.comm);
    const bookedUnder = Object.entries(R.under).map(([r, n]) => ({ rep: r, count: n })).sort((a, b) => b.count - a.count);
    return { same: R.same, diff: R.diff, none: R.none, commSame: round2(R.commSame), commDiff: round2(R.commDiff), commNone: round2(R.commNone), bookedUnder, lines };
  };
  const reps = Object.entries(agg).map(([rep, v]) => {
    const total = v.TriCare + v.PI + v.VA;
    const sr = findSr(rep);
    const sv = sr ? sr.value : 0, sc = sr ? sr.count : 0, su = sr ? sr.units : 0;
    const pctOfValue = sv > 0 ? Math.round((total / sv) * 1000) / 10 : null;
    const recon = reconOf(rep);
    const matchRate = v.count > 0 ? Math.round((recon.same / v.count) * 100) : null;
    // Flag on patient-level attribution: <50% of a rep's lines match their own
    // Striven orders is a real attribution break (not just a $-ratio artifact).
    const flag = (matchRate != null && matchRate < 50) ? 'attribution' : (!sr ? 'no-striven' : (pctOfValue != null && pctOfValue > 60 ? 'high-ratio' : null));
    return {
      rep, tricare: round2(v.TriCare), pi: round2(v.PI), va: round2(v.VA), total: round2(total), count: v.count,
      strivenOrders: sc, strivenUnits: su, strivenValue: round2(sv),
      commPerOrder: sc ? Math.round(total / sc) : null, pctOfValue, matchRate, recon, flag,
    };
  }).sort((a, b) => b.total - a.total);
  periods.sort((a, b) => String(b.key).localeCompare(String(a.key)));

  // ── Commission computed FROM STRIVEN (rate card) — mirrors the sheet's monthly
  // + TriCare/PI/VA structure, but sourced from Striven orders, so it no longer
  // depends on the manual workbook. VA is exact; TriCare/PI are estimates from a
  // rate card derived off the historical sheet (update RATE when the client
  // confirms the official rates).
  const RATE = {
    VA: { basis: 'unit', rate: 425, exact: true, note: '$425 / unit (validated)' },
    TriCare: { basis: 'order', rate: 369.78, exact: false, note: '$369.78 / order (est., sheet avg)' },
    PI: { basis: 'value', rate: 0.02677, exact: false, note: '2.677% of order value (est., derived)' },
  };
  const commFor = (prog, o) => {
    const R = RATE[prog]; if (!R) return 0;
    if (R.basis === 'unit') return o.units * R.rate;
    if (R.basis === 'order') return o.orders * R.rate;
    return o.value * R.rate;
  };
  const months = {}; const sByRep = {}; const sByProgram = { TriCare: 0, VA: 0, PI: 0 }; let sGrand = 0;
  for (const o of commByMonth) {
    const c = round2(commFor(o.program, o));
    if (!c) continue;
    const M = months[o.month] = months[o.month] || { month: o.month, total: 0, TriCare: 0, VA: 0, PI: 0, orders: 0, units: 0, value: 0, reps: {} };
    M[o.program] += c; M.total += c; M.orders += o.orders; M.units += o.units; M.value += o.value;
    const MR = M.reps[o.rep] = M.reps[o.rep] || { rep: o.rep, tricare: 0, va: 0, pi: 0, total: 0, orders: 0, units: 0, value: 0 };
    MR[o.program === 'TriCare' ? 'tricare' : o.program === 'VA' ? 'va' : 'pi'] += c; MR.total += c; MR.orders += o.orders; MR.units += o.units; MR.value += o.value;
    const BR = sByRep[o.rep] = sByRep[o.rep] || { rep: o.rep, tricare: 0, va: 0, pi: 0, total: 0, orders: 0, units: 0, value: 0 };
    BR[o.program === 'TriCare' ? 'tricare' : o.program === 'VA' ? 'va' : 'pi'] += c; BR.total += c; BR.orders += o.orders; BR.units += o.units; BR.value += o.value;
    sByProgram[o.program] += c; sGrand += c;
  }
  const rnd = (o, ks) => { for (const k of ks) o[k] = round2(o[k]); return o; };
  const sMonths = Object.values(months).map((M) => rnd({ ...M, reps: Object.values(M.reps).map((r) => rnd(r, ['tricare', 'va', 'pi', 'total', 'value'])).sort((a, b) => b.total - a.total) }, ['total', 'TriCare', 'VA', 'PI', 'value'])).sort((a, b) => b.month.localeCompare(a.month));
  const striven = {
    available: commByMonth.length > 0,
    grandTotal: round2(sGrand),
    byProgram: { TriCare: round2(sByProgram.TriCare), VA: round2(sByProgram.VA), PI: round2(sByProgram.PI) },
    months: sMonths,
    byRep: Object.values(sByRep).map((r) => rnd(r, ['tricare', 'va', 'pi', 'total', 'value'])).sort((a, b) => b.total - a.total),
    rateCard: Object.entries(RATE).map(([program, r]) => ({ program, note: r.note, exact: r.exact })),
  };

  // Per-order Striven lines for the rep popup — mirror the sheet's line view, but
  // sourced from Striven orders (patient last name + item + value + computed $).
  // Join report cache (lastName/program/units/value) with rep from the SO book.
  const soRep = new Map();
  for (const o of recent) soRep.set(String(o.id), o.rep || 'Unassigned');
  try {
    const rc = await sbCacheRead('report_patient_items');
    const linesByRep = {};
    for (const o of (rc?.data?.orders || [])) {
      const rep = soRep.get(String(o.soId)); if (!rep) continue;
      const program = o.program; if (!RATE[program]) continue;
      const units = (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
      const value = Number(o.value || 0);
      const comm = round2(commFor(program, { units, orders: 1, value }));
      (linesByRep[rep] = linesByRep[rep] || []).push({ last: commLastDisp(o.lastName), item: (o.items || [])[0]?.item || '', prog: program, value: round2(value), units, comm });
    }
    for (const r of striven.byRep) r.lines = (linesByRep[r.rep] || []).sort((a, b) => b.comm - a.comm);
  } catch { /* report cache optional */ }

  // ── Reconcile: sheet (what was paid) vs Striven-computed (what orders support),
  // per rep, side by side, so the gap is visible per person. Both keyed by the
  // normalized rep name so "Cassie Wates" (Striven) ties to "Cassie" (sheet).
  const recMap = {};
  const ensureRec = (rep) => (recMap[rep] = recMap[rep] || { rep, sheet: 0, striven: 0, sheetProg: { TriCare: 0, VA: 0, PI: 0 }, strivenProg: { TriCare: 0, VA: 0, PI: 0 }, lines: 0, orders: 0, matchRate: null });
  for (const rp of reps) { const R = ensureRec(rp.rep); R.sheet = rp.total; R.sheetProg = { TriCare: rp.tricare, VA: rp.va, PI: rp.pi }; R.lines = rp.count; R.matchRate = rp.matchRate; }
  for (const b of striven.byRep) {
    const rep = commRep(b.rep); const R = ensureRec(rep);
    R.striven = round2(R.striven + b.total); R.orders += b.orders;
    R.strivenProg.TriCare = round2(R.strivenProg.TriCare + b.tricare);
    R.strivenProg.VA = round2(R.strivenProg.VA + b.va);
    R.strivenProg.PI = round2(R.strivenProg.PI + b.pi);
  }
  const reconcile = {
    reps: Object.values(recMap).map((R) => ({ ...R, diff: round2(R.sheet - R.striven), onSheet: R.sheet > 0, inStriven: R.striven > 0 }))
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
    totals: { sheet: round2(grandTotal), striven: striven.grandTotal, diff: round2(grandTotal - striven.grandTotal) },
  };

  return {
    ok: true, configured: true, grandTotal: round2(grandTotal),
    byProgram: { TriCare: round2(byProgram.TriCare), PI: round2(byProgram.PI), VA: round2(byProgram.VA) },
    reps, periods, periodCount: periods.length, itemCount: rowCount, sheetsRead, sheetsConfigured: sheets.length, errors,
    striven, reconcile,
    sources: sheets.map((s) => ({ label: s.label || 'sheet', url: `https://docs.google.com/spreadsheets/d/${s.id}/edit` })),
  };
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
  '/api/commission': getCommission,
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

// Build ONE purchase order for a vendor from a template PO, carrying ALL the
// order's items for that vendor as separate line items (each `items[i]` =
// { itemId, itemName, qty, templateLine }). This is the streamlining: same vendor
// → one PO, not one PO per item.
function buildAutoPoPayloadMulti(prevPo, items, { soNumber, soCustomer, soShipTo }) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const p = clone(prevPo);
  p.id = 0;
  for (const k of ['purchaseOrderNumber', 'poNumber', 'number', 'dateCreated', 'createdDate', 'createdBy',
    'lastUpdatedDate', 'lastUpdatedBy', 'total', 'subTotal', 'subtotal', 'taxTotal', 'balance', 'customFields']) delete p[k];
  const now = new Date();
  p.purchaseOrderDate = now.toISOString();
  p.promiseDate = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  // Drop-ship to the CURRENT order's customer AND its OWN ship-to location. The
  // cloned template still carries the PREVIOUS customer's dropShipLocation, which
  // Striven rejects ("Drop Ship Location does not match Drop Ship Customer") — so
  // both must be overwritten together. No ship-to on the order → don't drop-ship.
  if (p.dropShipPO === true || 'dropShipLocation' in p || 'dropShipCustomer' in p) {
    if (soShipTo && soShipTo.id) {
      if (soCustomer) p.dropShipCustomer = clone(soCustomer);
      p.dropShipLocation = clone(soShipTo);
      p.dropShipPO = true;
    } else {
      p.dropShipPO = false;
      delete p.dropShipLocation;
      delete p.dropShipCustomer;
    }
  }
  p.title = `Auto PO for SO ${soNumber}`;
  if ('memo' in p) p.memo = `Auto-created from Sales Order ${soNumber}`;
  p.lineItems = items.map((it) => {
    const nl = clone(it.templateLine);
    nl.id = 0;
    for (const k of ['purchaseOrderLineItemId', 'purchaseOrderId', 'quantityReceived', 'quantityBilled',
      'amountReceived', 'amountBilled']) delete nl[k];
    nl.item = { ...(nl.item ?? {}), id: Number(it.itemId), name: String(it.itemName ?? nl.item?.name ?? '') };
    nl.quantity = Number(it.qty);
    return nl;
  });
  return p;
}

async function autoPoProcessSo(soId, mode) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const soNumber = String(so.orderNumber ?? so.number ?? soId);
  const typeName = so.type?.name ?? '';
  // soNumber is NOT logged: Striven order numbers embed the patient's surname
  // ("ADubberly DEMO Hidow"). soId identifies the order without carrying a name.
  // pos = one entry PER VENDOR (grouped); unmatched = items with no vendor found.
  const entry = { at: new Date().toISOString(), soId: Number(soId), type: typeName, mode, pos: [], unmatched: [] };
  const testy = isDemoType(typeName) || /demo|test/i.test(so.customer?.name ?? '') || /demo|test/i.test(so.name ?? '');
  if (autoPoDemoOnly() && !testy) { entry.skipped = 'not a DEMO/test order (pilot gate)'; return entry; }
  const chainSb = await sbCacheRead('order_chain');
  const chain = (chainSb && chainSb.data) || {};
  if ((chain[String(soId)]?.pos ?? []).length) { entry.skipped = 'SO already has a linked PO'; return entry; }
  const lines = so.lineItems ?? [];
  if (!lines.length) { entry.skipped = 'no line items on SO'; return entry; }

  // 1. Resolve each SO line to a vendor + template line, then GROUP BY VENDOR.
  const groups = new Map();   // vendorKey → { vendor, template, items: [{itemId,itemName,qty,unit,templateLine}] }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const itemId = l.item?.id ?? l.itemId ?? null;
    const itemName = l.item?.name ?? l.itemName ?? `Line ${i + 1}`;
    const qty = Number(l.quantity ?? l.qty ?? 0);
    if (!itemId || qty <= 0) { entry.unmatched.push({ itemName, qty, reason: 'missing item id or quantity' }); continue; }
    const prev = await previousPoForItem(itemId);
    if (!prev) { entry.unmatched.push({ itemId, itemName, qty, reason: 'no vendor — this item has no prior purchase order to copy from' }); continue; }
    const vName = prev.po.vendor?.name ?? '';
    const vKey = String(prev.po.vendor?.id ?? vName);
    if (!groups.has(vKey)) groups.set(vKey, { vendor: prev.po.vendor ?? { name: vName }, template: prev.po, items: [] });
    groups.get(vKey).items.push({ itemId, itemName, qty, unit: prev.line?.unitPrice ?? prev.line?.price ?? null, templateLine: prev.line });
  }

  // 2. One PO per vendor group — all that vendor's items on a single PO.
  for (const g of groups.values()) {
    const vendorName = g.vendor?.name ?? '';
    const items = g.items.map((it) => ({ itemName: it.itemName, qty: it.qty, unit: it.unit }));
    if (mode === 'live') {
      const payload = buildAutoPoPayloadMulti(g.template, g.items, { soNumber, soCustomer: so.customer ?? null, soShipTo: so.shipToLocation ?? so.shipTo ?? null });
      const created = await striven('POST', '/v1/purchase-orders', payload);
      const poId = created?.id ?? created?.data?.id ?? null;
      const vendorEmail = await vendorContactEmail(vendorName);
      entry.pos.push({ poId, vendor: vendorName, vendorEmail, items });
    } else {
      entry.pos.push({ poId: null, vendor: vendorName, vendorEmail: '', items, dryRun: true });
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

// item(name) → primary vendor, from the cached vendor-items report — instant, no
// live PO scan. This IS the "which item we buy from which vendor" mapping the
// Reports tab already computes; preview reads it so the vendor pops up at once.
async function itemVendorMap() {
  const r = await sbCacheRead('report_vendor_items');
  const vendors = r?.data?.vendors || [];
  const m = new Map();
  for (const v of vendors) for (const it of (v.items || [])) {
    const k = String(it.item || '').toLowerCase().trim();
    if (!k) continue;
    const cur = m.get(k);
    if (!cur || Number(it.poCount || 0) > cur.poCount) {
      const qty = Number(it.qty || 0);
      m.set(k, { vendor: v.vendor, poCount: Number(it.poCount || 0), unit: qty ? round2(Number(it.cost || 0) / qty) : null });
    }
  }
  return m;
}

// Fast preview for the UI: the order's items + the reports-based vendor for each
// (no slow previous-PO scan — that runs only when the PO is actually generated).
async function autoPoPreview(soId) {
  const so = await striven('GET', `/v1/sales-orders/${soId}`);
  const soNumber = String(so.orderNumber ?? so.number ?? soId);
  const typeName = so.type?.name ?? '';
  const testy = isDemoType(typeName) || /demo|test/i.test(so.customer?.name ?? '') || /demo|test/i.test(so.name ?? '');
  const vm = await itemVendorMap();
  // Group items by their reports-vendor; items with no reports match go to
  // `pending` (they usually still resolve from a prior PO at generate time).
  const groups = new Map();   // vendor → items[]
  const pending = [];
  let lineCount = 0;
  for (const l of (so.lineItems ?? [])) {
    lineCount++;
    const itemName = l.item?.name ?? l.itemName ?? `Line ${lineCount}`;
    const qty = Number(l.quantity ?? l.qty ?? 0);
    const hit = vm.get(String(itemName).toLowerCase().trim());
    const unit = hit?.unit ?? (l.unitPrice ?? l.price ?? null);
    if (hit?.vendor) {
      if (!groups.has(hit.vendor)) groups.set(hit.vendor, []);
      groups.get(hit.vendor).push({ itemName, qty, unit });
    } else {
      pending.push({ itemName, qty, unit });
    }
  }
  const vendorGroups = [...groups.entries()].map(([vendor, items]) => ({ vendor, items }));
  return {
    ok: true, soId: Number(soId), ref: safeRef('SO', soId, soNumber),
    type: testy ? 'DEMO / test' : (typeName ? soClass(typeName) : '—'), testy,
    demoOnly: autoPoDemoOnly(), orderDate: so.orderDate ?? so.dateCreated ?? null,
    lineCount, vendorGroups, pending,
  };
}

// Fetch a PO's own PDF (Striven document format 15) as base64 for the UI/email.
// striven() returns JSON, so this does a dedicated binary fetch with the token.
async function autoPoFetchPdf(poId) {
  const token = await getToken();
  const res = await fetch(`${BASE}/v1/purchase-orders/${poId}/format/15`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/pdf' },
  });
  if (!res.ok) throw new Error(`PO PDF ${poId} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, poId: Number(poId), filename: `PO-${poId}.pdf`, size: buf.length, pdfBase64: buf.toString('base64') };
}

// Vendor's primary contact email — search contacts by the vendor's account name,
// then read the contact detail for its primary active email (mirrors the SMR n8n
// flow). '' if none found; failures are swallowed so the field stays editable.
async function vendorContactEmail(vendorName) {
  if (!vendorName) return '';
  try {
    const s = await striven('POST', '/v1/contacts/search', { accountName: String(vendorName), pageIndex: 0, pageSize: 20 });
    const cid = (s.data ?? s.Data ?? [])[0]?.id;
    if (!cid) return '';
    const c = await striven('GET', `/v1/contacts/${cid}`);
    const emails = Array.isArray(c.emails) ? c.emails.filter((e) => e.active !== false) : [];
    const pick = emails.find((e) => e.isPrimary) ?? emails[0] ?? {};
    return String(pick.email ?? pick.emailAddress ?? c.email ?? c.emailAddress ?? c.primaryEmail ?? '').trim();
  } catch { return ''; }
}

// A professional PO email body (adapted from the SMR n8n template) — vendor-facing,
// no patient data. Built from the PO detail so it's correct and self-contained.
function autoPoEmailHtml(po, poId) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const poNo = po.poNumber ?? po.purchaseOrderNumber ?? `PO-${poId}`;
  const vendor = po.vendor?.name ?? 'Vendor';
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = po.lineItems ?? po.purchaseOrderLineItems ?? [];
  const rows = (lines.length ? lines : [{ item: { name: 'Requested item' } }]).map((l, i) => {
    const name = esc(l.item?.name ?? l.itemName ?? 'Item');
    const qty = esc(l.quantity ?? l.qty ?? '');
    const unit = l.unitPrice ?? l.price ?? null;
    const unitStr = unit != null ? `$${Number(unit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
    return `<tr><td style="padding:10px;border:1px solid #d6d6d6;text-align:center">${i + 1}</td><td style="padding:10px;border:1px solid #d6d6d6"><b>${name}</b></td><td style="padding:10px;border:1px solid #d6d6d6;text-align:center;font-weight:bold">${qty}</td><td style="padding:10px;border:1px solid #d6d6d6;text-align:center">${unitStr}</td></tr>`;
  }).join('');
  return `<div style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#222">
  <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #ddd">
    <div style="padding:22px 28px;border-bottom:4px solid #1f4e78">
      <div style="font-size:24px;font-weight:bold;color:#1f4e78;letter-spacing:.5px">PURCHASE ORDER</div>
      <div style="margin-top:6px;font-size:13px;color:#666">Confirmation required &middot; <b>${esc(poNo)}</b> &middot; ${esc(dateStr)}</div>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 16px;font-size:14px">Dear ${esc(vendor)},</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.7">Please process the following Purchase Order and confirm acceptance, expected dispatch date, and delivery date.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:22px;font-size:13px">
        <thead><tr style="background:#1f4e78;color:#fff">
          <th style="width:8%;padding:11px;border:1px solid #1f4e78">Sr.</th>
          <th style="padding:11px;border:1px solid #1f4e78;text-align:left">Item</th>
          <th style="width:16%;padding:11px;border:1px solid #1f4e78">Qty</th>
          <th style="width:18%;padding:11px;border:1px solid #1f4e78">Unit</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="padding:14px;margin-bottom:20px;border:1px solid #d6d6d6;background:#fafafa;font-size:13px;line-height:1.7">
        <b>Please confirm:</b>
        <ol style="margin:8px 0 0 20px;padding:0"><li>Acceptance of this PO</li><li>Unit price &amp; total</li><li>Taxes &amp; freight</li><li>Expected dispatch &amp; delivery dates</li><li>Payment terms</li></ol>
      </div>
      <p style="margin:0 0 6px;font-size:14px">Please reply confirming acceptance of <b>${esc(poNo)}</b>, and mention the PO number on all invoices &amp; documents.</p>
      <p style="margin:16px 0 0;font-size:14px">Regards,<br><b>Purchasing Team &middot; Sports Med Recovery</b></p>
    </div>
    <div style="padding:12px 28px;background:#f2f5f8;border-top:1px solid #ddd;text-align:center;font-size:11px;color:#666">Auto-generated Purchase Order &middot; PDF attached.</div>
  </div></div>`;
}

// Email the PO (rich HTML body + PDF attachment) via Resend (HTTPS → serverless-safe,
// native attachments, no npm dependency). RESEND_API_KEY (+ optional AUTO_PO_EMAIL_FROM).
// Recipient is passed per-call and is editable in the UI.
async function autoPoEmail({ poId, to, subject, body }) {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) return { ok: false, error: 'Email not configured yet — set RESEND_API_KEY (see the Auto-PO email note).' };
  if (!to || !/.+@.+\..+/.test(String(to))) return { ok: false, error: 'A valid recipient email is required.' };
  let po = {};
  try { po = await striven('GET', `/v1/purchase-orders/${poId}`); } catch { /* minimal template fallback */ }
  const pdf = await autoPoFetchPdf(poId);
  const from = process.env.AUTO_PO_EMAIL_FROM || 'SMR Auto-PO <onboarding@resend.dev>';
  const html = body || autoPoEmailHtml(po, poId);
  const subj = subject || `Purchase Order ${po.poNumber ?? `PO-${poId}`}${po.vendor?.name ? ` — ${po.vendor.name}` : ''}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [String(to)], subject: subj, html, attachments: [{ filename: pdf.filename, content: pdf.pdfBase64 }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `Email send failed (HTTP ${res.status}): ${j?.message || JSON.stringify(j)}` };
  return { ok: true, poId: Number(poId), to: String(to), id: j.id ?? null };
}

// POs already created for a sales order (from the auto-po run log) — so an
// already-processed SO can still show its PDF/email delivery step in the UI.
async function autoPoSoPos(soId) {
  const state = await autoPoState();
  const seen = new Set(); const pos = [];
  for (const e of (state.log || [])) {
    if (Number(e.soId) !== Number(soId)) continue;
    for (const p of (e.pos || [])) {           // new grouped structure
      if (p.poId && !seen.has(p.poId)) {
        seen.add(p.poId);
        pos.push({ poId: p.poId, vendor: p.vendor || '', vendorEmail: p.vendorEmail || '', items: p.items || [] });
      }
    }
    for (const l of (e.lines || [])) {          // backward-compat with old per-line logs
      if (l.poId && !seen.has(l.poId)) {
        seen.add(l.poId);
        pos.push({ poId: l.poId, vendor: l.vendor || '', vendorEmail: l.vendorEmail || '', items: [{ itemName: l.itemName || '', qty: l.qty ?? null }] });
      }
    }
  }
  return { ok: true, soId: Number(soId), pos };
}

// Render the email that WOULD be sent — subject, HTML body, and the resolved
// vendor email — WITHOUT sending. Needs no RESEND_API_KEY, so the user can review
// the mail in the UI before anything goes out ("jaane se pehle dikhe").
async function autoPoEmailPreview(poId) {
  let po = {};
  try { po = await striven('GET', `/v1/purchase-orders/${poId}`); } catch { /* minimal fallback */ }
  const subject = `Purchase Order ${po.poNumber ?? `PO-${poId}`}${po.vendor?.name ? ` — ${po.vendor.name}` : ''}`;
  const vendorEmail = await vendorContactEmail(po.vendor?.name ?? '');
  return { ok: true, poId: Number(poId), subject, vendor: po.vendor?.name ?? '', vendorEmail, html: autoPoEmailHtml(po, poId) };
}

export async function autoPoRun(params = {}) {
  const mode = params.mode === 'live' ? 'live' : (process.env.AUTO_PO_MODE === 'live' ? 'live' : 'dry');
  const state = await autoPoState();
  if (params.action === 'candidates') {
    return { ok: true, mode, demoOnly: autoPoDemoOnly(), candidates: await autoPoCandidates() };
  }
  if (params.action === 'preview' && params.so) return autoPoPreview(Number(params.so));
  if (params.action === 'pdf' && params.po) return autoPoFetchPdf(Number(params.po));
  if (params.action === 'so-pos' && params.so) return autoPoSoPos(Number(params.so));
  if (params.action === 'email-preview' && params.po) return autoPoEmailPreview(Number(params.po));
  if (params.action === 'email' && params.po) return autoPoEmail({ poId: Number(params.po), to: params.to, subject: params.subject, body: params.body });
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
