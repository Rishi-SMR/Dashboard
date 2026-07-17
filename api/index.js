// TEMPORARY DIAGNOSTIC — captures import/runtime errors that Vercel otherwise
// hides behind FUNCTION_INVOCATION_FAILED. Restored to the real handler after use.
export default async function handler(req, res) {
  const out = { node: process.version, cwd: (() => { try { return process.cwd(); } catch { return '?'; } })() };
  try {
    const s = await import('./_striven.js');
    out.striven = { loaded: true, exports: Object.keys(s).length, hasStriven: typeof s.striven };
  } catch (e) {
    out.striven = { loaded: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 10) };
    return res.status(200).json(out);
  }
  try {
    const q = await import('./_qb.js');
    out.qb = { loaded: true, exports: Object.keys(q).length, hasHandle: typeof q.qbHandle };
  } catch (e) {
    out.qb = { loaded: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 10) };
    return res.status(200).json(out);
  }
  try {
    const s = await import('./_striven.js');
    const auth = await s.getAuth();
    out.getAuth = { ok: true, gateEnabled: auth.gateEnabled };
  } catch (e) {
    out.getAuth = { ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 10) };
  }
  return res.status(200).json(out);
}
