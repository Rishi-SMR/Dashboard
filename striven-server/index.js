// SMR ⇄ Striven — LOCAL dev server.
// Thin HTTP wrapper around the shared logic in ../api/_striven.js (the exact
// same code that runs as the Vercel serverless function in production, so the
// two never drift). Credentials load from striven-server/.env. Run: `npm start`.
import http from 'node:http';
import { ROUTES, DYNAMIC, getAuth, login, verifySession, logPhiAccess, refreshAll, getCacheHealth, refreshTokenOk, autoPoTokenOk, autoPoRun, autoSoTokenOk, autoSoRun, trackingRun, getMe, getCommission, getCommissionFor, viewerFor, getOrderAnalytics, getDeviceMix, getPiStages, setPiStage, getRepOverview, getSODetailFor, listDashboardViews, saveDashboardView, deleteDashboardView } from '../api/_striven.js';
import { qbHandle } from '../api/_qb.js';

const PORT = Number(process.env.PORT || 4747);
const cookieVal = (header, name) => {
  const m = (header || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/api/refresh') {
    if (!refreshTokenOk(reqUrl.searchParams.get('token') || req.headers['x-refresh-token'])) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad token' }));
    }
    try { const refreshed = await refreshAll(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, refreshed })); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  const { gateEnabled } = await getAuth();
  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  let currentUser = null;

  // Auto-PO (SO placed → PO raised) — cron token OR a logged-in session (UI).
  if (pathname === '/api/auto-po') {
    const keyOk = autoPoTokenOk(reqUrl.searchParams.get('key') || req.headers['x-auto-po-key']);
    const sessionOk = Boolean(verifySession(cookieVal(req.headers.cookie, 'smr_session')));
    if (!keyOk && !sessionOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
    }
    try {
      const out = await autoPoRun({
        so: reqUrl.searchParams.get('so') || undefined,
        mode: reqUrl.searchParams.get('mode') || undefined,
        action: reqUrl.searchParams.get('action') || undefined,
        po: reqUrl.searchParams.get('po') || undefined,
        to: reqUrl.searchParams.get('to') || undefined,
        subject: reqUrl.searchParams.get('subject') || undefined,
        body: reqUrl.searchParams.get('body') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Auto-SO (recurring resupply → SO created) — cron token OR a logged-in session.
  if (pathname === '/api/auto-so') {
    const keyOk = autoSoTokenOk(reqUrl.searchParams.get('key') || req.headers['x-auto-so-key']);
    const sessionOk = Boolean(verifySession(cookieVal(req.headers.cookie, 'smr_session')));
    if (!keyOk && !sessionOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
    }
    try {
      const out = await autoSoRun({
        so: reqUrl.searchParams.get('so') || undefined,
        mode: reqUrl.searchParams.get('mode') || undefined,
        action: reqUrl.searchParams.get('action') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Shipment tracking (last name / ship-to → live carrier status via Shippo) — session only.
  if (pathname === '/api/tracking') {
    if (!verifySession(cookieVal(req.headers.cookie, 'smr_session'))) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await trackingRun({ action: reqUrl.searchParams.get('action') || undefined, id: reqUrl.searchParams.get('id') || undefined }, body);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // QuickBooks OAuth callback (registered redirect /auth/callback) — before the gate.
  if (pathname === '/auth/callback' || pathname === '/api/qb/callback') {
    try {
      const out = await qbHandle('/api/qb/callback', Object.fromEntries(reqUrl.searchParams), req.method);
      if (out?.redirect) { res.writeHead(302, { Location: out.redirect }); return res.end(); }
      if (out) { res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out.json)); }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (gateEnabled) {
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await login(body.username, body.password, { ip: clientIp });
      // Mark the cookies Secure whenever the request arrived over HTTPS (a
      // tunnel/proxy in front of this dev server); plain http://localhost would
      // silently drop a Secure cookie, so it is conditional here — the Vercel
      // handler, which is always HTTPS, sets it unconditionally.
      const sec = String(req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
      if (r.ok) {
        // SameSite=Strict matches production; smr_user stays display-only and is
        // never trusted as identity (authorization reads smr_session).
        res.setHeader('Set-Cookie', [
          `smr_session=${r.session}; HttpOnly;${sec} Path=/; SameSite=Strict; Max-Age=43200`,
          `smr_user=${encodeURIComponent(r.user)};${sec} Path=/; SameSite=Strict; Max-Age=43200`,
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
      }
      if (r.locked) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Too many failed attempts. Try again in 15 minutes.' })); }
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid username or password' }));
    }
    if (pathname === '/api/logout') {
      const sec = String(req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
      res.setHeader('Set-Cookie', [
        `smr_session=; HttpOnly;${sec} Path=/; SameSite=Strict; Max-Age=0`,
        `smr_user=;${sec} Path=/; SameSite=Strict; Max-Age=0`,
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname !== '/api/health') {
      const sess = verifySession(cookieVal(req.headers.cookie, 'smr_session'));
      if (!sess) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' })); }
      currentUser = sess.user;
      logPhiAccess(sess.user, pathname, clientIp);   // HIPAA audit trail
    }
  }

  // Who am I — resolved from the VERIFIED session, never from a cookie the
  // browser could set. Drives role + own-row scoping in the UI.
  if (pathname === '/api/me') {
    const me = await getMe({ user: currentUser });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(me || { email: null, repName: null, role: 'rep' }));
  }

  // Saved dashboard views — per signed-in user.
  if (pathname === '/api/views') {
    try {
      let out;
      if (req.method === 'POST') {
        const body = await readBody(req);
        out = body?.delete
          ? await deleteDashboardView(currentUser, body.delete)
          : await saveDashboardView(currentUser, body);
      } else out = await listDashboardViews(currentUser);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Cache freshness. Admin-only: it exposes nothing about any rep, but it is
  // operational plumbing and reps have no use for it.
  if (pathname === '/api/cache-health') {
    try {
      const me = await getMe({ user: currentUser });
      if (me?.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'admin only' })); }
      const out = await getCacheHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Rep overview — the team from the reps' side, redacted per caller.
  if (pathname === '/api/rep-overview') {
    try {
      const out = await getRepOverview(viewerFor(await getMe({ user: currentUser }), reqUrl.searchParams.get('as')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // PI stage pipeline — GET reads the buckets, POST moves one order.
  if (pathname === '/api/pi-stages') {
    try {
      const me = await getMe({ user: currentUser });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const out = await setPiStage({ soId: body.soId, stage: body.stage, user: currentUser });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      const out = await getPiStages(viewerFor(me, reqUrl.searchParams.get('as')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Order analytics — identity-scoped like commission.
  // SALES-ORDER DETAIL, scoped to the caller — the order reference is a link on
  // the rep boards, so this must answer per-viewer. Explicit here rather than in
  // DYNAMIC below, because that table's handlers receive only the URL match and
  // have no way to see who is asking. See getSODetailFor.
  {
    const m = pathname.match(/^\/api\/so\/(\d+)$/);
    if (m) {
      try {
        const out = await getSODetailFor(m[1], viewerFor(await getMe({ user: currentUser }), reqUrl.searchParams.get('as')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      } catch (e) {
        const code = e.status || 500;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
  }

  if (pathname === '/api/order-analytics') {
    try {
      const out = await getOrderAnalytics(viewerFor(await getMe({ user: currentUser }), reqUrl.searchParams.get('as')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Units by device — admin only, and the gate is inside getDeviceMix so the
  // route cannot forget it. Identity-scoped like the two above.
  if (pathname === '/api/device-mix') {
    try {
      const out = await getDeviceMix(viewerFor(await getMe({ user: currentUser }), reqUrl.searchParams.get('as')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Commission — identity-scoped. Handled here rather than via ROUTES because
  // the redaction needs the caller, and ROUTES handlers take no arguments.
  if (pathname === '/api/commission') {
    try {
      // ?fresh=1 re-reads the reconciliation sheet — see getCommissionFor().
      const out = await getCommissionFor(
        viewerFor(await getMe({ user: currentUser }), reqUrl.searchParams.get('as')),
        { fresh: reqUrl.searchParams.get('fresh') === '1' },
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // QuickBooks Online (OAuth + posting) — behind the session gate.
  if (pathname.startsWith('/api/qb/')) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await qbHandle(pathname, Object.fromEntries(reqUrl.searchParams), req.method, body);
      if (out?.redirect) { res.writeHead(302, { Location: out.redirect }); return res.end(); }
      if (out) { res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out.json)); }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ---- company data is admin-only ------------------------------------------
  // THIS GATE WAS MISSING HERE. api/index.js has carried it for the serverless
  // deployment since the roles landed, but this dev/self-host server dispatched
  // straight into ROUTES, so a signed-in REP could read /api/pl, /api/ar,
  // /api/ap-ledger, /api/vendors — the whole company book — simply by asking
  // for the URL. Every one of them returned 200. None of these handlers takes a
  // viewer, so none of them redacts; hiding the tab in the sidebar never stopped
  // a fetch. The two servers must not disagree about who may read what.
  //
  // Deliberately the SAME allow-list, kept verbatim so the pair can be diffed:
  // a route added later is admin-only until someone opens it on purpose. The
  // rep-scoped endpoints (/api/commission, /api/reps/*, /api/pi-stages,
  // /api/order-analytics, /api/device-mix) all return above this point and
  // already narrow their own payload to the caller.
  const OPEN_TO_REPS = new Set(['/api/health', '/api/status']);
  if (!OPEN_TO_REPS.has(pathname)) {
    const me = await getMe({ user: currentUser });
    if (me?.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'admin only' })); }
  }

  let fn = ROUTES[pathname];
  if (!fn) {
    for (const d of DYNAMIC) { const m = pathname.match(d.re); if (m) { fn = () => d.handler(m); break; } }
  }
  if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
  try {
    const data = await fn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error(`[${pathname}]`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

/**
 * WARM THE DERIVED CACHES ON BOOT, so the first person to sign in is not the one
 * who pays for building them.
 *
 * With stale-while-revalidate in `cached()`, a key that HAS a copy never blocks
 * anyone — but a key with no copy at all still does, and after a restart that is
 * every key. That first dashboard load measured ~5.9s while it pulled four
 * Google Sheets and two Striven reports; every load after it was ~0.2s. Doing
 * that work at boot moves the wait to a moment when nobody is watching.
 *
 * These two calls are the whole dependency graph the dashboard needs:
 * getOrderAnalytics fills `derived:so` and `derived:analytics:admin`,
 * getCommissionFor fills `derived:commission:raw` and the workbook/recon caches
 * under it. Everything the rep and admin boards render is downstream of them.
 *
 * DELIBERATELY NOT AWAITED and deliberately silent. The server must accept
 * connections immediately — warming is an optimisation, not a startup
 * dependency — and a warm-up that cannot reach Sheets or Striven must not print
 * a scary error or, worse, stop the server booting. A failed warm just means the
 * first request builds the cache the old way, which is exactly today's
 * behaviour.
 */
function warmCaches() {
  const ADMIN = { repName: null, role: 'admin' };
  const t0 = Date.now();
  Promise.allSettled([getOrderAnalytics(ADMIN), getCommissionFor(ADMIN)])
    .then((r) => {
      const failed = r.filter((x) => x.status === 'rejected').length;
      console.log(`  caches warm in ${Date.now() - t0}ms${failed ? ` (${failed} of ${r.length} unavailable — first request will build them)` : ''}`);
    })
    .catch(() => { /* warming can never be fatal */ });
}

server.listen(PORT, () => {
  console.log(`SMR ⇄ Striven local server on http://localhost:${PORT}`);
  warmCaches();
});
