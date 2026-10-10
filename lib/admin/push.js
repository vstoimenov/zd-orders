import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { readJson, send, searchParams } from '../http.js';
import { resolveShop } from '../shops.js';
import { pushConfigured, publicKey, saveSubscription, removeSubscription, subscriptionStatus, testPush } from '../push.js';

/** GET → {enabled, publicKey} · POST {action: subscribe {subscription} | unsubscribe | test | status {endpoint}}; ?shop=<id>|all chooses whose orders. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  if (req.method === 'GET') return send(res, 200, { enabled: pushConfigured(), publicKey: publicKey() });
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  const q = getQuery();
  try {
    switch (b.action) {
      case 'subscribe': {
        if (!pushConfigured()) throw new Error('Известията още не са настроени на сървъра');
        const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, strict: true });
        await saveSubscription(q, { subscription: b.subscription, shopId: scope.id, userAgent: req.headers['user-agent'] || '' });
        return send(res, 200, { ok: true, shopId: scope.id });
      }
      case 'unsubscribe': await removeSubscription(q, b.endpoint); return send(res, 200, { ok: true });
      case 'status': return send(res, 200, { ok: true, ...(await subscriptionStatus(q, b.endpoint)) });
      case 'test': await testPush(q, b.endpoint); return send(res, 200, { ok: true });
      default: return send(res, 400, { error: 'Непознато действие' });
    }
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] push failed', b.action, err);
    return send(res, 500, { error: 'Неочаквана грешка на сървъра — опитайте отново' });
  }
}
