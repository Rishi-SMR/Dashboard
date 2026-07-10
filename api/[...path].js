// Vercel serverless function — handles every /api/* request in production.
// The Striven credentials live in Vercel Environment Variables (server-side);
// they are read only here, never sent to the browser. The frontend just calls
// same-origin /api/* and gets back shaped, PHI-masked JSON.
import { ROUTES, DYNAMIC, getAuth, login } from './_striven.js';

const cookieVal = (header, name) => {
  const m = (header || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname; // e.g. /api/ar
  const { gateEnabled, sessionToken } = await getAuth();

  // ---- access gate (only when a password / users are configured) ----
  if (gateEnabled) {
    if (pathname === '/api/login' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const r = await login(body?.username, body?.password);
      if (r.ok) {
        res.setHeader('Set-Cookie', `smr_session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        return res.status(200).json({ ok: true });
      }
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (pathname === '/api/logout') {
      res.setHeader('Set-Cookie', 'smr_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
      return res.status(200).json({ ok: true });
    }
    if (pathname !== '/api/health' && cookieVal(req.headers.cookie, 'smr_session') !== sessionToken) {
      return res.status(401).json({ error: 'auth required' });
    }
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
