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
import { readXlsxBuffer } from './_xlsx-read.js';
import {
  COMMISSION_RATES, FALLBACK_VERTICAL_RATES, ORDER_LABEL_RULES,
  REP_DIRECTORY, REP_NAMES, STANDINGS_ORDERS_ONLY, STANDINGS_EXCLUDE, EXCLUDED_REPS,
  REP_SUB_REPS, REP_BLINDSPOTS, blindspotsFor, supervisorOf, PI_STAGES, STRIVEN_STAGE_FIELD,
  PI_LABEL_STAGE, PIP_STAGES, PIP_LABEL_STAGE, PIP_IDENTIFYING_LABELS, REVIEW_LABELS,
  VA_STAGES, VA_LABEL_STAGE, COMMISSION_PAID_THROUGH, canonicalStage, arExpectedFor,
  verticalOfCommissionLine,
} from './_commission-config.js';
import {
  commissionForOrder, splitByState, resolveIdentity,
  redactCommissionPayload, isCancelledStatus, reconcileToWorkbook,
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
/**
 * The app_config table, MEMOISED for 60 seconds and de-duplicated in flight.
 *
 * Every cfgValue() call used to be its own Supabase round trip, and there are
 * thirteen call sites — sheet ids, report URLs, the recon config, the paid-
 * through map, the Shippo token. A single cold page load therefore spent most of
 * a second re-reading the same fifteen-row table over and over, serially,
 * because each caller awaited its own copy.
 *
 * `_cfgInflight` is the important half: without it, the ten endpoints a page
 * fires in parallel each miss the empty cache at the same instant and start
 * their own fetch, so the memo saves nothing on the very load that needs it.
 * Sharing the promise collapses those into one request.
 *
 * 60s is short enough that changing a value in Supabase still takes effect
 * within a minute — which is the property the whole config-not-code pattern
 * exists for — and long enough that no single page load reads it twice.
 */
let _cfgCache = { at: 0, data: null };
let _cfgInflight = null;
const CFG_TTL = 60_000;
export async function readConfigTable() {
  const url = SB_URL(), key = SB_KEY();
  if (!url || !key) return {};
  if (_cfgCache.data && Date.now() - _cfgCache.at < CFG_TTL) return _cfgCache.data;
  if (_cfgInflight) return _cfgInflight;
  _cfgInflight = (async () => {
    try {
      const res = await fetch(`${url}/rest/v1/app_config?select=key,value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) return _cfgCache.data ?? {};
      const rows = await res.json();
      if (!Array.isArray(rows)) return _cfgCache.data ?? {};
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      _cfgCache = { at: Date.now(), data: out };
      return out;
    } catch {
      // A blip serves the LAST GOOD copy rather than {}. Returning empty would
      // read as "nothing is configured" and silently fall back to defaults —
      // which is how one host once computed commission a different way from
      // another. Stale config is recoverable; absent config is not.
      return _cfgCache.data ?? {};
    } finally { _cfgInflight = null; }
  })();
  return _cfgInflight;
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
  // The whole run has to fit Vercel's 60s function cap (vercel.json), and the
  // two incremental top-ups below are the only open-ended part of it. They share
  // what is left of a 50s allowance rather than each claiming a fixed budget —
  // two 25s defaults plus the base fetches above would have overrun. Whatever
  // does not fit is picked up by the next cycle, which is why both are
  // incremental in the first place.
  const startedAt = Date.now();
  const leftMs = () => 50_000 - (Date.now() - startedAt);
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
  try {
    out.so_detail = leftMs() > 2_000
      ? await refreshDerived({ budgetMs: Math.min(25_000, leftMs()) })
      : 'skipped: out of time, next cycle';
  } catch (e) { out.so_detail = `FAIL ${e.message}`; }

  // The device lines, on the same cycle and for the same reason. This used to be
  // rebuilt only by a script someone had to remember to run, so every order
  // newer than the last run showed a blank Devices column and 0 units while its
  // revenue and counts looked normal — wrong in a way nothing on screen said.
  //
  // It runs AFTER so_detail deliberately: it reads so_detail for each order's
  // type and status to skip demo and cancelled orders, so it wants the fresher
  // copy.
  try {
    out.report_patient_items = leftMs() > 2_000
      ? await refreshReportItems({ budgetMs: Math.min(20_000, leftMs()) })
      : 'skipped: out of time, next cycle';
  } catch (e) { out.report_patient_items = `FAIL ${e.message}`; }

  // The DEMO orders' device lines, in a cache of their own. Same cycle, last,
  // and the least important of the three — a stale demo count is a cosmetic
  // problem where a stale real one is a wrong number.
  try {
    out.report_demo_items = leftMs() > 2_000
      ? await refreshDemoItems({ budgetMs: Math.min(12_000, leftMs()) })
      : 'skipped: out of time, next cycle';
  } catch (e) { out.report_demo_items = `FAIL ${e.message}`; }

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

  // MISSING ENTIRELY, or written before a field existed.
  //
  // The second half is what makes adding a field to this cache work at all.
  // Entries are only ever written once, so a new field would otherwise reach
  // new orders only, and the whole back catalogue would read as "no tracking
  // number" — indistinguishable from a genuinely untracked order. Testing for
  // the KEY (not a truthy value) is the difference: an order Striven has no
  // tracking number for stores '' and is then left alone, so this converges
  // instead of re-fetching the same orders every cycle for ever.
  const stale = (id) => !(id in detail) || !('tracking' in (detail[id] || {}));
  const missing = soRows.map((r) => r.id).filter(stale);
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
          // Carrier tracking number, straight off the sales order in Striven —
          // the ONLY place one exists. Sparsely filled today (~6% of the book),
          // so most orders store '' and the columns downstream show a dash.
          // That is the honest reading: blank means nobody entered one, not
          // that the order never shipped.
          tracking: String(d?.trackingNumber ?? '').trim(),
          shipVia: d?.shipVia?.name ?? d?.shipVia ?? '',
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
    // Orders needing a fetch: never seen, PLUS ones whose entry predates a
    // field. After a field is added the first run reports the whole book here.
    missingBefore: missing.length,
    fetched,
    failed,
    remaining: Math.max(0, missing.length - fetched),
    complete: fetched >= missing.length,
    ms: Date.now() - started,
  };
}

// ── report_patient_items: the DEVICE LINES ───────────────────────────────────
// The per-order device lines every Devices column, unit count and commission
// figure reads. It was rebuilt ONLY by scripts/gen-reports.mjs (minutes, every
// order) or scripts/top-up-reports.mjs, both run by hand — so it went stale
// between runs and new orders rendered a blank Devices column and 0 units while
// their revenue and counts appeared normally. That is the exact failure
// refreshDerived() above was written for, one cache along: it showed up on the
// VA board as 25 of the newest orders with "-" in Devices.
//
// So it runs on the 6h cycle too. Incremental, like so_detail: only orders in
// `so` that the report has never seen, under a wall-clock budget so a backlog
// makes progress across successive runs instead of timing out and writing
// nothing. A full rebuild — changed lines on EXISTING orders — is still the
// generator's job.
//
// HIPAA: LAST NAME ONLY, patients keyed as PT-<id>. No first name, DOB or
// address is read out of the detail, and a demo/test customer's name is used to
// filter the row out and never stored.
const reportLastName = (name) => {
  const v = String(name ?? '').trim();
  if (!v) return '';
  if (v.includes(',')) return v.split(',')[0].trim();
  const parts = v.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
};
const reportProgram = (t) => {
  const s = String(t?.name ?? t ?? '').toLowerCase();
  if (/tri.?care/.test(s)) return 'TriCare';
  if (/\bva\b|veteran/.test(s)) return 'VA';
  if (/\bpi\b|personal injury/.test(s)) return 'PI';
  return 'Other';
};

/**
 * Fill in device lines for orders the report has never seen.
 *
 * Shared by the 6h refresh and scripts/top-up-reports.mjs, so the scheduled path
 * and the manual one cannot extract orders differently — which is the only way
 * a hand-run top-up and a cron top-up could ever leave the cache in two
 * different shapes.
 *
 * @param {{budgetMs?:number, maxOrders?:number, log?:(msg:string)=>void}} opts
 */
export async function refreshReportItems({ budgetMs = 20_000, maxOrders = 400, log } = {}) {
  const started = Date.now();
  const blob = (await sbCacheRead('report_patient_items'))?.data;
  // Never bootstrap from nothing: writing a fresh blob here would replace a
  // report the generator builds from EVERY order with one built from whatever
  // happened to be missing, and silently drop the patient aggregates.
  if (!blob) return { skipped: 'report_patient_items is empty — run scripts/gen-reports.mjs first' };

  const orders = [...(blob.orders || [])];
  const patients = blob.patients || [];
  const soRows = (await sbCacheRead('so'))?.data || [];
  const detail = (await sbCacheRead('so_detail'))?.data || {};
  const have = new Set(orders.map((o) => String(o.soId)));

  let skippedDemo = 0, skippedCancelled = 0;
  const todo = [];
  for (const so of soRows) {
    if (have.has(String(so.id))) continue;
    const meta = detail[so.id] || {};
    if (isCancelledStatus(meta.status)) { skippedCancelled += 1; continue; }
    // DEMO orders carry no device lines by the same rule the full generator
    // applies. They still count in the order book.
    if (isDemoType(meta.type) || isDemoType(meta.status)) { skippedDemo += 1; continue; }
    todo.push(so);
  }

  const byRef = new Map(patients.map((p) => [p.ref, p]));
  let added = 0, failed = 0, itemsAdded = 0;
  // Orders VISITED, not orders added. An order can be walked and still add
  // nothing — a demo customer is only recognisable from the detail, so it is
  // filtered inside the loop — and counting those as outstanding would report
  // `complete: false` forever on a list that is fully worked.
  let walked = 0;
  for (const so of todo.slice(0, maxOrders)) {
    if (Date.now() - started > budgetMs) break;              // leave time to write
    walked += 1;
    let d = null;
    for (let attempt = 0; attempt < 3 && !d; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { d = await striven('GET', `/v1/sales-orders/${so.id}`); } catch { /* retry */ }
    }
    if (!d) { failed += 1; log?.(`  FAIL  SO ${so.id} — detail unavailable after 3 attempts`); continue; }
    if (isDemoType(d.customer?.name)) { skippedDemo += 1; continue; }

    const custRef = d.customer?.id ? `PT-${d.customer.id}` : '(unassigned)';
    const p = byRef.get(custRef) || { ref: custRef, soCount: 0, totalValue: 0, items: [] };
    const itemMap = new Map((p.items || []).map((i) => [i.item, { ...i }]));

    const soItems = [];
    let soValue = 0;
    for (const li of (d.lineItems || [])) {
      const item = li.item?.name;
      if (!item) continue;
      const qty = Number(li.qty ?? li.quantity ?? 0);
      const val = round2(qty * Number(li.price ?? 0) + Number(li.shippingPrice ?? 0));
      soValue = round2(soValue + val);
      const it = itemMap.get(item) || { item, qty: 0, value: 0, soCount: 0 };
      it.qty += qty; it.value = round2(it.value + val); it.soCount += 1;
      itemMap.set(item, it);
      soItems.push({ item, qty, value: val });
      itemsAdded += 1;
    }

    p.soCount += 1;
    p.totalValue = round2(p.totalValue + soValue);
    p.items = [...itemMap.values()].sort((a, b) => b.qty - a.qty);
    byRef.set(custRef, p);

    orders.push({
      soId: so.id, so: `SO-${so.id}`,
      ref: String(d?.orderNumber ?? d?.number ?? d?.referenceNumber ?? '').trim(),
      custRef, lastName: reportLastName(d.customer?.name), program: reportProgram(d.type),
      date: (d.dateCreated ?? so.dateCreated ?? null), value: soValue, items: soItems,
    });
    added += 1;
    log?.(`  ok    SO ${String(so.id).padEnd(5)} ${String(detail[so.id]?.type ?? '').padEnd(10)} ${soItems.length} device line(s)`);
  }

  if (added > 0) {
    orders.sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }) || a.soId - b.soId);
    const patientReport = [...byRef.values()].sort((a, b) => b.soCount - a.soCount || b.totalValue - a.totalValue);
    await sbCacheWrite('report_patient_items', {
      ...blob, patients: patientReport, orders, count: patientReport.length, orderCount: orders.length,
    });
  }
  return {
    missingBefore: todo.length, added, failed, itemsAdded,
    skippedDemo, skippedCancelled,
    // A failure is retryable, so it stays outstanding; a walked-and-filtered
    // order does not.
    remaining: Math.max(0, todo.length - walked + failed),
    complete: walked >= todo.length && failed === 0,
    orderCount: orders.length,
    ms: Date.now() - started,
  };
}

// ── report_demo_items: the DEMO orders' device lines ─────────────────────────
// A SEPARATE CACHE, and the separation is the whole design.
//
// `report_patient_items` deliberately drops demo orders, and TEN things read it
// — the rep leaderboard's unit counts, the tracking board, the Reports tab, the
// vertical map, the zero-value check, the device mix. Putting demo rows in there
// behind a flag would mean every one of those had to filter it out, and missing
// a single site would put test orders into a commission or leaderboard figure
// without anything on screen saying so. That is not a risk worth taking to fill
// in one card.
//
// So the demo lines live under their own key that ONLY getDeviceMix reads.
// Nothing existing can regress, because nothing existing looks here.
//
// Incremental and budgeted, exactly like refreshReportItems: one Striven detail
// call per order it has not seen, stopping on a wall clock so a backlog makes
// progress across runs instead of timing out and writing nothing.
//
// HIPAA: no patient identifier is stored at all. The real report keeps a last
// name because a rep has to identify their own order; nobody needs to identify
// a demo, so this holds the sales order id, its type and its device lines and
// nothing else.
export async function refreshDemoItems({ budgetMs = 12_000, maxOrders = 200, log } = {}) {
  const started = Date.now();
  const prev = (await sbCacheRead('report_demo_items'))?.data ?? { orders: [] };
  const orders = [...(prev.orders || [])];
  const have = new Set(orders.map((o) => String(o.soId)));

  const soRows = (await sbCacheRead('so'))?.data || [];
  const detail = (await sbCacheRead('so_detail'))?.data || {};
  // The mirror image of refreshReportItems' filter: this one keeps ONLY what
  // that one skips. Cancelled is dropped by both — a cancelled demo is not a
  // demo that happened.
  const todo = soRows.filter((so) => {
    if (have.has(String(so.id))) return false;
    const meta = detail[so.id] || {};
    if (isCancelledStatus(meta.status)) return false;
    return isDemoType(meta.type) || isDemoType(meta.status);
  });

  let added = 0, failed = 0, itemsAdded = 0, walked = 0;
  for (const so of todo.slice(0, maxOrders)) {
    if (Date.now() - started > budgetMs) break;
    walked += 1;
    let d = null;
    for (let attempt = 0; attempt < 3 && !d; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { d = await striven('GET', `/v1/sales-orders/${so.id}`); } catch { /* retry */ }
    }
    if (!d) { failed += 1; log?.(`  FAIL  demo SO ${so.id}`); continue; }

    const items = [];
    for (const li of (d.lineItems || [])) {
      const item = li.item?.name;
      const qty = Number(li.qty ?? li.quantity ?? 0);
      if (!item || !(qty > 0)) continue;
      items.push({ item, qty });
      itemsAdded += 1;
    }
    orders.push({
      soId: so.id,
      ref: safeRef('SO', so.id, d.soNumber ?? so.number),
      type: detail[so.id]?.type || '',
      items,
    });
    added += 1;
  }

  if (added > 0) {
    orders.sort((a, b) => a.soId - b.soId);
    await sbCacheWrite('report_demo_items', {
      orders, orderCount: orders.length, generatedAt: new Date().toISOString(),
      note: 'DEMO / test sales orders and their device lines. Read ONLY by the Units by Device card — deliberately absent from report_patient_items, which feeds commission and the leaderboard. No patient identifier is stored.',
    });
  }
  return {
    missingBefore: todo.length, added, failed, itemsAdded,
    remaining: Math.max(0, todo.length - walked + failed),
    complete: walked >= todo.length && failed === 0,
    orderCount: orders.length,
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
  // Nothing here is manual any more. report_patient_items used to be — new
  // orders got their device lines only when someone ran the generator — and it
  // is now topped up incrementally on the same 6h cycle as so_detail. A FULL
  // rebuild (changed lines on existing orders) is still gen-reports.mjs's job,
  // but that is a different question from "is this cache current".
  const MANUAL_ONLY = new Set();
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
/**
 * Unapplied customer credits netted against that customer's open invoices,
 * OLDEST DUE FIRST. `payment.openBalance` is money the customer has paid that is
 * not applied to a specific invoice; Striven nets it in its own aging, so we do
 * the same. Returns invoice id → net open, plus the credit total.
 *
 * ONE DEFINITION, because two screens reporting different outstanding totals is
 * worse than either being wrong on its own. The AR Register originally read raw
 * `openBalance` and reported $50,109.94 across 17 invoices while the AR tab
 * beside it reported $35,075.99 across 11 — the difference being exactly the
 * $15,033.95 of credits, spread over six invoices that are in fact fully
 * covered. Both callers now net through here.
 *
 * Safe to pass PAID invoices too: they carry openBalance 0, so they consume no
 * credit and leave the order among the open ones untouched.
 */
async function netOpenByInvoice(live) {
  const payments = await allPayments();
  const creditByCust = new Map();
  for (const p of payments) { const c = p.customer?.id; const un = Number(p.openBalance || 0); if (c && un > 0) creditByCust.set(c, (creditByCust.get(c) || 0) + un); }
  const byCust = new Map();
  for (const r of live) { const c = r.customer?.id ?? 0; if (!byCust.has(c)) byCust.set(c, []); byCust.get(c).push(r); }
  const net = new Map();
  for (const [cust, invs] of byCust) {
    let credit = creditByCust.get(cust) || 0;
    invs.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    for (const r of invs) {
      const open = Number(r.openBalance || 0);
      const applied = Math.min(open, credit); credit -= applied;
      net.set(r.id, round2(open - applied));
    }
  }
  return { net, unappliedCredits: round2([...creditByCust.values()].reduce((s, v) => s + v, 0)) };
}

async function getAR() {
  const openInv = openOnly(await allInvoices());                          // openBalance > 0
  const statusOf = (r) => INVOICE_STATUS[r.id] ?? '';
  const live = openInv.filter((r) => !isVoidStatus(statusOf(r)));         // drop VOIDED invoices
  const voidedExcluded = round2(openInv.filter((r) => isVoidStatus(statusOf(r))).reduce((s, r) => s + Number(r.openBalance || 0), 0));

  const { net, unappliedCredits } = await netOpenByInvoice(live);
  const netRows = live.map((r) => ({ ...r, netOpen: net.get(r.id) ?? round2(Number(r.openBalance || 0)) }));
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
// ── ONE VENDOR, TWO RECORDS ──────────────────────────────────────────────────
// Striven carries "WMD" (id 33) and "Wholesale Medical Devices" (id 306) as
// separate vendor records for the same supplier: the second took two POs in
// June, everything from July onward is booked to the first. Every figure
// grouped by vendor NAME therefore split one supplier in two — the PO
// breakdown listed $840.50 and $70.00 as if they were unrelated companies, and
// neither half could be tied to the AP ledger, which knows the vendor by a
// third spelling again ("WHOLESALE MEDICAL DEVICES LLC").
//
// Folded HERE, at the boundary, exactly as reconRep() folds a rep's spellings,
// so one canonical name reaches every consumer and the vendor chart, the PO
// drill, the vendor drill and the bill list cannot disagree about who bought
// what.
//
// A DISPLAY FOLD, NOT A MERGE. Both records still exist in Striven and both
// still appear in the vendor master list — that list is a list OF RECORDS and
// would be lying if it quietly showed one. The real fix is merging them in
// Striven; until someone does, this keeps the money grouped correctly.
//
// IT DOES NOT MOVE A CENT. Only the grouping changes: the active PO total is
// the same figure before and after, which is the check to run on any addition
// here.
//
// Extend without a redeploy via the app_config key VENDOR_ALIASES — JSON of
// { "<alias, as Striven spells it>": "<canonical name>" }, merged over the
// defaults below. Keys match case-insensitively after trimming.
export const VENDOR_ALIASES = {
  // Folded TOWARDS the full name: it is what the AP ledger and the vendor
  // master both call the company, so the canonical form is the one already in
  // use everywhere else.
  'wmd': 'Wholesale Medical Devices',
};

const vendorAliasMap = async () => {
  const raw = String(await cfgValue('VENDOR_ALIASES', '')).trim();
  let extra = {};
  if (raw) {
    // A malformed override keeps the checked-in defaults rather than dropping
    // every fold — a typo in app_config must not silently re-split a vendor.
    try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) extra = v; } catch { /* defaults stand */ }
  }
  const m = new Map();
  for (const [k, v] of Object.entries({ ...VENDOR_ALIASES, ...extra })) m.set(String(k).trim().toLowerCase(), String(v));
  return m;
};
/** @param {Map<string,string>} map @returns {(name:unknown)=>string} */
const canonicalVendorWith = (map) => (name) => {
  const s = String(name ?? '').trim();
  return map.get(s.toLowerCase()) ?? s;
};

async function getAP() {
  const bills = openOnly(await allBills()).filter(notVoid);
  const canon = canonicalVendorWith(await vendorAliasMap());
  const rows = bills.map((r) => ({
    id: r.id, number: r.number ?? String(r.id),
    // The NAME is folded; `vendorId` is not, because it identifies the Striven
    // record and two records are what is actually there.
    vendor: canon(r.vendor?.name), vendorId: r.vendor?.id ?? null,
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
/**
 * invoice number → its PROGRAMME (PI / VA / TriCare / …), from two sources.
 *
 * An invoice carries no vertical of its own: it is a Striven transaction
 * against a customer, and the programme lives on the sales order behind it. So
 * it has to be joined, and one join is not enough:
 *
 *   1. `order_chain` — the SO→invoice link, so the SO's own type decides. This
 *      is the authoritative answer and covers most of the book.
 *   2. PT-<customer id> → the patient's programme in report_patient_items.
 *      The chain is rebuilt by a script and is currently a month stale, so the
 *      NEWEST invoices — exactly the ones at the top of the register, the ones
 *      anyone is actually looking at — are missing from it. This cache is on
 *      the 6h refresh, so it covers them.
 *   3. the payer text, last. `payerOf()` returns 'Veterans Affairs' or
 *      'TriCare' straight from the order type and the law firm otherwise, so a
 *      payer that names neither programme came from the PI branch.
 *
 * Blank when nothing resolves — the column shows a dash rather than a guess.
 */
async function invoiceVerticalMap() {
  const [sb, rc] = await Promise.all([
    sbCacheRead('order_chain').catch(() => null),
    sbCacheRead('report_patient_items').catch(() => null),
  ]);
  const byInvoice = {};
  for (const o of Object.values((sb && sb.data) || {})) {
    const v = soClass(o.type || '');
    if (!v || v === 'Other') continue;
    for (const inv of (o.invoices || [])) {
      const num = String(inv.ref || '').replace(/^#/, '');
      if (num) byInvoice[num] = v;
    }
  }
  const byCustRef = new Map();
  for (const o of (rc?.data?.orders || [])) if (o.custRef && o.program) byCustRef.set(o.custRef, o.program);
  return { byInvoice, byCustRef };
}
/** Programme implied by the payer, for invoices neither join reaches. */
const verticalOfPayer = (payer) => {
  const s = String(payer ?? '').trim();
  if (!s) return '';
  if (/veteran|\bva\b/i.test(s)) return 'VA';
  if (/tri.?care/i.test(s)) return 'TriCare';
  return 'PI';                       // payerOf() only names a law firm for PI
};

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
  // THE ROSTER, FOLDED — this list is the leaderboard, and a leaderboard is of
  // REPS. It used to be every distinct Striven "Sales Rep" value passed through
  // cleanRep(), which ranked a house bucket, a chiropractic practice and two
  // admins alongside the five people who sell.
  //
  // commRep() BEFORE the roster test, and that ordering is the whole thing.
  // Striven stores the reps under company prefixes and married/legal spellings —
  // "Maverick Medical - Alle Ann Dubberley", "CVT Medical - Christy Tan",
  // "Maverick Medical- Cassie Wates" — so of the five only "Maylon Sanders"
  // matches REP_NAMES literally. Testing the raw value against the roster would
  // have dropped the other four and left a leaderboard of one.
  //
  // Folding also MERGES the sub-rep: "Maylon Sanders - Denise Zavala" is
  // Maylon's order and Denise had her own 3-order bar next to his 32.
  //
  // Off-roster orders are not deleted from anything — they stay in `book`,
  // `count`, `totalValue`, `byType` and `recent`. They are simply not a rep, so
  // they are not on the rep board. The difference (count minus the sum of these
  // rows) is what the UI reports as off-roster volume.
  const rosterSet = new Set(REP_NAMES);
  const byRepMap = {};
  for (const r of book) {
    const raw = String(r.d.rep ?? '').trim();
    const rep = raw ? commRep(raw) : 'Unassigned';
    if (!rosterSet.has(rep)) continue;
    if (!byRepMap[rep]) byRepMap[rep] = { count: 0, value: 0, units: 0 };
    byRepMap[rep].count += 1;
    byRepMap[rep].value += Number(r.d.total || 0);
    byRepMap[rep].units += unitsBySo.get(String(r.id)) || 0;
  }
  const byRep = Object.entries(byRepMap).map(([rep, v]) => ({ rep, count: v.count, value: round2(v.value), units: v.units })).sort((a, b) => b.count - a.count || b.value - a.value);

  // The COMPLETE live order list (each row carries its status for filtering).
  // STRIVEN LABELS on each order. `status` is Striven's own In Progress /
  // Completed, which says nothing about where an order actually sits; the LABELS
  // are what decide its stage, so the orders table needs them alongside.
  //
  // The labels report does not cover the whole book — it carries the PI/PIP
  // orders only — so most rows come back with an empty array rather than a
  // label. Empty is the honest answer: it means Striven has tagged nothing.
  // TWO SAVED REPORTS, FETCHED TOGETHER. They are independent Striven requests
  // of ~2s each; awaiting them one after the other put both on the critical path
  // of every page that reaches getSO — which is nearly all of them — and cost a
  // needless ~1.9s on every cold load. Nothing here reads one to build the
  // other, so there was never a reason to serialise them.
  const [soTags, soTrack] = await Promise.all([
    soLabelsBySoId().catch(() => new Map()),
    // TRACKING, read per request rather than off the 6h cache, so a number
    // entered in Striven this morning is on the board now.
    soTrackingBySoId().catch(() => new Map()),
  ]);
  const recent = live.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => ({ id: r.id, ref: safeRef('SO', r.id, r.number), type: soClass(r.d.type), rep: cleanRep(r.d.rep), payer: payerOf(r.d), value: Number(r.d.total || 0), status: soStatusOf(r), invStatus: r.d.invStatus || '', date: r.dateCreated ?? null, updated: r.d.lastUpdatedDate ?? null, stage: r.d.stage || '', labels: soTags.get(String(r.id))?.labels ?? [],
      // REPORT FIRST, CACHE SECOND. Both read the same field in Striven and
      // agree on every row, so this is about FRESHNESS and COVERAGE, not about
      // one being more correct: the report is fetched now but is scoped to
      // PI + VA, while `so_detail` covers the whole book and can be up to 6h
      // old. Taking the report where it has a row and the cache everywhere else
      // is the only combination with neither a stale PI order nor a blank
      // TriCare one.
      tracking: soTrack.get(String(r.id))?.tracking || r.d.tracking || '',
      shipVia: soTrack.get(String(r.id))?.shipVia || r.d.shipVia || '',
      // FIRST INITIAL + SURNAME, already reduced at the boundary by
      // commInitialLastDisp() — the full first name is never carried here. Empty
      // where the labels report has no row for this order.
      patient: soTags.get(String(r.id))?.patient ?? '' }));

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

  // ── DEMO PURCHASE ORDERS ARE NOT SPEND ──────────────────────────────────────
  //
  // A PO raised to fulfil a DEMO sales order buys stock for a demonstration, and
  // counting it as vendor spend overstated the book by $9,818 across 27 POs —
  // 8% of the total. It also distorted the ranking rather than merely inflating
  // it: HiDow International was HALF demo ($13,160 against a real $6,440), so
  // the chart put it third on volume it never really bought.
  //
  // A PO CARRIES NO TYPE OF ITS OWN. Demo lives on the SALES ORDER, so the test
  // is the order-chain link — which is also why an UNLINKED PO is kept: with no
  // sales order behind it there is nothing to call it a demo, and dropping it
  // would quietly delete real spend on a guess.
  //
  // Filtered before the active / cancelled / pending split so no bucket carries
  // them, and reported as `demoCount` / `demoValue` so the exclusion is visible
  // on the card rather than being a silent shrink.
  const soDet = (await sbCacheRead('so_detail'))?.data || {};
  const demoSo = new Set(Object.entries(soDet)
    .filter(([, d]) => isDemoType(d?.type) || isDemoType(d?.status))
    .map(([id]) => `SO-${id}`));
  const rev = await poToSoMap();
  const refOf = (r) => safeRef('PO', r.id, r.poNumber);
  const isDemoPo = (r) => { const so = rev[refOf(r)]; return Boolean(so) && demoSo.has(so); };

  const demo = all.filter(isDemoPo);
  const live = all.filter((r) => !isDemoPo(r));

  const rows = live.filter((r) => r.classified && !poIsVoid(r));   // active, known-good
  const cancelled = live.filter((r) => r.classified && poIsVoid(r));
  const pending = live.filter((r) => !r.classified);     // not yet classified this session
  const sum = (list) => round2(list.reduce((s, r) => s + Number(r.poTotal ?? 0), 0));
  // One supplier held under two Striven records is one supplier here — see
  // VENDOR_ALIASES above. Applied before the grouping, so the aggregate is
  // right rather than corrected afterwards.
  const canon = canonicalVendorWith(await vendorAliasMap());
  const byVendorMap = {};
  for (const r of rows) { const v = canon(r.vendor?.name) || 'Unknown'; byVendorMap[v] = (byVendorMap[v] || 0) + Number(r.poTotal ?? 0); }
  const byVendor = Object.entries(byVendorMap).map(([vendor, total]) => ({ vendor, total: round2(total) })).sort((a, b) => b.total - a.total).slice(0, 12);
  const recent = rows.slice().sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''))
    .map((r) => { const ref = refOf(r); return { id: r.id, ref, vendor: canon(r.vendor?.name), total: Number(r.poTotal ?? 0), date: r.dateCreated ?? null, status: r.statusName ?? '', so: rev[ref] ?? '' }; });
  return {
    count: rows.length, totalValue: sum(rows), byVendor, recent,
    cancelledCount: cancelled.length, cancelledValue: sum(cancelled),
    pendingCount: pending.length, pendingValue: sum(pending),
    demoCount: demo.length, demoValue: sum(demo),
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
    // Folded like the list views, or opening a PO from the chart would show a
    // vendor name the chart does not use.
    id: r.id, ref: safeRef('PO', r.id, r.poNumber), vendor: canonicalVendorWith(await vendorAliasMap())(r.vendor?.name),
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
  // COUNTS PER MONTH, alongside the amounts. Without them the dashboard could
  // only ever show the FY-wide invoice count, which then sat under a
  // month-scoped figure and contradicted it — "$0 invoiced this month" beside
  // "165 invoices". A count belongs to the same period as the amount it sits
  // with, so it has to be carried here.
  const bump = (dateStr, key, amt, nKey) => {
    if (!dateStr) return;
    const m = String(dateStr).slice(0, 7);
    months[m] = months[m] || { month: m, revenue: 0, expenses: 0, invoices: 0, bills: 0 };
    months[m][key] += amt;
    months[m][nKey] += 1;
  };
  for (const r of inv) bump(r.dateCreated, 'revenue', Number(r.invoiceTotal ?? 0), 'invoices');
  for (const r of bills) bump(r.dateCreated, 'expenses', Number(r.totalAmount ?? 0), 'bills');
  const series = Object.values(months).map((m) => ({ ...m, revenue: round2(m.revenue), expenses: round2(m.expenses), net: round2(m.revenue - m.expenses) })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  return { series };
}
async function getPayments() {
  const rows = (await allPayments()).filter(notVoid);
  const total = round2(rows.reduce((s, r) => s + Number(r.paymentAmount ?? 0), 0));
  // Amount AND count per month — see the note in getTrends(). `count` above is
  // every payment ever taken, which is the wrong number to put beside a
  // month-scoped total.
  const byMonthMap = {};
  for (const r of rows) {
    const m = String(r.paymentDate ?? r.dateCreated ?? '').slice(0, 7);
    if (!m) continue;
    const e = byMonthMap[m] || { amount: 0, count: 0 };
    e.amount += Number(r.paymentAmount ?? 0);
    e.count += 1;
    byMonthMap[m] = e;
  }
  const byMonth = Object.entries(byMonthMap).map(([month, v]) => ({ month, amount: round2(v.amount), count: v.count })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
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
  // THE NOTE USED TO SAY "excluded from sales totals". That is false, and has
  // been since DEMO was deliberately put back into the order book — these 29
  // orders ARE in getSO's totalValue and in the vertical breakdown, under their
  // own DEMO bucket. They are excluded from PO SPEND, from the reports feed and
  // therefore from commission and the leaderboard. Stating the split accurately
  // matters more here than anywhere: this row is what someone reads to decide
  // whether a demo order is distorting a figure they are looking at.
  push({ key: 'demo_orders', severity: 'warn', title: 'DEMO / test sales orders', count: demo.length, value: round2(demo.reduce((s, r) => s + Number(det[r.id]?.total || 0), 0)), note: 'Counted in the order book (volume, value and the DEMO vertical) so it matches Striven\'s own list; excluded from PO spend, commission and the rep leaderboard. Should be archived in Striven.', columns: ['ref', 'type', 'value'], rows: demo.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, type: det[r.id]?.type || '', value: round2(Number(det[r.id]?.total || 0)) })) });
  const noRep = sos.filter((r) => { const t = det[r.id]?.type; return t && !isDemoType(t) && repIsUnassigned(det[r.id]?.rep); });
  push({ key: 'missing_rep', severity: 'warn', title: 'Sales orders with no sales rep', count: noRep.length, note: 'Rep is blank or "House Account" — needed for rep reporting.', columns: ['ref', 'rep', 'type'], rows: noRep.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, rep: cleanRep(det[r.id]?.rep) || '(none)', type: det[r.id]?.type || '' })) });
  const unclassified = sos.filter((r) => { const t = det[r.id]?.type; return t && !isDemoType(t) && soClass(t) === 'Other'; });
  push({ key: 'missing_pi_va', severity: 'warn', title: 'Sales orders not classified PI / VA / Tri-Care', count: unclassified.length, note: 'Order type does not map to PI, VA or Tri-Care.', columns: ['ref', 'type'], rows: unclassified.slice(0, 25).map((r) => ({ ref: `SO-${r.id}`, type: det[r.id]?.type || '(none)' })) });

  // ── SALES ORDERS PRICED AT NOTHING ──────────────────────────────────────────
  // 38 live orders carry line items and a total of $0 — 36 of them TriCare, and
  // 30 raised in a single batch on 12–13 May. They are not empty shells: every
  // one has devices on it, and the same devices are priced on other orders.
  //
  // NOTHING IS IMPUTED HERE, deliberately. The list prices are stable but not
  // unambiguous — "TriCare 4 Stim" bills at $425 on some orders and $500 on
  // others, and the garments appear at both $75 and $0 on orders that are
  // otherwise priced. So the real value of these 38 cannot be derived, only
  // guessed at, and a revenue figure this page invented would be worse than the
  // zero it replaced. What CAN be stated exactly is which orders they are and
  // what is on them, which is what a person needs to go and price them.
  //
  // This is a different fault from `item_price` below: that one is about the
  // ITEM master having no price, this is about ORDERS that priced to nothing
  // regardless. An order can be $0 while every item on it has a list price.
  // LINE ITEMS COME FROM THE SO-WISE REPORT CACHE, not `so_detail`, which
  // carries an order's type, rep and total but no items at all. Reading
  // `det[id].items` here found nothing and produced an empty group — a check
  // that silently passes is worse than no check, so the source is named.
  // That cache already excludes cancelled and demo orders, which is exactly the
  // population this should be asking about.
  const soRep = await sbCacheRead('report_patient_items').catch(() => null);
  const zeroValueSos = (soRep?.data?.orders || [])
    .filter((o) => (o.items?.length ?? 0) > 0 && !(Number(o.value || 0) > 0));
  push({
    key: 'zero_value_orders', severity: 'high',
    title: 'Sales orders with line items but no value',
    count: zeroValueSos.length,
    note: 'Devices are on the order and the order totals $0, so it contributes nothing to revenue, commission or the order book. The value is NOT estimated here: the same devices bill at more than one price elsewhere (4 Stim at both $425 and $500, garments at both $75 and $0), so the real figure has to be set in Striven rather than guessed at.',
    columns: ['ref', 'type', 'date', 'devices', 'units'],
    // No patient. The cache carries an initial + surname and this list does not
    // need it to be actionable — an SO reference is what someone opens.
    rows: zeroValueSos.slice(0, 25).map((o) => ({
      ref: String(o.so || `SO-${o.soId}`),
      type: o.program || '',
      date: String(o.date || '').slice(0, 10),
      devices: (o.items || []).map((i) => i.item).join(', ').slice(0, 60),
      units: (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0),
    })),
  });

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
  const data = r?.data;
  if (!data) return { patients: [], count: 0, generatedAt: null, note: 'Report not generated yet.' };

  // FIRST INITIAL + SURNAME, derived HERE and not stored.
  //
  // report_patient_items keeps the surname alone — gen-reports.mjs drops the
  // first name at ingest, and that boundary is deliberate, so this does NOT
  // widen what sits at rest. The labels report is the one source carrying a
  // full name; commInitialLastDisp() reduces it to a letter before it is
  // serialized, exactly as the PI/PIP board does. Cached rows are untouched:
  // only the response is enriched.
  //
  // Falls back to the stored surname whenever the labels report has no row for
  // that order, so a name never disappears in exchange for an initial.
  const tags = await soLabelsBySoId().catch(() => new Map());
  if (!tags.size || !Array.isArray(data.orders)) return data;
  const orders = data.orders.map((o) => {
    const better = tags.get(String(o.soId))?.patient;
    return better ? { ...o, lastName: better } : o;
  });
  return { ...data, orders };
}

/**
 * UNITS BY DEVICE — counts only, never money.
 *
 * One row per device: units, how many ORDERS carried it, its programme, and how
 * many of those units sit on a held order.
 *
 * The hold count has to be derived HERE. The commission engine excludes a held
 * order outright (ORDER_LABEL_RULES: hold → no line at all), so every line it
 * emits reads 'payable' and heldOrders is 0 across the board — the hold is
 * invisible downstream. The Striven LABEL report is the only place it survives,
 * and joining it to devices needs the soId→labels map that lives on this side.
 *
 * ADMIN ONLY. report_patient_items carries no rep, so there is no way to scope
 * these rows to one rep's book; rather than leak the company's device mix to a
 * rep, a non-admin gets nothing.
 */
export async function getDeviceMix(viewer = null) {
  if (viewer?.role !== 'admin') return { ok: true, devices: [], scoped: false };
  const [rc, tags, soBlob] = await Promise.all([
    sbCacheRead('report_patient_items').catch(() => null),
    soLabelsBySoId().catch(() => new Map()),
    // WHEN each order was raised. The units source carries no date of its own —
    // it is a device report keyed by sales order — so the month has to be joined
    // from the order book. Without it this endpoint can only ever answer for the
    // whole book, which is why Units by programme ignored the period filter.
    sbCacheRead('so').then((b) => b?.data ?? []).catch(() => []),
  ]);
  const monthBySo = new Map(
    (Array.isArray(soBlob) ? soBlob : [])
      .filter((o) => o?.id != null && o?.dateCreated)
      .map((o) => [String(o.id), String(o.dateCreated).slice(0, 7)]),
  );
  const orders = rc?.data?.orders ?? [];
  const held = new Set(['hold']);                 // the label, not a stage
  // Keyed case-insensitively: item names are typed by hand, so "PI TENS/NMES"
  // and "PI Tens/NMES" are one device and must not rank as two.
  const m = new Map();
  for (const o of orders) {
    const onHold = (tags.get(String(o.soId))?.labels ?? [])
      .some((l) => held.has(String(l).trim().toLowerCase()));
    const month = monthBySo.get(String(o.soId)) || '';
    for (const it of o.items ?? []) {
      const name = String(it.item ?? '').trim();
      const units = Number(it.qty ?? 0);
      if (!name || units <= 0) continue;          // zero-unit rows are hidden, not zero bars
      const k = name.toLowerCase();
      const e = m.get(k) ?? { device: name, vertical: o.program || 'Other', units: 0, orders: 0, heldUnits: 0, heldOrders: 0, byMonth: {} };
      e.units += units;
      e.orders += 1;
      if (onHold) { e.heldUnits += units; e.heldOrders += 1; }
      // PER MONTH, so the board can scope units to a period. An order the `so`
      // cache has no date for lands in no month and is reported by the client as
      // undated rather than folded into one — the same rule the rep board uses,
      // because silently banking undated work into a month is how a period total
      // comes to disagree with the all-time one it should sum into.
      if (month) {
        const b = e.byMonth[month] ?? { units: 0, orders: 0 };
        b.units += units; b.orders += 1;
        e.byMonth[month] = b;
      }
      m.set(k, e);
    }
  }
  // ── DEMO, from its own cache, as its own rows ───────────────────────────────
  // Merged HERE and nowhere else: report_demo_items exists so exactly one card
  // can show demo without any other figure on the site learning about it.
  //
  // NOT folded into the real device rows. "Genesys Lumbar" selling 25 real
  // units and 2 demo units is two different facts, and adding them gives a
  // number that is neither — so a demo device is its own row, flagged, and the
  // caller decides whether to show or total it. `vertical: 'DEMO'` puts it
  // outside every programme filter for free.
  const demoBlob = await sbCacheRead('report_demo_items').catch(() => null);
  const demoRows = new Map();
  for (const o of (demoBlob?.data?.orders ?? [])) {
    for (const it of o.items ?? []) {
      const name = String(it.item ?? '').trim();
      const units = Number(it.qty ?? 0);
      if (!name || units <= 0) continue;
      const k = name.toLowerCase();
      const e = demoRows.get(k) ?? { device: name, vertical: 'DEMO', units: 0, orders: 0, heldUnits: 0, heldOrders: 0, byMonth: {}, demo: true };
      e.units += units; e.orders += 1;
      demoRows.set(k, e);
    }
  }

  const bySize = (a, b) => b.units - a.units || a.device.localeCompare(b.device);
  return {
    ok: true,
    scoped: true,
    // Real devices first, demo after — a sorted list that interleaved them would
    // rank a demo above a real device on units, which is exactly the comparison
    // this card must not invite.
    devices: [...[...m.values()].sort(bySize), ...[...demoRows.values()].sort(bySize)],
    demoUnits: [...demoRows.values()].reduce((s, d) => s + d.units, 0),
    demoDevices: demoRows.size,
    demoOrders: (demoBlob?.data?.orders ?? []).length,
  };
}

// ── COMMISSION RECONCILIATION (Google Sheet) ─────────────────────────────────
// "Commission Payout Reconciliation: Sign-off Summary" — payout sheets matched
// against the live Striven pull. Its Detail tab is now the BASE for commission
// figures in the portal.
//
// AUTO-MATCHED ONLY, per the sheet's own tier definition: "Patient and rep
// resolve to a Striven sales order after normalization; label state consistent
// with the sheet's due/paid position. Safe to pay/portal-load without further
// checks." Needs-review and Unmatched rows are carried as counts so the money
// held back is visible, but they are never added to a payable figure.
// WHERE THE SHEET ID COMES FROM. Supabase `app_config` first, environment
// second — the same order as shippoToken(), and for the same reason: a value
// that lives in the table can be changed without a redeploy, and one host
// forgetting to set it is not a silent outage.
//
// It used to read process.env ONLY, and that is exactly how production and
// local came to disagree. Vercel had no COMMISSION_RECON_SHEET_ID, so
// getCommissionRecon() returned `configured: false`, the whole reconciliation
// block was skipped, and Commission Due silently fell back to the Striven
// engine ($211,269) while localhost — which had the variable in
// striven-server/.env — showed the sheet's $169,909.20. Neither figure was
// wrong for the code that produced it; the two hosts were simply not running
// the same configuration, and nothing on the page said so.
//
// Reading the table closes that: set the key once in Supabase and every host
// picks it up, including any future one nobody remembers to configure.
// THE resolution order for every externally-configured value, in one place:
// Supabase `app_config` first, environment second, hardcoded default last.
//
// Generalised from reconConfig() after the same bug bit three more keys. Any
// setting read straight from process.env is a setting that can be present on
// one host and absent on another, and the failure is not loud: a missing sheet
// id renders "X is not set" on the tab, or — worse, as it did for commission —
// silently falls back to a different calculation and shows a plausible wrong
// number. Reading the table means the value is set once and every host agrees.
export const cfgValue = async (key, fallback = '') => {
  const t = await readConfigTable().catch(() => ({}));
  return t[key] || process.env[key] || fallback;
};

const reconConfig = async () => ({
  id: await cfgValue('COMMISSION_RECON_SHEET_ID'),
  gid: await cfgValue('COMMISSION_RECON_GID', '1281286844'),
});

// ── THE hard-exclusion rule, in one place ────────────────────────────────────
// Companion to isStandingsExcluded() further down, and deliberately NOT the
// same test. isStandingsExcluded asks "should this rep be ranked?" — a display
// question, answered per leaderboard. This asks "is this a rep at all?", and a
// `true` means the name must not survive to ANY payload: not a roster row, not
// a picker entry, not an off-roster remark, not a dollar in a total.
//
// It is applied at every point a name can enter a response, rather than filtered
// once at the end, because the payload is assembled from four independent
// sources (REP_NAMES, the order book, the reconciliation sheet, and the analytics
// rollup) and a single late filter would have to know all four shapes. The call
// sites are: the recon reader below, and getCommission's roster / offRoster /
// unmatched blocks.
//
// Compared against the FOLDED name (commRep / reconRep output), so raw spelling
// variants are already collapsed by the time this runs.
export const isExcludedRep = (rep) => (EXCLUDED_REPS || [])
  .some((s) => String(s).trim().toLowerCase() === String(rep ?? '').trim().toLowerCase());

// The sheet spells one rep two ways ("Jillian" and "Jillian Colin"), which would
// otherwise split her total across two rows. Names are folded onto the portal's
// REP_DIRECTORY spelling here, at the boundary, so nothing downstream has to
// know the sheet's variants.
const RECON_REP_ALIASES = [
  [/^alle/i, 'Alle Ann'],
  [/^jillian/i, 'Jillian'],
  [/^christy/i, 'Christy'],
  [/^cassie/i, 'Cassie'],
  [/^maylon/i, 'Maylon Sanders'],
  [/^kinley/i, 'Kinley Shepherd'],
  [/cmc/i, 'CMC (direct)'],
];
const reconRep = (raw) => {
  const s = String(raw ?? '').trim();
  for (const [re, name] of RECON_REP_ALIASES) if (re.test(s)) return name;
  return s;
};

// ── Payout cycle → the MONTH it pays for ─────────────────────────────────────
// The sheet's "Payout Cycle" column names a PAY DATE, not a period: "Payable 15
// Aug 26 (due)", "Paid ~15 Jul 26", "Paid ~Apr/May 26". A cycle settles the
// PREVIOUS month's work — the 15 Aug 26 run pays July — so the month is the pay
// month minus one. This is the rule the source workbooks encode in their tab
// names (a tab called 8/15/2026 holds July's commission).
//
// THE FIRST MONTH NAMED WINS. "Paid ~Apr/May 26" is one run that went out over
// a month boundary; its work is March, and taking the later name would collide
// with the "15 May 26" cycle, which is April. Verified against both workbooks:
// all five live cycles resolve to the tab that contains exactly the same lines
// and the same total, to the cent.
//
// Unparseable → null. Such a line keeps its money and its place in the rep's
// total; it simply belongs to no month and is reachable only under All months.
// Guessing a month for it would move real money into a period at random.
const CYCLE_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function monthOfPayoutCycle(cycle) {
  const s = String(cycle ?? '');
  const m = new RegExp(`\\b(${CYCLE_MON.join('|')})[a-z]*`, 'i').exec(s);
  if (!m) return null;
  // The year token AFTER the month name, so the "15" in "15 Aug 26" cannot be
  // read as one. Two digits are 20xx: this sheet has no 19xx cycle.
  const y = /\b(\d{2}|\d{4})\b/.exec(s.slice(m.index + m[0].length));
  if (!y) return null;
  const year = Number(y[1]) < 100 ? 2000 + Number(y[1]) : Number(y[1]);
  const payIdx = CYCLE_MON.indexOf(m[1].toLowerCase());
  const d = new Date(year, payIdx, 1);
  d.setMonth(d.getMonth() - 1);                 // the cycle pays the month before
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Per-rep commission from the reconciliation sheet.
 *
 * Patient names come from the sheet's "Striven Match" column, which is already
 * properly cased ("Ruby Drisdell"), and are reduced to INITIAL + SURNAME here —
 * the sheet's own patient column carries full legal names in mixed case and
 * never leaves this function.
 */
export async function getCommissionRecon() {
  const { id, gid } = await reconConfig();
  if (!id) {
    return {
      ok: false, configured: false, byRep: [],
      note: 'COMMISSION_RECON_SHEET_ID is set neither in Supabase app_config nor in the environment.',
    };
  }
  return cached('derived:commission-recon', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const csv = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!csv) return { ok: false, configured: true, byRep: [], note: 'Reconciliation sheet is unreachable.' };

    // The sheet's "Striven Match" column reads "Ruby Drisdell / RDrisdell" —
    // the second half is the ORDER NUMBER, and Striven order numbers frequently
    // embed a patient's initial and surname. safeRef() masks exactly those, so
    // the number is resolved to its SO id here and the masked ref emitted; the
    // raw number never leaves this function.
    const soBlob = await sbCacheRead('so').catch(() => null);
    const soRows = Array.isArray(soBlob?.data) ? soBlob.data : [];
    const soByNumber = new Map(soRows.filter((o) => o?.number != null)
      .map((o) => [String(o.number).trim().toLowerCase(), o]));
    // patient (initial + surname) → the order(s) carrying it, for the fallback
    // below. The `so` cache is PHI-scrubbed — its customer is a PT-<id> — so the
    // names come from the labels report, the one source that has them. A key
    // with more than one order is kept AS a list precisely so the fallback can
    // see it is ambiguous and refuse.
    const soById = new Map(soRows.map((o) => [String(o.id), o]));
    const soByPatient = new Map();
    for (const [soId, tag] of await soLabelsBySoId().catch(() => new Map())) {
      const key = String(tag?.patient ?? '').trim().toLowerCase();
      const row = soById.get(String(soId));
      if (!key || !row) continue;
      soByPatient.set(key, [...(soByPatient.get(key) ?? []), row]);
    }

    const rows = parseCsvRows(csv);
    const hIdx = rows.findIndex((r) => r.some((c) => /match status/i.test(String(c))));
    if (hIdx < 0) return { ok: false, configured: true, byRep: [], note: 'Reconciliation sheet has no Match Status column.' };
    const hdr = rows[hIdx].map((c) => String(c).trim());
    const col = (n) => hdr.findIndex((h) => h.toLowerCase().startsWith(n.toLowerCase()));
    const C = {
      cycle: col('Payout Cycle'), vert: col('Vertical'), pat: col('Patient'),
      rep: col('Rep'), item: col('Device'), amt: col('Commission'),
      status: col('Match Status'), match: col('Striven Match'),
    };

    const tierOf = (s) => {
      const v = String(s ?? '').trim().toLowerCase();
      return v.startsWith('auto') ? 'auto' : v.startsWith('needs') ? 'review' : v.startsWith('unmatched') ? 'unmatched' : 'other';
    };
    const byRep = new Map();
    let totals = { auto: 0, review: 0, unmatched: 0, rows: 0 };

    for (const r of rows.slice(hIdx + 1)) {
      const repRaw = String(r[C.rep] ?? '').trim();
      const amt = sheetMoney(r[C.amt]);
      if (!repRaw || !amt) continue;
      const rep = reconRep(repRaw);
      // Dropped BEFORE `totals` is touched, so an excluded name contributes to
      // no figure the page can print — not the payable headline, not the
      // auto/review/unmatched split, not the row count. Skipping later (at the
      // byRep merge, say) would have left their money inside `totals` with no
      // row to explain it, which is the one outcome worse than either choice.
      if (isExcludedRep(rep)) continue;
      const tier = tierOf(r[C.status]);
      const e = byRep.get(rep) ?? {
        rep, payableTotal: 0, reviewTotal: 0, unmatchedTotal: 0,
        autoRows: 0, reviewRows: 0, unmatchedRows: 0, lines: [],
      };
      totals.rows += 1;

      // EVERY VALUED ROW IS A LINE NOW, not just the auto-matched ones.
      //
      // This reader previously kept auto-matched rows only, which was right
      // while the brief was "push only what is automatched". The brief has
      // changed: a rep's dashboard shows their whole sheet, and the rows Striven
      // could not confirm are marked rather than withheld. Dropping them made
      // Jillian's board read $23,721.04 against a sheet that says $57,234.20,
      // with the difference invisible to the person being paid.
      //
      // `matched` on the line is what drives the "Unmatched from Striven"
      // remark; the tier still drives the per-rep breakdown below.
      const cell = String(r[C.match] ?? '');
      // THE MATCH COLUMN IS NOT ALWAYS A NAME. On rows Striven could not tie,
      // the sheet writes a PHRASE there — "Not Found" on 15 of them — and
      // feeding that to the name masker produced a patient called "N. Found"
      // on Jillian's statement. Anything that is not a real match is discarded
      // so the row falls back to the sheet's own Patient column.
      const matchedRaw = cell.split('/')[0].trim();
      const matched = /^(not\s*found|none|n\/?a|no\s*match|-|—)$/i.test(matchedRaw) ? '' : matchedRaw;
      // THE CELL CAN NAME MORE THAN ONE ORDER: "Ruben Eloi / REloi,158" and
      // "Arnold Agaba / 113,116" are single sheet rows covering two sales
      // orders. Joining the tail back into one string looked up "REloi,158",
      // which is not an order number, so rows the sheet had correctly matched
      // came out with no reference at all. Each candidate is tried in turn;
      // the first that resolves wins, which is the right one to show because
      // the row is one commission line however many orders fed it.
      const soNums = (cell.includes('/') ? cell.split('/').slice(1).join('/') : '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      let so = null;
      for (const n of soNums) { so = soByNumber.get(n.toLowerCase()) || null; if (so) break; }
      // FALLBACK: the number is wrong but the ORDER EXISTS. The sheet writes an
      // initials-style number for some VA rows ("LCarpenter", "CBaham",
      // "MMoniz") that Striven never issued — those orders are numbered 442,
      // 443 and 447. The patient in the same cell does identify them, so it is
      // used, but ONLY when it picks out exactly one order in the whole book:
      // a surname shared by two patients must stay unresolved rather than
      // attach a rep's commission to somebody else's order.
      if (!so && matched) {
        const key = commInitialLastDisp(matched).trim().toLowerCase();
        const hit = key ? soByPatient.get(key) : null;
        if (hit && hit.length === 1) so = hit[0];
      }
      e.lines.push({
        // '' rather than a guess when the sheet row ties to no live order —
        // CMC-direct, pre-Striven and unmatched rows genuinely have none, and
        // inventing a reference would make them look verifiable.
        ref: so ? safeRef('SO', so.id, so.number) : '',
        // The Striven spelling when there is one, the sheet's own otherwise.
        // Unmatched rows have no Striven half, so they fall back to the sheet's
        // Patient column — reduced to an initial + surname either way, at this
        // boundary, before anything is stored.
        patient: commInitialLastDisp(matched || r[C.pat]),
        // WHEN THE SALES ORDER WAS RAISED. Off the matched Striven order, not
        // the sheet — the sheet has a payout cycle but no order date, and a
        // payout cycle is when the money moves, not when the work happened. A
        // rep reconciling a line against their own records needs the latter.
        //
        // null on a row that ties to no live order (CMC-direct, pre-Striven,
        // unmatched); there is genuinely no date to show and inventing the
        // cycle's would make an unverifiable row look verified.
        date: so?.dateCreated ?? null,
        prog: String(r[C.vert] ?? '').trim(),
        item: String(r[C.item] ?? '').trim(),
        cycle: String(r[C.cycle] ?? '').trim(),
        // WHICH MONTH THIS LINE IS COMMISSION FOR — the payout cycle's own
        // period, which is what the business pays on, not the sales order's
        // date. See monthOfPayoutCycle() above.
        month: monthOfPayoutCycle(r[C.cycle]),
        comm: round2(amt),
        state: 'payable',
        // The one flag the UI needs. Everything else about a row's provenance
        // stays out of the payload.
        unmatched: tier === 'unmatched',
        // Internal, and deleted before this function returns: the totals are
        // computed from the lines AFTER the workbook check below, so each line
        // has to carry the tier it was read at.
        tier,
        // ALSO INTERNAL, and the name the workbook check pairs on. It is NOT
        // `patient` above: that one prefers the STRIVEN spelling of a matched
        // row, and Striven and the workbook disagree about which token of a
        // compound name is the surname often enough to matter. The sheet's own
        // Patient column is the column the workbook was transcribed from, so it
        // is the only one that can be relied on to pair.
        sheetPatient: commInitialLastDisp(r[C.pat]),
      });

      byRep.set(rep, e);
    }

    // ── THE SHEET AGAINST THE WORKBOOK IT WAS TRANSCRIBED FROM ───────────────
    // Applied BEFORE any total is computed, so every figure below — the rep's
    // payable, the auto/review/unmatched split, the sheet-wide payable — is
    // taken from the corrected lines and no two of them can disagree.
    //
    // Cassie's July 2026 cycle is why this runs: five $80 brace lines had been
    // transcribed at the $425 combo rate and a $425 line was missing outright,
    // so her board read $21,555 against a workbook that says $20,255. Every
    // other rep-month in both books agrees with the sheet to the cent, which is
    // what makes the check safe to apply everywhere rather than to one rep.
    const source = await commissionSourceIndex().catch(() => null);
    const corrections = { lines: 0, added: 0, amount: 0, orphanedLines: 0, reps: [] };
    if (source?.configured) {
      for (const [rep, e] of byRep) {
        const byMonth = new Map();
        for (const l of e.lines) {
          if (!l.month) continue;                // no month, no bucket to check it against
          byMonth.set(l.month, [...(byMonth.get(l.month) ?? []), l]);
        }
        let repDelta = 0, repLines = 0, repAdded = 0;
        for (const [month, lines] of byMonth) {
          const wbRows = source.byRepMonth.get(`${rep}|${month}`);
          if (!wbRows?.length) continue;         // the books say nothing here; leave the sheet alone
          const { corrected, added, orphaned, delta } = reconcileToWorkbook(lines, wbRows, {
            // The sheet's own Patient column on a sheet line; the workbook's
            // own on a workbook row, which carries no `sheetPatient` at all.
            keyOf: (x) => x.sheetPatient || x.patient,
          });
          // A workbook row with no sheet line at all. It is still owed, so it
          // becomes a line — carrying the cycle and vertical of its own
          // rep-month, because the workbook records neither and a sibling row
          // from the same bucket is the only honest source for them.
          for (const a of added) {
            const sib = lines[0] ?? {};
            const hit = soByPatient.get(String(a.patient).trim().toLowerCase());
            const so = hit && hit.length === 1 ? hit[0] : null;
            e.lines.push({
              ref: so ? safeRef('SO', so.id, so.number) : '',
              patient: a.patient,
              date: so?.dateCreated ?? null,
              prog: sib.prog ?? '',
              item: a.item,
              cycle: sib.cycle ?? `Paid ~${a.cycle}`,
              month,
              comm: a.comm,
              state: 'payable',
              // Absent from the reconciliation sheet, so there is no Striven
              // match evidence for it — the same remark the sheet's own
              // unmatched rows carry, and for the same reason.
              unmatched: true,
              tier: 'unmatched',
            });
          }
          repDelta = round2(repDelta + delta);
          repLines += corrected.length;
          repAdded += added.length;
          corrections.orphanedLines += orphaned.length;
        }
        if (repLines || repAdded) {
          corrections.lines += repLines;
          corrections.added += repAdded;
          corrections.amount = round2(corrections.amount + repDelta);
          // NAMES ONLY, never a patient. This is an operator-facing count of
          // where the sheet and the books disagree, not a second copy of the
          // detail — the corrected lines themselves already carry that.
          corrections.reps.push({ rep, lines: repLines, added: repAdded, amount: repDelta });
        }
      }
    }

    // ── TOTALS, COMPUTED FROM THE LINES ──────────────────────────────────────
    // Not accumulated as the rows were read, which is what they used to be. A
    // total added up during the read is a total that cannot survive a later
    // correction: it would still hold the sheet's $425 for a line now paying
    // $80, and nothing would flag the two disagreeing. Deriving every figure
    // from the same array the page prints makes that impossible by construction.
    for (const e of byRep.values()) {
      e.payableTotal = 0; e.reviewTotal = 0; e.unmatchedTotal = 0;
      e.autoRows = 0; e.reviewRows = 0; e.unmatchedRows = 0;
      for (const l of e.lines) {
        e.payableTotal = round2(e.payableTotal + l.comm);
        if (l.tier === 'auto') { e.autoRows += 1; totals.auto = round2(totals.auto + l.comm); }
        else if (l.tier === 'review') { e.reviewTotal = round2(e.reviewTotal + l.comm); e.reviewRows += 1; totals.review = round2(totals.review + l.comm); }
        else if (l.tier === 'unmatched') { e.unmatchedTotal = round2(e.unmatchedTotal + l.comm); e.unmatchedRows += 1; totals.unmatched = round2(totals.unmatched + l.comm); }
      }
      // Both are reading aids, not payload. Dropped once the totals and the
      // pairing they drive are done, so the line the browser receives is the
      // shape it has always been.
      for (const l of e.lines) { delete l.tier; delete l.sheetPatient; }
    }

    const reps = [...byRep.values()].sort((a, b) => b.payableTotal - a.payableTotal);
    return {
      ok: true,
      configured: true,
      byRep: reps,
      // Where the sheet and the workbooks it was transcribed from disagree, and
      // by how much. Zero everywhere is the expected reading; a non-zero
      // `amount` is a transcription error the portal has corrected, not a rule
      // it has applied.
      corrections,
      totals: {
        ...totals,
        // Appended lines are rows the sheet should have carried and did not.
        rows: totals.rows + corrections.added,
        // NOTHING IS HELD BACK ANY MORE — every valued row is paid and the
        // unmatched ones are marked instead. Kept at 0 rather than deleted so a
        // consumer still reading it gets "none withheld" instead of undefined.
        heldBack: 0,
        // The whole sheet, which is now also the payable total. Summed from the
        // rep rows rather than from the three tiers: a row whose Match Status
        // the sheet spells in a way tierOf() does not recognise is in none of
        // them, and adding the tiers up would quietly leave its money out of a
        // figure named for the total.
        payable: round2(reps.reduce((t, r) => t + r.payableTotal, 0)),
      },
      fetchedAt: new Date().toISOString(),
    };
  }, 300_000);
}

// ── COMMISSION WORKBOOKS: a tab per payout cycle ─────────────────────────────
// A second shape of commission source, for reps the reconciliation sheet does
// not carry. Maylon Sanders is the live case and the reason this exists: 39 PI
// orders in Striven, not one row in the reconciliation sheet, so his login read
// $0 for every month while his own workbook says $2,489.86.
//
// THE TAB NAME IS THE PERIOD. Each tab is named for its pay date ("8/15/2026",
// which Excel stores as 8152026 because a sheet name cannot contain a slash)
// and the run pays the previous month — the same rule the reconciliation
// sheet's cycle strings follow, via monthOfPayoutCycle(). Nothing inside a tab
// repeats the date, which is why this reads the workbook as .xlsx rather than
// per-tab CSV: the CSV export identifies a tab only by an opaque gid, so every
// new month would need a config edit. Reading names means next month's tab
// appears on the dashboard on its own.
//
// TWO LAYOUTS, because the workbooks differ:
//   PATIENT | REP | DEVICE | COMMISSION   — a shared book, rep per row
//   PATIENT | DEVICE | COMMISSION         — one rep's book, named in config
// Detected from the header row, so a workbook can change shape without code.
//
// Configure with COMMISSION_WORKBOOKS: a JSON array of
//   { "id": "<google sheet id>", "rep": "<name>", "vertical": "PI" }
// `rep` is required only for the three-column layout; `vertical` defaults to PI.
const workbookConfig = async () => {
  const raw = String(await cfgValue('COMMISSION_WORKBOOKS', '')).trim();
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return (Array.isArray(v) ? v : [v]).filter((w) => w && w.id);
  } catch { return []; }
};

const isPatientHeader = (r) => /^patient$/i.test(String(r[0] ?? '').trim());

/**
 * Every VALUED row of one commission workbook, flattened across its tabs.
 *
 * The tab-name and column rules live here in one place because two readers now
 * need them — getCommissionWorkbooks() below, which pays reps the
 * reconciliation sheet does not carry, and commissionSourceIndex(), which
 * checks the sheet against the book it was transcribed from. Two copies would
 * drift the first time a workbook changed shape.
 *
 * PATIENTS ARE REDUCED TO AN INITIAL + SURNAME HERE, at the parse, so the full
 * legal names these workbooks carry never reach a caller, a cache or a payload.
 *
 * @param {Buffer} buffer an .xlsx export of the workbook
 * @param {string} defaultRep owner for the three-column layout, which names no rep
 * @returns {Array<{rep:string, cycle:string, month:string, patient:string, item:string, comm:number}>}
 */
function commissionBookRows(buffer, defaultRep = '') {
  let sheets = [];
  try { sheets = readXlsxBuffer(buffer); } catch { return []; }
  const out = [];
  for (const sheet of sheets) {
    // "8152026" → the pay date, then the month it settles.
    const d = String(sheet.name).replace(/\D/g, '');
    const md = /^(\d{1,2})(\d{2})(\d{4})$/.exec(d);
    if (!md) continue;                           // not a payout-cycle tab
    const cycle = `${Number(md[1])}/${Number(md[2])}/${md[3]}`;
    // The same "pays the previous month" rule as monthOfPayoutCycle(), but
    // computed from the digits: that function reads month NAMES, which is what
    // the reconciliation sheet's cycle strings use, and a tab name is numeric.
    // Passing "8/15/2026" to it matches no month name and silently returns
    // null — which is exactly how this shipped empty the first time.
    const payDate = new Date(Number(md[3]), Number(md[1]) - 1, 1);
    payDate.setMonth(payDate.getMonth() - 1);
    const month = `${payDate.getFullYear()}-${String(payDate.getMonth() + 1).padStart(2, '0')}`;

    // TWO LAYOUTS, resolved from the header row so a workbook can change shape
    // without a code change:
    //   PATIENT | REP | DEVICE | COMMISSION   — a shared book, rep per row
    //   PATIENT | DEVICE | COMMISSION         — one rep's book, named in config
    let cols = null;
    for (const r of sheet.rows) {
      if (isPatientHeader(r)) {
        cols = /^rep$/i.test(String(r[1] ?? '').trim())
          ? { rep: 1, item: 2, amt: 3 }
          : { rep: -1, item: 1, amt: 2 };
        continue;
      }
      if (!cols) continue;                       // rows above the header are titles
      const patient = String(r[0] ?? '').trim();
      const comm = sheetMoney(r[cols.amt]);
      if (!patient || !(comm > 0)) continue;
      const repRaw = cols.rep >= 0 ? String(r[cols.rep] ?? '').trim() : String(defaultRep ?? '').trim();
      if (!repRaw) continue;                     // a row with no owner pays nobody
      out.push({
        rep: reconRep(repRaw),
        cycle,
        month,
        patient: commInitialLastDisp(patient),
        item: String(r[cols.item] ?? '').trim(),
        comm: round2(comm),
      });
    }
  }
  return out;
}

// ── THE WORKBOOKS THE RECONCILIATION SHEET WAS TRANSCRIBED FROM ──────────────
// Not the same list as COMMISSION_WORKBOOKS above, and the difference matters.
// That list is a SUBSTITUTE source, for reps the reconciliation sheet has no
// rows for at all; this one is the ORIGINAL of rows the sheet does carry, and
// it is read only to check them. A book in the wrong list either pays a rep
// twice or corrects nothing, so they stay separate.
//
// Configure with COMMISSION_SOURCE_WORKBOOKS — a JSON array of
//   { "id": "<google sheet id>", "label": "Team", "rep": "<name>" }
// `rep` is needed only by the three-column layout. Falling back to
// COMMISSION_SHEETS is deliberate: that key already names exactly these two
// books on every host, left over from the feed that used to read them, so the
// check works out of the box rather than waiting on a config edit nobody knows
// is outstanding.
const sourceBookConfig = async () => {
  const raw = String((await cfgValue('COMMISSION_SOURCE_WORKBOOKS', ''))
    || (await cfgValue('COMMISSION_SHEETS', ''))).trim();
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return (Array.isArray(v) ? v : [v]).filter((w) => w && w.id);
  } catch { return []; }
};

/**
 * The source workbooks indexed by "rep|month", for reconcileToWorkbook().
 *
 * @returns {Promise<{configured:boolean, books:number, byRepMonth:Map<string,Array>}>}
 */
async function commissionSourceIndex() {
  const books = await sourceBookConfig();
  if (!books.length) return { configured: false, books: 0, byRepMonth: new Map() };
  return cached('derived:commission-source-index', async () => {
    // Downloaded together: these are ~2s Google exports apiece and nothing in
    // one is needed to read the other.
    const buffers = await Promise.all(books.map((w) => fetch(`https://docs.google.com/spreadsheets/d/${w.id}/export?format=xlsx`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)));
    const byRepMonth = new Map();
    let read = 0;
    for (let i = 0; i < books.length; i += 1) {
      if (!buffers[i]) continue;
      read += 1;
      for (const row of commissionBookRows(Buffer.from(buffers[i]), books[i].rep)) {
        if (isExcludedRep(row.rep)) continue;
        const k = `${row.rep}|${row.month}`;
        byRepMonth.set(k, [...(byRepMonth.get(k) ?? []), row]);
      }
    }
    return { configured: true, books: read, byRepMonth };
  }, 300_000);
}

/**
 * Commission lines from every configured workbook, shaped exactly like the
 * reconciliation sheet's so both merge through one code path.
 *
 * @returns {Promise<{ok:boolean, configured:boolean, byRep:Array, note?:string}>}
 */
export async function getCommissionWorkbooks() {
  const books = await workbookConfig();
  if (!books.length) return { ok: true, configured: false, byRep: [] };
  return cached('derived:commission-workbooks', async () => {
    const soBlob = await sbCacheRead('so').catch(() => null);
    const soRows = Array.isArray(soBlob?.data) ? soBlob.data : [];
    const soById = new Map(soRows.map((o) => [String(o.id), o]));
    // patient (initial + surname) → order(s). These workbooks carry no order
    // number at all, so the patient is the only join available; a name shared
    // by two orders stays unresolved rather than guessing which one paid.
    const soByPatient = new Map();
    for (const [soId, tag] of await soLabelsBySoId().catch(() => new Map())) {
      const key = String(tag?.patient ?? '').trim().toLowerCase();
      const row = soById.get(String(soId));
      if (!key || !row) continue;
      soByPatient.set(key, [...(soByPatient.get(key) ?? []), row]);
    }

    const byRep = new Map();
    // EVERY WORKBOOK DOWNLOADED AT ONCE. These are ~2.2s Google Sheets exports
    // apiece and were fetched in sequence, so two books cost 4.4s on the single
    // slowest endpoint the dashboard has. They are independent files; nothing in
    // one is needed to read the other. Downloading in parallel and PARSING in
    // the original order keeps the merge below deterministic — later books must
    // still win over earlier ones, and a race would make that order arbitrary.
    const buffers = await Promise.all(books.map((w) => fetch(`https://docs.google.com/spreadsheets/d/${w.id}/export?format=xlsx`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)));
    for (let bi = 0; bi < books.length; bi += 1) {
      const w = books[bi];
      if (!buffers[bi]) continue;
      // Tab names, column layout and the patient mask all live in
      // commissionBookRows() — see it for the rules this reader used to spell
      // out inline.
      for (const row of commissionBookRows(Buffer.from(buffers[bi]), w.rep)) {
        if (isExcludedRep(row.rep)) continue;
        // These workbooks carry no order number at all, so the patient is the
        // only join available; a name shared by two orders stays unresolved
        // rather than guessing which one paid.
        const hit = soByPatient.get(row.patient.trim().toLowerCase());
        const so = hit && hit.length === 1 ? hit[0] : null;

        const e = byRep.get(row.rep) ?? { rep: row.rep, payableTotal: 0, lines: [] };
        e.lines.push({
          ref: so ? safeRef('SO', so.id, so.number) : '',
          patient: row.patient,
          date: so?.dateCreated ?? null,
          prog: String(w.vertical || 'PI'),
          item: row.item,
          cycle: `Paid ~${row.cycle}`,
          month: row.month,
          comm: row.comm,
          state: 'payable',
          // The workbook is not the reconciliation sheet, so it carries no
          // match status of its own. A line that found no order is marked the
          // same way the sheet's unmatched rows are — it is still paid, the
          // remark just says the Striven tie is missing.
          unmatched: !so,
          fromWorkbook: true,
        });
        e.payableTotal = round2(e.payableTotal + row.comm);
        byRep.set(row.rep, e);
      }
    }
    return {
      ok: true,
      configured: true,
      byRep: [...byRep.values()].sort((a, b) => b.payableTotal - a.payableTotal),
      fetchedAt: new Date().toISOString(),
    };
  }, 300_000);
}

// ── AP LEDGER (Google Sheet) ─────────────────────────────────────────────────
// The AP Register's source of truth: the "AP Ledgers" tab of the AP workbook.
// It is NOT a Striven feed — these are vendor bills tracked by hand in a sheet,
// so the tab sits beside Payables rather than agreeing with it.
//
// The workbook id lives in the environment, never in committed source, matching
// how STRIVEN_LABELS_URL is handled.
// Supabase app_config first, env second — see cfgValue().
const AP_LEDGER_ID = () => cfgValue('AP_LEDGER_SHEET_ID');
const AP_LEDGER_GID = () => cfgValue('AP_LEDGER_GID', '575084060');

/** RFC4180-ish CSV parse: quoted fields may contain commas and newlines. */
function parseCsvRows(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') { if (q && text[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; }
    else if (c === ',' && !q) { row.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !q) {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const sheetMoney = (s) => { const n = Number(String(s ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
// "4/13/2026" → "2026-04-13" so dates sort and format like every other feed.
const sheetDate = (s) => {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

/**
 * Vendor bills from the AP Ledgers sheet, grouped by SUB-LEDGER.
 *
 * COLUMNS 1..12 ONLY. Columns 14+ hold a pivot table of these same rows; reading
 * it would double-count, so it is ignored outright.
 *
 * The sheet restarts its header for each vendor block, so header rows appear
 * mid-data and are dropped by matching their literal labels. That is fragile by
 * nature — rename a header in the sheet and phantom rows appear — so the count
 * of dropped rows is reported rather than swallowed.
 *
 * NO PHI: this tab carries no Ship To / patient column. (AP Report Base does;
 * it is deliberately not read here.)
 */
export async function getApLedger() {
  const id = await AP_LEDGER_ID();
  const gid = await AP_LEDGER_GID();
  if (!id) return { ok: false, configured: false, bills: [], subLedgers: [], note: 'AP_LEDGER_SHEET_ID is set neither in Supabase app_config nor in the environment.' };
  return cached('derived:ap-ledger', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const csv = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!csv) return { ok: false, configured: true, bills: [], subLedgers: [], note: 'AP Ledgers sheet is unreachable.' };
    const rows = parseCsvRows(csv);

    // ROW 0'S "Total Outstanding" CELL IS NOT READ. Dropped on request.
    //
    // It is a hand-typed figure that nothing recomputes, and it sits ABOVE what
    // the sheet's own vendor blocks add to. Reporting a gap against it put a
    // permanent discrepancy notice on a register whose every block reconciles —
    // a warning about a stale cell, dressed as a warning about the data.
    //
    // THE DRIFT GROWS, which is why no figure for it is quoted here any more.
    // This note used to name one ($5,845.86); the cell has not been touched
    // since while the blocks below it have, so that number was wrong within
    // weeks and read as current. As of 14 Aug 2026 the cell says $36,587.80
    // against a true payable of $29,557.23 — and the $7,030.57 between them is
    // exactly ManaMed's recorded payments, i.e. one update that never happened
    // rather than an accumulation of small errors. Recompute it before citing
    // it; do not trust this paragraph's arithmetic either.
    //
    // The register's authority for what is outstanding is the Outstanding
    // COLUMN, validated block by block against the per-vendor subtotal rows
    // below (blockTotals). Those are computed by the sheet and all six agree.

    let droppedHeaders = 0;
    // THE SHEET CHECKS ITSELF, AND WE WERE THROWING THAT AWAY.
    //
    // Each vendor block ends with its own "Total Outstanding" row. They were
    // discarded silently along with every other unnumbered row, so the register
    // had no way to tell "the sheet and I agree" from "the sheet and I differ" —
    // and the banner it did show, that row 0's header cell disagrees with the
    // column by $5,845.86, read as though the DATA were in doubt.
    //
    // It is not. All six blocks tie to their own subtotals exactly. Only the
    // hand-maintained header cell is stale, and saying so precisely is worth far
    // more than a vague warning.
    //
    // The label's COLUMN is not fixed — four blocks put it in the Invoice Date
    // column, ManaMed's lands in Sub-Ledger — so it is matched across the first
    // few columns rather than at one index. Attributed to the vendor whose rows
    // precede it, which is what "the block's total" means in a sheet laid out
    // one supplier at a time.
    // PAYMENTS LIVE IN THE DEBIT COLUMN, on their own rows.
    //
    // A vendor block runs: repeated header, then the BILLS (credit side, invoice
    // numbered), then the PAYMENTS made against them (debit side, dated, no
    // invoice number), then a bare column-totals row, then "Total Outstanding".
    // Only the bills were ever read, so the register knew what was owed but had
    // no record of what had actually been paid.
    //
    // The three unnumbered row types have to be told apart or the sums double:
    //   dated, debit only          → a PAYMENT
    //   undated, debit AND credit  → the block's column totals (a restatement of
    //                                rows already counted — EvoHealth's made its
    //                                payments read as $45,250 against $22,625 of
    //                                bills, exactly twice, until this was split out)
    //   "Total Outstanding" label  → the block's closing balance
    // ManaMed merges the last two onto one row, so the label is tested first.
    const blockTotals = new Map();
    const blockPaid = new Map();
    const payments = [];
    let blockVendor = null;
    for (const r of rows.slice(3) ?? []) {
      const sub = String(r[2] ?? '').trim();
      const no = String(r[5] ?? '').trim();
      const debit = sheetMoney(r[6]);
      const credit = sheetMoney(r[7]);
      const dated = Boolean(String(r[3] ?? '').trim());
      // THE SUBTOTAL TEST RUNS FIRST, before `blockVendor` is updated. ManaMed's
      // "Total Outstanding" label sits in the Sub-Ledger column, so advancing
      // the vendor first files that block's balance under a phantom supplier
      // called "Total Outstanding" and drops ManaMed's $13,635.76 check.
      if ([1, 2, 3, 4, 5].some((c) => /^total outstanding$/i.test(String(r[c] ?? '').trim()))) {
        if (blockVendor) blockTotals.set(blockVendor, round2(sheetMoney(r[12])));
        continue;
      }
      if (sub && !/^sub-ledger$/i.test(sub)) blockVendor = sub;
      if (no || !blockVendor) continue;                    // a bill, or nothing to attribute to
      if (debit && credit && !dated) continue;             // the block's column-totals row
      if (debit && !credit) {
        const g = blockPaid.get(blockVendor) ?? { amount: 0, rows: 0 };
        g.amount = round2(g.amount + debit); g.rows += 1;
        blockPaid.set(blockVendor, g);
        // KEPT ROW BY ROW, not only summed. The payables page lists what has
        // actually been settled, and it was listing Striven's bill-payment
        // records — ONE payment, $840 — while this sheet holds the real fifty-
        // odd debits. (It was 50 rows / $74,265.17 when this was written and 51
        // / $76,026.06 a few weeks later; the count is quoted loosely on purpose,
        // because a payments ledger grows and a comment naming its size is a
        // comment that starts lying almost immediately.) A total with no rows
        // behind it cannot be checked by the person reconciling it.
        //
        // A payment row carries a DATE and an AMOUNT and nothing else: the
        // sheet gives it no invoice number (that is what marks it as a payment
        // rather than a bill) and no bank account. The card shows the three
        // facts that exist rather than printing empty columns.
        payments.push({ subLedger: blockVendor, date: sheetDate(r[3]), amount: round2(debit) });
      }
    }

    const bills = (rows.slice(3) ?? []).reduce((out, r) => {
      const no = String(r[5] ?? '').trim();
      const sub = String(r[2] ?? '').trim();
      if (!no) return out;
      if (/^invoice no\.?$/i.test(no) || /^sub-ledger$/i.test(sub) || !sub) { droppedHeaders += 1; return out; }
      const credit = sheetMoney(r[7]);
      const debit = sheetMoney(r[6]);
      // DEBIT AND CREDIT ARE OPPOSITE SIDES, NOT TWO PLACES TO FIND ONE NUMBER.
      //
      // This is a CREDITORS ledger, so a supplier bill is a CREDIT — it raises
      // what is owed — and a DEBIT takes value back off the account. The old
      // `credit || debit` read whichever cell was populated and called it "the
      // bill's face value", which booked every credit note as an extra bill.
      //
      // Today that is the two CM rows on TREND Delco: $51.20 of credit notes
      // added to the register instead of subtracted, a $102.40 swing. Netting
      // the sides is also the general rule, so a credit note raised against any
      // other supplier tomorrow is handled without touching this code.
      //
      // Deliberately NOT keyed on the "CM" prefix: the numbering scheme differs
      // per supplier (INV…, DM-…, SMR-…, bare digits), and the ledger side is
      // the fact that actually says which direction the money goes. `CM` is
      // asserted below as a cross-check, not used as the test.
      const isCreditNote = debit > 0 && credit === 0;
      const status = String(r[8] ?? '').trim();
      // A CANCELLED BILL WAS NEVER OWED. It is void, so it does not belong in
      // the payable at all — today that is INV228023, $63.80 against TREND
      // Delco, which was inflating that supplier's block and the register with
      // it. The row is NOT dropped: a cancelled bill you cannot see is one
      // nobody can confirm was cancelled. It stays visible at face value and
      // counts as zero.
      const isCancelled = /^cancel/i.test(status);
      const face = round2(credit - debit);
      out.push({
        no,
        subLedger: sub,
        date: sheetDate(r[3]),
        due: sheetDate(r[4]),
        // TWO AMOUNTS, deliberately.
        //
        // `total` is what COUNTS toward the payable: signed, so a credit note
        // nets, and zero on a cancelled bill. Every sum downstream reads this
        // one and is correct without knowing which rows are special — which is
        // the point, since there are a dozen such sums and any of them could be
        // written next by someone who has never read this comment.
        total: isCancelled ? 0 : face,
        // `faceValue` is what the DOCUMENT says, kept so the register can still
        // print $63.80 against a cancelled row rather than a bare $0.
        faceValue: face,
        // Lets the UI label the row rather than falling through to "Unpaid"
        // on a blank status, which is what a credit note carries.
        kind: isCancelled ? 'cancelled' : isCreditNote ? 'credit-note' : 'bill',
        status,
        terms: String(r[9] ?? '').trim(),
        dueDays: Number(String(r[10] ?? '').trim()) || 0,
        aging: String(r[11] ?? '').trim(),
        // A CREDIT NOTE CARRIES A NEGATIVE BALANCE, so it reduces what is owed.
        //
        // The sheet leaves Outstanding blank on these rows — its column counts
        // bills only — so the credit sat at zero and the register reported
        // $51.20 more owing than it actually is. An unapplied credit is money
        // off the payable, so it is imputed at the note's own face value
        // (`total`, already negative) unless the sheet states one explicitly.
        //
        // This is what makes billed − paid = outstanding come out at exactly
        // zero across the register, rather than leaving a residual that has to
        // be explained on every screen that shows the three figures.
        //
        // Cancelled stays at zero: a void bill owes nothing and refunds nothing.
        open: isCancelled ? 0
          : isCreditNote ? (sheetMoney(r[12]) ? -round2(sheetMoney(r[12])) : face)
            : round2(sheetMoney(r[12])) || 0,
      });
      return out;
    }, []);

    // GROUPED BY SUB-LEDGER, as the register is read: one block per vendor.
    const bySub = new Map();
    for (const b of bills) {
      const g = bySub.get(b.subLedger) ?? { subLedger: b.subLedger, bills: 0, billed: 0, open: 0, openBills: 0, oldestDays: 0, terms: '', creditNotes: 0, creditNoteAmount: 0 };
      g.bills += 1;
      g.billed = round2(g.billed + b.total);
      g.open = round2(g.open + b.open);
      // Per block, because a block's credit notes are the whole explanation for
      // why `billed - paid` misses its outstanding: `billed` is net of them and
      // the sheet's Outstanding column is not, so the shortfall is exactly the
      // credit-note amount. Carried so the UI can say that rather than call an
      // explained difference "unreconciled".
      if (b.kind === 'credit-note') { g.creditNotes += 1; g.creditNoteAmount = round2(g.creditNoteAmount + Math.abs(b.total)); }
      if (b.open > 0) { g.openBills += 1; g.oldestDays = Math.max(g.oldestDays, b.dueDays); }
      if (!g.terms && b.terms) g.terms = b.terms;
      bySub.set(b.subLedger, g);
    }

    // Each block against the sheet's own subtotal for it. `sheetOpen` null means
    // that block has no subtotal row to check against — worth distinguishing
    // from one that has a subtotal and matches.
    for (const g of bySub.values()) {
      const stated = blockTotals.has(g.subLedger) ? blockTotals.get(g.subLedger) : null;
      g.sheetOpen = stated;
      // COMPARE LIKE WITH LIKE. The sheet's block subtotal counts BILLS only —
      // its Outstanding column has no row for a credit note — so it must be
      // checked against the pre-credit balance. Comparing it to `g.open`, which
      // is now net of credit notes, would report TREND Delco as $51.20 adrift
      // and put a warning on the one register that fully reconciles.
      g.openGap = stated == null ? null : round2(stated - round2(g.open + g.creditNoteAmount));
      // What the sheet records as actually PAID to this vendor, from the debit
      // rows. Reported alongside `billed - open` rather than replacing it: the
      // two do not agree on four of six vendors, and picking one silently would
      // bury that.
      const p = blockPaid.get(g.subLedger) ?? { amount: 0, rows: 0 };
      g.paidRecorded = p.amount;
      g.paymentRows = p.rows;
      g.paidGap = round2(p.amount - round2(g.billed - g.open));
    }
    const checked = [...bySub.values()].filter((g) => g.sheetOpen != null);
    const mismatched = checked.filter((g) => Math.abs(g.openGap) >= 0.01);

    const open = round2(bills.reduce((s, b) => s + b.open, 0));
    return {
      ok: true,
      configured: true,
      bills,
      // Newest first, which is the order the payables page reads them in.
      payments: payments.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
      subLedgers: [...bySub.values()].sort((a, b) => b.open - a.open || b.billed - a.billed),
      totals: {
        bills: bills.length,
        // NET of credit notes, since their `total` is already negative.
        billed: round2(bills.reduce((s, b) => s + b.total, 0)),
        open,
        openBills: bills.filter((b) => b.open > 0).length,
        // The sheet's own header figure, and the gap against the column sum.
        // Reported, not reconciled: the difference is a manual cell, not a rule
        // this code could apply.
        // The sheet's own per-vendor subtotals: how many blocks carry one, how
        // many agree with the rows beneath them, and what they add to. This is
        // the register's ONLY cross-check now, and the right one: it is computed
        // by the sheet per vendor rather than typed once at the top.
        // Payments recorded in the Debit column, and how far they sit from what
        // the bills imply was settled (billed − outstanding).
        paidRecorded: round2([...bySub.values()].reduce((s, g) => s + g.paidRecorded, 0)),
        paymentRows: [...bySub.values()].reduce((s, g) => s + g.paymentRows, 0),
        paidImplied: round2(bills.reduce((s, b) => s + b.total, 0) - open),
        blocksChecked: checked.length,
        blocksMatched: checked.length - mismatched.length,
        blockOpenTotal: round2(checked.reduce((s, g) => s + g.sheetOpen, 0)),
        blockMismatches: mismatched.map((g) => ({ subLedger: g.subLedger, rows: g.open, sheet: g.sheetOpen, gap: g.openGap })),
        // Named separately so the register can say what it netted off rather
        // than just showing a total that is quietly smaller than the sheet's.
        creditNotes: bills.filter((b) => b.kind === 'credit-note').length,
        creditNoteAmount: round2(bills.filter((b) => b.kind === 'credit-note').reduce((s, b) => s + Math.abs(b.total), 0)),
        cancelled: bills.filter((b) => b.kind === 'cancelled').length,
        cancelledAmount: round2(bills.filter((b) => b.kind === 'cancelled').reduce((s, b) => s + b.faceValue, 0)),
      },
      droppedHeaderRows: droppedHeaders,
      fetchedAt: new Date().toISOString(),
    };
  }, 300_000);
}

// ── AR REGISTER (Google Sheet + Striven) ─────────────────────────────────────
// The invoice book behind the AR tab: the "Sales_Activity_Report" sheet supplies
// the DETAIL for each invoice (date, patient, PO memo, GL account) and Striven
// supplies the BOOK — which invoices exist, and what is still open.
//
// That split is deliberate and load-bearing, and THE SHEET RUNS BEHIND — which
// is the whole reason the book comes from Striven. Driving the register off the
// sheet would understate AR by whatever has not been pasted in yet, and the next
// row someone forgets would go the same way with nothing on screen to show for
// it. Driving it off Striven means an un-pasted invoice appears as a row with no
// detail: counted in every figure, visibly missing its narrative.
//
// THE GAP IS ALWAYS ONE-DIRECTIONAL AND ALWAYS THE NEWEST ROWS. It was one
// invoice (#116) when this was written; at 14 Aug 2026 it is six — #167..#172,
// every one of them dated 10 Aug — against a sheet that has since gained #116.
// So no figure is quoted here: it is a lag, it moves every time someone updates
// the sheet, and `totals.missingFromSheet` / `missingAmount` report it live.
//
// What does NOT move is the quality of the overlap: every invoice present in
// both agrees to the cent, and no sheet row has ever named an invoice Striven
// does not have (`totals.orphanSheetRows`). The sheet is late, never wrong.
//
// PHI: every sheet row names a patient in full. commInitialLastDisp() reduces
// the first name to a letter HERE, at the boundary — the full name is never
// cached or serialized, the same rule the commission feed follows.
// Supabase app_config first, env second — see cfgValue().
const AR_REGISTER_ID = () => cfgValue('AR_REGISTER_SHEET_ID');
const AR_REGISTER_GID = () => cfgValue('AR_REGISTER_GID', '687173788');

/** Rows on this report that are NOT receivables. */
const AR_SHEET_AP_TYPES = /^(bills?|received items)/i;

export async function getArRegister() {
  const id = await AR_REGISTER_ID();
  const gid = await AR_REGISTER_GID();
  if (!id) return { ok: false, configured: false, invoices: [], note: 'AR_REGISTER_SHEET_ID is set neither in Supabase app_config nor in the environment.' };
  return cached('derived:ar-register', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const csv = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!csv) return { ok: false, configured: true, invoices: [], note: 'Sales activity sheet is unreachable.' };
    const rows = parseCsvRows(csv);
    const cell = (r, i) => String(r[i] ?? '').trim();

    // ── the sheet: detail, keyed by invoice number ──────────────────────────
    // Three HiDow rows on this "sales activity" report offset ACCOUNTS PAYABLE,
    // not receivable: two "Received Items (Bill Pending)" and one "Bill",
    // -$1,400 between them. Summing the Amount column blindly understates AR by
    // exactly that, so they are counted out loud rather than quietly skipped.
    let apRows = 0; let apAmount = 0;
    const detail = new Map();
    for (const r of rows.slice(1)) {
      const type = cell(r, 0);
      if (!type) continue;
      if (AR_SHEET_AP_TYPES.test(type)) { apRows += 1; apAmount = round2(apAmount + sheetMoney(r[6])); continue; }
      const no = cell(r, 1);
      if (!no) continue;
      detail.set(no, {
        date: (() => { const m = cell(r, 2).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; })(),
        patient: commInitialLastDisp(cell(r, 3)),   // ← full name dies here
        memo: cell(r, 4),
        gl: cell(r, 5),
        amount: round2(sheetMoney(r[6])),
      });
    }

    // ── Striven: the book, and what is still open ───────────────────────────
    const all = (await allInvoices()).filter((r) => !isVoidStatus(INVOICE_STATUS[r.id] ?? ''));
    const payerByInv = await invoicePayerMap().catch(() => ({}));
    const vertMap = await invoiceVerticalMap().catch(() => ({ byInvoice: {}, byCustRef: new Map() }));
    // Same netting the AR tab applies — see netOpenByInvoice(). Reading raw
    // `openBalance` here would put two different outstanding figures on one page.
    const { net, unappliedCredits } = await netOpenByInvoice(all);
    const invoices = all.map((r) => {
      const no = String(r.txnNumber ?? r.id);
      const d = detail.get(no) ?? null;
      const total = round2(Number(r.invoiceTotal ?? 0));
      const rawOpen = round2(Number(r.openBalance ?? 0));
      const open = net.get(r.id) ?? rawOpen;
      // THREE WAYS AN INVOICE STOPS BEING OUTSTANDING, and they are not the
      // same money:
      //   total - rawOpen   cash paid against THIS invoice
      //   rawOpen - open    an unapplied customer credit covering the rest
      //   open              still owed
      // Splitting them here means the Collected tile can show what was actually
      // banked against invoices versus what was cleared by a credit sitting on
      // the customer's account, and have the two add back to the total.
      const creditApplied = round2(rawOpen - open);
      // Which programme billed this decides what is expected back on it, so the
      // vertical has to be resolved before the expectation is — see below.
      const vertical = vertMap.byInvoice[no]
        || vertMap.byCustRef.get(`PT-${r.customer?.id}`)
        || verticalOfPayer(payerByInv[no])
        || '';
      const expected = arExpectedFor({ vertical, billed: total });
      return {
        no,
        // The sheet's date is the invoice date; Striven's is the created stamp.
        // Prefer the sheet's, which is what the accountant reads.
        date: d?.date || String(r.dateCreated ?? '').slice(0, 10),
        dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : '',
        patient: d?.patient ?? maskName(r.customer?.name),
        payer: payerByInv[no] || '',
        // Which programme billed this — see invoiceVerticalMap().
        vertical,
        // WHAT IS EXPECTED BACK, not what was billed. PI settles out of a lien
        // at a fraction of face value; everything else is expected in full.
        // `arBasis` names the rule so the table can mark a discounted row rather
        // than leaving the reader to wonder why a figure differs from Billed.
        arExpected: expected.amount,
        arBasis: expected.basis,
        memo: d?.memo ?? '',
        gl: d?.gl ?? '',
        total,
        open,
        paid: round2(total - open),
        // Cash banked against this invoice, and credit applied to it. The two
        // plus `open` always add back to `total`.
        cashPaid: round2(total - rawOpen),
        creditApplied,
        // A zero-value invoice is neither paid nor outstanding; calling it
        // "paid" would inflate the collected count by four rows that never
        // billed anything. `credited` is an invoice whose balance is covered by
        // an unapplied customer credit rather than by a payment against it —
        // settled, but worth distinguishing from a straightforward payment.
        status: total === 0 ? 'zero-value'
          : open > 0.005 ? 'open'
            : Number(r.openBalance ?? 0) > 0.005 ? 'credited' : 'paid',
        // Whether the accountant's sheet carries this invoice at all. A `false`
        // here is the visible form of "someone has not pasted it in yet".
        inSheet: Boolean(d),
        // Named only when the two sources disagree, so the register can show
        // the gap instead of picking a winner silently.
        sheetAmount: d ? d.amount : null,
        variance: d ? round2(d.amount - total) : null,
      };
    }).sort((a, b) => Number(b.no) - Number(a.no) || b.no.localeCompare(a.no));

    const sum = (rows_, k) => round2(rows_.reduce((s, x) => s + x[k], 0));
    const openRows = invoices.filter((i) => i.status === 'open');
    const billed = sum(invoices, 'total');
    const outstanding = sum(openRows, 'open');
    const missing = invoices.filter((i) => !i.inSheet);
    // The reverse lookup: sheet rows no Striven invoice claimed. Built from the
    // invoice numbers actually consumed above, so it cannot drift from them.
    const claimed = new Set(invoices.map((i) => String(i.no)));
    const orphanSheet = [...detail.entries()]
      .filter(([no]) => !claimed.has(String(no)))
      .map(([no, d]) => ({ no: String(no), amount: d.amount, date: d.date }));
    const variances = invoices.filter((i) => i.variance != null && Math.abs(i.variance) >= 0.005);
    const aging = bucketAging(openRows, 'dueDate', 'open');
    for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);

    // Billed per calendar month, off the same rows the table renders.
    const byMonth = new Map();
    for (const i of invoices) {
      const m = (i.date || '').slice(0, 7);
      if (!m) continue;
      const g = byMonth.get(m) ?? { month: m, invoices: 0, billed: 0 };
      g.invoices += 1; g.billed = round2(g.billed + i.total);
      byMonth.set(m, g);
    }

    // EVERY month between the first and last, including the ones with nothing
    // in them. Feb and Mar 2026 have no invoices, and omitting them put Jan next
    // to Apr as adjacent categories — an axis where the gap between two points
    // is sometimes one month and sometimes three, which misreads as a ramp that
    // never happened. A month with no invoices is a fact worth plotting.
    const keys = [...byMonth.keys()].sort();
    const filled = [];
    if (keys.length) {
      const [y0, m0] = keys[0].split('-').map(Number);
      const [y1, m1] = keys[keys.length - 1].split('-').map(Number);
      for (let y = y0, mo = m0; y < y1 || (y === y1 && mo <= m1); mo === 12 ? (mo = 1, y += 1) : (mo += 1)) {
        const k = `${y}-${String(mo).padStart(2, '0')}`;
        filled.push(byMonth.get(k) ?? { month: k, invoices: 0, billed: 0 });
      }
    }

    return {
      ok: true,
      configured: true,
      invoices,
      byMonth: filled,
      aging,
      totals: {
        invoices: invoices.length,
        billed,
        // The register-wide expectation, summed from the SAME per-row figures
        // the table renders, so the headline can never disagree with the column
        // under it. `arDiscount` is what the PI rule takes off — surfaced
        // because "billed 290k, expected 248k" invites the question, and the
        // answer should not require re-deriving it.
        arExpected: sum(invoices, 'arExpected'),
        arDiscount: round2(billed - sum(invoices, 'arExpected')),
        arDiscounted: invoices.filter((i) => i.arBasis === 'pi-15').length,
        outstanding,
        openInvoices: openRows.length,
        collected: round2(billed - outstanding),
        collectedInvoices: invoices.filter((i) => i.status === 'paid' || i.status === 'credited').length,
        // Settled by an unapplied credit rather than by a payment against the
        // invoice itself. Named so the six rows this covers are explicable.
        credited: invoices.filter((i) => i.status === 'credited').length,
        creditedAmount: round2(invoices.filter((i) => i.status === 'credited').reduce((s, i) => s + Number(i.total - i.open), 0)),
        // COLLECTED, SPLIT BY WHERE THE MONEY CAME FROM. cash + credit is
        // `collected` by construction — both are derived from the same per-row
        // arithmetic, so the drill that shows them cannot disagree with the tile
        // that opens it.
        cashCollected: sum(invoices, 'cashPaid'),
        creditCollected: sum(invoices, 'creditApplied'),
        unappliedCredits,
        collectionRate: billed > 0 ? round2(((billed - outstanding) / billed) * 100) : 0,
        zeroValue: invoices.filter((i) => i.status === 'zero-value').length,
        // Everything the sheet and Striven do not agree on, stated rather than
        // reconciled — the difference is someone's data entry, not a rule this
        // code could apply.
        sheetRows: detail.size,
        sheetAmount: round2([...detail.values()].reduce((s, d) => s + (d.amount || 0), 0)),
        missingFromSheet: missing.length,
        missingAmount: sum(missing, 'total'),
        // THE OTHER DIRECTION, which this reader could not see.
        //
        // The register walks STRIVEN and looks each invoice up in the sheet, so
        // a sheet row with no Striven invoice behind it was invisible by
        // construction — not reported as zero, simply never asked about. That is
        // the more alarming of the two gaps if it ever happens: an invoice
        // number on the accountant's report that the system of record has no
        // invoice for is either a typo or a document raised outside Striven, and
        // neither should pass unremarked.
        //
        // Zero today across all 164 rows. Reported anyway, because "we checked
        // and there are none" and "we never looked" are the same number.
        orphanSheetRows: orphanSheet.length,
        orphanSheetAmount: round2(orphanSheet.reduce((s, o) => s + (o.amount || 0), 0)),
        orphanSheetNos: orphanSheet.map((o) => o.no),
        variances: variances.length,
        varianceAmount: round2(variances.reduce((s, i) => s + i.variance, 0)),
        apRowsExcluded: apRows,
        apAmountExcluded: apAmount,
      },
      fetchedAt: new Date().toISOString(),
    };
  }, 300_000);
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
export const commRep = (r) => {
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
/**
 * Display name as FIRST INITIAL + FULL SURNAME — "J. Honeycutt".
 *
 * A surname alone stops being an identifier the moment two patients share one,
 * which is exactly when a rep needs to tell the orders apart. One letter is the
 * least that resolves it.
 *
 * The FIRST NAME IS REDUCED TO A LETTER HERE, at the boundary, and the full
 * name is never stored, cached or serialized — the same rule commLastDisp()
 * applies. Surname selection is deliberately identical to commLastDisp(), so a
 * compound name ("Debra Gonzales Garcia" → "D. Garcia") reads the same way it
 * always has and the two never disagree about which token is the surname.
 */
const commInitialLastDisp = (name) => {
  const s = String(name || '').trim();
  if (!s) return '';
  const clean = (v) => v.replace(/[^A-Za-z\-']/g, '').trim();
  let last = '';
  let first = '';
  if (s.includes(',')) {
    // "Last, First"
    const [l, ...rest] = s.split(',');
    last = clean(l);
    first = clean((rest.join(',').trim().split(/\s+/)[0]) || '');
  } else {
    const t = s.split(/\s+/).filter(Boolean);
    last = clean(t[t.length - 1] || '');
    first = t.length > 1 ? clean(t[0]) : '';
  }
  if (!last) return '';
  return first ? `${first[0].toUpperCase()}. ${last}` : last;
};
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
// THE roster rule, in one place. Two endpoints need "who is a producing rep":
// getRepOverview (which rows to send) and getCommission (which names the admin
// "View as" preview may offer). They had drifted — the Reps section listed four
// names while the Commission tab's picker still offered all eleven, including
// House Account and a chiropractic practice.
const isStandingsExcluded = (rep) => (STANDINGS_EXCLUDE || [])
  .some((s) => String(s).trim().toLowerCase() === String(rep).trim().toLowerCase());
/** Producing reps, in roster order. The names any picker should offer. */
const producerNames = () => REP_NAMES.filter((n) => !isStandingsExcluded(n));

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
      // The Striven LABELS, which is where HOLD and "Waiting for
      // Reimbursement" live. They were already on this row and simply were not
      // being read — see the note in classifyOrderLabel().
      labels: Array.isArray(o.labels) ? o.labels : [],
    });
  }

  // Per-ORDER device rows: a per-device rate needs the device, so this is the
  // commission source rather than any month/program rollup.
  let rcOrders = [];
  try { rcOrders = (await sbCacheRead('report_patient_items'))?.data?.orders || []; } catch { /* optional */ }

  // soId -> patient name for the commission drill.
  //
  // FIRST INITIAL + SURNAME, matching every other patient field in the portal.
  // This map used to run commLastName(), which UPPERCASES and strips for a join
  // key — so the drill read "JOHNSON · DELGADO · MARTINEZ" while the pipeline
  // and the reports beside it read "R. Johnson". Same person, two spellings, on
  // screens a rep reads together.
  //
  // The labels report is the only source carrying a first name and is preferred;
  // report_patient_items is surname-only and backs it up, in its own case rather
  // than shouted. Both reduce at this boundary — no full first name is stored.
  const commTags = await soLabelsBySoId().catch(() => new Map());
  const lastNameBySo = new Map();
  for (const o of rcOrders) {
    const ln = commLastDisp(o.lastName);
    if (ln && o.soId != null) lastNameBySo.set(String(o.soId), ln);
  }
  for (const [soId, tag] of commTags) {
    if (tag?.patient) lastNameBySo.set(String(soId), tag.patient);
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
        // The ROW stays, the NAME goes — same trade as offRoster.reps above.
        // Cassie's orders land here now that she is off the roster, and this
        // list is exactly the "who was it booked to" field that would put her
        // back on screen. Nulled, so the order is still surfaced as a data
        // problem and `reason` below still explains it.
        rep: isExcludedRep(bookedTo) ? null : bookedTo,
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
    const res = commissionForOrder({ status: info.status, labels: info.labels, program, items: o.items, value }, commCfg);
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
      // The sales-order date — the same field the month bucket above is cut
      // from, so a line and the month it is paid in can never disagree.
      date: info.date || null,
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

  // ── THE RECONCILIATION IS THE BASE FOR MONEY ───────────────────────────────
  //
  // Payable figures come from the signed-off reconciliation sheet, AUTO-MATCHED
  // ROWS ONLY, per its own tier definition. The Striven computation is kept
  // beside it as `strivenPayable` rather than discarded: the two disagree by
  // roughly $98k, and a page that shows one without the other cannot explain
  // itself.
  //
  // A rep absent from the sheet goes to ZERO, not to their Striven figure.
  // Falling back would silently mix two bases in one column and make the total
  // reconcile to nothing. Maylon Sanders is the live case — 39 PI orders in
  // Striven, no rows in the sheet — and `reconciled: false` marks him so the UI
  // can say "not in the reconciliation" instead of showing a bare $0.
  const recon = await getCommissionRecon().catch(() => null);
  if (recon?.ok) {
    const bySheet = new Map(recon.byRep.map((r) => [r.rep, r]));
    for (const r of striven.byRep) {
      const s = bySheet.get(r.rep);
      r.strivenPayable = r.payableTotal;          // what the engine computed
      r.payableTotal = s ? s.payableTotal : 0;    // what the sheet signs off
      r.reviewTotal = s ? s.reviewTotal : 0;
      r.unmatchedTotal = s ? s.unmatchedTotal : 0;
      r.reconciled = Boolean(s);
      r.total = r.payableTotal;
      if (s) r.lines = s.lines.slice().sort((a, b) => b.comm - a.comm);
      else r.lines = [];
    }
    // Reps the sheet knows but the order book does not still have to be paid,
    // so they are appended rather than dropped. This is how a sheet-only payee
    // reaches the page at all.
    //
    // "CMC (direct)" used to be the example here and is now the counter-example:
    // it is in EXCLUDED_REPS, so getCommissionRecon() never emits a row for it
    // and there is nothing to append. The guard below repeats that test rather
    // than trusting it, because THIS loop is what invents a rep row out of a
    // sheet name — if an excluded name ever reached it, it would be re-created
    // downstream of every other filter.
    for (const s of recon.byRep) {
      if (isExcludedRep(s.rep)) continue;
      if (striven.byRep.some((r) => r.rep === s.rep)) continue;
      striven.byRep.push({
        rep: s.rep, tricare: 0, va: 0, pi: 0, total: s.payableTotal,
        orders: 0, units: 0, value: 0, nTricare: 0, nVa: 0, nPi: 0,
        payableTotal: s.payableTotal, waitingTotal: 0, heldOrders: 0,
        strivenPayable: 0, reviewTotal: s.reviewTotal, unmatchedTotal: s.unmatchedTotal,
        reconciled: true, lines: s.lines.slice().sort((a, b) => b.comm - a.comm),
      });
    }
    striven.byRep.sort((a, b) => b.payableTotal - a.payableTotal);
    striven.payableTotal = round2(striven.byRep.reduce((t, r) => t + (r.payableTotal || 0), 0));
    striven.grandTotal = striven.payableTotal;
    // AUTO-MATCHED ROWS SITTING ON A ZERO-VALUE ORDER. The sheet signs these
    // off, and Striven records no revenue against the order — so commission is
    // payable on an order the books value at nothing. Not resolved here (the
    // sheet is the agreed base) but counted, so the discrepancy is visible on
    // the page instead of only surfacing in an audit.
    // `recent` is getSO()'s order list, already in scope above — the earlier
    // draft reached for `analytics`, which does not exist in this function.
    const liveByRef = new Map((recent || []).map((o) => [o.ref, o]));
    let zeroValueLines = 0; let zeroValueAmount = 0;
    let cancelledRefLines = 0; let cancelledRefAmount = 0;
    for (const r of striven.byRep) {
      for (const l of r.lines ?? []) {
        if (!l.ref) continue;
        const o = liveByRef.get(l.ref);
        // A LINE MUST NOT CLAIM A CANCELLED ORDER. The sheet matched Jillian's
        // R. Eloi row to SO-369, which Striven has cancelled — one of the
        // sheet's own open items (two Striven records for one patient). The
        // line is still PAID, because the sheet is the agreed base and this is
        // an attribution question, not an entitlement one; but the reference is
        // dropped, because printing it would tell a rep the payment is
        // evidenced by an order that no longer stands. Counted, so a cancelled
        // order re-entering payable commission stays visible.
        if (o && isCancelledStatus(o.status)) {
          l.ref = '';
          cancelledRefLines += 1;
          cancelledRefAmount = round2(cancelledRefAmount + l.comm);
          continue;
        }
        if (o && !(Number(o.value) > 0)) { zeroValueLines += 1; zeroValueAmount = round2(zeroValueAmount + l.comm); }
      }
    }
    striven.recon = {
      source: 'Commission Payout Reconciliation · every signed-off row, unmatched marked',
      totals: recon.totals,
      zeroValueLines,
      zeroValueAmount,
      cancelledRefLines,
      cancelledRefAmount,
      // Rows where the sheet disagreed with the workbook it was transcribed
      // from, and which the workbook won. Surfaced rather than applied
      // silently: this changes what a rep is paid, so it has to be answerable.
      corrections: recon.corrections ?? null,
      fetchedAt: recon.fetchedAt,
    };
  }

  // ── WORKBOOK SOURCES, for reps the reconciliation sheet does not carry ──────
  // Maylon Sanders is why: 39 PI orders in Striven and no row in the sheet, so
  // his login read $0 every month. His commission lives in a workbook of its
  // own — see getCommissionWorkbooks().
  //
  // GUARDED PER REP × MONTH. A workbook line is taken only where the sheet has
  // nothing for that rep in that month. The sheet stays the base wherever it
  // speaks, and pointing this at a workbook the sheet already covers cannot
  // double anyone's pay — which is the failure that would be least visible and
  // worst to ship, since both sources are legitimately named the same thing.
  const workbooks = await getCommissionWorkbooks().catch(() => null);
  if (workbooks?.configured) {
    const covered = new Set();               // "rep|month" the sheet already pays
    for (const r of striven.byRep) {
      for (const l of r.lines || []) if (l.month) covered.add(`${r.rep}|${l.month}`);
    }
    let added = 0, skipped = 0, addedAmt = 0;
    for (const w of workbooks.byRep) {
      const take = w.lines.filter((l) => !covered.has(`${w.rep}|${l.month}`));
      skipped += w.lines.length - take.length;
      if (!take.length) continue;
      let row = striven.byRep.find((r) => r.rep === w.rep);
      if (!row) { row = { ...zeroRepRow(w.rep), strivenPayable: 0, reviewTotal: 0, unmatchedTotal: 0 }; striven.byRep.push(row); }
      const amt = round2(take.reduce((s, l) => s + l.comm, 0));
      row.lines = [...(row.lines || []), ...take].sort((a, b) => b.comm - a.comm);
      row.payableTotal = round2((row.payableTotal || 0) + amt);
      row.total = row.payableTotal;
      row.reconciled = true;                 // signed off, just not by that sheet
      added += take.length; addedAmt = round2(addedAmt + amt);
    }
    striven.byRep.sort((a, b) => b.payableTotal - a.payableTotal);
    striven.payableTotal = round2(striven.byRep.reduce((t, r) => t + (r.payableTotal || 0), 0));
    striven.grandTotal = striven.payableTotal;
    striven.workbooks = { lines: added, amount: addedAmt, skippedCoveredBySheet: skipped, fetchedAt: workbooks.fetchedAt };
  }

  // ── WHAT HAS ALREADY BEEN PAID ──────────────────────────────────────────────
  // "Payable / Due" was every signed-off dollar a rep had ever earned, months
  // after the money left the bank. COMMISSION_PAID_THROUGH names the last month
  // each vertical has actually been paid for, and those lines become `paid`:
  // still theirs, still in the total, no longer owed.
  //
  // Marked HERE, before the month rollup below, so one rule decides the state
  // and every figure downstream — rep row, month row, drill line — splits the
  // same way. Nothing is removed: `total` still carries the lot, which is what
  // stops a rep's year-to-date shrinking the day they are paid.
  const paidThrough = await (async () => {
    const raw = String(await cfgValue('COMMISSION_PAID_THROUGH', '')).trim();
    if (!raw) return COMMISSION_PAID_THROUGH;
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : COMMISSION_PAID_THROUGH; }
    catch { return COMMISSION_PAID_THROUGH; }
  })();
  // The sheet's Vertical column spells things loosely; fold it to the same three
  // names the config is keyed by, so "VA Order" and "va" both land on VA.
  // Shared with getRepOverview's commission rollup — see the config module.
  const vertOfLine = (l) => verticalOfCommissionLine(l?.prog);
  // An UNDATED line is never marked paid. Its cycle could not be resolved to a
  // month, so there is no way to tell which side of the cut-off it falls — and
  // calling money paid when it may not be is the worse error of the two.
  const isPaidLine = (l) => {
    const v = vertOfLine(l);
    const through = v && paidThrough[v];
    return Boolean(through && l.month && String(l.month) <= String(through));
  };
  const splitPaid = (lines) => {
    let paid = 0, due = 0;
    for (const l of lines) {
      if (isPaidLine(l)) { l.state = 'paid'; paid += l.comm; } else due += l.comm;
    }
    return { paid: round2(paid), due: round2(due) };
  };
  for (const r of striven.byRep) {
    const { paid, due } = splitPaid(r.lines || []);
    r.paidTotal = paid;
    r.payableTotal = due;
    r.total = round2(paid + due);
  }
  striven.paidTotal = round2(striven.byRep.reduce((t, r) => t + (r.paidTotal || 0), 0));
  striven.payableTotal = round2(striven.byRep.reduce((t, r) => t + (r.payableTotal || 0), 0));
  // The headline stays the WHOLE signed-off figure. Paying a rep does not
  // reduce what they earned, and a "Total commission" tile that fell every
  // payday would be reporting the wrong thing.
  striven.grandTotal = round2(striven.paidTotal + striven.payableTotal);
  striven.paidThrough = paidThrough;

  // ── THE MONTHS ARE THE PAYOUT CYCLES ────────────────────────────────────────
  // A month on this page now means "the commission settled by the payout run
  // for that month", which is the thing the business actually pays and the
  // thing a rep is asking about. Two problems this fixes:
  //
  //   1. THE MONEY. Month rows carried the Striven ENGINE's figure while the
  //      all-months row carried the signed-off sheet's. Alle Ann therefore read
  //      $63,025 on All months and months that summed to $94,000 — two bases
  //      behind one selector, with nothing on screen saying which was which.
  //      (The label fix above closed most of that gap; this closes the rest.)
  //   2. THE ATTRIBUTION. Lines were bucketed by SALES ORDER DATE, which is not
  //      when the commission is paid and does not agree with the sheet: Alle
  //      Ann's lines fell 26/29/78 across Jul/Jun/May by order date, against
  //      28/30/36/19/21 by payout cycle. Same money, wrong months.
  //
  // The cycle → month rule is monthOfPayoutCycle(). Verified line-for-line and
  // cent-for-cent against the two source workbooks across all 18 rep×month
  // cells; the one disagreement (Cassie, June) is a difference between the
  // WORKBOOK and the signed-off SHEET, and the sheet wins here because it is
  // the base every other figure on this page already comes from.
  //
  // Volume (orders, units) is untouched: it comes from the order book and is a
  // different question from what is owed.
  {
    const zeroMoney = (row) => {
      row.strivenPayable = row.payableTotal;      // keep the engine's, for comparison
      row.payableTotal = 0; row.paidTotal = 0; row.total = 0;
      row.tricare = 0; row.va = 0; row.pi = 0;
      row.lines = []; row.reconciled = false;
    };
    // month → rep → its signed-off lines
    const byMonth = new Map();
    for (const r of striven.byRep) {
      for (const l of r.lines || []) {
        if (!l.month) continue;                    // undated cycle: All months only
        const reps = byMonth.get(l.month) ?? new Map();
        const arr = reps.get(r.rep) ?? [];
        arr.push(l); reps.set(r.rep, arr); byMonth.set(l.month, reps);
      }
    }
    const known = new Map(striven.months.map((M) => [M.month, M]));
    for (const [month, reps] of byMonth) {
      let M = known.get(month);
      if (!M) {
        // A month the sheet pays for but the order book has no orders in — the
        // sheet reaches further back than report_patient_items does. It is a
        // real payout and must not vanish for want of a Striven bucket.
        M = { month, total: 0, TriCare: 0, VA: 0, PI: 0, orders: 0, units: 0, value: 0, oTriCare: 0, oVA: 0, oPI: 0, ...zeroState(), reps: [] };
        striven.months.push(M); known.set(month, M);
      }
      const rowOf = new Map(M.reps.map((r) => [r.rep, r]));
      for (const [rep, lines] of reps) {
        let row = rowOf.get(rep);
        if (!row) { row = { ...zeroRepRow(rep) }; M.reps.push(row); rowOf.set(rep, row); }
        row.strivenPayable = row.payableTotal;
        // Same paid/due split as the rep row above, off the same rule.
        const { paid, due } = splitPaid(lines);
        row.paidTotal = paid;
        row.payableTotal = due;
        row.total = round2(paid + due);
        row.reconciled = true;
        row.lines = lines.slice().sort((a, b) => b.comm - a.comm);
        // Per vertical, off the SHEET's own Vertical column rather than the
        // engine's programme — same source as the money beside it.
        const prog = (re) => round2(lines.filter((l) => re.test(String(l.prog || ''))).reduce((s, l) => s + l.comm, 0));
        row.tricare = prog(/tri.?care/i);
        row.va = prog(/\bva\b|veteran/i);
        row.pi = prog(/\bpi\b|personal injury/i);
      }
      // A rep with orders that month but no signed-off line is owed nothing for
      // it. Leaving the engine's figure would mix the two bases back together.
      for (const row of M.reps) if (!reps.has(row.rep)) zeroMoney(row);
      M.paidTotal = round2(M.reps.reduce((s, r) => s + (r.paidTotal || 0), 0));
      M.payableTotal = round2(M.reps.reduce((s, r) => s + (r.payableTotal || 0), 0));
      M.total = round2(M.paidTotal + M.payableTotal);
      M.TriCare = round2(M.reps.reduce((s, r) => s + (r.tricare || 0), 0));
      M.VA = round2(M.reps.reduce((s, r) => s + (r.va || 0), 0));
      M.PI = round2(M.reps.reduce((s, r) => s + (r.pi || 0), 0));
      M.reconciled = true;
    }

    // ── THE IN-FLIGHT MONTH ────────────────────────────────────────────────────
    // A month with orders but no payout cycle yet: the current one, and any
    // month settled after this sheet was last saved. NOTHING IN IT IS PAYABLE —
    // commission is settled by the 15th of the following month, so until that
    // run exists there is no signed-off figure and the engine's number is an
    // estimate, not an entitlement.
    //
    // So its money moves to WAITING rather than being deleted: the rep still
    // sees what the month has earned, in the column that says "not yet". Marked
    // `reconciled: false` so the page can say why.
    for (const M of striven.months) {
      if (byMonth.has(M.month)) continue;
      for (const row of M.reps) {
        const earned = round2((row.payableTotal || 0) + (row.waitingTotal || 0));
        zeroMoney(row);
        row.waitingTotal = earned;
      }
      M.waitingTotal = round2(M.reps.reduce((s, r) => s + (r.waitingTotal || 0), 0));
      M.payableTotal = 0; M.paidTotal = 0; M.total = 0; M.TriCare = 0; M.VA = 0; M.PI = 0;
      M.reconciled = false;
    }
    striven.months.sort((a, b) => b.month.localeCompare(a.month));
  }

  // ── ONE BASIS FOR EVERY MONEY FIGURE ON THE PAGE ────────────────────────────
  //
  // Everything above rebuilt the rep rows and the month rows off the signed-off
  // sheet. Two families of field did NOT get rebuilt and kept the Striven
  // ENGINE's figures, which is how the page came to print two bases side by
  // side with nothing saying which was which:
  //
  //   tricare/va/pi   the vertical split. Company-wide it read $238,523 under a
  //   and byProgram   $195,954 headline, and the ranking INVERTED — TriCare
  //                   $37,348 engine against $68,865 signed off, PI $48,250
  //                   against $14,414. Picking a single month switched the same
  //                   three tiles to the sheet, because month rows ARE rebuilt,
  //                   so one dropdown gave two answers. A rep saw it too: their
  //                   own split is read off these row fields (see
  //                   redactCommissionPayload), so their $0 rows still showed a
  //                   per-vertical breakdown of money nobody was paying them.
  //
  //   waitingTotal    the engine's held/waiting sum, printed beside a sheet
  //                   payable. A RECONCILED MONTH CANNOT HAVE ANYTHING WAITING:
  //                   the sheet has signed every line in it off as either paid
  //                   or due. The only real waiting is the in-flight cycle — the
  //                   month with no payout run yet — which the block above has
  //                   already worked out. The rest was engine residue, and it
  //                   made "Payable + Waiting" add up to nothing in particular.
  //
  // Both are re-derived from the LINES, which is where the money on the row
  // already comes from, so the split sums to the total by construction instead
  // of by luck — and the admin table's trimmed path (which re-sums the rendered
  // rows) can no longer disagree with its untrimmed one.
  //
  // `strivenPayable` stays on every row. That is the engine's figure kept
  // deliberately and labelled, for the comparison the recon block exists to
  // make; a field nobody rebuilt is a different thing.
  {
    // WAITING IS THE IN-FLIGHT CYCLE, NOTHING ELSE.
    const waitingByRep = new Map();
    for (const M of striven.months) {
      if (M.reconciled) {
        for (const row of M.reps) row.waitingTotal = 0;
        M.waitingTotal = 0;
        continue;
      }
      for (const row of M.reps) {
        const w = round2(row.waitingTotal || 0);
        row.waitingTotal = w;
        if (w) waitingByRep.set(row.rep, round2((waitingByRep.get(row.rep) || 0) + w));
      }
      M.waitingTotal = round2(M.reps.reduce((s, r) => s + (r.waitingTotal || 0), 0));
    }
    for (const r of striven.byRep) r.waitingTotal = waitingByRep.get(r.rep) || 0;
    striven.waitingTotal = round2(striven.byRep.reduce((s, r) => s + (r.waitingTotal || 0), 0));

    // THE VERTICAL SPLIT COMES OFF THE SAME LINES AS THE TOTAL.
    //
    // verticalOfCommissionLine() is the shared fold — the one the month rows
    // above already use — so a spelling learned in one place is learned in
    // both. It returns '' for anything it does not recognise, and that money is
    // reported as `byProgramUnassigned` rather than banked into one of the
    // three: a split that silently absorbs an unfoldable line is how the two
    // bases hid from each other in the first place.
    let unassigned = 0;
    for (const r of striven.byRep) {
      const v = { TriCare: 0, VA: 0, PI: 0 };
      for (const l of r.lines || []) {
        const k = verticalOfCommissionLine(l.prog);
        if (k) v[k] = round2(v[k] + (l.comm || 0));
        else unassigned = round2(unassigned + (l.comm || 0));
      }
      r.tricare = v.TriCare; r.va = v.VA; r.pi = v.PI;
    }
    striven.byProgram = {
      TriCare: round2(striven.byRep.reduce((s, r) => s + (r.tricare || 0), 0)),
      VA: round2(striven.byRep.reduce((s, r) => s + (r.va || 0), 0)),
      PI: round2(striven.byRep.reduce((s, r) => s + (r.pi || 0), 0)),
    };
    striven.byProgramUnassigned = unassigned;
  }

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
      // The NAMES are filtered; the volume above is not. An excluded rep's
      // orders are still real orders and still have to be counted somewhere, or
      // this block stops doing the job it was added for (making the commission
      // table's columns sum to the book). So the orders/units/value keep them
      // and only the attribution is withheld — "booked off-roster" without
      // saying to whom.
      reps: [...new Set(offRows.map((o) => o.rep))].filter((n) => !isExcludedRep(n)).sort(),
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
    // The names the admin "View as" picker may offer.
    //
    // PRODUCERS *PLUS* ANYONE THE RECONCILIATION PAYS. producerNames() alone is
    // REP_NAMES minus STANDINGS_EXCLUDE — a Striven-order-volume rule — and it
    // had drifted from who actually has commission to look at: Crystal and Rishi
    // were offered Maylon (now $0) but not the sheet-only payees, so those views
    // could not be opened at all. The second term is what fixes that.
    //
    // STANDINGS_EXCLUDE is still left alone here: it governs the LEADERBOARD,
    // and being unrankable is not the same as being unpayable. Only the second
    // should empty this list.
    //
    // EXCLUDED_REPS is the opposite case and IS filtered. This union reaches
    // into striven.byRep, which is assembled from sources with their own
    // notions of who exists, so it is the one place a dropped name could
    // reappear as a selectable "View as" target — a picker entry for somebody
    // the rest of the payload no longer has any rows for.
    //
    // Emptied for a rep by redactCommissionPayload: it is an admin control, and
    // a bare list of names is exactly the peer disclosure the rest of that
    // redaction prevents.
    roster: [...new Set([
      ...producerNames(),
      ...(striven.byRep || []).filter((r) => (r.payableTotal || 0) > 0 || (r.lines || []).length).map((r) => r.rep),
    ])].filter((n) => !isExcludedRep(n)),
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

  // soId → devices on that order (item + qty), and soId → the PATIENT NAME.
  //
  // FIRST INITIAL + SURNAME — "C. Richmond" — matching every other patient field
  // in the portal. This map used to be surname-only, because report_patient_items
  // is its only always-present source and that report strips the first name at
  // ingest. The result was the same person reading two different ways on screens
  // a rep uses together: the pipeline said "C. Richmond" (it overlays the labels
  // report) while My Orders beside it said "Richmond".
  //
  // THREE SOURCES, WEAKEST FIRST, each overwriting the last:
  //   1. report_patient_items — surname only, but covers the whole book
  //   2. the TRACKING report — names ~14 orders the labels report misses
  //   3. the LABELS report — the most complete, and the one the pipeline uses,
  //      so this ends on exactly the value the other boards show
  //
  // No new PHI is introduced and nothing extra is fetched: both reports are
  // already read on this request path and memoised, and both reduce the name to
  // an initial at their own boundary — the full first name is never stored.
  const devBySo = new Map();
  const lastNameBySo = new Map();
  for (const o of rcOrders) {
    const items = (o.items || [])
      .map((i) => ({ item: String(i.item || '').trim(), qty: Number(i.qty || 0) }))
      .filter((i) => i.item && i.qty > 0);
    if (items.length) devBySo.set(String(o.soId), items);
    const ln = commLastDisp(o.lastName);
    if (ln && o.soId != null) lastNameBySo.set(String(o.soId), ln);
  }
  const [nameTrack, nameTags] = await Promise.all([
    soTrackingBySoId().catch(() => new Map()),
    soLabelsBySoId().catch(() => new Map()),
  ]);
  for (const [soId, t] of nameTrack) if (t?.patient) lastNameBySo.set(String(soId), t.patient);
  for (const [soId, tag] of nameTags) if (tag?.patient) lastNameBySo.set(String(soId), tag.patient);

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
      // Patient SURNAME only — how a rep actually recognises the order. Empty
      // when the report cache has no row for this SO (it trails the live book).
      patient: lastNameBySo.get(String(r.id)) || '',
      rep,
      revenue: round2(Number(r.value || 0)),
      units: devices.reduce((s, i) => s + i.qty, 0),
      devices,
      status: r.status || '',
      invStatus: r.invStatus || '',
      strivenStage: r.stage || '',            // '' until the tag is mirrored
      // SHIPMENT. Read from Striven — the saved tracking report where it has a
      // row, the sales-order detail cache otherwise. NOT redacted for a rep: a
      // tracking number is operational, not financial, and a rep chasing "where
      // is my patient's device" is the main reason to show it.
      //
      // `tracking` is the raw string exactly as Striven holds it, which is what
      // search and the exports need; `shipments` is that string resolved into
      // one entry per parcel, because an order can carry more than one.
      tracking: r.tracking || '',
      shipments: shipmentsOf(r.tracking, r.shipVia),
      shipVia: r.shipVia || '',
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
/**
 * @param {{fresh?:boolean}} opts `fresh` RE-READS THE RECONCILIATION SHEET.
 *
 * The sheet is edited by hand and the figures on this page are its figures, so
 * "I changed the sheet and the portal still shows the old number" is the one
 * failure that makes the page untrustworthy. A page load and the Refresh button
 * both pass this, so a reload always shows what the sheet says right now.
 *
 * The 2-minute background poll deliberately does NOT: the sheet is a ~1s
 * fetch from Google, and paying that on every tab's timer, forever, to catch an
 * edit nobody has made is the wrong trade. Refresh the page — that is what the
 * flag is for.
 */
export async function getCommissionFor(viewer = null, { fresh = false } = {}) {
  if (fresh) {
    _cache.delete('derived:commission:raw');
    _cache.delete('derived:commission-recon');
    _cache.delete('derived:commission-workbooks');
  }
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

  // ── MONEY BY PAYOUT CYCLE, LIFTED STRAIGHT OFF THE COMMISSION PAYLOAD ───────
  //
  // THIS PAGE AND THE COMMISSION TAB HAVE TO AGREE, and they did not: Jillian's
  // July read $21,966 there and $6,646 here. Neither was wrong — they were
  // answering different questions. The Commission tab buckets by PAYOUT CYCLE
  // (the run the money actually goes out in), this page bucketed commission by
  // the SALES ORDER's date. Same money, different months, and $28,526 of
  // Jillian's lines tie to no live order at all, so on order-date they fell into
  // no month and simply vanished from every period.
  //
  // The payout cycle wins, because it is what the business pays on and what the
  // Commission tab — the authority for pay — already reports. Read from
  // `comm.striven.months`, the very rows that tab renders, so agreement is by
  // construction rather than by two calculations happening to match.
  //
  // WAITING COMES FREE WITH IT. It is a cycle figure by nature (the run that has
  // not gone out yet), so it has no order-date equivalent and had to be withheld
  // under a period filter. Per cycle it is simply a column like the others.
  //
  // The consequence, and it is deliberate: on one row the ORDER columns are cut
  // by order date and the MONEY columns by payout cycle. Two meanings of "month"
  // side by side is a real cost, paid so that the pay figure on this page is the
  // pay figure on the Commission tab. The UI states it rather than hiding it.
  const cycleByRep = new Map();
  for (const M of comm.striven?.months || []) {
    for (const r of (M.reps || [])) {
      const arr = cycleByRep.get(r.rep) ?? [];
      arr.push({
        month: M.month,
        paid: round2(r.paidTotal ?? 0),
        payable: round2(r.payableTotal ?? 0),
        waiting: round2(r.waitingTotal ?? 0),
        total: round2(r.total ?? 0),
      });
      cycleByRep.set(r.rep, arr);
    }
  }
  for (const arr of cycleByRep.values()) arr.sort((a, b) => a.month.localeCompare(b.month));

  /**
   * COMMISSION DUE, cut by vertical and by month, from the signed-off lines.
   *
   * OWED ONLY. A line whose state is 'paid' has already left the bank — it is
   * still the rep's earnings but it is not due, and "Commission due" that
   * includes paid money is not a figure anyone can act on. This is the same
   * split the Commission page reports, so the two agree by construction.
   *
   * CUT BY THE SALES ORDER'S DATE, not the payout cycle. The cycle is when the
   * money moves and is the more complete field — every line has one — but this
   * sits in a row of ORDER counts under a month selector that filters orders,
   * and a column whose "month" means something different from the columns
   * beside it is worse than one that is merely incomplete.
   *
   * The incompleteness is real and is reported rather than absorbed: 127 lines
   * tie to no live sales order, so they have no date and belong to no month.
   * `undated` carries them, and the UI states the figure — otherwise the months
   * would quietly sum to less than the all-time total with nothing to say why.
   */
  const commissionRollup = (rep) => {
    const allLines = (commByRep.get(rep)?.lines || []).filter(Boolean);
    const lines = allLines.filter((l) => l.state !== 'paid');
    const zero = () => Object.fromEntries(['PI', 'VA', 'DOL', 'TriCare'].map((v) => [v, 0]));
    const all = zero();
    let total = 0; let undated = 0;
    const months = new Map();
    for (const l of lines) {
      const v = verticalOfCommissionLine(l.prog);
      const amt = Number(l.comm) || 0;
      total += amt;
      if (v && all[v] != null) all[v] += amt;
      const key = String(l.date || '').slice(0, 7);
      if (!key) { undated += amt; continue; }
      const e = months.get(key) ?? { month: key, total: 0, byVertical: zero() };
      e.total += amt;
      if (v && e.byVertical[v] != null) e.byVertical[v] += amt;
      months.set(key, e);
    }
    // PAID LINES, bucketed the same way, so a month can report what was EARNED
    // (paid + owed) and not only what is still owed. The team table's Commission
    // column is the earned figure and its Payable column is the owed one; before
    // this, only the owed half could be cut by month, so scoping that table
    // would have put a month's Payable beside an all-time Commission.
    //
    // Tracked separately rather than by dropping the state filter above: `total`,
    // `byVertical` and `undated` are the COMMISSION DUE figures other panels
    // already read, and widening them to include paid money would overstate what
    // is owed everywhere they appear.
    const paidByMonth = new Map();
    let paidUndated = 0;
    for (const l of allLines) {
      if (l.state !== 'paid') continue;
      const amt = Number(l.comm) || 0;
      const key = String(l.date || '').slice(0, 7);
      if (!key) { paidUndated += amt; continue; }
      paidByMonth.set(key, (paidByMonth.get(key) ?? 0) + amt);
    }
    const r2 = (o) => { for (const k of Object.keys(o)) o[k] = round2(o[k]); return o; };
    // A month may hold ONLY paid lines (an old, fully-settled month), so the key
    // set is the union — keying off `months` alone would drop it from the picker
    // with money still in it.
    const keys = [...new Set([...months.keys(), ...paidByMonth.keys()])].sort();
    return {
      total: round2(total),
      undated: round2(undated),
      paidUndated: round2(paidUndated),
      byVertical: r2(all),
      byMonth: keys.map((k) => {
        const e = months.get(k);
        const owed = e ? round2(e.total) : 0;
        const paid = round2(paidByMonth.get(k) ?? 0);
        return {
          month: k,
          total: owed,                          // unchanged: OWED, what is due
          paid,                                 // already gone out
          earned: round2(owed + paid),          // what the month is worth in total
          byVertical: e ? r2(e.byVertical) : zero(),
        };
      }),
    };
  };
  // THE FOUR REAL PROGRAMMES. DEMO and Contract used to be here and are gone:
  // neither is a book a rep works, and both read as dead weight on every screen
  // that listed them — a row of dashes and a zero on the By vertical table, and
  // two permanently empty columns on the rep × vertical matrix.
  //
  // They are not equally empty, and neither is worth a row. 'Contract' has NO
  // orders anywhere in the book, so it was pure phantom. 'DEMO' has 29, but
  // only ONE is booked to a rep on the roster — the rest sit with house and ops
  // names — and a demo earns no revenue and no commission by design.
  //
  // This matches OrderDashboard's own VERTICALS list, which has always been
  // these four; the rep dashboard was the odd one out.
  //
  // ORDER COUNTS ARE UNCHANGED. `orders` below is still the rep's whole book,
  // so nothing is subtracted from the leaderboard metric or from what any other
  // page reports — the two verticals stop being LISTED, they are not deleted.
  const VERTS = ['PI', 'VA', 'DOL', 'TriCare'];

  // Non-producers are flagged here and DROPPED below, so they are absent from
  // the whole rep dashboard rather than merely hidden by the two leaderboards.
  // Every panel used to filter (or forget to filter) for itself, which is why
  // the same names kept resurfacing in the roster table and the KPI drills.
  //
  // This is a REP-DASHBOARD decision only. getCommission is a separate endpoint
  // and is untouched: a demo or house order still has to reconcile and still
  // pays whoever it pays, so no commission row is lost by this.
  // ── REPORTING LINES ─────────────────────────────────────────────────────────
  // Loaded HERE, above the rows, because two things below need them: which reps
  // this viewer supervises (their rows carry operational detail) and which reps
  // are withheld from them entirely (see `shown`).
  const jsonCfg = async (key, fallback) => {
    const raw = String(await cfgValue(key, '')).trim();
    if (!raw) return fallback;
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : fallback; }
    catch { return fallback; }
  };
  const subRepMap = await jsonCfg('REP_SUB_REPS', REP_SUB_REPS);
  const blindspots = blindspotsFor(mine, subRepMap, await jsonCfg('REP_BLINDSPOTS', REP_BLINDSPOTS));
  // The reps THIS viewer supervises, lower-cased. Empty for an admin, who is
  // already unredacted, and for anyone who supervises nobody.
  const supervises = new Set(
    Object.entries(subRepMap || {})
      .filter(([boss]) => mine && String(boss).trim().toLowerCase() === mine)
      .flatMap(([, subs]) => (subs || []).map((s) => String(s).trim().toLowerCase())),
  );

  const rows = REP_NAMES.map((rep) => {
    const own = isAdmin || isOwn(rep);
    // A REP THE VIEWER SUPERVISES. Their row carries the OPERATIONAL detail a
    // supervisor needs — units, accounts, devices, last order, the per-vertical
    // and per-month splits — which `lean` would otherwise strip to a bare order
    // count. Deliberately NOT `own`: `own` is what unlocks MONEY, and pay stays
    // between the rep and finance. Commission, payable, waiting and revenue are
    // null on a sub-rep's row exactly as on any other peer's.
    const supervised = !own && supervises.has(String(rep).trim().toLowerCase());
    const orders = analytics.orders.filter((o) => o.rep === rep);
    const cm = commByRep.get(rep) || null;
    const sh = sheetByRep.get(rep) || null;

    // Order counts are the one thing shared across the team. With
    // STANDINGS_ORDERS_ONLY on, everything else about another rep goes too, so
    // Team Standings can only ever be a ranking by volume.
    // `supervised` opts out of lean: a supervisor sees their sub-rep's volume in
    // full. Everyone else's peer row is still name-and-count only.
    const lean = !own && !supervised && STANDINGS_ORDERS_ONLY;
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
      standingsExcluded: isStandingsExcluded(rep),
      own,                                    // did this row survive unredacted?
      orders: orders.length,                  // always visible — the standings metric
      units: lean ? null : orders.reduce((s, o) => s + o.units, 0),
      // PI law firms only — see isRealAccount. VA/TriCare are verticals, and
      // counting them here is what made this figure unreadable.
      //
      // MANAGER ONLY. A rep's permitted figures are orders, units and their own
      // commission; the vendor spread is not one of them, so it is nulled even
      // on their own row rather than merely left off the tile row.
      accounts: (isAdmin || supervised) && !lean ? new Set(orders.map((o) => o.account).filter(isRealAccount)).size : null,
      // How many verticals this rep actually works in — the thing the old
      // "accounts" number was accidentally measuring for VA and TriCare reps.
      verticals: lean ? null : byVertical.filter((v) => v.orders > 0).length,
      devices: lean ? null : new Set(orders.flatMap((o) => o.devices.map((d) => d.item))).size,
      lastOrder: lean ? null : (orders.map((o) => o.date).filter(Boolean).sort().slice(-1)[0] || null),
      byVertical,
      // THE SAME ROW, CUT BY CALENDAR MONTH — what a period selector on the
      // leaderboard ranks. Derived from the very orders `orders` above counts,
      // so a month's figures can never disagree with the all-time ones they sum
      // to; deriving them from a second source is how two boards on one page
      // start reporting different numbers.
      //
      // Order counts follow the same rule as the total: shared across the team.
      // Units follow `lean`, so a peer row stays counts-only per month exactly
      // as it is in aggregate — a period selector must not become a way to read
      // a figure the aggregate withholds.
      byMonth: (() => {
        const m = new Map();
        for (const o of orders) {
          const key = String(o.date || '').slice(0, 7);
          if (!key) continue;                       // undated orders join no month
          const e = m.get(key) ?? { month: key, orders: 0, units: 0, revenue: 0, accts: new Set(), verts: new Map() };
          e.orders += 1;
          e.units += o.units;
          e.revenue += Number(o.revenue || 0);
          if (isRealAccount(o.account)) e.accts.add(o.account);
          const v = e.verts.get(o.vertical) ?? { orders: 0, units: 0 };
          v.orders += 1; v.units += o.units;
          e.verts.set(o.vertical, v);
          m.set(key, e);
        }
        return [...m.values()]
          .sort((a, b) => a.month.localeCompare(b.month))
          .map((e) => ({
            month: e.month,
            orders: e.orders,
            units: lean ? null : e.units,
            // REVENUE and ACCOUNTS were added so the team table can be read one
            // month at a time rather than only in aggregate. Cut from the same
            // `orders` pass as everything else here, and carrying the SAME
            // redaction as their all-time counterparts above — revenue is
            // admin-only, accounts is admin-and-not-lean. A period selector must
            // never become a way to read a figure the aggregate withholds.
            revenue: isAdmin ? round2(e.revenue) : null,
            accounts: (isAdmin || supervised) && !lean ? e.accts.size : null,
            // The SAME four verticals, in the same order, as byVertical above:
            // the mix bar is drawn from this and would re-colour between periods
            // if the list were built from whatever the month happened to hold.
            byVertical: VERTS.map((v) => ({
              vertical: v,
              orders: e.verts.get(v)?.orders ?? 0,
              units: lean ? null : (e.verts.get(v)?.units ?? 0),
            })),
          }));
      })(),
      // THE PAY FIGURES, BY PAYOUT CYCLE — the same rows the Commission tab
      // renders, so the two pages cannot disagree. See the note where
      // `cycleByRep` is built. Money, so it follows `own` exactly as the
      // aggregate `commission` / `payable` / `waiting` below do: a peer row
      // carries none of it, and a period selector must not be a way around that.
      commissionByCycle: own ? (cycleByRep.get(rep) ?? []) : null,
      // Admin only, for the same reason as byVertical above: own revenue is
      // still revenue. Commission below IS the rep's to see.
      revenue: isAdmin ? round2(orders.reduce((s, o) => s + o.revenue, 0)) : null,
      commission: own ? (cm?.total ?? 0) : null,
      payable: own ? (cm?.payableTotal ?? 0) : null,
      waiting: own ? (cm?.waitingTotal ?? 0) : null,
      // Commission DUE, per vertical and per month. Money, so it follows `own`
      // exactly as the three figures above do — a peer row carries null, not a
      // zero, because zero is a claim about their pay and null is silence.
      commissionDue: own ? commissionRollup(rep) : null,
      matchRate: sh?.matchRate ?? null,       // operational, shared
      verified: sh?.verified ?? false,
    };
  });

  // ONE scope for the whole tile row. These figures describe the
  // REP-ATTRIBUTED book, so orders, units, accounts and revenue all count the
  // same set of orders. Previously `orders` summed the rep rows while revenue and
  // units summed the entire company book, which made the row contradict itself
  // and disagree with the Orders & Revenue page.
  // THE roster for this payload: producers only. A viewer who is themselves
  // STANDINGS-excluded keeps their own row, or they would sign in to an empty
  // dashboard and no figure of their own anywhere.
  //
  // This carve-out does NOT extend to EXCLUDED_REPS, and cannot: those names are
  // gone from REP_NAMES, so `rows` above never builds them a row to keep. That
  // is the intended difference — an unranked rep still has a dashboard, a name
  // that is not a rep has nothing to show. Cassie was the reason this sentence
  // used to name her; her directory row went with her roster entry.
  //
  // Everything below counts `shown`, not `rows` — the table footer has to be
  // the sum of the rows above it, and the KPI tiles have to agree with both.
  // Filtering the display list while totalling the full roster is what would
  // put 4 rows under a total of 11.
  const producers = rows.filter((r) => !r.standingsExcluded || r.isSelf);

  // Every producer's row ships to everyone, INCLUDING a rep — the leaderboard
  // is back on a rep's dashboard and a ranking needs the field to rank against.
  //
  // A peer row is not a full row. `lean` above (STANDINGS_ORDERS_ONLY) has
  // already reduced it to a name, an order count and the per-vertical order
  // split that draws its bar: no units, no accounts, no devices, no last-order
  // date, and no money of any kind. That is the whole of what a leaderboard
  // needs, and it is the whole of what a rep receives about anybody else.
  //
  // Peer names and peer order counts ARE visible to a rep; that is the cost of
  // ranking them against each other, and it was asked for explicitly. Pay is
  // not part of the trade: commission, payable, waiting and revenue stay
  // own-row-only here, and /api/commission still ships a rep nothing but their
  // own rows.
  //
  // ── EXCEPT WHERE A BLIND SPOT APPLIES ──────────────────────────────────────
  //
  // REP_BLINDSPOTS names, per viewer, the reps their login must show nothing
  // about. Jillian works under Alle, so Alle's book is not hers to read. The
  // row is DROPPED rather than blanked, for the reason redactCommissionPayload
  // drops peers on /api/commission: a row cut down to a name and a count still
  // names the rep, and nulling fields one at a time means the next field added
  // leaks by default.
  //
  // RANK IS STAMPED BEFORE THE FILTER, and that is the part that matters.
  // Removing Alle's 185 would otherwise float Jillian's 99 to the top of the
  // list and the board would tell her she is 1st, fire the top-of-the-board
  // banner and burn her one-per-achievement confetti — a false claim
  // manufactured by the privacy filter itself. `rank` is computed over the whole
  // producing field, so a hidden rep leaves a GAP in the numbering instead of
  // promoting everyone below her. Jillian reads 2nd, and position 1 is simply
  // not there.

  // The true field, ranked on the metric the board ranks on: order count.
  const byRank = [...producers].sort((a, b) => b.orders - a.orders || a.rep.localeCompare(b.rep));
  byRank.forEach((r, i) => { r.rank = i + 1; });

  // THE SAME RANK, PER MONTH. The board defaults to the current month, and
  // without this the client fell back to array position whenever a period was
  // selected — which re-opens the exact hole `rank` exists to close. A row the
  // viewer does not receive (a blind spot, or a sub-rep now shown inside their
  // supervisor's card) would silently promote everyone beneath it, so a rep
  // could read 1st for a month they placed 2nd in.
  //
  // Ranked over the whole producing field, and only over reps who booked that
  // month — the board itself drops a rep with nothing in the period rather than
  // listing them last on zero, so ranking them would leave an unreachable number.
  const monthKeys = new Set(producers.flatMap((r) => (r.byMonth ?? []).map((m) => m.month)));
  for (const key of monthKeys) {
    const field = producers
      .map((r) => ({ rep: r.rep, m: (r.byMonth ?? []).find((x) => x.month === key) }))
      .filter((x) => x.m && x.m.orders > 0)
      .sort((a, b) => b.m.orders - a.m.orders || a.rep.localeCompare(b.rep));
    field.forEach((x, i) => { x.m.rank = i + 1; });
  }

  const shown = isAdmin || !blindspots.size
    ? producers
    : producers.filter((r) => r.isSelf || !blindspots.has(String(r.rep).trim().toLowerCase()));
  const shownNames = new Set(shown.map((r) => r.rep));

  // ── "WORKS UNDER YOU" — the other half of the reporting line ────────────────
  //
  // Marks a row as the viewer's sub-rep so their login can say so. DISPLAY ONLY:
  // no figure moves and the row stays exactly as lean as any other peer's — the
  // supervisor gets the relationship, not extra access. Rolling the volume up
  // into the supervisor's own row is what commRep() does for Denise Zavala, and
  // is deliberately NOT what happens here: Jillian is a rep in her own right
  // with her own login and her own pay.
  //
  // STAMPED ONLY FOR THE SUPERVISOR (and for an admin, who sees the whole org
  // anyway). Setting it on every payload would tell Christy and Cassie who
  // reports to whom, which is a disclosure nobody asked for and the smallest
  // possible version of this feature does not need.
  for (const r of shown) {
    const boss = supervisorOf(r.rep, subRepMap);
    r.subRepOf = boss && !r.isSelf && (isAdmin || (mine && String(boss).trim().toLowerCase() === mine))
      ? boss
      : null;
  }

  // The KPI TILES are a different question from the leaderboard. They describe
  // the caller: a rep's tiles are their own orders, units and commission, not
  // the team's. Totalling `shown` for a rep would have put the team's order
  // count on a tile labelled "Your orders".
  const tileRows = isAdmin ? shown : shown.filter((r) => r.isSelf);
  const tileNames = new Set(tileRows.map((r) => r.rep));

  const self = shown.find((r) => r.isSelf) ?? null;
  // Scoped to `tileRows`, so for a rep this is their own book and nothing else.
  const repOrders = analytics.orders.filter((o) => tileNames.has(o.rep));
  const teamTotals = {
    reps: tileRows.length,
    orders: tileRows.reduce((s, r) => s + r.orders, 0),
    // Units come from `repOrders`, already narrowed to the rows above — so a
    // manager gets the team's units and a rep gets their own.
    units: repOrders.reduce((s, o) => s + o.units, 0),
    // Accounts stay manager-only: a rep's permitted figures are orders, units
    // and their own commission, and the vendor spread is not among them.
    accounts: isAdmin ? new Set(repOrders.map((o) => o.account).filter(isRealAccount)).size : null,
    // Money is manager-only. This used to fall back to the rep's OWN revenue,
    // which is exactly the figure the business does not want a rep to see:
    // knowing what their orders billed drives "you made X, why am I paid Y".
    // Commission still falls back to their own, because that is their pay.
    revenue: isAdmin ? round2(repOrders.reduce((s, o) => s + o.revenue, 0)) : null,
    commission: isAdmin ? round2(shown.reduce((s, r) => s + (r.commission ?? 0), 0)) : (self?.commission ?? null),
  };
  // THE SAME TOTALS, CUT BY MONTH — for the team table's period selector.
  //
  // ACCOUNTS IS WHY THIS EXISTS. Orders, units and revenue could be summed from
  // the rep rows on the client, but `accounts` is a DISTINCT count: two reps
  // both billing the same law firm are one payer, and adding their row figures
  // counts it twice (the rows sum to 60 against a true 57 all-time). The union
  // can only be taken where the orders are, so it is taken here.
  //
  // Same source and same redaction as `teamTotals` above, so a month can never
  // disagree with the aggregate it sums into.
  const teamByMonth = (() => {
    const m = new Map();
    for (const o of repOrders) {
      const key = String(o.date || '').slice(0, 7);
      if (!key) continue;                         // undated orders join no month
      const e = m.get(key) ?? { month: key, orders: 0, units: 0, revenue: 0, accts: new Set() };
      e.orders += 1;
      e.units += o.units;
      e.revenue += Number(o.revenue || 0);
      if (isRealAccount(o.account)) e.accts.add(o.account);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((e) => ({
      month: e.month,
      orders: e.orders,
      units: e.units,
      revenue: isAdmin ? round2(e.revenue) : null,
      accounts: isAdmin ? e.accts.size : null,
    }));
  })();
  // The rest of the order book: everything not booked to a producing rep —
  // house/clinic accounts, ops staff, departed names, unassigned. Reported
  // rather than folded in, so the gap against Orders & Revenue is explained
  // instead of puzzling.
  //
  // This bucket GREW when the non-producers left the roster: their orders were
  // rep-attributed before and are unattributed now. That is the honest place
  // for them — but note their commission is no longer in the tile above, while
  // /api/commission still pays it. The two are answering different questions.
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
    // EVERY month the shown book touches, oldest first, so a period selector
    // offers exactly the periods that exist. Built from the rows rather than
    // from a date range: a month nobody booked in is not a period to rank, and
    // generating the range would offer an empty board as a valid choice.
    // The UNION of order months and payout-cycle months. A cycle can settle in a
    // month the order book has nothing in (2026-03 pays for work booked earlier),
    // and keying the picker off orders alone would leave that money unreachable —
    // present in the All time total, in no period you could select.
    months: [...new Set([
      ...shown.flatMap((r) => (r.byMonth ?? []).map((m) => m.month)),
      ...shown.flatMap((r) => (r.commissionByCycle ?? []).map((m) => m.month)),
    ])].sort(),
    reps: shown.sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.orders - a.orders),
    teamTotals,
    teamByMonth,
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
// ── Striven sales-order LABELS ───────────────────────────────────────────────
// A saved Striven report, one row per sales order, carrying the LABELS staff
// actually tag orders with. This is what drives the PI and PIP pipelines.
//
// JOIN: report.Number → the sales order's `number`, matched case-insensitively.
// It is NOT the SO id — Striven order numbers are often text ("JHoneycutt"),
// which is also why the join has to happen HERE and not in the browser:
// safeRef() masks any order number containing letters, because those letters
// are a patient's initials and surname. The raw number never leaves this file.
//
// The URL carries a bearer token in its path, so it lives in the environment
// (STRIVEN_LABELS_URL), never in committed source.
// SEVERAL REPORTS ARE ALLOWED. STRIVEN_LABELS_URL takes a comma- or
// whitespace-separated list, and their rows are merged.
//
// This matters because each report is SCOPED IN STRIVEN, not here, and no
// amount of code on this side can give an order a label its report omits. The
// first report used to return 119 rows — the PI/PIP book alone — which is why
// the list exists; it has since been widened in Striven to 471 and now covers
// the whole book, VA included.
//
// The second entry is the VA book (216 rows). It is a STRICT SUBSET of the
// widened first report and agrees with it on every row, so today it changes no
// figure. It is listed anyway because the first report's scope is a Striven-side
// setting: if someone narrows it back to PI, the VA board would silently empty,
// and naming the VA report is what stops the board depending on a setting that
// lives outside this repository.
//
// Reports may overlap freely: rows merge into one soId → labels map, so an order
// listed in several simply resolves once. TriCare and DEMO have no report of
// their own and rely entirely on the first one.
// Supabase app_config first, env second — see cfgValue().
const LABELS_URLS = async () => String(await cfgValue('STRIVEN_LABELS_URL'))
  .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/**
 * Fetch one saved Striven report, following pagination.
 *
 * The response carries totalRecords / pageSize / pageIndex / nextPage. Today
 * every report fits one page (400-471 rows of a 10,000 page size) so this
 * changes nothing — but a widened report covering the whole book could not, and
 * silently reading page one would then drop rows with no error anywhere. Capped
 * so a malformed nextPage cannot spin.
 *
 * Shared by the LABELS and TRACKING reports: both are saved reports on the same
 * endpoint with a bearer token in the path, and the pagination bug above is one
 * anybody would reintroduce writing the second fetcher from scratch.
 */
async function fetchSavedReport(url) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < 25; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const j = await fetch(next).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!j) break;
    out.push(...(Array.isArray(j.data) ? j.data : []));
    const n = j.nextPage;
    // Absolute URL, or a page token to hang off the base — accept either, and
    // stop rather than guess if it is neither.
    next = typeof n === 'string' && /^https?:\/\//i.test(n) ? n : null;
  }
  return out;
}

/** soId → the labels Striven has on that order. Empty when unconfigured. */
async function soLabelsBySoId() {
  const urls = await LABELS_URLS();
  if (!urls.length) return new Map();
  return cached('derived:so-labels', async () => {
    const [pages, soBlob] = await Promise.all([
      Promise.all(urls.map((u) => fetchSavedReport(u))),
      sbCacheRead('so').then((b) => b?.data ?? []).catch(() => []),
    ]);
    const rows = pages.flat();
    const so = Array.isArray(soBlob) ? soBlob : [];
    const idByNumber = new Map(
      so.filter((o) => o?.number != null).map((o) => [String(o.number).trim().toLowerCase(), String(o.id)]),
    );
    const out = new Map();
    for (const r of rows) {
      const id = idByNumber.get(String(r?.Number ?? '').trim().toLowerCase());
      if (!id) continue;
      const labels = String(r?.Labels ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // The report carries the patient's FULL name. Only the first INITIAL and
      // the surname are kept, and only here — the full first name is discarded
      // at the boundary, so it is never stored, cached or serialized. This is
      // the one source that has a first name at all: report_patient_items drops
      // it at ingest, so every other patient field in the portal is surname-only.
      out.set(id, { labels, patient: commInitialLastDisp(r?.PatientName) });
    }
    return out;
  }, 60_000);
}

// ── Striven sales-order TRACKING NUMBERS ─────────────────────────────────────
// A second saved report, one row per PI/VA sales order, carrying TrackingNumber
// and ShipVia. Like the labels report the URL holds a bearer token in its path,
// so it is configuration (Supabase app_config STRIVEN_TRACKING_URL), never
// committed source, and a comma/whitespace list is accepted so more reports can
// be added without a code change.
//
// WHY A REPORT WHEN /v1/sales-orders/{id} ALREADY RETURNS trackingNumber:
//   · ONE request instead of 520. The detail route is only reachable through the
//     `so_detail` cache, topped up on a 6h cycle, so a tracking number entered
//     in Striven took up to 6h to appear. This is read per request (60s memo).
//   · ShipVia. The detail endpoint returns it null on every order sampled;
//     the report has it filled on every tracked row (UPS 84, USPS 13, Fed Ex 26),
//     which replaces guessing the carrier from the number's format.
// Verified against the detail route on 2026-08-12: 123 tracked orders, 123
// agreements, zero contradictions.
//
// IT DOES NOT REPLACE `so_detail`. The report is scoped to PI + VA in Striven —
// 400 of 520 orders — so TriCare, DEMO and Contract orders appear in it not at
// all, and their tracking still comes from the cache. Report first, cache
// second; see getSO().
const TRACKING_URLS = async () => String(await cfgValue('STRIVEN_TRACKING_URL'))
  .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

// Striven's own ShipVia text → the carrier codes the tracking URLs are keyed by.
// Normalised to letters only, so "Fed Ex", "FedEx" and "FEDEX" are one carrier.
const SHIPVIA_CARRIER = {
  ups: 'ups', usps: 'usps', unitedstatespostalservice: 'usps',
  fedex: 'fedex', federalexpress: 'fedex', dhl: 'dhl_express', dhlexpress: 'dhl_express',
};
const carrierOfShipVia = (s) => SHIPVIA_CARRIER[String(s || '').toLowerCase().replace(/[^a-z]/g, '')] || null;

// ONE ORDER CAN CARRY SEVERAL PARCELS. Striven has no repeating field for that,
// so staff put both numbers in the one box: "1Z18H97F0306688623,
// 1Z18H97F0310776841". Treating that as a single number produced a value no
// carrier recognises and no format matches — which is exactly how it was found.
const splitTracking = (raw) => String(raw || '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);

/**
 * The parcels on one order: a number, and the carrier to track it with.
 *
 * ShipVia LEADS because it is what Striven records; the format detector is the
 * fallback for the orders (and any future report) that carry a number and no
 * carrier. Both can fail, and `carrier: null` is then the honest answer — the
 * number still shows, unlinked, rather than pointing at a guessed carrier.
 */
export function shipmentsOf(raw, shipVia) {
  const fromShipVia = carrierOfShipVia(shipVia);
  return splitTracking(raw).map((tn) => {
    const code = fromShipVia || detectCarrier(tn);
    return {
      tn,
      carrier: code
        ? { code, name: CARRIER_NAME[code] || code.toUpperCase(), url: (CARRIER_URL[code] || (() => ''))(tn) }
        : null,
    };
  });
}

/** soId → { tracking, shipVia } from the tracking report. Empty when unconfigured. */
async function soTrackingBySoId() {
  const urls = await TRACKING_URLS();
  if (!urls.length) return new Map();
  return cached('derived:so-tracking', async () => {
    const [pages, soBlob] = await Promise.all([
      Promise.all(urls.map((u) => fetchSavedReport(u))),
      sbCacheRead('so').then((b) => b?.data ?? []).catch(() => []),
    ]);
    const so = Array.isArray(soBlob) ? soBlob : [];
    // SalesOrderId is on this report and is the exact join, so unlike the labels
    // report there is no name-matching to get wrong. The Number → id map is kept
    // as a fallback for a report saved without that column.
    const idByNumber = new Map(
      so.filter((o) => o?.number != null).map((o) => [String(o.number).trim().toLowerCase(), String(o.id)]),
    );
    const out = new Map();
    for (const r of pages.flat()) {
      const id = r?.SalesOrderId != null
        ? String(r.SalesOrderId)
        : idByNumber.get(String(r?.Number ?? '').trim().toLowerCase());
      const tracking = String(r?.TrackingNumber ?? '').trim();
      // Rows with no tracking number are the majority and carry nothing this
      // map is for. Skipping them keeps "has an entry" meaning "is tracked".
      if (!id || !tracking) continue;
      out.set(id, {
        tracking,
        shipVia: String(r?.ShipVia ?? '').trim(),
        // The patient, reduced to an INITIAL + SURNAME at this boundary — the
        // full first name is never stored, cached or serialized, exactly as the
        // labels report is handled. Carried because this report names orders the
        // labels one does not, and a rep identifies an order by patient.
        patient: commInitialLastDisp(r?.PatientName),
      });
    }
    return out;
  }, 60_000);
}

/**
 * Fold a label SET into one stage.
 *
 * FURTHEST ALONG WINS: an order carrying "Waiting for first payment, Shipped"
 * has shipped AND is now awaiting payment, so it belongs in the later stage.
 * A label with no mapping contributes nothing; an order with no mapped label at
 * all stays in stage 1, which is where a sales order starts the moment it is
 * created.
 */
// A label maps to one stage or to SEVERAL. 'Delivered' is the case that needs
// several: delivery is both its own milestone and the event that puts the order
// into Lienstar and starts the wait for the first payment, so it attests to two
// stages at once. Everything downstream reads through here, so a plain string
// and a list behave identically.
const stagesOfLabel = (map, label) => {
  const v = map[String(label).trim().toLowerCase()];
  return v ? (Array.isArray(v) ? v : [v]) : [];
};

function stageFromLabels(labels, stages, map) {
  let best = 0;
  for (const l of labels || []) {
    for (const st of stagesOfLabel(map, l)) {
      const i = stages.indexOf(st);
      if (i > best) best = i;
    }
  }
  return stages[best];
}

/**
 * EVERY stage this order's labels attest to, in pipeline order.
 *
 * An order tagged "Shipped, Waiting for first payment" has genuinely shipped AND
 * is genuinely awaiting payment, so it belongs on BOTH boards' cards — reducing
 * it to the furthest one hides the shipment from whoever works the dispatch
 * stage. stageFromLabels() still names its CURRENT position (the last of these);
 * this is the full set.
 *
 * Only what the labels actually say. An order is NOT back-filled into earlier
 * stages it must logically have passed through — the labels are the evidence,
 * and inventing the rest would put orders in stages no one tagged them for.
 */
function stagesFromLabels(labels, stages, map) {
  const hit = new Set();
  for (const l of labels || []) for (const st of stagesOfLabel(map, l)) hit.add(st);
  return stages.filter((s) => hit.has(s));            // pipeline order, deduped
}

const STAGE_KEY = 'pi_stages';
// canonicalStage first: a stage that has been RENAMED is still the same stage,
// and the store holds whatever string was current when the order was moved.
const isPiStage = (s) => PI_STAGES.includes(canonicalStage(s));

async function readStageStore() {
  const hit = await sbCacheRead(STAGE_KEY).catch(() => null);
  const d = hit?.data;
  return d && typeof d === 'object' ? d : {};
}

/**
 * Move one order to a stage and record the transition.
 * @param {{soId:string, stage:string, user:string}} p
 */
export async function setPiStage({ soId, stage: requested, user }) {
  const id = String(soId ?? '').trim();
  if (!id) throw new Error('soId is required');
  if (!isPiStage(requested)) throw new Error(`unknown stage "${requested}" — expected one of: ${PI_STAGES.join(', ')}`);
  // Written under the CURRENT name, so a caller still sending an old one does
  // not seed the store with a string the next rename has to alias too.
  const stage = canonicalStage(requested);
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
 * THREE pipelines off one payload: PI, PIP and VA. One bucket per stage with
 * its orders, plus how long each has been sitting. Scoped like commission — a
 * rep sees only their own orders.
 *
 * The boards are separate because their stages are: a PIP order never reaches
 * Lienstar, and a VA order has neither an attorney nor a settlement. They share
 * this function because they share everything else — the ageing, the label
 * folding, the review queue and the redaction rules are one implementation, so
 * the three boards cannot drift apart.
 */
export async function getPiStages(viewer = null) {
  const isAdmin = viewer?.role === 'admin';
  const mine = viewer?.repName ? String(viewer.repName).trim().toLowerCase() : null;

  const [analytics, store, labelMap] = await Promise.all([
    getOrderAnalytics(viewer), readStageStore(), soLabelsBySoId(),
  ]);
  const now = Date.now();
  const daysSince = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null; };

  // PIP is a separate pipeline with its own stages: it never reaches Lienstar,
  // so 'LOP requested' and 'Waiting for settlement' cannot apply to it.
  //
  // The routing decision is the ORDER TYPE. That type does not exist in Striven
  // yet, so the LABEL is the fallback: a PIP-identifying label names the payer
  // as the auto insurer just as definitively as the type would. Without this
  // the board is empty and orders that are plainly PIP sit on the PI board
  // under 'Waiting for settlement' — a stage they can never reach.
  const pipLabels = new Set(PIP_IDENTIFYING_LABELS.map((l) => l.trim().toLowerCase()));
  // Exception labels: no stage on either board, straight to the review queue.
  const reviewSet = new Set(REVIEW_LABELS.map((l) => l.trim().toLowerCase()));
  const isPip = (o) => isPipType(o.type || '')
    || (labelMap.get(String(o.soId))?.labels || [])
      .some((l) => pipLabels.has(String(l).trim().toLowerCase()));
  // VA needs no label sniffing: it is already its own VERTICAL, so the order
  // type decides and nothing is inferred. Checked FIRST, so a VA order carrying
  // a stray PIP label is still read against the VA stages — the vertical is a
  // fact about the payer, the label is only ever evidence of one.
  const isVa = (o) => o.vertical === 'VA';
  const boardOf = (o) => (isVa(o) ? 'VA' : isPip(o) ? 'PIP' : 'PI');
  const stagesFor = (o) => (isVa(o) ? VA_STAGES : isPip(o) ? PIP_STAGES : PI_STAGES);
  const mapFor = (o) => (isVa(o) ? VA_LABEL_STAGE : isPip(o) ? PIP_LABEL_STAGE : PI_LABEL_STAGE);

  const build = (rows) => rows
    .map((o) => {
      const rec = store[o.soId];
      const mine = stagesFor(o);
      const tag = labelMap.get(String(o.soId));
      const labels = tag?.labels || [];
      // PRECEDENCE, most authoritative first:
      //   1. the Striven LABELS on the order — what staff actually tag
      //   2. the mirrored Stage custom field, where it is filled in
      //   3. the portal's own store, for orders Striven says nothing about
      //   4. stage 1, where every sales order starts
      const labelStages = labels.length ? stagesFromLabels(labels, mine, mapFor(o)) : [];
      const fromLabels = labels.length ? stageFromLabels(labels, mine, mapFor(o)) : '';
      // LABELS THAT CARRY NO STAGE, split by WHY — the two need different
      // action, so collapsing them into one list would hide which is which:
      //
      //   flagged — a known exception (HOLD, Attorney Denied, Case Dropped).
      //             The order has stopped rather than progressed. Expected, and
      //             the queue is a worklist of stalled cases to chase.
      //   unknown — a label nobody has mapped yet. This one is a defect: the
      //             label contributes nothing, so the order falls back to stage
      //             1 and reads as brand new, and it happens silently.
      const flagged = labels.filter((l) => reviewSet.has(l.trim().toLowerCase()));
      const unknown = labels.filter((l) => !reviewSet.has(l.trim().toLowerCase())
        && stagesOfLabel(mapFor(o), l).length === 0);
      // Both sources hold a free string written OUTSIDE this codebase — the
      // Striven custom field by staff, the store by whoever last moved the
      // order — so both are read through the rename map before being matched.
      // Without it a renamed stage stops matching and the order drops to stage
      // 1 with `source: 'default'`, which reads as "never tagged".
      const fieldStage = canonicalStage(o.strivenStage);
      const storeStage = canonicalStage(rec?.stage);
      const fromField = mine.includes(fieldStage) ? fieldStage : '';
      const fromStore = mine.includes(storeStage) ? storeStage : '';
      const stage = fromLabels || fromField || fromStore || mine[0];
      const src = fromLabels ? 'labels' : fromField ? 'striven' : fromStore ? 'portal' : 'default';
      // WHERE THIS ORDER IS VISIBLE. `stage` is its current position — one
      // stage, the furthest its labels reach. `stages` is every stage its
      // labels attest to, so an order tagged "Shipped, Waiting for first
      // payment" appears on the dispatch card as well as the payment one.
      // Anything not label-driven has exactly one stage, so this collapses to
      // the old behaviour for those rows.
      const shownIn = labelStages.length ? labelStages : [stage];
      // Real ageing only once the PORTAL moved it; a label carries no timestamp,
      // so those orders age from the order date and stay flagged estimated.
      const tracked = src === 'portal' && Boolean(rec?.since);
      const since = tracked ? rec.since : o.date;
      return {
        ...o,
        stage,
        stages: shownIn,                        // every stage it is listed under
        labels,                                 // the exact Striven tags, for the drill
        unknown,                                // labels no map recognises — a defect
        flagged,                                // known exceptions — a stalled case
        // FIRST INITIAL + SURNAME, never a full first name.
        //
        // The LABELS REPORT LEADS, which is a reversal: it is the only source
        // that carries a first name, so taking analytics first would silently
        // throw the initial away and every row would read "Felix" again.
        // Analytics still backs it up — report_patient_items is surname-only,
        // but it covers orders the labels report has not picked up, and a
        // surname beats a blank. A rep identifies an order by patient, not by
        // "SO-476".
        patient: tag?.patient || o.patient || '',
        pipeline: boardOf(o),
        stageSince: since,
        daysInStage: daysSince(since),
        estimated: !tracked,                    // ageing is a fallback, not measured
        source: src,
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

  // Three boards off one filtered set. `orders` stays the PI board so every
  // existing caller keeps working; `pipOrders`/`pipStages` and `vaOrders`/
  // `vaStages` are additive.
  //
  // PI and PIP split one vertical between them; VA is a vertical of its own, so
  // the three books are disjoint by construction and no order can be counted
  // twice across them.
  const piBook = analytics.orders.filter((o) => o.vertical === 'PI' && !isPip(o));
  const pipBook = analytics.orders.filter((o) => o.vertical === 'PI' && isPip(o));
  const vaBook = analytics.orders.filter((o) => o.vertical === 'VA');
  const orders = build(piBook);
  const pipOrders = build(pipBook);
  const vaOrders = build(vaBook);

  // TWO COUNTS PER STAGE, and they measure different things:
  //
  //   count   — every order LISTED here, i.e. whose labels attest to this stage.
  //             An order tagged "Shipped, Waiting for first payment" is counted
  //             at both. These OVERLAP: they do not sum to the board total, and
  //             `revenue`/`units` overlap with them, so stage revenue must never
  //             be added up to reconstruct the book.
  //   current — orders whose CURRENT position is this stage (the furthest their
  //             labels reach). Every order has exactly one, so these DO sum to
  //             the board total — which is what the flow bar needs to stay at
  //             100%.
  const roll = (rows, names) => names.map((stage) => {
    const set = rows.filter((o) => (o.stages || [o.stage]).includes(stage));
    const aged = set.map((o) => o.daysInStage ?? 0);
    return {
      stage,
      count: set.length,
      current: rows.filter((o) => o.stage === stage).length,
      revenue: round2(set.reduce((s, o) => s + o.revenue, 0)),
      units: set.reduce((s, o) => s + o.units, 0),
      oldestDays: aged.length ? Math.max(...aged) : 0,
      avgDays: aged.length ? Math.round(aged.reduce((s, n) => s + n, 0) / aged.length) : 0,
    };
  });
  const stages = roll(orders, PI_STAGES);
  const pipStages = roll(pipOrders, PIP_STAGES);
  const vaStages = roll(vaOrders, VA_STAGES);

  // ── REVIEW: labels nobody has mapped yet ────────────────────────────────────
  // Striven's label vocabulary is edited by staff, not by this codebase, so a
  // new label can appear at any time. Until it is mapped it contributes nothing
  // and its order quietly falls back to stage 1 — indistinguishable from a
  // genuinely new order. This is the queue that makes that visible, so the
  // taxonomy can be corrected rather than silently drifting.
  //
  // ADMIN ONLY. Deciding what a new label means, and fixing it in Striven, is
  // Crystal's call; a rep can neither act on it nor should be reading the whole
  // book to find it. For a rep this is always an empty list — the same
  // redaction rule the rest of this payload follows.
  const reviewOrders = isAdmin
    ? [...orders, ...pipOrders, ...vaOrders]
      .filter((o) => o.unknown.length > 0 || o.flagged.length > 0)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    : [];
  // The distinct labels behind that queue, commonest first. The action is per
  // LABEL — map an unknown one once, or work through a flagged one's orders —
  // so this is the worklist and the orders below are its evidence.
  const reviewLabels = (() => {
    const m = new Map();
    const add = (label, reason, board) => {
      const k = label.trim().toLowerCase();
      const e = m.get(k) || { label, reason, count: 0, boards: new Set() };
      e.count += 1;
      e.boards.add(board);
      m.set(k, e);
    };
    for (const o of reviewOrders) {
      for (const l of o.flagged) add(l, 'flagged', o.pipeline);
      for (const l of o.unknown) add(l, 'unknown', o.pipeline);
    }
    return [...m.values()]
      .map((e) => ({ label: e.label, reason: e.reason, count: e.count, boards: [...e.boards].sort() }))
      // Unknown labels first: those are a defect and need mapping, whereas a
      // flagged one is working as intended and is just a case to chase.
      .sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'unknown' ? -1 : 1)
        || b.count - a.count || a.label.localeCompare(b.label));
  })();

  return {
    ok: true,
    scopedToRep: isAdmin ? null : (viewer?.repName ?? null),
    canEdit: isAdmin || Boolean(mine),
    stageNames: PI_STAGES,
    stages,
    orders,
    // PIP: its own stage list and its own board. Empty until the PIP order type
    // exists in Striven, so the UI can render it unconditionally.
    pipStageNames: PIP_STAGES,
    pipStages,
    pipOrders,
    // VA: its own board, off the VA vertical. Populated as soon as a VA labels
    // report is listed in STRIVEN_LABELS_URL; before that every VA order sits in
    // stage 1, which is the honest reading of "no label says otherwise".
    vaStageNames: VA_STAGES,
    vaStages,
    vaOrders,
    // Orders carrying a label this codebase does not recognise, and the distinct
    // labels behind them. Admin-only; empty for a rep.
    reviewOrders,
    reviewLabels,
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
  '/api/ap-ledger': getApLedger,
  // Carries patient initials + surnames. Admin-only by construction: the gate in
  // index.js is an allow-list, so this is closed to reps unless someone opens it
  // deliberately. Do not add it to OPEN_TO_REPS.
  '/api/ar-register': getArRegister,
  '/api/commission-recon': getCommissionRecon,
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
