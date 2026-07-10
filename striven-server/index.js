// SMR ⇄ Striven — LOCAL dev server.
// Thin HTTP wrapper around the shared logic in ../api/_striven.js (the exact
// same code that runs as the Vercel serverless function in production, so the
// two never drift). Credentials load from striven-server/.env. Run: `npm start`.
import http from 'node:http';
import { ROUTES, DYNAMIC, ACCESS_PASSWORD, SESSION_TOKEN } from '../api/_striven.js';

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
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  if (ACCESS_PASSWORD) {
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.password === ACCESS_PASSWORD) {
        res.setHeader('Set-Cookie', `smr_session=${SESSION_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Incorrect password' }));
    }
    if (pathname !== '/api/health' && cookieVal(req.headers.cookie, 'smr_session') !== SESSION_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth required' }));
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
