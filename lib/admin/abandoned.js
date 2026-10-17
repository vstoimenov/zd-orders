import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { listCarts, openCount, getReminderSettings, setReminderSettings, reminderLinks, markReminded, hideCart } from '../abandoned.js';
import { readJson, send, searchParams } from '../http.js';

/** GET ?shop&state → { carts, openCount, settings } · ?count=1 → { openCount } · POST {action: remind {id, kind, channel} | hide {id} | settings {...}}. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    const p = searchParams(req);
    const b = req.method === 'POST' ? readJson(req) || {} : {};
    const settingsAction = b.action === 'settings';
    const scope = await resolveShop(q, p.get('shop'), { allowAll: !settingsAction, strict: settingsAction, user });
    const where = scope.all ? { shopIds: scope.ids } : { shopId: scope.id };
    const actScope = scope.all ? { scopeShopIds: scope.ids } : { scopeShopId: scope.id };
    if (req.method === 'GET') {
      if (p.get('count') === '1') return send(res, 200, { openCount: await openCount(q, where) });
      const [carts, open, settings] = await Promise.all([
        listCarts(q, { ...where, state: p.get('state') || 'open' }), openCount(q, where), scope.id ? getReminderSettings(q, scope.id) : null,
      ]);
      return send(res, 200, { carts, openCount: open, settings });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (b.action === 'remind') {
      const links = await reminderLinks(q, { id: b.id, kind: b.kind === 'discount' ? 'discount' : 'plain', ...actScope });
      if (!links) return send(res, 404, { error: 'Няма такава количка' });
      if (links.whatsapp) await markReminded(q, { id: b.id, channel: b.channel, ...actScope });
      return send(res, 200, { ok: true, ...links });
    }
    if (b.action === 'hide') return (await hideCart(q, { id: b.id, ...actScope })) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Няма такава количка' });
    if (settingsAction) return send(res, 200, { ok: true, settings: await setReminderSettings(q, scope.id, b) });
    return send(res, 400, { error: 'Непознато действие' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] abandoned failed', err);
    return send(res, 500, { error: 'server' });
  }
}
