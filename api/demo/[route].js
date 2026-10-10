// Public demo of the admin (/demo/ on zd-orders.vercel.app): the same admin code without a password, on sample data.
// Every visitor gets an own in-memory database (a sandbox), so nobody sees or changes another visitor's demo.
// Nothing here reaches the real database, the real admin login or the platform's keys; outside calls go through lib/demo/fakes.js.
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// before anything else: only harmless variables stay (no database, admin, platform or Vercel secrets)
const KEEP = /^(AWS_|LAMBDA_|NODE_|VERCEL_(REGION|ENV|URL)$|PATH$|HOME$|LANG$|TZ$|PWD$|LD_LIBRARY_PATH$|_HANDLER$|PUBLIC_BASE_URL$)/;
for (const k of Object.keys(process.env)) if (!KEEP.test(k)) delete process.env[k];
process.env.ZD_DEMO = '1'; // lib/db.js refuses the real database
process.env.ADMIN_SECRET = `demo-${randomBytes(16).toString('hex')}`;
process.env.INTEGRATIONS_SECRET = `demo-${randomBytes(16).toString('hex')}`;
process.env.PUSH_ADMIN_PATH = '/demo/'; // a tapped notification opens the demo, not the real admin
{ // own push keys: the demo never signs with the real admin's key
  const { default: webpush } = await import('web-push');
  const k = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = k.publicKey;
  process.env.VAPID_PRIVATE_KEY = k.privateKey;
}

const { setQueryForTests } = await import('../../lib/db.js');
const { makeMemoryQuery } = await import('../../lib/demo/memory-db.js');
const { demoFetch } = await import('../../lib/demo/fakes.js');
const { seedDemo, simulateOrder } = await import('../../lib/demo/seed.js');
const { signSession, COOKIE } = await import('../../lib/auth.js');
const { send, readJson, searchParams } = await import('../../lib/http.js');
const { resolveShop } = await import('../../lib/shops.js');
const { notifyNewOrder } = await import('../../lib/push.js');

globalThis.fetch = demoFetch(globalThis.fetch);

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

/* ---- one sandbox per visitor (a cookie), at most MAX_BOXES per instance: the least recently used one is reset ---- */
const MAX_BOXES = 4; // each in-memory database takes ~250 MB
const BOX_COOKIE = 'zdo_demo';
const boxes = new Map();
const current = new AsyncLocalStorage();
setQueryForTests((text, params) => {
  const box = current.getStore();
  if (!box) throw new Error('demo: no sandbox');
  return box.q(text, params);
});

const LIMITS = { shops: 6, orders: 400, product_costs: 60, expenses: 60, push_subscriptions: 3 };
const ECONT_CALLS_MAX = 40; // calls to Econt's public test server per sandbox
const SIMULATE_GAP_MS = 5000;

function boxId(req) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${BOX_COOKIE}=`));
  const id = hit ? hit.slice(BOX_COOKIE.length + 1) : '';
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

async function openBox(req, res) {
  let id = boxId(req);
  if (!id) {
    id = randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `${BOX_COOKIE}=${id}; Path=/api/demo; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
  }
  let box = boxes.get(id);
  if (!box) {
    while (boxes.size >= MAX_BOXES) {
      const [oldId, old] = [...boxes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      boxes.delete(oldId);
      old.ready.then((q) => q.close()).catch(() => {});
    }
    box = { q: null, lastUsed: Date.now(), simulatedAt: 0, econtCalls: 0 };
    box.ready = (async () => {
      const q = await makeMemoryQuery();
      box.q = q;
      await current.run(box, () => seedDemo(q));
      return q;
    })();
    box.ready.catch(() => boxes.delete(id)); // a failed seed is retried on the next request
    boxes.set(id, box);
  }
  box.lastUsed = Date.now();
  await box.ready;
  return box;
}

/** A visitor's demo stays small: refuse writes once a table is full. */
async function overLimit(box) {
  for (const [table, max] of Object.entries(LIMITS)) {
    const [r] = await box.q(`select count(*)::int as n from zd.${table}`);
    if (r.n >= max) return true;
  }
  return false;
}

/** POST ?shop= → one invented order in that shop, with the new-order notification (a few seconds apart). */
async function simulate(req, res, box) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (Date.now() - box.simulatedAt < SIMULATE_GAP_MS) return send(res, 429, { error: 'Изчакайте няколко секунди между поръчките' });
  if (await overLimit(box)) return send(res, 429, { error: 'Демото достигна лимита си — отворете го в нов прозорец (private) за ново' });
  box.simulatedAt = Date.now();
  const shop = await resolveShop(box.q, searchParams(req).get('shop'));
  const id = await simulateOrder(box.q, shop.id);
  await notifyNewOrder(box.q, id);
  return send(res, 200, { ok: true, id });
}

export default async function handler(req, res) {
  const segment = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '').split('/').pop();
  try {
    if (segment === 'login') return send(res, 200, { ok: true }); // no password in the demo
    const box = await openBox(req, res);
    return await current.run(box, async () => {
      if (segment === 'simulate') return simulate(req, res, box);
      const route = Object.hasOwn(ROUTES, segment) ? ROUTES[segment] : null;
      if (!route) return send(res, 404, { error: 'not found' });
      if (req.method === 'POST' || req.method === 'PATCH') {
        const b = readJson(req) || {};
        const creates = (segment === 'shops' && req.method === 'POST') || segment === 'inventory' || segment === 'costs' || (segment === 'push' && b.action === 'subscribe');
        if (creates && await overLimit(box)) return send(res, 429, { error: 'Демото достигна лимита си — отворете го в нов прозорец (private) за ново' });
        const econt = (segment === 'integrations' && ['econt_profile', 'save_econt', 'sync_econt'].includes(b.action)) || segment === 'waybills';
        if (econt && ++box.econtCalls > ECONT_CALLS_MAX) return send(res, 429, { error: 'Достигнахте лимита на демото за товарителници' });
        // Econt only with its own public test account on its test server: a visitor's real e-Econt login is never used
        if (segment === 'integrations' && ['econt_profile', 'save_econt'].includes(b.action)) {
          req.body = JSON.stringify({ ...b, username: 'iasp-dev', password: '1Asp-dev', demo: true });
        }
      }
      req.headers = { ...req.headers, cookie: `${COOKIE}=${signSession(process.env.ADMIN_SECRET)}` }; // the visitor is the admin of their own demo
      return route(req, res);
    });
  } catch (err) {
    console.error('[demo] failed', segment, err);
    return send(res, 500, { error: 'Демото има проблем — опитайте отново' });
  }
}
