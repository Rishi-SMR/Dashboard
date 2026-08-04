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
import {
  COMMISSION_RATES, FALLBACK_VERTICAL_RATES, ORDER_LABEL_RULES,
  REP_DIRECTORY, REP_NAMES, STANDINGS_ORDERS_ONLY, STANDINGS_EXCLUDE, PI_STAGES, STRIVEN_STAGE_FIELD,
} from './_commission-config.js';
import {
  commissionForOrder, splitByState, resolveIdentity,
  redactCommissionPayload, isCancelledStatus,
} from './_commission-core.js';
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

// ── Commission config + caller identity ──────────────────────────────────────
// Every commission knob is overridable from the Supabase `app_config` table, so
// rates and the rep roster change without a redeploy; the checked-in values in
// _commission-config.js are the fallback. See README → "Commission configuration".
const _json = (raw, fallback) => { try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } };
// app_config stores label rules as plain strings; compile them to RegExp here.
const _rules = (raw, fallback) => {
  const o = raw ? _json(raw, null) : null;
  if (!o) return fallback;
  const conv = (a) => (Array.isArray(a) ? a.map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean) : []);
  return { hold: conv(o.hold), waiting: conv(o.waiting) };
};
let _commCfg = { at: 0, val: null };
export async function getCommissionConfig() {
  if (_commCfg.val && Date.now() - _commCfg.at < 60_000) return _commCfg.val;
  const cfg = await readConfigTable().catch(() => ({}));
  const val = {
    rates: cfg.COMMISSION_RATES ? _json(cfg.COMMISSION_RATES, COMMISSION_RATES) : COMMISSION_RATES,
    fallback: cfg.COMMISSION_FALLBACK_RATES ? _json(cfg.COMMISSION_FALLBACK_RATES, FALLBACK_VERTICAL_RATES) : FALLBACK_VERTICAL_RATES,
    labelRules: _rules(cfg.ORDER_LABEL_RULES, ORDER_LABEL_RULES),
    directory: cfg.REP_DIRECTORY ? _json(cfg.REP_DIRECTORY, REP_DIRECTORY) : REP_DIRECTORY,
  };
  _commCfg = { at: Date.now(), val };
  return val;
}
/**
 * Who is calling — resolved from the VERIFIED session username only, never from
 * a client-supplied value. The role is looked up live from the directory rather
 * than trusted from the token, so a revoked admin loses access immediately
 * instead of at token expiry.
 * @returns {Promise<{email:string, repName:string|null, role:'rep'|'admin'}|null>}
 */
export async function getMe(sess) {
  if (!sess?.user) return null;
  const { directory } = await getCommissionConfig();
  return resolveIdentity(sess.user, directory);
}
/**
 * Apply an admin's "view as <rep>" preview. This can only ever NARROW what is
 * returned: an admin already sees everything, so stepping into a rep's shoes
 * removes data rather than granting it. A rep-role caller passing `as` is
 * ignored entirely — the parameter cannot widen anyone's access.
 */
export function viewerFor(me, as) {
  const rep = String(as ?? '').trim();
  if (!rep || me?.role !== 'admin') return me;
  return { email: me.email, repName: rep, role: 'rep', previewAs: rep };
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
    // Fall back to Infinity (not rows.length) when the API omits a count — else a
    // full page with no total would stop pagination after page 1. A short page
    // (data.length < pageSize) reliably marks the last page.
    const total = body.totalCount ?? body.TotalCount ?? Infinity;
    pageIndex += 1;
    if (data.length < pageSize || rows.length >= total || rows.length >= cap) break;
  }
  // Surface (don't silently swallow) a cap-hit so undercounting is visible in logs.
  if (rows.length >= cap) console.warn(`[searchAll] ${endpoint}: hit ${cap}-row cap — dataset may be truncated. Raise the cap if this business exceeds it.`);
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

  // Base datasets are refreshed above; `so_detail` is DERIVED from them and used
  // by every vertical, commission and analytics figure. Refreshing `so` without
  // it is what let new orders go uncounted — so it runs here, on the same cycle,
  // rather than waiting for someone to remember the generator.
  try { out.so_detail = await refreshDerived(); }
  catch (e) { out.so_detail = `FAIL ${e.message}`; }

  return out;
}
// ── Derived caches ───────────────────────────────────────────────────────────
// `so_detail` holds the per-order fields the sales-order SEARCH endpoint omits
// (type, rep, payer, total, invoice status, stage). Everything downstream —
// verticals, the commission engine, order analytics — reads it.
//
// It was previously only ever built by `scripts/gen-so-detail.mjs`, run by hand.
// refreshAll() did not touch it, so new orders landed in `so` with no matching
// `so_detail` entry and silently fell out of the vertical counts: that is why
// the dashboard showed 82 PI orders against Striven's 108, on a cache 13 days
// stale.
//
// The generator cannot simply be inlined here — it re-fetches EVERY order's
// detail and takes minutes, well past the 60s serverless limit. This does the
// incremental part instead: only ids present in `so` but missing from
// `so_detail`. On a 6h cycle that is a handful of orders and finishes in
// seconds. It also honours a wall-clock deadline and reports whether it
// finished, so a large backlog makes progress across successive runs rather
// than timing out and writing nothing.
//
// A full rebuild (changed fields on EXISTING orders, not just new ones) is
// still the generator's job. Run it after bulk edits in Striven.
const soCustomField = (d, name) => (d?.customFields || []).find((f) => f.name === name)?.valueText;
function soPayerOf(d) {
  const type = d?.type?.name || '';
  const explicit = String(soCustomField(d, 'Payer') || '').trim();
  if (explicit) return explicit;
  if (/tri.?care/i.test(type)) return 'TriCare';
  if (/\bva\b|veteran/i.test(type)) return 'Veterans Affairs';
  if (/\bpi\b|personal injury/i.test(type)) return String(soCustomField(d, 'Law Firm') || '').trim();
  return '';
}

export async function refreshDerived({ budgetMs = 25_000, maxOrders = 400 } = {}) {
  const started = Date.now();
  const soRows = (await sbCacheRead('so'))?.data || [];
  const detail = { ...((await sbCacheRead('so_detail'))?.data || {}) };

  const missing = soRows.map((r) => r.id).filter((id) => !(id in detail));
  const todo = missing.slice(0, maxOrders);

  let fetched = 0, failed = 0;
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (Date.now() - started > budgetMs) return;        // leave time to write
      const id = todo[i++];
      try {
        const d = await striven('GET', `/v1/sales-orders/${id}`);
        detail[id] = {
          type: d?.type?.name ?? '', rep: d?.salesRep?.name ?? '', payer: soPayerOf(d),
          total: Number(d?.orderTotal ?? 0), invStatus: d?.invoiceStatus?.name ?? '',
          status: d?.status?.name ?? '', stage: String(soCustomField(d, 'Stage') || '').trim(),
        };
        fetched++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  if (fetched > 0) {
    await sbCacheWrite('so_detail', detail);
    _cache.delete('so_detail');
    _cache.delete('derived:so');                           // getSO memo is now stale
  }
  return {
    missingBefore: missing.length,
    fetched,
    failed,
    remaining: Math.max(0, missing.length - fetched),
    complete: fetched >= missing.length,
    ms: Date.now() - started,
  };
}

/**
 * Age of every cache the dashboard depends on. Derived caches drift silently —
 * the figures still render, they are just wrong — so the age has to be
 * reportable rather than something you discover by reconciling against Striven.
 */
export async function getCacheHealth() {
  const KEYS = ['so', 'so_detail', 'report_patient_items', 'invoices', 'customers'];
  // Rebuilt by scripts/gen-reports.mjs only; nothing refreshes it automatically.
  const MANUAL_ONLY = new Set(['report_patient_items']);
  const now = Date.now();
  const rows = await Promise.all(KEYS.map(async (key) => {
    const hit = await sbCacheRead(key);
    const updatedAt = hit?.updated_at ?? null;
    const ageHours = updatedAt ? Math.round((now - new Date(updatedAt).getTime()) / 3_600_000) : null;
    return {
      key,
      updatedAt,
      ageHours,
      manualOnly: MANUAL_ONLY.has(key),
      // 48h is comfortably beyond the 6h refresh cycle, so this only fires when
      // refreshes have genuinely stopped landing.
      stale: ageHours == null || ageHours > 48,
    };
  }));
  return { generatedAt: new Date().toISOString(), caches: rows, anyStale: rows.some((r) => r.stale) };
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
/**
 * 'Veterans Affairs' and 'TriCare' are PROGRAMME names, not customer accounts.
 * Every VA order in the company bills the same payer, and every TriCare order
 * bills TriCare — so for those two verticals the "payer" is just the vertical
 * restated.
 *
 * Counting them as accounts made the metric meaningless: a rep with 161 VA
 * orders showed 1 account, while a rep with 35 PI orders showed 28, and the
 * chart read as though the smaller book had 28× the client base. Across the
 * whole book there are 77 distinct PI payers against exactly 1 VA and 1 TriCare.
 *
 * A genuine account is therefore a PI law firm — anything that is not a
 * programme constant and not blank.
 */
/**
 * An account is any named payer billed on an order — the law firm on a PI
 * order, Veterans Affairs on a VA order, TriCare on a Tri-Care order.
 *
 * Only blanks are excluded. An order with no payer (the 27 DEMO orders) has no
 * account to count, and 'Unassigned' is a placeholder rather than a customer.
 *
 * Striven's own customer records cannot supply this number: the `categories`
 * field on customer detail is null on the records sampled, and
 * /v1/customers/search ignores a category filter (100 rows returned filtered
 * and unfiltered alike). The 440 customer records are also overwhelmingly
 * patients, which are PHI and must never be counted as accounts here. The
 * payer actually billed on each order is the grounded, HIPAA-safe measure.
 *
 * Note: VA and TriCare are single-payer programmes, so a rep working only VA
 * shows 1 account against 161 orders. That is accurate — it just means this
 * figure measures payer spread, not customer count.
 */
// Test payers are excluded by an ANCHORED pattern, not a substring match. The
// whole value must be "test"/"testing" with an optional trailing number, so
// "Testing 1" goes and a real firm named "Testa Law" or "Protest Legal" stays.
//
// A `\btest\b` word-boundary rule would have been the obvious choice and is
// wrong twice over: it misses "Testing" entirely (the boundary fails before
// "ing") and would match a genuine firm with "Test" in its name.
//
// Today this removes exactly one value: "Testing 1" — 1 order, $0, booked by
// Rishi Arora. Accounts go 79 -> 78.
export const isTestPayer = (s) => /^test(ing)?\s*\d*$/i.test(String(s ?? '').trim());

export const isRealAccount = (payer) => {
  const s = String(payer ?? '').trim();
  return Boolean(s) && !/^unassigned$/i.test(s) && !isTestPayer(s);
};

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
  // Invoice status isn't on the search payload — resolve voids from INVOICE_STATUS
  // (same as getAR); notVoid(r) would be a no-op here and leak voided invoices.
  const invNotVoid = (r) => !isVoidStatus(INVOICE_STATUS[r.id] ?? '');
  const inv = (await allInvoices()).filter((r) => inYear(r) && invNotVoid(r));
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
// TriCare/VA checked before PI, and PI is word-bounded, so a type merely
// containing "pi" (e.g. "Shipping") can't be misbooked as Personal Injury.
/**
 * Collapses rows sharing an id, keeping the most recently updated copy.
 *
 * Deliberately keyed on the Striven id ALONE. Orders that merely look alike are
 * not duplicates: SO 112 and SO 115 share a patient, a day, a rep, a type and a
 * $0 total, and were created three minutes apart — but carry different line
 * items (2 devices vs 1). Matching on customer+value+date would have silently
 * deleted a real order and its devices.
 *
 * If a genuine double-entry ever needs removing, that is a correction in
 * Striven, not a filter here.
 */
export function dedupeById(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Map();
  for (const r of rows) {
    const id = r?.id;
    if (id == null) continue;
    const prev = seen.get(id);
    if (!prev) { seen.set(id, r); continue; }
    const at = (x) => Date.parse(x?.lastUpdatedDate ?? x?.dateCreated ?? '') || 0;
    if (at(r) >= at(prev)) seen.set(id, r);
  }
  return [...seen.values()];
}

// Striven defines exactly seven sales order types (GET /v1/sales-order-types);
// five are active: PI Order, VA Order, Tri-Care, DEMO, Contract - With Approval.
// The clinical three are checked first so a name like "PI Demo" would classify
// by programme rather than falling into the DEMO bucket.
/**
 * PIP = Personal Injury Protection: the patient's own auto policy pays, so the
 * insurer is billed at full value with no LeanStar funding and no case
 * settlement to wait for. It is still PI to a rep, so it DISPLAYS inside the PI
 * vertical; only the back-office routing differs.
 *
 * Detected separately because `soClass` cannot express it: `/\bpi\b/` does not
 * match "PIP" (no word boundary between the i and the p), so before this a PIP
 * order fell through every branch and landed in 'Other'.
 *
 * The PIP order type does not exist in Striven yet. This is here so the day it
 * is created the orders classify correctly instead of silently going to 'Other'.
 */
export const isPipType = (t) => /\bpip\b|personal injury protection/i.test(String(t || ''));

const soClass = (t) => {
  const s = (t || '').toLowerCase();
  if (/tri.?care/.test(s)) return 'TriCare';
  if (/\bva\b|veteran/.test(s)) return 'VA';
  // PIP before PI: it reports as PI, but it must be caught explicitly rather
  // than by accident, and it must never reach the 'Other' fallback.
  if (isPipType(s)) return 'PI';
  if (/\bpi\b|personal injury/.test(s)) return 'PI';
  if (/demo|test|sample/.test(s)) return 'DEMO';
  if (/contract/.test(s)) return 'Contract';
  return 'Other';
};
const isDemoType = (t) => /demo|test|sample/i.test(t || '');
// Cancelled / completed / active(open) status grouping — cancelled orders must
// never inflate the order book (same rule the PO side already follows).
const soStatusOf = (r) => r.status?.name ?? r.d?.status ?? 'Unknown';
const soGroupOf = (status) => {
  const s = String(status || '').toLowerCase();
  if (/cancel|void|lost|denied|rejected/.test(s)) return 'cancelled';
  // "Incomplete" is checked FIRST and explicitly. `/complete/` matches it —
  // "complete" is a substring — which classified every Incomplete order as
  // completed, in the server's own status groups and everything downstream.
  // The word boundary below would now catch it anyway; the explicit test means
  // the intent survives a future edit to the regex.
  if (/\bin[\s-]?complete\b/.test(s)) return 'active';
  if (/\b(?:complete|completed|closed|done|delivered|fulfilled)\b/.test(s)) return 'completed';
  return 'active';
};
async function getSO() {
  // Collapse any repeated SO id before anything counts it.
  //
  // The book is clean today — 467 rows, 467 distinct ids — so this changes
  // nothing now. It guards the way duplicates would actually arrive: allSO()
  // pages through /v1/sales-orders/search with PageIndex, and if an order is
  // created or re-sorted between two page fetches, a record can land on both
  // pages. That would silently inflate order counts and revenue, with no error
  // anywhere. Cheap to prevent, painful to detect after the fact.
  //
  // Keeps the most recently updated copy, so a row re-read after an edit wins.
  const rows = dedupeById(await allSO());
  const det = await soDetailMap();
  const enriched = rows.map((r) => ({ ...r, d: det[r.id] || {} }));
  // Every sales order type Striven defines is now carried, DEMO included, so the
  // dashboard's book matches Striven's own list exactly (452 non-cancelled).
  // DEMO used to be filtered out here, which hid 27 orders worth $17,369.
  //
  // DEMO and Contract - With Approval get their own soClass buckets rather than
  // being folded into "Other", so they are visible and filterable instead of
  // being quietly mixed with unclassified orders.
  //
  // NOTE: commission is sourced from `report_patient_items`, which applies its
  // own demo exclusion in scripts/gen-reports.mjs. DEMO orders therefore appear
  // in volume, revenue and vertical breakdowns but still earn no commission —
  // which is the intended split, not an oversight.
  const live = enriched;
  const demoOrders = enriched.filter((r) => isDemoType(r.d.type)).length;

  // Explicit status groups (counts + value) — the source of truth for KPIs.
  const statusGroups = { active: { count: 0, value: 0 }, completed: { count: 0, value: 0 }, cancelled: { count: 0, value: 0 } };
  for (const r of live) { const g = statusGroups[soGroupOf(soStatusOf(r))]; g.count++; g.value = round2(g.value + Number(r.d.total || 0)); }

  // Order book = live minus cancelled. Every aggregate below uses `book` so no
  // figure silently contains cancelled orders.
  const book = live.filter((r) => soGroupOf(soStatusOf(r)) !== 'cancelled');
  const totalValue = round2(book.reduce((s, r) => s + Number(r.d.total || 0), 0));

  const piva = { PI: { count: 0, value: 0 }, VA: { count: 0, value: 0 }, TriCare: { count: 0, value: 0 }, DEMO: { count: 0, value: 0 }, Contract: { count: 0, value: 0 }, Other: { count: 0, value: 0 } };
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
    .map((r) => ({ id: r.id, ref: safeRef('SO', r.id, r.number), type: soClass(r.d.type), rep: cleanRep(r.d.rep), payer: payerOf(r.d), value: Number(r.d.total || 0), status: soStatusOf(r), invStatus: r.d.invStatus || '', date: r.dateCreated ?? null, updated: r.d.lastUpdatedDate ?? null, stage: r.d.stage || '' }));

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
    liveCount: live.length, demoCount: demoOrders,
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
  // Invoice voids come from INVOICE_STATUS (search payload omits status); notVoid
  // is a no-op on invoices and would leak voided invoices into the revenue trend.
  const inv = invAll.filter((r) => !isVoidStatus(INVOICE_STATUS[r.id] ?? ''));
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
// Folds a raw Striven "Sales Rep" value to the roster name used everywhere else.
//
// The four original reps are stored with company prefixes ("Maverick Medical -
// Alle Ann Dubberley"), so they fold to short names. The remaining values are
// listed explicitly rather than machine-stripped: "Maylon Sanders - Denise
// Zavala" and "House Account- Angel Santiago" both put a PERSON after the
// hyphen, but "Santiago Family Chiropractic" has no hyphen and is a practice,
// so a generic prefix-strip would produce wrong names for some and right names
// for others. Explicit beats clever here.
//
// Order matters: the /christ/i test would also catch "Christy Tan", so the
// specific folds run before the pass-through.
const commRep = (r) => {
  const s = String(r || '').trim();
  if (/cassie/i.test(s)) return 'Cassie';
  if (/jillian/i.test(s)) return 'Jillian';
  if (/all?e ?ann?e?/i.test(s)) return 'Alle Ann';
  if (/christ/i.test(s)) return 'Christy';
  // Added when the roster widened from the original four to every Sales Rep
  // value in Striven except Rishi Arora.
  //
  // SUB-REPS fold into the rep who is PAID on the order. Striven's Sales Rep
  // field carries "Maylon Sanders - Denise Zavala" so the business can report on
  // who took the order, but Denise is Maylon's sub-rep: the order is Maylon's
  // and Maylon is paid on it. Treating Denise as her own rep put those orders
  // and their commission on the wrong person. This test must run BEFORE the
  // plain /maylon/ one only in the sense that both now return the same name;
  // it is kept explicit so the intent survives the next edit.
  if (/denise\s+zavala/i.test(s)) return 'Maylon Sanders';         // "Maylon Sanders - Denise Zavala"
  if (/angel\s+santiago/i.test(s)) return 'Angel Santiago';        // "House Account- Angel Santiago"
  if (/maylon\s+sanders/i.test(s)) return 'Maylon Sanders';
  if (/santiago\s+family/i.test(s)) return 'Santiago Family Chiropractic';
  if (/kinley\s+shepherd/i.test(s)) return 'Kinley Shepherd';
  if (/crystal\s+chambers/i.test(s)) return 'Crystal Chambers';
  if (/zach\s+shank/i.test(s)) return 'Zach Shank';
  if (/^house\s+account$/i.test(s)) return 'House Account';
  return s || 'Unknown';
};
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
/**
 * Commission for one caller. `viewer` comes from the verified session via
 * getMe(); it decides what survives redaction. Never call this without one.
 * @param {{repName:string|null, role:'rep'|'admin'}|null} viewer
 */
export async function getCommission(viewer = null) {
  const cfg = await readConfigTable().catch(() => ({}));
  // ── THE COMMISSION SHEET IS GONE ────────────────────────────────────────────
  // Commission used to be reconciled against Crystal's Google Sheet workbooks.
  // That sheet stopped being maintained the day Striven went live, so every
  // figure it contributed was historical, and reconciling live pay against a
  // frozen document produced permanent variances that meant nothing.
  //
  // Removed with it: the Google Sheets fetch and CSV parsing, the per-period
  // rollup, the sheet-vs-Striven `reconcile` block, and the MIN_MATCH_RATE
  // verification gate. `COMMISSION_SHEETS` in app_config is no longer read.
  //
  // The roster is REP_NAMES, a checked-in list, rather than whichever names
  // happened to appear on a sheet tab (a typo there used to invent a rep).
  //
  // Commission is computed from Striven ONLY: units x per-device rate.
  //
  // The SO book, which is the ref/status/date source the engine needs: status to
  // apply the hold and waiting label rules, date to bucket by month.
  let recent = [];
  try { recent = (await cached('derived:so', getSO, 60_000)).recent || []; } catch { /* Striven optional */ }
  const soInfo = new Map();
  for (const o of recent) {
    soInfo.set(String(o.id), {
      rep: commRep(o.rep || 'Unassigned'), ref: o.ref || `SO-${o.id}`,
      status: o.status || '', date: o.date || '', program: o.type || 'Other', value: Number(o.value || 0),
      stage: o.stage || '',
    });
  }

  // Per-ORDER device rows: a per-device rate needs the device, so this is the
  // commission source rather than any month/program rollup.
  let rcOrders = [];
  try { rcOrders = (await sbCacheRead('report_patient_items'))?.data?.orders || []; } catch { /* optional */ }

  // soId -> patient SURNAME for the commission drill. Same cache, a Striven
  // derivation, NOT the removed sheet feed.
  const lastNameBySo = new Map();
  for (const o of rcOrders) {
    const ln = commLastName(o.lastName);
    if (ln && o.soId != null) lastNameBySo.set(String(o.soId), ln);
  }

  // ── Commission computed FROM STRIVEN ────────────────────────────────────────
  // Commission is calculated HERE, not in Striven — Striven holds no commission
  // logic. The rule is strictly `units × per-device rate`, summed across the
  // devices on an order (see _commission-core.js). Order labels decide inclusion:
  // `hold` is excluded entirely, `waiting for reimbursement` counts toward the
  // total but is reported as pending rather than payable.
  //
  // Sourced per ORDER (report_patient_items → device + qty) rather than from the
  // month/program rollup, because a per-device rate needs the device.
  const commCfg = await getCommissionConfig();
  // THE rep roster: the names on the commission sheet. Striven books orders under
  // plenty of other people (house/clinic accounts, ops staff) — they are not reps
  // and must never appear as one. An order booked under a non-rep is reported as
  // unmatched rather than silently commissioned to somebody.
  const rosterReps = new Set(REP_NAMES);
  const months = {}; const sByRep = {}; const sByProgram = { TriCare: 0, VA: 0, PI: 0 };
  const sByProgramOrders = { TriCare: 0, VA: 0, PI: 0 }; let sGrand = 0;
  let sPayable = 0, sWaiting = 0, sHeld = 0, sZeroValue = 0, sCancelled = 0;
  const rateGaps = new Set();
  const strivenLinesByRep = {};
  // Empty per-vertical volume buckets, so every rep/month row has the same shape.
  const zeroVol = () => ({ nTricare: 0, nVa: 0, nPi: 0, uTricare: 0, uVa: 0, uPi: 0 });
  const zeroState = () => ({ payableTotal: 0, waitingTotal: 0, heldOrders: 0 });
  const zeroRepRow = (rep) => ({ rep, tricare: 0, va: 0, pi: 0, total: 0, orders: 0, units: 0, value: 0, ...zeroVol(), ...zeroState() });

  // Seed EVERY rep on the roster, so the table lists the whole team rather than
  // only those with a commissioned order. Previously a rep row was created on
  // first earning, so eight of the twelve never appeared at all — indistinguish-
  // able from not being a rep. A rep at $0 is information; a missing row is not.
  for (const rep of REP_NAMES) sByRep[rep] = zeroRepRow(rep);

  // Orders we could not tie to a sales order. They still carry a vertical and
  // real volume, so they are reported rather than dropped — an unattributable
  // order is a data problem to surface, not a number to quietly lose.
  const unmatched = [];
  for (const o of rcOrders) {
    const info = soInfo.get(String(o.soId));
    const bookedTo = info?.rep && info.rep !== 'Unassigned' ? info.rep : null;
    if (!info || !bookedTo || !rosterReps.has(bookedTo)) {
      const units = (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
      unmatched.push({
        soId: String(o.soId ?? ''),
        ref: info?.ref || '',
        prog: o.program || info?.program || 'Unclassified',
        rep: bookedTo,
        item: (o.items || [])[0]?.item || '',
        itemCount: (o.items || []).length,
        units,
        value: round2(Number(o.value || info?.value || 0)),
        status: info?.status || '',
        reason: !info ? 'no matching sales order'
          : !bookedTo ? 'no rep on the sales order'
            : 'booked to someone who is not a rep on the commission sheet',
      });
      continue;
    }
    const rep = bookedTo;
    const program = o.program || info.program;
    if (!['TriCare', 'VA', 'PI', 'DOL'].includes(program)) continue;

    const value = Number(o.value || info.value || 0);
    const res = commissionForOrder({ status: info.status, program, items: o.items, value }, commCfg);
    for (const g of res.rateGaps) rateGaps.add(g);
    if (res.state === 'cancelled') { sCancelled++; continue; }    // cancelled → never earned
    if (res.state === 'zero-value') { sZeroValue++; continue; }   // $0 order earns nothing
    // A held order is COUNTED and costed, then routed to Waiting below. It used
    // to `continue` here, which silently undid the split the engine computes:
    // the order never reached waitingTotal, so a rep whose month was held saw
    // an empty Waiting column instead of what is pending.
    if (res.state === 'hold') sHeld++;
    if (!res.commission && !res.units) continue;

    const month = (info.date || '').slice(0, 7) || 'unknown';
    const c = res.commission;
    const pk = program === 'TriCare' ? 'tricare' : program === 'VA' ? 'va' : 'pi';
    const nk = program === 'TriCare' ? 'nTricare' : program === 'VA' ? 'nVa' : 'nPi';   // orders in this vertical
    const uk = program === 'TriCare' ? 'uTricare' : program === 'VA' ? 'uVa' : 'uPi';   // units in this vertical
    const bump = (t) => {
      t[pk] += c; t.total += c; t.orders += 1; t.units += res.units; t.value += value;
      t[nk] += 1; t[uk] += res.units;
      // `hold` and `waiting` are both earned-but-not-payable.
      if (res.state === 'waiting' || res.state === 'hold') t.waitingTotal += c; else t.payableTotal += c;
    };
    const M = months[month] = months[month] || { month, total: 0, TriCare: 0, VA: 0, PI: 0, orders: 0, units: 0, value: 0, oTriCare: 0, oVA: 0, oPI: 0, ...zeroState(), reps: {} };
    M[program] += c; M.total += c; M.orders += 1; M.units += res.units; M.value += value;
    if (program !== 'DOL') M[`o${program}`] += 1;
    if (res.state === 'waiting' || res.state === 'hold') M.waitingTotal += c; else M.payableTotal += c;
    bump(M.reps[rep] = M.reps[rep] || { rep, tricare: 0, va: 0, pi: 0, total: 0, orders: 0, units: 0, value: 0, ...zeroVol(), ...zeroState() });
    bump(sByRep[rep] = sByRep[rep] || zeroRepRow(rep));

    if (sByProgram[program] != null) { sByProgram[program] += c; sByProgramOrders[program] += 1; }
    sGrand += c;
    if (res.state === 'waiting' || res.state === 'hold') sWaiting += c; else sPayable += c;

    // Per-order line for the rep popup.
    //
    // Carries the patient's LAST NAME, because a rep cannot reconcile a Striven
    // sales order number against their own records: "that sales order won't let
    // them do their own checks and balances". Surname only, never the given
    // name, and only on the rep's own orders, which is the minimum that makes
    // the line identifiable to the person who took it.
    //
    // This is the one place PHI is deliberately surfaced. maskName() still
    // blanks patient names everywhere else, and `patient` falls back to '' when
    // the report cache has no row, so the drill degrades to the SO ref.
    (strivenLinesByRep[rep] = strivenLinesByRep[rep] || []).push({
      ref: info.ref, patient: lastNameBySo.get(String(o.soId ?? info.soId ?? '')) || '',
      item: (o.items || [])[0]?.item || '', prog: program,
      value: round2(value), units: res.units, comm: c, state: res.state,
    });
  }

  const MONEY = ['tricare', 'va', 'pi', 'total', 'value', 'payableTotal', 'waitingTotal'];
  const rnd = (o, ks) => { for (const k of ks) o[k] = round2(o[k]); return o; };
  const sMonths = Object.values(months).map((M) => rnd({ ...M, reps: Object.values(M.reps).map((r) => rnd(r, MONEY)).sort((a, b) => b.total - a.total) }, ['total', 'TriCare', 'VA', 'PI', 'value', 'payableTotal', 'waitingTotal'])).sort((a, b) => b.month.localeCompare(a.month));
  const striven = {
    available: rcOrders.length > 0,
    grandTotal: round2(sGrand),
    payableTotal: round2(sPayable),
    waitingTotal: round2(sWaiting),
    heldOrders: sHeld,
    zeroValueOrders: sZeroValue,          // $0 order value → no commission earned
    cancelledOrders: sCancelled,          // cancelled → never earned, never counted
    byProgram: { TriCare: round2(sByProgram.TriCare), VA: round2(sByProgram.VA), PI: round2(sByProgram.PI) },
    byProgramOrders: { ...sByProgramOrders },              // orders per vertical, all months
    months: sMonths,
    // Earners first, then anyone at zero by name — without the tiebreakers the
    // eight zero rows would reorder arbitrarily between refreshes.
    byRep: Object.values(sByRep).map((r) => rnd(r, MONEY))
      .sort((a, b) => b.total - a.total || b.orders - a.orders || a.rep.localeCompare(b.rep)),
    // Devices priced off the legacy per-vertical fallback because they are not
    // yet in COMMISSION_RATES — surfaced so an unpriced device is never silent.
    rateGaps: [...rateGaps].sort(),
    // Orders with no usable sales order — vertical + whatever else we have.
    unmatched: unmatched.sort((a, b) => b.value - a.value),
    unmatchedValue: round2(unmatched.reduce((s, u) => s + u.value, 0)),
    rateCard: [
      { program: 'All', note: 'commission = units × per-device rate (COMMISSION_RATES)', exact: true },
    ],
  };
  for (const r of striven.byRep) r.lines = (strivenLinesByRep[r.rep] || []).sort((a, b) => b.comm - a.comm);

  // ── Volume columns come from the ORDER BOOK, not the commission engine ──────
  //
  // The engine only sees orders in report_patient_items that tie to a sales
  // order, so its counts cover 296 of 452 orders. Rendering those as "Orders"
  // made eight reps read 0 — Maylon Sanders showed no orders against a real
  // book of 35 worth $341,053.
  //
  // So the volume columns now report what Striven actually holds, and the money
  // columns keep reporting what was actually computed. `commOrders`/`commUnits`
  // carry the engine's own basis so the gap between the two is inspectable
  // rather than looking like a calculation fault.
  //
  // Order counts are non-financial and already shared across the team (see
  // orderCounts below), so sourcing them at admin scope leaks nothing new —
  // redaction still strips every dollar field per caller.
  try {
    // Admin scope, spelled out here: getRepOverview's ADMIN is local to that
    // function. Same cache key, so the two share one derivation.
    const an = await cached('derived:analytics:admin', () => getOrderAnalytics({ repName: null, role: 'admin' }), 60_000);
    const book = new Map();
    for (const o of an.orders || []) {
      const e = book.get(o.rep) || { orders: 0, units: 0, TriCare: 0, VA: 0, PI: 0, DOL: 0 };
      e.orders += 1;
      e.units += Number(o.units || 0);
      if (e[o.vertical] != null) e[o.vertical] += 1;
      book.set(o.rep, e);
    }
    for (const r of striven.byRep) {
      const b = book.get(r.rep);
      r.commOrders = r.orders;              // what the money was computed on
      r.commUnits = r.units;
      r.orders = b?.orders ?? 0;            // what Striven actually holds
      r.units = b?.units ?? 0;
      r.nTricare = b?.TriCare ?? 0;
      r.nVa = b?.VA ?? 0;
      r.nPi = b?.PI ?? 0;
    }
    striven.commissionedOrders = striven.byRep.reduce((s, r) => s + (r.commOrders || 0), 0);
    striven.bookOrders = (an.orders || []).length;

    // Volume booked to someone off the roster. Without this the commission
    // table's columns sum to 450 orders / 643 units against a book of
    // 452 / 644 — the table quietly disagreeing with every other screen.
    //
    // It is NOT a byRep entry: those rows carry identity and drive redaction,
    // and a synthetic rep in that list would be one more thing to special-case
    // everywhere. Reported alongside instead, for the table to render as a row.
    const rosterNames = new Set(REP_NAMES);
    const offRows = (an.orders || []).filter((o) => !rosterNames.has(o.rep));
    striven.offRoster = {
      orders: offRows.length,
      units: offRows.reduce((s, o) => s + Number(o.units || 0), 0),
      value: round2(offRows.reduce((s, o) => s + Number(o.revenue || 0), 0)),
      nTricare: offRows.filter((o) => o.vertical === 'TriCare').length,
      nVa: offRows.filter((o) => o.vertical === 'VA').length,
      nPi: offRows.filter((o) => o.vertical === 'PI').length,
      reps: [...new Set(offRows.map((o) => o.rep))].sort(),
    };
  } catch { /* analytics optional — volume columns stay on the engine's counts */ }

  // Per-rep operational fields (orderCounts, payable/waiting) are built directly
  // into the rows below. There is no sheet row to graft them onto any more, and
  // no isRepVerified gate: with one source there is nothing to verify against.
  // The `reps` rows are derived from Striven alone: one row per roster name
  // carrying what that rep's orders actually support. There is no second source
  // to disagree with, so there is nothing to reconcile and no verification gate.
  const svByRep2 = new Map(striven.byRep.map((r) => [r.rep, r]));
  const reps = REP_NAMES.map((rep) => {
    const sv = svByRep2.get(rep);
    return {
      rep,
      tricare: round2(sv?.tricare ?? 0), va: round2(sv?.va ?? 0), pi: round2(sv?.pi ?? 0),
      total: round2(sv?.total ?? 0),
      count: sv?.orders ?? 0,
      nTricare: sv?.nTricare ?? 0, nVa: sv?.nVa ?? 0, nPi: sv?.nPi ?? 0,
      strivenOrders: sv?.orders ?? 0, strivenUnits: sv?.units ?? 0, strivenValue: round2(sv?.value ?? 0),
      orderCounts: { TriCare: sv?.nTricare || 0, VA: sv?.nVa || 0, PI: sv?.nPi || 0, DOL: 0 },
      payableTotal: round2(sv?.payableTotal ?? 0),
      waitingTotal: round2(sv?.waitingTotal ?? 0),
      commPerOrder: sv?.orders ? Math.round((sv.total || 0) / sv.orders) : null,
      pctOfValue: sv?.value ? round2(((sv.total || 0) / sv.value) * 100) : null,
      lines: sv?.lines ?? [],
    };
  }).sort((a, b) => b.total - a.total || b.strivenOrders - a.strivenOrders);

  const payload = {
    ok: true, configured: true,
    // Every headline figure is now the Striven computation. These used to be the
    // sheet's numbers, which is exactly why the two never agreed.
    grandTotal: striven.grandTotal,
    byProgram: { ...striven.byProgram },
    byProgramCount: { ...(striven.byProgramOrders || { TriCare: 0, VA: 0, PI: 0 }) },
    payableTotal: striven.payableTotal, waitingTotal: striven.waitingTotal, heldOrders: striven.heldOrders,
    reps,
    striven,
    sources: [],
  };
  // Redaction happens HERE, before serialization — another rep's dollars must
  // never reach the browser, whether or not the UI would have hidden them.
  // A missing viewer fails closed (a rep with no own row unlocks nothing).
  return redactCommissionPayload(payload, viewer || { repName: null, role: 'rep' });
}

// ── ORDER ANALYTICS ──────────────────────────────────────────────────────────
// One flat, PHI-safe row per order: date, vertical, account, rep, revenue, the
// devices on it, and status. Small enough (a few hundred rows) to send whole and
// let the UI slice it by week / month / custom range without a round trip.
//
// "Account" is the PAYER — Veterans Affairs, TriCare, or the PI law firm. It is
// deliberately NOT the Striven customer, because that is the patient (PHI).
//
// Scoped like commission: a rep-role caller gets only orders booked to them; an
// admin gets the whole book. Revenue is company data, so the same boundary that
// protects commission protects it here.
export async function getOrderAnalytics(viewer = null) {
  const isAdmin = viewer?.role === 'admin';
  const mine = viewer?.repName ? String(viewer.repName).trim().toLowerCase() : null;

  let recent = [];
  // getSO() is the expensive derivation, and a single page load can reach it
  // three times (analytics + commission + rep overview). One short-lived memo
  // with in-flight de-duplication collapses those into one.
  try { recent = (await cached('derived:so', getSO, 60_000)).recent || []; } catch { /* Striven optional */ }
  let rcOrders = [];
  try { rcOrders = (await sbCacheRead('report_patient_items'))?.data?.orders || []; } catch { /* optional */ }

  // soId → devices on that order (item + qty). No names, no patient fields.
  const devBySo = new Map();
  for (const o of rcOrders) {
    const items = (o.items || [])
      .map((i) => ({ item: String(i.item || '').trim(), qty: Number(i.qty || 0) }))
      .filter((i) => i.item && i.qty > 0);
    if (items.length) devBySo.set(String(o.soId), items);
  }

  const now = Date.now();
  const days = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null; };

  const orders = [];
  let excludedCancelled = 0, excludedCancelledValue = 0;
  for (const r of recent) {
    // `recent` is the live book INCLUDING cancellations, so they are dropped
    // here. A cancelled order contributes no revenue, no devices and no count —
    // the same rule the commission engine applies.
    if (isCancelledStatus(r.status)) {
      excludedCancelled++;
      excludedCancelledValue = round2(excludedCancelledValue + Number(r.value || 0));
      continue;
    }
    const rep = commRep(r.rep || 'Unassigned');
    if (!isAdmin && (!mine || rep.toLowerCase() !== mine)) continue;
    const devices = devBySo.get(String(r.id)) || [];
    orders.push({
      ref: r.ref, soId: String(r.id),
      date: r.date || null,
      vertical: r.type || 'Other',                 // TriCare | VA | PI | Other
      // Payer — never the patient. Test payers ("Testing 1") fold into
      // Unassigned at the source, so they cannot appear as a row in ANY account
      // list: the dashboard donut, the account table and the totals drill all
      // read this field. The order itself still counts in orders and revenue —
      // only its fake account is dropped.
      account: (r.payer && !isTestPayer(String(r.payer).trim())) ? r.payer : 'Unassigned',
      rep,
      revenue: round2(Number(r.value || 0)),
      units: devices.reduce((s, i) => s + i.qty, 0),
      devices,
      status: r.status || '',
      invStatus: r.invStatus || '',
      strivenStage: r.stage || '',            // '' until the tag is mirrored
      // Interim ageing proxy until portal stage history accrues: an edit to the
      // order resets this, so it understates genuinely stale orders.
      daysSinceUpdate: days(r.updated || r.date),
      ageDays: days(r.date),
    });
  }

  // BUSINESS RULE: a rep may see exactly one dollar figure, their own
  // commission. Revenue is company data even on the rep's own orders, so it is
  // nulled here, at the serialization boundary, rather than hidden in the UI.
  // Computed first and stripped after, so the counts and unit totals above are
  // still derived from real values.
  //
  // The ONE exception lives in getPiStages, not here: PI commission is a
  // percentage of billed, so a PI rep must see billed revenue to understand
  // their own pay. Every other surface is counts only.
  const orderRows = isAdmin ? orders : orders.map((o) => ({ ...o, revenue: null }));

  return {
    ok: true,
    scopedToRep: isAdmin ? null : (viewer?.repName ?? null),
    verticals: ['PI', 'VA', 'DOL', 'TriCare'],    // DOL is live-but-empty until the first order
    orders: orderRows,
    // Dropped, not hidden: surfaced so the exclusion is visible rather than a
    // silent gap between this and Striven's own order count.
    excludedCancelled,
    excludedCancelledValue: isAdmin ? excludedCancelledValue : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Commission for one caller, computed ONCE and redacted per viewer.
 *
 * getCommission() reads nine sheet tabs plus the Striven derivations — ~11s. The
 * result is identical for everyone before redaction, so it is cached unredacted
 * and narrowed per caller here. Redaction always runs, so a cache hit can never
 * hand one rep another rep's figures.
 */
export async function getCommissionFor(viewer = null) {
  const raw = await cached('derived:commission:raw', () => getCommission({ repName: null, role: 'admin' }), 60_000);
  return redactCommissionPayload(raw, viewer || { repName: null, role: 'rep' });
}

// ── SAVED DASHBOARD VIEWS ────────────────────────────────────────────────────
// A named filter set (period, vertical, date range) per user. Stored in the same
// generic striven_cache table as the PI stages, so no schema change was needed.
// Keyed by the VERIFIED session user, so one person's views are never another's.
const VIEWS_KEY = 'dashboard_views';
const readViewStore = async () => {
  const hit = await sbCacheRead(VIEWS_KEY).catch(() => null);
  return hit?.data && typeof hit.data === 'object' ? hit.data : {};
};

// Both the saved views and the PI stages live in one JSON document per key, so a
// naive read-modify-write loses an update when two people save at once. Every
// mutation is funnelled through here: it serializes writes to a key within this
// process AND re-reads immediately before applying, so the read→write window is
// as small as it can be.
//
// Residual limitation, stated plainly: on Vercel each serverless instance has its
// own queue, so simultaneous writes from two instances can still collide. Moving
// each record to its own row is the real fix and needs a table.
const _writeQueue = new Map();
function withKeyLock(key, work) {
  const prev = _writeQueue.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);            // run regardless of prior outcome
  _writeQueue.set(key, next.catch(() => {}));    // never let a rejection poison the chain
  return next;
}
export async function listDashboardViews(user) {
  const store = await readViewStore();
  return { ok: true, views: Array.isArray(store[user]) ? store[user] : [] };
}
export async function saveDashboardView(user, view) {
  const name = String(view?.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('a view needs a name');
  if (!user) throw new Error('not signed in');
  return withKeyLock(VIEWS_KEY, async () => {
  const store = await readViewStore();          // re-read inside the lock
  const mine = Array.isArray(store[user]) ? store[user] : [];
  const entry = {
    id: `v${Date.now().toString(36)}`,
    name,
    filters: {
      preset: String(view?.filters?.preset ?? 'all'),
      from: String(view?.filters?.from ?? ''),
      to: String(view?.filters?.to ?? ''),
      vert: String(view?.filters?.vert ?? 'all'),
    },
    savedAt: new Date().toISOString(),
  };
  // Saving the same name twice replaces it rather than piling up duplicates.
  store[user] = [...mine.filter((v) => v.name.toLowerCase() !== name.toLowerCase()), entry].slice(-30);
  await sbCacheWrite(VIEWS_KEY, store);
  return { ok: true, view: entry, views: store[user] };
  });
}
export async function deleteDashboardView(user, id) {
  return withKeyLock(VIEWS_KEY, async () => {
  const store = await readViewStore();          // re-read inside the lock
  const mine = Array.isArray(store[user]) ? store[user] : [];
  store[user] = mine.filter((v) => v.id !== String(id));
  await sbCacheWrite(VIEWS_KEY, store);
  return { ok: true, views: store[user] };
  });
}

// ── REP OVERVIEW ─────────────────────────────────────────────────────────────
// The team seen from the reps' side: one row per rep with volume, revenue and
// commission, split by vertical.
//
// A manager sees every rep in full. A rep sees their OWN row in full and, for
// everyone else, order and unit COUNTS only — no revenue, no commission. The
// redaction happens here, before serialization, so another rep's money never
// reaches the browser.
export async function getRepOverview(viewer = null) {
  const isAdmin = viewer?.role === 'admin';
  const mine = viewer?.repName ? String(viewer.repName).trim().toLowerCase() : null;
  const isOwn = (rep) => Boolean(mine) && String(rep).trim().toLowerCase() === mine;

  // Computed unredacted, then narrowed per row below.
  const ADMIN = { repName: null, role: 'admin' };
  const [analytics, comm] = await Promise.all([
    cached('derived:analytics:admin', () => getOrderAnalytics(ADMIN), 60_000),
    getCommissionFor(ADMIN),
  ]);
  const commByRep = new Map((comm.striven?.byRep || []).map((r) => [r.rep, r]));
  const sheetByRep = new Map((comm.reps || []).map((r) => [r.rep, r]));
  const VERTS = ['PI', 'VA', 'DOL', 'TriCare', 'DEMO', 'Contract'];

  // Non-producers are FLAGGED, not dropped. Their commission rows are still
  // needed (a demo order still has to reconcile), so the exclusion is a display
  // fact the standings view honours rather than a hole in the data.
  const excluded = new Set((STANDINGS_EXCLUDE || []).map((s) => String(s).trim().toLowerCase()));
  const rows = REP_NAMES.map((rep) => {
    const own = isAdmin || isOwn(rep);
    const orders = analytics.orders.filter((o) => o.rep === rep);
    const cm = commByRep.get(rep) || null;
    const sh = sheetByRep.get(rep) || null;

    // Order counts are the one thing shared across the team. With
    // STANDINGS_ORDERS_ONLY on, everything else about another rep goes too, so
    // Team Standings can only ever be a ranking by volume.
    const lean = !own && STANDINGS_ORDERS_ONLY;
    const byVertical = VERTS.map((v) => {
      const set = orders.filter((o) => o.vertical === v);
      return {
        vertical: v,
        orders: set.length,
        units: lean ? null : set.reduce((s, o) => s + o.units, 0),
        // Revenue is financial: counts stay, money goes. ADMIN ONLY, not
        // `own`. A rep must not see revenue even on their own verticals, since
        // the only dollar figure they may see is their own commission.
        revenue: isAdmin ? round2(set.reduce((s, o) => s + o.revenue, 0)) : null,
      };
    });

    return {
      rep,
      isSelf: isOwn(rep),
      // True for house/ops/departed names: they carry orders but are not
      // producers, so Team Standings filters them out of the ranking.
      standingsExcluded: excluded.has(String(rep).trim().toLowerCase()),
      own,                                    // did this row survive unredacted?
      orders: orders.length,                  // always visible — the standings metric
      units: lean ? null : orders.reduce((s, o) => s + o.units, 0),
      // PI law firms only — see isRealAccount. VA/TriCare are verticals, and
      // counting them here is what made this figure unreadable.
      accounts: lean ? null : new Set(orders.map((o) => o.account).filter(isRealAccount)).size,
      // How many verticals this rep actually works in — the thing the old
      // "accounts" number was accidentally measuring for VA and TriCare reps.
      verticals: lean ? null : byVertical.filter((v) => v.orders > 0).length,
      devices: lean ? null : new Set(orders.flatMap((o) => o.devices.map((d) => d.item))).size,
      lastOrder: lean ? null : (orders.map((o) => o.date).filter(Boolean).sort().slice(-1)[0] || null),
      byVertical,
      // Admin only, for the same reason as byVertical above: own revenue is
      // still revenue. Commission below IS the rep's to see.
      revenue: isAdmin ? round2(orders.reduce((s, o) => s + o.revenue, 0)) : null,
      commission: own ? (cm?.total ?? 0) : null,
      payable: own ? (cm?.payableTotal ?? 0) : null,
      waiting: own ? (cm?.waitingTotal ?? 0) : null,
      matchRate: sh?.matchRate ?? null,       // operational, shared
      verified: sh?.verified ?? false,
    };
  });

  // ONE scope for the whole tile row. These figures describe the
  // REP-ATTRIBUTED book, so orders, units, accounts and revenue all count the
  // same set of orders. Previously `orders` summed the rep rows while revenue and
  // units summed the entire company book, which made the row contradict itself
  // and disagree with the Orders & Revenue page.
  const self = rows.find((r) => r.isSelf) ?? null;
  const repOrders = analytics.orders.filter((o) => REP_NAMES.includes(o.rep));
  const teamTotals = {
    reps: rows.length,
    orders: rows.reduce((s, r) => s + r.orders, 0),
    // Team-wide unit and account counts are only meaningful — and only shown —
    // to a manager; a rep would otherwise infer peers' volume by subtraction.
    units: isAdmin ? repOrders.reduce((s, o) => s + o.units, 0) : null,
    accounts: isAdmin ? new Set(repOrders.map((o) => o.account).filter(isRealAccount)).size : null,
    // Money is manager-only. This used to fall back to the rep's OWN revenue,
    // which is exactly the figure the business does not want a rep to see:
    // knowing what their orders billed drives "you made X, why am I paid Y".
    // Commission still falls back to their own, because that is their pay.
    revenue: isAdmin ? round2(repOrders.reduce((s, o) => s + o.revenue, 0)) : null,
    commission: isAdmin ? round2(rows.reduce((s, r) => s + (r.commission ?? 0), 0)) : (self?.commission ?? null),
  };
  // The rest of the order book: booked in Striven to someone who is not a rep
  // (house/clinic accounts, ops staff, unassigned). Reported rather than folded
  // in, so the gap against Orders & Revenue is explained instead of puzzling.
  const unattributed = isAdmin ? {
    orders: analytics.orders.length - teamTotals.orders,
    revenue: round2(analytics.orders.reduce((s, o) => s + o.revenue, 0) - teamTotals.revenue),
    // Units were missing here, which is what made the Devices KPI read 643
    // against Orders & Revenue's 644 with nothing on screen to explain it.
    // The gap is Rishi Arora's SO 294 — one device on an order deliberately
    // kept off the rep roster. Reporting it turns a contradiction into a
    // reconciliation.
    units: (analytics.orders.reduce((s, o) => s + o.units, 0)) - (teamTotals.units ?? 0),
  } : null;

  // The WHOLE order book — the same set Orders & Revenue reports, so the two
  // screens show identical headline figures instead of differing by whatever
  // sits outside the rep roster.
  //
  // teamTotals stays rep-scoped because the per-rep table and commission math
  // need it that way; this is the reconciled view for the KPI strip. Admin only:
  // a rep must not learn the company book by subtracting their own row.
  const bookTotals = isAdmin ? {
    orders: analytics.orders.length,
    units: analytics.orders.reduce((s, o) => s + o.units, 0),
    revenue: round2(analytics.orders.reduce((s, o) => s + o.revenue, 0)),
    // Distinct payers billed across the whole book, so the Accounts KPI reads
    // the same set as Orders, Devices and Revenue beside it.
    accounts: new Set(analytics.orders.map((o) => o.account).filter(isRealAccount)).size,
  } : null;

  return {
    ok: true,
    role: isAdmin ? 'admin' : 'rep',
    bookTotals,
    me: viewer?.repName ?? null,
    verticals: VERTS,
    reps: rows.sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.orders - a.orders),
    teamTotals,
    unattributed,
    bookOrders: isAdmin ? analytics.orders.length : null,
    excludedCancelled: analytics.excludedCancelled ?? 0,
  };
}

// ── PI ORDER STAGES ──────────────────────────────────────────────────────────
// Striven carries only In Progress / Completed / Canceled / Incomplete, so the
// operational pipeline is tracked HERE. State lives in the existing generic
// striven_cache table under one key — no schema change was needed.
//
// Every change appends to that order's history, so "how long has this been
// sitting" becomes a real measurement from the moment the feature goes live.
// Until an order has been moved once, ageing falls back to its order date and is
// flagged `estimated` so the two are never confused.
export { PI_STAGES };
const STAGE_KEY = 'pi_stages';
const isPiStage = (s) => PI_STAGES.includes(String(s));

async function readStageStore() {
  const hit = await sbCacheRead(STAGE_KEY).catch(() => null);
  const d = hit?.data;
  return d && typeof d === 'object' ? d : {};
}

/**
 * Move one order to a stage and record the transition.
 * @param {{soId:string, stage:string, user:string}} p
 */
export async function setPiStage({ soId, stage, user }) {
  const id = String(soId ?? '').trim();
  if (!id) throw new Error('soId is required');
  if (!isPiStage(stage)) throw new Error(`unknown stage "${stage}" — expected one of: ${PI_STAGES.join(', ')}`);
  return withKeyLock(STAGE_KEY, async () => {
  const store = await readStageStore();          // re-read inside the lock
  const prev = store[id];
  if (prev?.stage === stage) return { ok: true, unchanged: true, entry: prev };
  const at = new Date().toISOString();
  const entry = {
    stage,
    since: at,
    by: String(user ?? '').slice(0, 200),
    history: [...(Array.isArray(prev?.history) ? prev.history : []), { stage, at, by: String(user ?? '').slice(0, 200) }].slice(-40),
  };
  store[id] = entry;
  await sbCacheWrite(STAGE_KEY, store);
  return { ok: true, entry };
  });
}

/**
 * The PI pipeline: one bucket per stage with its orders, plus how long each has
 * been sitting. Scoped like commission — a rep sees only their own orders.
 */
export async function getPiStages(viewer = null) {
  const isAdmin = viewer?.role === 'admin';
  const mine = viewer?.repName ? String(viewer.repName).trim().toLowerCase() : null;

  const [analytics, store] = await Promise.all([getOrderAnalytics(viewer), readStageStore()]);
  const now = Date.now();
  const daysSince = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null; };

  const orders = analytics.orders
    .filter((o) => o.vertical === 'PI')
    .map((o) => {
      const rec = store[o.soId];
      // Striven wins when it has an answer — it is the system of record, and a
      // mirrored tag is maintained by the people doing the work. The portal's
      // own store is the fallback for as long as the API exposes no tag.
      const fromStriven = isPiStage(o.strivenStage) ? o.strivenStage : '';
      const stage = fromStriven || (isPiStage(rec?.stage) ? rec.stage : PI_STAGES[0]);
      // Real ageing once the order has been moved; otherwise the order date.
      const tracked = !fromStriven && Boolean(rec?.since);
      const since = tracked ? rec.since : o.date;
      return {
        ...o,
        stage,
        stageSince: since,
        daysInStage: daysSince(since),
        estimated: !tracked,                    // ageing is a fallback, not measured
        source: fromStriven ? 'striven' : (rec?.stage ? 'portal' : 'default'),
        movedBy: rec?.by || null,
        history: Array.isArray(rec?.history) ? rec.history : [],
      };
    })
    // Ascending by time in stage: the newest arrivals lead, and the hierarchy
    // continues from there. Ties break on order date (most recent first), then
    // on SO reference, so the order is stable across reloads.
    .sort((a, b) => (a.daysInStage ?? 0) - (b.daysInStage ?? 0)
      || String(b.date || '').localeCompare(String(a.date || ''))
      || String(b.ref || '').localeCompare(String(a.ref || '')));

  const stages = PI_STAGES.map((stage) => {
    const set = orders.filter((o) => o.stage === stage);
    const aged = set.map((o) => o.daysInStage ?? 0);
    return {
      stage,
      count: set.length,
      revenue: round2(set.reduce((s, o) => s + o.revenue, 0)),
      units: set.reduce((s, o) => s + o.units, 0),
      oldestDays: aged.length ? Math.max(...aged) : 0,
      avgDays: aged.length ? Math.round(aged.reduce((s, n) => s + n, 0) / aged.length) : 0,
    };
  });

  return {
    ok: true,
    scopedToRep: isAdmin ? null : (viewer?.repName ?? null),
    canEdit: isAdmin || Boolean(mine),
    stageNames: PI_STAGES,
    stages,
    orders,
    trackedCount: orders.filter((o) => !o.estimated).length,
    // Shipped/Delivered are manual for now: the tracking module keys rows by
    // patient last name, not by sales order, so there is no reliable join to
    // auto-advance a stage from carrier status yet.
    autoFromTracking: false,
    strivenStageField: STRIVEN_STAGE_FIELD,
    fromStriven: orders.filter((o) => o.source === 'striven').length,
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

// A PO that no longer counts: cancelled/voided/rejected in Striven. Such a PO
// must not be used as a template, must not show as "already created", and must
// not block a re-run — otherwise one bad run keeps an order stuck forever.
const poIsDead = (status) => /cancel|void|reject|denied/i.test(String(status ?? ''));

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
      if (poIsDead(po.status?.name)) continue;
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
  // Cancelled POs don't count as "linked" — the order still needs a real PO.
  if ((chain[String(soId)]?.pos ?? []).some((p) => !poIsDead(p.status))) { entry.skipped = 'SO already has a linked PO'; return entry; }
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
  const seen = new Set(); const logged = [];
  for (const e of (state.log || [])) {
    if (Number(e.soId) !== Number(soId)) continue;
    for (const p of (e.pos || [])) {           // new grouped structure
      if (p.poId && !seen.has(p.poId)) {
        seen.add(p.poId);
        logged.push({ poId: p.poId, vendor: p.vendor || '', vendorEmail: p.vendorEmail || '', items: p.items || [] });
      }
    }
    for (const l of (e.lines || [])) {          // backward-compat with old per-line logs
      if (l.poId && !seen.has(l.poId)) {
        seen.add(l.poId);
        logged.push({ poId: l.poId, vendor: l.vendor || '', vendorEmail: l.vendorEmail || '', items: [{ itemName: l.itemName || '', qty: l.qty ?? null }] });
      }
    }
  }
  // Drop the ones cancelled/voided in Striven since. Without this, a PO from an
  // OLD run (e.g. the pre-grouping one-PO-per-item code) keeps showing up as if
  // it were today's output, and the order can never be re-run cleanly.
  const pos = [];
  for (const p of logged) {
    let dead = false;
    try { dead = poIsDead((await striven('GET', `/v1/purchase-orders/${p.poId}`)).status?.name); }
    catch { /* unreadable → keep it rather than hide a real PO */ }
    if (!dead) pos.push(p);
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
      // Guard on LIVE POs only. If every PO the earlier run created was later
      // cancelled in Striven, the order genuinely has no PO — let it run again.
      const prior = await autoPoSoPos(soId);
      if (prior.pos.length) {
        return { ok: true, mode, note: `SO ${soId} already processed — idempotency guard`, checkpoint: state.lastSoId };
      }
      state.processed = state.processed.filter((n) => Number(n) !== soId);
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
      // Advance the checkpoint ONLY for actually-processed live orders — else a
      // dry run marches the checkpoint past orders that live mode would then skip.
      if (mode === 'live' && !entry.skipped) {
        state.lastSoId = Math.max(state.lastSoId, soId);
        state.processed.push(soId);
      }
    }
  }
  state.processed = state.processed.slice(-500);
  state.log = [...results, ...state.log].slice(0, 50);
  await sbCacheWrite('auto_po_state', state);
  return { ok: true, mode, demoOnly: autoPoDemoOnly(), processed: results, checkpoint: state.lastSoId };
}
