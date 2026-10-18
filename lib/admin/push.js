import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { readJson, send, searchParams } from '../http.js';
import { resolveShop } from '../shops.js';
import { pushConfigured, publicKey, saveSubscription, removeSubscription, subscriptionStatus, testPush, getPushTemplate, setPushTemplate, testPushTemplate } from '../push.js';

/** GET → {enabled, publicKey, template} · POST {action: subscribe {subscription} | unsubscribe | test | status {endpoint} | template {title, body} | template_test {endpoint}};
 * ?shop=<id>|all chooses whose orders (the text belongs to one shop). */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method === 'GET') {
    const shop = searchParams(req).get('shop');
    let template = null;
    if (shop && shop !== 'all') { try { template = await getPushTemplate(q, (await resolveShop(q, shop, { strict: true, user })).id); } catch { /* no such shop */ } }
    return send(res, 200, { enabled: pushConfigured(), publicKey: publicKey(), template });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  const mine = user.owner ? null : user.id;
  try {
    switch (b.action) {
      case 'subscribe': {
        if (!pushConfigured()) throw new Error('Известията още не са настроени на сървъра');
        const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, strict: true, user });
        await saveSubscription(q, { subscription: b.subscription, shopId: scope.id, userAgent: req.headers['user-agent'] || '', userId: mine });
        return send(res, 200, { ok: true, shopId: scope.id });
      }
      case 'unsubscribe': await removeSubscription(q, b.endpoint, mine); return send(res, 200, { ok: true });
      case 'status': return send(res, 200, { ok: true, ...(await subscriptionStatus(q, b.endpoint, mine)) });
      case 'test': await testPush(q, b.endpoint, mine); return send(res, 200, { ok: true });
      case 'template': {
        const scope = await resolveShop(q, searchParams(req).get('shop'), { strict: true, user });
        return send(res, 200, { ok: true, template: await setPushTemplate(q, scope.id, b) });
      }
      case 'template_test': {
        const scope = await resolveShop(q, searchParams(req).get('shop'), { strict: true, user });
        await testPushTemplate(q, b.endpoint, scope.id, mine);
        return send(res, 200, { ok: true });
      }
      default: return send(res, 400, { error: 'Непознато действие' });
    }
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] push failed', b.action, err);
    return send(res, 500, { error: 'Неочаквана грешка на сървъра — опитайте отново' });
  }
}
