// Build the SO -> PO / Invoice chain (order-to-cash), keyed by order number, NO
// patient data. PO line items carry order.id (the SO) and invoices carry order.id,
// so we link everything to the sales order. Writes Supabase striven_cache 'order_chain'.
// Run: node scripts/gen-order-chain.mjs
import fs from 'node:fs';
const env = fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8');
const g = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const BASE = 'https://api.striven.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SB = g('SUPABASE_URL'), SK = g('SUPABASE_SERVICE_KEY');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tk = await (await fetch(`${BASE}/accesstoken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: g('STRIVEN_CLIENT_ID'), client_secret: g('STRIVEN_CLIENT_SECRET') }) })).json();
const T = tk.access_token;
const api = async (m, ep) => { for (let a = 0; a < 8; a++) { const r = await fetch(BASE + ep, { method: m, headers: { Authorization: `Bearer ${T}`, 'User-Agent': UA, ...(m === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: m === 'POST' ? JSON.stringify({ PageIndex: 0, PageSize: 100 }) : undefined }); if (r.status === 429) { await wait(1000); continue; } if (r.ok) return r.json(); return null; } return null; };
const ids = async (ep) => { let rows = [], pi = 0; for (;;) { const b = await (await fetch(BASE + ep, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ PageIndex: pi, PageSize: 100 }) })).json(); const d = b.data || b.Data || []; rows.push(...d); if (d.length < 100) break; pi++; } return rows; };
const detail = async (ep, list, fn) => { let todo = list.map((r) => r.id), done = new Set(); for (let p = 0; p < 10 && todo.length; p++) { let i = 0; const w = async () => { while (i < todo.length) { const id = todo[i++]; const d = await api('GET', `${ep}/${id}`); if (d) { fn(d); done.add(id); } } }; await Promise.all(Array.from({ length: 6 }, w)); todo = list.map((r) => r.id).filter((id) => !done.has(id)); if (todo.length) await wait(2500); } };

// SO enrichment (already cached)
const soDet = (await (await fetch(`${SB}/rest/v1/striven_cache?key=eq.so_detail&select=data`, { headers: { apikey: SK, Authorization: `Bearer ${SK}` } })).json())[0]?.data || {};

const poRows = await ids('/v1/purchase-orders/search');
const invRows = await ids('/v1/invoices/search');
console.log('POs', poRows.length, 'invoices', invRows.length);

const poBySo = {}, invBySo = {};
await detail('/v1/purchase-orders', poRows, (d) => { const soId = (d.lineItems || []).map((li) => li.order?.id).find(Boolean); if (soId) (poBySo[soId] = poBySo[soId] || []).push({ ref: `PO-${d.id}`, vendor: d.vendor?.name || '', value: Number(d.poTotal || 0), status: d.status?.name || '' }); });
console.log('PO linked');
await detail('/v1/invoices', invRows, (d) => { const soId = d.order?.id; if (soId) (invBySo[soId] = invBySo[soId] || []).push({ ref: `#${d.txnNumber || d.id}`, total: Number(d.invoiceTotal || d.total || 0), open: Number(d.openBalance || 0), status: d.status?.name || '' }); });
console.log('invoices linked');

const chain = {};
for (const [soId, s] of Object.entries(soDet)) {
  chain[soId] = { ref: `SO-${soId}`, type: s.type || '', rep: s.rep || '', value: Number(s.total || 0), status: s.status || '', invStatus: s.invStatus || '', pos: poBySo[soId] || [], invoices: invBySo[soId] || [] };
}
await fetch(`${SB}/rest/v1/striven_cache`, { method: 'POST', headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'order_chain', data: chain, updated_at: new Date().toISOString() }) });
const withPo = Object.values(chain).filter((c) => c.pos.length).length;
console.log(`wrote order_chain — ${Object.keys(chain).length} orders, ${withPo} with a linked PO`);
