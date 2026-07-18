// Vercel serverless function — handles every /api/* request in production.
// The Striven credentials live in Vercel Environment Variables (server-side);
// they are read only here, never sent to the browser. The frontend just calls
// same-origin /api/* and gets back shaped, PHI-masked JSON.
import { ROUTES, DYNAMIC, getAuth, login, verifySession, logPhiAccess, refreshAll, refreshTokenOk, autoPoTokenOk, autoPoRun } from './_striven.js';
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
    const sessionOk = !gateEnabled || Boolean(verifySession(cookieVal(req.headers.cookie, 'smr_session')));
    if (!keyOk && !sessionOk) return res.status(401).json({ error: 'auth required' });
    try {
      return res.status(200).json(await autoPoRun({
        so: url.searchParams.get('so') || undefined,
        mode: url.searchParams.get('mode') || undefined,
        action: url.searchParams.get('action') || undefined,
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---- access gate (only when a password / users are configured) ----
  if (gateEnabled) {
    if (pathname === '/api/login' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const r = await login(body?.username, body?.password, { ip: clientIp });
      if (r.ok) {
        res.setHeader('Set-Cookie', [
          `smr_session=${r.session}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`,
          `smr_user=${encodeURIComponent(r.user)}; Path=/; SameSite=Lax; Max-Age=43200`,
        ]);
        return res.status(200).json({ ok: true });
      }
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (pathname === '/api/logout') {
      res.setHeader('Set-Cookie', [
        'smr_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
        'smr_user=; Path=/; SameSite=Lax; Max-Age=0',
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
