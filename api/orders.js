import { getQuery } from '../lib/db.js';
import { validateOrder } from '../lib/order.js';
import { insertOrder, countRecentByIp } from '../lib/orders-repo.js';
import { checkOrders } from '../lib/nk-check.js';
import { nekorektenKey } from '../lib/nekorekten.js';
import { syncStockSafe } from '../lib/stock.js';
import { trafficSourceFor } from '../lib/visits.js';
import { originAllowed, setCors, readJson, send, clientIp } from '../lib/http.js';

const RATE_LIMIT = 20; // orders per IP per 10 minutes (generous: shared mobile IPs / CGNAT)

export default async function handler(req, res) {
  const origin = originAllowed(req);
  setCors(res, origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return send(res, 204);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!origin) return send(res, 403, { error: 'origin' });
  const body = readJson(req);
  const token = process.env.ORDER_TOKEN;
  if (!token || !body || body.token !== token) return send(res, 401, { error: 'token' });
  const v = validateOrder(body);
  if (!v.ok) {
    console.warn('[orders] rejected', body.cb_order_id, v.error);
    return send(res, 400, { error: v.error });
  }
  try {
    const q = getQuery();
    const ip = clientIp(req);
    if ((await countRecentByIp(q, ip)) >= RATE_LIMIT) {
      console.warn('[orders] rate-limited', ip, body.cb_order_id);
      return send(res, 429, { error: 'rate' });
    }
    // ConvertBuilder numbers orders per store (each starts at 1): key them by the store's domain
    const site = new URL(origin).host.replace(/^www\./, '');
    const cbOrderId = `${site}:${v.order.cbOrderId}`;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 400);
    // where this buyer came from today (anonymous visit statistics); never fails the order
    const trafficSource = await trafficSourceFor(q, { site, ip, ua: userAgent }).catch(() => '');
    const r = await insertOrder(q, { ...v.order, cbOrderId, ip, userAgent: userAgent.slice(0, 300), trafficSource });
    await syncStockSafe(q, r.id); // takes stock for a new order (never fails the order)
    // check the phone on nekorekten.com now; failures are stored as 'error' and retried later — never fail the order for it
    const nkKey = r.inserted && v.order.phoneNorm ? nekorektenKey() : null;
    if (nkKey) {
      try { await checkOrders(q, [{ id: r.id, phoneNorm: v.order.phoneNorm }], nkKey); } catch (err) { console.error('[orders] nekorekten', err); }
    }
    return send(res, 200, { ok: true, inserted: r.inserted, duplicate: r.duplicate });
  } catch (err) {
    console.error('[orders] store failed', v.order.cbOrderId, err);
    return send(res, 500, { error: 'server' });
  }
}
