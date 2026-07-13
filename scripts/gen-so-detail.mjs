// Enrich every sales order with type (PI/VA/DEMO), sales rep, order total and
// invoice status (the SO *search* omits all of these) and write the map to the
// Supabase striven_cache under key 'so_detail'. getSO reads it from there.
// Run: node scripts/gen-so-detail.mjs
import fs from 'node:fs';
const env = fs.readFileSync(new URL('../striven-server/.env', import.meta.url), 'utf8');
const g = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const BASE = 'https://api.striven.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SB = g('SUPABASE_URL'), SK = g('SUPABASE_SERVICE_KEY');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tk = await (await fetch(`${BASE}/accesstoken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: g('STRIVEN_CLIENT_ID'), client_secret: g('STRIVEN_CLIENT_SECRET') }) })).json();
const T = tk.access_token;

let rows = [], pi = 0;
for (;;) { const b = await (await fetch(`${BASE}/v1/sales-orders/search`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ PageIndex: pi, PageSize: 100 }) })).json(); const d = b.data || b.Data || []; rows.push(...d); if (d.length < 100) break; pi++; }
console.log('sales orders:', rows.length);

const map = {};
const get = async (id) => {
  for (let a = 0; a < 8; a++) {
    const r = await fetch(`${BASE}/v1/sales-orders/${id}`, { headers: { Authorization: `Bearer ${T}`, 'User-Agent': UA } });
    if (r.status === 429) { await wait(1000); continue; }
    if (r.ok) { const d = await r.json(); map[id] = { type: d.type?.name ?? '', rep: d.salesRep?.name ?? '', total: Number(d.orderTotal ?? 0), invStatus: d.invoiceStatus?.name ?? '', status: d.status?.name ?? '' }; return; }
    return;
  }
};
let todo = rows.map((r) => r.id);
for (let pass = 0; pass < 10 && todo.length; pass++) {
  let i = 0;
  const w = async () => { while (i < todo.length) await get(todo[i++]); };
  await Promise.all(Array.from({ length: 6 }, w));
  todo = rows.map((r) => r.id).filter((id) => !(id in map));
  console.log(`pass ${pass + 1}: ${Object.keys(map).length}/${rows.length}`);
  if (todo.length) await wait(2500);
}
// summary
const byType = {}; for (const v of Object.values(map)) byType[v.type || '(none)'] = (byType[v.type || '(none)'] || 0) + 1;
console.log('types:', JSON.stringify(byType));
await fetch(`${SB}/rest/v1/striven_cache`, { method: 'POST', headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'so_detail', data: map, updated_at: new Date().toISOString() }) });
console.log(`wrote so_detail to Supabase — ${Object.keys(map).length} SOs`);
