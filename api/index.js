// Vercel serverless function — handles every /api/* request in production.
// The Striven credentials live in Vercel Environment Variables (server-side);
// they are read only here, never sent to the browser. The frontend just calls
// same-origin /api/* and gets back shaped, PHI-masked JSON.
import { ROUTES, DYNAMIC, getAuth, login, verifySession, logPhiAccess, refreshAll, getCacheHealth, refreshTokenOk, autoPoTokenOk, autoPoRun, autoSoTokenOk, autoSoRun, trackingRun, getMe, getCommission, getCommissionFor, viewerFor, getOrderAnalytics, getDeviceMix, getPiStages, setPiStage, getRepOverview, getSODetailFor, listDashboardViews, saveDashboardView, deleteDashboardView } from './_striven.js';
import { qbHandle } from './_qb.js';

const cookieVal = (header, name) => {
  const m = (header || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname; // e.g. /api/ar

  // ---- out-of-band cache refresh (pg_cron every 6h) — token-guarded, no cookie ----
  if (pathname === '/api/refresh') {
    if (!refreshTokenOk(url.searchParams.get('token') || req.headers['x-refresh-token'])) {
      return res.status(401).json({ error: 'bad token' });
    }
    try { return res.status(200).json({ ok: true, refreshed: await refreshAll() }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const { gateEnabled } = await getAuth();
  const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let currentUser = null;

  // ---- QuickBooks OAuth callback — Intuit redirects here after authorize.
  // The registered redirect is /auth/callback (also accept /api/qb/callback).
  // Handled BEFORE the gate: the OAuth `state` param is the CSRF guard. ----
  if (pathname === '/auth/callback' || pathname === '/api/qb/callback') {
    try {
      const out = await qbHandle('/api/qb/callback', Object.fromEntries(url.searchParams), req.method);
      if (out?.redirect) { res.statusCode = 302; res.setHeader('Location', out.redirect); return res.end(); }
      if (out) return res.status(out.status ?? 200).json(out.json);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- auto-PO (SO placed → PO raised) — cron token OR a logged-in session ----
  if (pathname === '/api/auto-po') {
    const keyOk = autoPoTokenOk(url.searchParams.get('key') || req.headers['x-auto-po-key']);
    const sessionOk = Boolean(verifySession(cookieVal(req.headers.cookie, 'smr_session')));
    if (!keyOk && !sessionOk) return res.status(401).json({ error: 'auth required' });
    try {
      return res.status(200).json(await autoPoRun({
        so: url.searchParams.get('so') || undefined,
        mode: url.searchParams.get('mode') || undefined,
        action: url.searchParams.get('action') || undefined,
        po: url.searchParams.get('po') || undefined,
        to: url.searchParams.get('to') || undefined,
        subject: url.searchParams.get('subject') || undefined,
        body: url.searchParams.get('body') || undefined,
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (pathname === '/api/auto-so') {
    const keyOk = autoSoTokenOk(url.searchParams.get('key') || req.headers['x-auto-so-key']);
    const sessionOk = Boolean(verifySession(cookieVal(req.headers.cookie, 'smr_session')));
    if (!keyOk && !sessionOk) return res.status(401).json({ error: 'auth required' });
    try {
      return res.status(200).json(await autoSoRun({
        so: url.searchParams.get('so') || undefined,
        mode: url.searchParams.get('mode') || undefined,
        action: url.searchParams.get('action') || undefined,
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (pathname === '/api/tracking') {
    if (!verifySession(cookieVal(req.headers.cookie, 'smr_session'))) return res.status(401).json({ error: 'auth required' });
    try {
      const body = req.method === 'POST' ? req.body : null;
      return res.status(200).json(await trackingRun({ action: url.searchParams.get('action') || undefined, id: url.searchParams.get('id') || undefined }, body));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- access gate — always on: every route below serves patient-derived data ----
  if (gateEnabled) {
    if (pathname === '/api/login' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const r = await login(body?.username, body?.password, { ip: clientIp });
      if (r.ok) {
        // Secure: production is HTTPS-only, so the session must never travel in
        // clear. SameSite=Strict: no cross-site request may carry the session.
        // smr_user is DISPLAY ONLY and is never trusted as identity — every
        // authorization decision reads the signed smr_session instead.
        res.setHeader('Set-Cookie', [
          `smr_session=${r.session}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=43200`,
          `smr_user=${encodeURIComponent(r.user)}; Secure; Path=/; SameSite=Strict; Max-Age=43200`,
        ]);
        return res.status(200).json({ ok: true });
      }
      if (r.locked) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (pathname === '/api/logout') {
      res.setHeader('Set-Cookie', [
        'smr_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0',
        'smr_user=; Secure; Path=/; SameSite=Strict; Max-Age=0',
      ]);
      return res.status(200).json({ ok: true });
    }
    if (pathname !== '/api/health') {
      const sess = verifySession(cookieVal(req.headers.cookie, 'smr_session'));
      if (!sess) return res.status(401).json({ error: 'auth required' });
      currentUser = sess.user;
      // HIPAA audit: record every authenticated read of patient-derived data.
      logPhiAccess(currentUser, pathname, clientIp);
    }
  }

  // ---- who am I — resolved from the VERIFIED session, never from a cookie the
  // browser could set. Drives role + own-row scoping in the UI. ----
  if (pathname === '/api/me') {
    const me = await getMe({ user: currentUser });
    return res.status(200).json(me || { email: null, repName: null, role: 'rep' });
  }

  // ---- commission — identity-scoped. Handled here rather than via ROUTES
  // because the redaction needs the caller, and ROUTES handlers take no args. ----
  if (pathname === '/api/commission') {
    try {
      // ?fresh=1 re-reads the reconciliation sheet — see getCommissionFor().
      return res.status(200).json(await getCommissionFor(
        viewerFor(await getMe({ user: currentUser }), url.searchParams.get('as')),
        { fresh: url.searchParams.get('fresh') === '1' },
      ));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- saved dashboard views — per signed-in user ----
  if (pathname === '/api/views') {
    try {
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        return res.status(200).json(body?.delete
          ? await deleteDashboardView(currentUser, body.delete)
          : await saveDashboardView(currentUser, body));
      }
      return res.status(200).json(await listDashboardViews(currentUser));
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }

  // ---- cache freshness — admin only, operational plumbing ----
  if (pathname === '/api/cache-health') {
    try {
      const me = await getMe({ user: currentUser });
      if (me?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
      return res.status(200).json(await getCacheHealth());
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- rep overview — the team from the reps' side, redacted per caller ----
  if (pathname === '/api/rep-overview') {
    try {
      return res.status(200).json(await getRepOverview(viewerFor(await getMe({ user: currentUser }), url.searchParams.get('as'))));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- PI stage pipeline — GET reads the buckets, POST moves one order ----
  if (pathname === '/api/pi-stages') {
    try {
      const me = await getMe({ user: currentUser });
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        return res.status(200).json(await setPiStage({ soId: body?.soId, stage: body?.stage, user: currentUser }));
      }
      return res.status(200).json(await getPiStages(viewerFor(me, url.searchParams.get('as'))));
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }

  // ---- order analytics — identity-scoped like commission ----
  // SALES-ORDER DETAIL, scoped to the caller — the order reference is a link on
  // the rep boards, so this must answer per-viewer. Explicit here rather than in
  // DYNAMIC below, because that table's handlers receive only the URL match and
  // have no way to see who is asking. See getSODetailFor.
  {
    const m = pathname.match(/^\/api\/so\/(\d+)$/);
    if (m) {
      try {
        // `url`, NOT `reqUrl`. This block was copied from striven-server/index.js,
        // where the parsed URL is called `reqUrl`; here it is `url` (line 14).
        // Nothing caught it — the identifier only evaluates when someone opens a
        // sales order, so the route threw ReferenceError in PRODUCTION ONLY while
        // the dev server, which has a `reqUrl`, served the same request happily.
        // That is why the drill read "Could not load · reqUrl is not defined".
        const out = await getSODetailFor(m[1], viewerFor(await getMe({ user: currentUser }), url.searchParams.get('as')));
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
      return res.status(200).json(await getOrderAnalytics(viewerFor(await getMe({ user: currentUser }), url.searchParams.get('as'))));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- units by device — admin only, and the gate is inside getDeviceMix ----
  // Handled HERE, above the admin allow-list, for the same reason commission and
  // order-analytics are: getDeviceMix already narrows its own payload to the
  // caller (a rep gets `devices: []`, never a 403), so routing it through the
  // blanket gate below would answer a rep differently to the dev server.
  if (pathname === '/api/device-mix') {
    try {
      return res.status(200).json(await getDeviceMix(viewerFor(await getMe({ user: currentUser }), url.searchParams.get('as'))));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- QuickBooks Online (OAuth + posting) — behind the session gate ----
  if (pathname.startsWith('/api/qb/')) {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const out = await qbHandle(pathname, Object.fromEntries(url.searchParams), req.method, body);
      if (out?.redirect) { res.statusCode = 302; res.setHeader('Location', out.redirect); return res.end(); }
      if (out) return res.status(out.status ?? 200).json(out.json);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- company data is admin-only ------------------------------------------
  // Everything reached below this point is COMPANY-wide: AR/AP, P&L, the full
  // order book, vendors, payments. None of those handlers takes a viewer, so
  // none of them redacts — which means a rep session could simply request
  // /api/pl and read the company's books. Hiding the tab in the sidebar does
  // not stop a fetch, so the gate has to live here.
  //
  // Allow-list, not a block-list: a route added later is admin-only until
  // someone deliberately opens it. The rep-scoped endpoints (/api/commission,
  // /api/reps/*, /api/pi-stages, /api/order-analytics, /api/device-mix) never
  // get here — they are handled above and already narrow their payload to the
  // caller.
  const OPEN_TO_REPS = new Set(['/api/health', '/api/status']);
  if (!OPEN_TO_REPS.has(pathname)) {
    const me = await getMe({ user: currentUser });
    if (me?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  }

  let fn = ROUTES[pathname];
  if (!fn) {
    for (const d of DYNAMIC) {
      const m = pathname.match(d.re);
      if (m) { fn = () => d.handler(m); break; }
    }
  }
  if (!fn) return res.status(404).json({ error: 'not found' });
  try {
    return res.status(200).json(await fn());
  } catch (err) {
    console.error(`[${pathname}]`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
