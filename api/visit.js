import { getQuery } from '../lib/db.js';
import { isBot, recordVisit } from '../lib/visits.js';
import { setCors, readJson, send, clientIp } from '../lib/http.js';
import { allowedShopOrigin } from '../lib/shops.js';
import { alertNoShipping } from '../lib/push.js';
import { captureCart } from '../lib/abandoned.js';

const CART_LIMIT = 30; // cart captures per address per 10 minutes (the endpoint is public)

/** Anonymous page view from kurier.js (sendBeacon, text/plain JSON {p: path, s: query, r: referrer}). Always quick; never errors to the page. */
export default async function handler(req, res) {
  const allowed = await allowedShopOrigin(getQuery(), req).catch(() => null);
  const origin = allowed?.origin || null;
  setCors(res, origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return send(res, 204);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!origin) return send(res, 403, { error: 'origin' });
  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  if (isBot(ua)) return send(res, 204);
  const b = readJson(req) || {};
  if (b.e === 'no_shipping') { // not a visit: the checkout found no shipping method for the cart
    await alertNoShipping(getQuery(), allowed.shopId, new URL(origin).host.replace(/^www\./, ''));
    return send(res, 204);
  }
  if (b.e === 'cart') { // not a visit: what the customer typed in the checkout (abandoned carts)
    try {
      const q = getQuery(), ip = clientIp(req);
      const [{ n }] = await q(`select count(*)::int as n from zd.abandoned_carts where ip = $1 and updated_at > now() - interval '10 minutes'`, [ip]);
      if (n < CART_LIMIT) {
        await captureCart(q, { shopId: allowed.shopId, phone: b.phone, name: b.name, email: b.email, items: b.items, total: b.total, currency: b.currency,
          deliveryText: b.delivery, pageUrl: b.page, ip });
      }
    } catch (err) {
      console.error('[visit] cart capture failed', err);
    }
    return send(res, 204);
  }
  try {
    await recordVisit(getQuery(), { site: new URL(origin).host.replace(/^www\./, ''), shopId: allowed.shopId, ip: clientIp(req), ua, path: b.p, search: b.s, referrer: b.r });
  } catch (err) {
    console.error('[visit] store failed', err);
  }
  return send(res, 204);
}
