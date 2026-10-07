import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { listShops, createShop, setShopHidden } from '../shops.js';
import { readJson, send } from '../http.js';

/** GET → shops · POST {name, domain} → new shop · PATCH {id, hidden} → hide/show a shop in the switcher. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  const q = getQuery();
  const b = readJson(req) || {};
  try {
    if (req.method === 'GET') return send(res, 200, { shops: await listShops(q) });
    if (req.method === 'POST') return send(res, 200, { ok: true, shop: await createShop(q, b) });
    if (req.method === 'PATCH') return send(res, 200, { ok: true, shop: await setShopHidden(q, String(b.id || ''), b.hidden) });
    return send(res, 405, { error: 'method' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] shops failed', err);
    return send(res, 500, { error: 'server' });
  }
}
