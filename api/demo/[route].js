// Public demo of the admin (/demo/): the same admin code on an in-memory database full of sample data, without a password.
// Nothing here reaches the real database, the real admin login or the platform's keys; outside calls go through lib/demo/fakes.js.
import { randomBytes } from 'node:crypto';

// before anything else: this function never knows the real database, admin secret or platform keys
for (const k of ['DATABASE_URL', 'NEKOREKTEN_API_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_CONFIG_ID', 'CRON_SECRET', 'ORDER_TOKEN']) delete process.env[k];
process.env.ADMIN_SECRET = `demo-${randomBytes(16).toString('hex')}`;
process.env.INTEGRATIONS_SECRET = `demo-${randomBytes(16).toString('hex')}`;
process.env.PUSH_ADMIN_PATH = '/demo/'; // a tapped notification opens the demo, not the real admin

const { setQueryForTests } = await import('../../lib/db.js');
const { makeMemoryQuery } = await import('../../lib/demo/memory-db.js');
const { demoFetch } = await import('../../lib/demo/fakes.js');
const { seedDemo, simulateOrder } = await import('../../lib/demo/seed.js');
const { signSession, COOKIE } = await import('../../lib/auth.js');
const { send, readJson, searchParams } = await import('../../lib/http.js');
const { resolveShop } = await import('../../lib/shops.js');
const { notifyNewOrder } = await import('../../lib/push.js');

const realFetch = globalThis.fetch;
globalThis.fetch = demoFetch(realFetch);

const ready = (async () => {
  const q = await makeMemoryQuery();
  setQueryForTests(q);
  await seedDemo(q);
  return q;
})();

const ROUTES = {
  orders: (await import('../../lib/admin/orders.js')).default,
  stats: (await import('../../lib/admin/stats.js')).default,
  costs: (await import('../../lib/admin/costs.js')).default,
  integrations: (await import('../../lib/admin/integrations.js')).default,
  inventory: (await import('../../lib/admin/inventory.js')).default,
  shops: (await import('../../lib/admin/shops.js')).default,
  waybills: (await import('../../lib/admin/waybills.js')).default,
  push: (await import('../../lib/admin/push.js')).default,
};
const SIMULATE_GAP_MS = 5000;
let lastSimulated = 0;

/** POST ?shop= → one invented order in that shop, with the new-order notification (a few seconds apart). */
async function simulate(req, res, q) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (Date.now() - lastSimulated < SIMULATE_GAP_MS) return send(res, 429, { error: 'Изчакайте няколко секунди между поръчките' });
  lastSimulated = Date.now();
  const shop = await resolveShop(q, searchParams(req).get('shop'));
  const id = await simulateOrder(q, shop.id);
  await notifyNewOrder(q, id);
  return send(res, 200, { ok: true, id });
}

export default async function handler(req, res) {
  const segment = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '').split('/').pop();
  try {
    const q = await ready;
    if (segment === 'login') return send(res, 200, { ok: true }); // no password in the demo
    if (segment === 'simulate') return await simulate(req, res, q);
    const route = Object.hasOwn(ROUTES, segment) ? ROUTES[segment] : null;
    if (!route) return send(res, 404, { error: 'not found' });
    // Econt only on its test server here: a visitor's real e-Econt login must never be used
    if (segment === 'integrations' && req.method === 'POST') {
      const b = readJson(req) || {};
      if (['econt_profile', 'save_econt'].includes(b.action) && b.demo === false) return send(res, 400, { error: 'В демото Еконт работи само в тестов режим' });
    }
    req.headers = { ...req.headers, cookie: `${COOKIE}=${signSession(process.env.ADMIN_SECRET)}` }; // everyone is the demo's admin
    return await route(req, res);
  } catch (err) {
    console.error('[demo] failed', segment, err);
    return send(res, 500, { error: 'Демото има проблем — опитайте отново' });
  }
}
