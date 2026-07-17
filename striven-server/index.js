// SMR ⇄ Striven — LOCAL dev server.
// Thin HTTP wrapper around the shared logic in ../api/_striven.js (the exact
// same code that runs as the Vercel serverless function in production, so the
// two never drift). Credentials load from striven-server/.env. Run: `npm start`.
import http from 'node:http';
import { ROUTES, DYNAMIC, getAuth, login, refreshAll, refreshTokenOk, autoPoTokenOk, autoPoRun } from '../api/_striven.js';
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

  const { gateEnabled, sessionToken } = await getAuth();

  // Auto-PO (SO placed → PO raised) — cron token OR a logged-in session (UI).
  if (pathname === '/api/auto-po') {
    const keyOk = autoPoTokenOk(reqUrl.searchParams.get('key') || req.headers['x-auto-po-key']);
    const sessionOk = !gateEnabled || cookieVal(req.headers.cookie, 'smr_session') === sessionToken;
    if (!keyOk && !sessionOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
    }
    try {
      const out = await autoPoRun({
        so: reqUrl.searchParams.get('so') || undefined,
        mode: reqUrl.searchParams.get('mode') || undefined,
        action: reqUrl.searchParams.get('action') || undefined,
      });
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
      const r = await login(body.username, body.password, { ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() });
      if (r.ok) {
        res.setHeader('Set-Cookie', [
          `smr_session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
          `smr_user=${encodeURIComponent(String(body.username ?? '').trim())}; Path=/; SameSite=Lax; Max-Age=86400`,
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid username or password' }));
    }
    if (pathname === '/api/logout') {
      res.setHeader('Set-Cookie', [
        'smr_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
        'smr_user=; Path=/; SameSite=Lax; Max-Age=0',
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname !== '/api/health' && cookieVal(req.headers.cookie, 'smr_session') !== sessionToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
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

server.listen(PORT, () => console.log(`SMR ⇄ Striven local server on http://localhost:${PORT}`));
