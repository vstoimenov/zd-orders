import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { shopsFor, createShop, setShopHidden } from '../shops.js';
import { readJson, send } from '../http.js';
import { notifyOwner } from '../push.js';

const CLIENT_SHOPS_MAX = 10;
const OFFER_SHOPS_MAX = 200; // the unlimited plan, with a safety cap

/** GET → the shops this admin may see · POST {name, domain} → new shop (a client's becomes theirs) · PATCH {id, hidden} → hide/show own shop. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  const b = readJson(req) || {};
  try {
    if (req.method === 'GET') return send(res, 200, { shops: await shopsFor(q, user) });
    if (req.method === 'POST') {
      if (user.owner) return send(res, 200, { ok: true, shop: await createShop(q, b) });
      const max = user.plan === 'unlimited' ? OFFER_SHOPS_MAX : CLIENT_SHOPS_MAX;
      if (user.shopIds.length >= max) throw new Error(`Може до ${max} магазина — пишете на собственика`);
      const shop = await createShop(q, b, { byClient: true });
      try {
        await q(`insert into zd.user_shops (user_id, shop_id) values ($1::uuid, $2::uuid)`, [user.id, shop.id]);
      } catch (err) {
        await q(`delete from zd.shops where id = $1::uuid`, [shop.id]).catch(() => {}); // no shop without its owner
        throw err;
      }
      await notifyOwner(q, { title: '🏪 Магазин чака одобрение', body: `${shop.name} · ${shop.domain} — ${user.name || user.email}`, url: '/admin/#clients' });
      return send(res, 200, { ok: true, shop });
    }
    if (req.method === 'PATCH') {
      const id = String(b.id || '');
      if (!user.owner && !user.shopIds.includes(id)) throw new Error('Няма такъв магазин');
      return send(res, 200, { ok: true, shop: await setShopHidden(q, id, b.hidden) });
    }
    return send(res, 405, { error: 'method' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] shops failed', err);
    return send(res, 500, { error: 'server' });
  }
}
