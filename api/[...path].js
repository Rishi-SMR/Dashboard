// Vercel serverless function — handles every /api/* request in production.
// The Striven credentials live in Vercel Environment Variables (server-side);
// they are read only here, never sent to the browser. The frontend just calls
// same-origin /api/* and gets back shaped, PHI-masked JSON.
import { ROUTES, DYNAMIC, getAuth } from './_striven.js';

const cookieVal = (header, name) => {
  const m = (header || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname; // e.g. /api/ar
  const { ACCESS_PASSWORD, SESSION_TOKEN } = await getAuth();

  // ---- access gate (only when ACCESS_PASSWORD is configured) ----
  if (ACCESS_PASSWORD) {
    if (pathname === '/api/login' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      if (body && body.password === ACCESS_PASSWORD) {
        res.setHeader('Set-Cookie', `smr_session=${SESSION_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        return res.status(200).json({ ok: true });
      }
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (pathname !== '/api/health' && cookieVal(req.headers.cookie, 'smr_session') !== SESSION_TOKEN) {
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
