// Local admin preview: serves public/ and the admin API against an in-memory PGlite DB seeded with sample orders.
// Usage: node dev/admin-local.mjs  → http://localhost:8766/admin/  (password: local-test)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestQuery } from '../test/helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, saveNekorekten, updateStatus } from '../lib/orders-repo.js';
import login from '../api/admin/login.js';
import orders from '../api/admin/orders.js';
import stats from '../api/admin/stats.js';
import costs from '../api/admin/costs.js';
import integrations from '../api/admin/integrations.js';

process.env.ADMIN_PASSWORD = 'local-test';
process.env.ADMIN_SECRET = 'local-secret';
process.env.INTEGRATIONS_SECRET = 'local-integrations-secret';
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

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/admin/')) {
    let body = '';
    for await (const c of req) body += c;
    req.body = body || undefined;
    const routes = { '/api/admin/login': login, '/api/admin/stats': stats, '/api/admin/costs': costs, '/api/admin/integrations': integrations };
    return (routes[url] || orders)(req, res);
  }
  const file = path.join(root, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try { const b = await readFile(file); res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(b); }
  catch { res.statusCode = 404; res.end('not found'); }
}).listen(8766, () => console.log('admin-local on http://localhost:8766/admin/'));
