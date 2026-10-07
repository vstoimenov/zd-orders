// Local admin preview: serves public/ and the admin API against an in-memory PGlite DB seeded with sample orders.
// Usage: node dev/admin-local.mjs  → http://localhost:8766/admin/  (password: local-test)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestQuery } from '../test/helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, saveNekorekten, updateStatus } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import adminRouter from '../api/admin/[route].js';

process.env.ADMIN_PASSWORD = 'local-test';
process.env.ADMIN_SECRET = 'local-secret';
process.env.INTEGRATIONS_SECRET = 'local-integrations-secret';
// local only: pretend a Meta app exists and answer Facebook's Graph API with sample data (no real calls leave this machine)
process.env.META_APP_ID = 'local-app'; process.env.META_APP_SECRET = 'local-secret';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname !== 'graph.facebook.com') return realFetch(url, init);
  const ok = (d) => ({ ok: true, status: 200, json: async () => d });
  if (u.pathname.endsWith('/me/adaccounts')) return ok({ data: [
    { account_id: '1234567890', name: 'adhd реклами', currency: 'EUR', account_status: 1, business: { name: 'ProfitBrand' } },
    { account_id: '9876543210', name: 'Стар рекламен акаунт', currency: 'BGN', account_status: 2 },
  ] });
  if (/\/act_\d+$/.test(u.pathname)) return ok({ name: 'adhd реклами', currency: 'EUR', account_status: 1 });
  if (u.pathname.endsWith('/insights')) return ok({ data: [] });
  return ok({});
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const q = await makeTestQuery();
setQueryForTests(q);
const base = { email: 'm@x.bg', courier: 'econt', deliveryType: 'econt_office', officeId: 'econt:4002', postCode: '4000', addressText: '', currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '' };
await insertOrder(q, { ...base, cbOrderId: 'L1', name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', officeText: 'ЕКОНТ – автомат Тракия (4002), бул. Освобождение 31', city: 'Пловдив', items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }], total: 22.57 });
await insertOrder(q, { ...base, cbOrderId: 'L2', name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', officeText: 'ЕКОНТ – офис Пловдив Център (4001), ул. Гладстон 1', city: 'Пловдив', items: [{ name: 'Да се заобичаме с думи', qty: 2, price: 37 }], total: 41.07 });
await insertOrder(q, { ...base, cbOrderId: 'L3', name: 'Петя <b>Петрова</b>', phone: '0899000111', phoneNorm: '+359899000111', courier: 'speedy', deliveryType: 'speedy_address', officeId: '', officeText: 'СПИДИ – адрес: ул. Роза 5', addressText: 'ул. Роза 5', city: 'Варна', postCode: '9000', items: [{ name: 'Тесте за син', qty: 1, price: 18.5 }], total: 22.54 });

// sample nekorekten results: L1 flagged, L3 clean, L2 left unchecked
const ids = Object.fromEntries((await q('select id, cb_order_id from zd.orders')).map((r) => [r.cb_order_id, r.id]));
await saveNekorekten(q, ids.L1, { status: 'flagged', count: 2, reportIds: ['12345', '12346'] });
await saveNekorekten(q, ids.L3, { status: 'clean', count: 0 });
await updateStatus(q, ids.L2, 'delivered');
await updateStatus(q, ids.L3, 'returned');
// sample anonymous visits and Meta ad spend for today
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
for (const [visitor, source] of [['v1', 'facebook'], ['v2', 'facebook'], ['v3', 'instagram'], ['v4', 'direct'], ['v5', 'google'], ['v6', 'facebook'], ['v7', 'direct']]) {
  await q(`insert into zd.visits (day, site, visitor, path, source, device) values ($1::date, 'adhdbg.eu', $2, '/', $3, 'mobile')`, [today, visitor, source]);
}
await q(`update zd.orders set traffic_source = 'facebook' where cb_order_id in ('L1', 'L2')`);
await q(`insert into zd.ad_spend (platform, account_id, day, spend, impressions, clicks, purchases, purchase_value, currency) values ('meta', '1234567890', $1::date, 18.4, 5200, 96, 2, 63.64, 'EUR')`, [today]);
await saveIntegration(q, 'meta', { config: { accountId: '1234567890', accountName: 'adhd реклами', currency: 'EUR', active: true, lastSyncAt: new Date().toISOString(), lastSyncResult: { days: 30 } }, secret: 'LOCAL-FAKE-TOKEN' });
// a connected ConvertBuilder store (fake key — the local server never calls ConvertBuilder unless you press its buttons)
await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, currency: 'EUR', webhookId: 'wh_local', webhookSecret: 'local', connectedAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastSyncResult: { fetched: 6, inserted: 6, updated: 0 } }, secret: 'LOCAL-FAKE-KEY' });

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/admin/')) {
    let body = '';
    for await (const c of req) body += c;
    req.body = body || undefined;
    return adminRouter(req, res);
  }
  const file = path.join(root, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try { const b = await readFile(file); res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(b); }
  catch { res.statusCode = 404; res.end('not found'); }
}).listen(8766, () => console.log('admin-local on http://localhost:8766/admin/'));
