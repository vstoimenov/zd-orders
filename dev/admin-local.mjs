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
import officesApi from '../api/offices.js';

process.env.ADMIN_PASSWORD = 'local-test';
process.env.ADMIN_SECRET = 'local-secret';
process.env.INTEGRATIONS_SECRET = 'local-integrations-secret';
// local only: throwaway push keys, so "Известия" can be tried here
{ const { default: webpush } = await import('web-push'); const k = webpush.generateVAPIDKeys(); process.env.VAPID_PUBLIC_KEY = k.publicKey; process.env.VAPID_PRIVATE_KEY = k.privateKey; }
// local only: pretend a Meta app exists and answer Facebook's Graph API with sample data (no real calls leave this machine)
process.env.META_APP_ID = 'local-app'; process.env.META_APP_SECRET = 'local-secret';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.speedy.bg') return fakeSpeedy(u.pathname.replace('/v1/', ''), JSON.parse(init.body));
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
// local only: a fake Speedy API (Speedy has no public test server) — sample contract, prices and waybills
let speedyNo = 61000000000;
function fakeSpeedy(p, b) {
  const json = (d) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => d });
  if (b.password !== 'local-speedy') return json({ error: { message: 'bg.error.invalid.credentials (LOCAL)', code: 1 } });
  if (p === 'client/contract') return json({ clients: [{ clientId: 77001, clientName: 'ЕТ Книги', objectName: 'Склад', privatePerson: false, address: { fullAddressString: 'гр. София, ул. Пиротска 5' } }] });
  if (p === 'services') return json({ services: [{ id: 505, name: 'СТАНДАРТ 24 ЧАСА', cargoType: 'PARCEL' }, { id: 412, name: 'ПАЛЕТНА', cargoType: 'PALLET' }] });
  if (p === 'calculate') return json({ calculations: [{ serviceId: 505, price: { total: 6.12, currency: 'EUR' } }] });
  if (p === 'shipment') return json({ id: String(++speedyNo), price: { total: 6.12, currency: 'EUR' } });
  if (p === 'shipment/cancel') return json({});
  if (p === 'pickup') return json({ orders: [{ id: 1 }] });
  if (p === 'track') return json({ parcels: b.parcels.map((x) => ({ parcelId: x.id, operations: [{ operationCode: 12, description: 'Предадена на куриер за доставка' }] })) });
  if (p === 'print') return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4\n% local Speedy waybill\n%%EOF').buffer };
  return json({ error: { message: 'unknown', code: 1 } });
}
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
// a second shop with one order (multi-shop switcher)
const { createShop, updateShop, DEFAULT_SHOP } = await import('../lib/shops.js');
await q(`update zd.shops set domain = 'adhdbg.eu' where id = $1`, [DEFAULT_SHOP]);
await updateShop(q, DEFAULT_SHOP, { name: 'adhd', url: 'https://adhdbg.eu' });
const kids = await createShop(q, { name: 'Книги за деца', domain: 'knigi-deca.bg' });
await insertOrder(q, { ...base, cbOrderId: 'knigi-deca.bg:1', shopId: kids.id, name: 'Иван Петров', phone: '0877000111', phoneNorm: '+359877000111', officeText: 'ЕКОНТ – офис Варна (9000)', city: 'Варна', items: [{ name: 'Приказки', qty: 2, price: 24 }], total: 28.5 });
// a connected ConvertBuilder store (fake key — the local server never calls ConvertBuilder unless you press its buttons)
await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, currency: 'EUR', webhookId: 'wh_local', webhookSecret: 'local', connectedAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastSyncResult: { fetched: 6, inserted: 6, updated: 0 } }, secret: 'LOCAL-FAKE-KEY' });

// Econt waybills in test mode: Econt's public demo account (demo.econt.com, no real shipments) and a few office codes it knows
await q(`insert into zd.offices (id, courier, code, name, city, address) values
  ('econt:1107', 'econt', '1107', 'Офис София Младост', 'София', 'бул. Александър Малинов 1'),
  ('econt:1127', 'econt', '1127', 'Офис София Лозенец', 'София', 'ул. Златовръх 1')`);
await insertOrder(q, { ...base, cbOrderId: 'L4', name: 'Георги Димитров', phone: '0888555666', phoneNorm: '+359888555666', officeId: 'econt:1127', officeText: 'ЕКОНТ – офис София Лозенец (1127)', city: 'София', postCode: '1000', items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }], total: 22.57 });
await saveIntegration(q, 'econt', {
  config: { username: 'iasp-dev', demo: true, profileName: 'ЕТ КОНСУЛТ - ИВАН КИРЯЗОВ', profileCompany: true, senderAgent: 'Иван Кирязов', sender: { type: 'office', officeCode: '1107', addressId: '', address: null, text: 'Офис София Младост, София' },
    senderName: '', senderPhone: '0888888888', payer: 'receiver', weight: 1, description: '', review: false, active: true, connectedAt: new Date().toISOString() },
  secret: JSON.stringify({ username: 'iasp-dev', password: '1Asp-dev' }),
});

await q(`insert into zd.offices (id, courier, code, name, city) values ('speedy:12', 'speedy', '12', 'СОФИЯ - ЦЕНТЪР', 'София'), ('speedy:66', 'speedy', '66', 'ПЛЕВЕН - ЦЕНТЪР', 'Плевен')`);
await insertOrder(q, { ...base, cbOrderId: 'L5', name: 'Елена Стоянова', phone: '0877123123', phoneNorm: '+359877123123', courier: 'speedy', deliveryType: 'speedy_office', officeId: 'speedy:66', officeText: 'СПИДИ – офис Плевен Център', city: 'Плевен', postCode: '5800', items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }], total: 22.57 });
await saveIntegration(q, 'speedy', {
  config: { username: '999111', clientId: 77001, clientName: 'ЕТ Книги', clientCompany: true, sender: { type: 'office', officeId: 12, text: 'СОФИЯ - ЦЕНТЪР' },
    senderPhone: '0888888888', senderContact: 'Иван Петров', payer: 'receiver', weight: 1, description: '', review: 'OPEN', serviceId: 505, serviceName: 'СТАНДАРТ 24 ЧАСА', paperSize: 'A4', active: true, connectedAt: new Date().toISOString() },
  secret: JSON.stringify({ username: '999111', password: 'local-speedy' }),
});

// a sample client who sees only "Книги за деца" (local only): local-client@example.com / client-pass-1
{ const { createClient, acceptInvite } = await import('../lib/users.js'); const c = await createClient(q, { email: 'local-client@example.com', name: 'Клиент Книги', shopIds: [kids.id] }); await acceptInvite(q, c.token, 'client-pass-1'); }

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/offices') return officesApi(Object.assign(req, { query: Object.fromEntries(new URL(req.url, 'http://x').searchParams) }), res);
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
