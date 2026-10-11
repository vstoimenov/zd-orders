import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { confirmLink, getTemplate, setTemplate } from '../confirm.js';
import { readJson, send, searchParams } from '../http.js';

/** GET ?shop → the shop's confirmation text · POST {action: link {id} | template {text}}. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    const b = req.method === 'POST' ? readJson(req) || {} : {};
    // a link is for any order the admin may see; the text belongs to one shop
    const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: b.action !== 'template', strict: b.action === 'template', user });
    if (req.method === 'GET') return send(res, 200, { template: scope.id ? await getTemplate(q, scope.id) : null });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (b.action === 'link') {
      const out = await confirmLink(q, { orderId: b.id, scopeShopId: scope.all ? null : scope.id, scopeShopIds: scope.all ? scope.ids : null });
      return out ? send(res, 200, { ok: true, ...out }) : send(res, 404, { error: 'Няма такава поръчка' });
    }
    if (b.action === 'template') return send(res, 200, { ok: true, template: await setTemplate(q, scope.id, b.text) });
    return send(res, 400, { error: 'Непознато действие' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] confirm failed', err);
    return send(res, 500, { error: 'server' });
  }
}
