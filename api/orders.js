import { getQuery } from '../lib/db.js';
import { validateOrder } from '../lib/order.js';
import { insertOrder, countRecentByIp } from '../lib/orders-repo.js';
import { syncStockSafe } from '../lib/stock.js';
import { cbConfig, cbKnowsOrder, confirmKeptAside, startOrder } from '../lib/cb-sync.js';
import { trafficSourceFor } from '../lib/visits.js';
import { setCors, readJson, send, clientIp } from '../lib/http.js';
import { allowedShopOrigin } from '../lib/shops.js';
import { keyedOrders } from '../lib/external-orders.js';
import { saveInvoice } from '../lib/invoice.js';

const RATE_LIMIT = 20; // orders per IP per 10 minutes (generous: shared mobile IPs / CGNAT)

export default async function handler(req, res) {
  // a shop's own server (WooCommerce plugin, custom site) with its key
  if (/^Bearer\s/i.test(String(req.headers.authorization || ''))) return keyedOrders(req, res);
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
  const body = readJson(req);
  const token = process.env.ORDER_TOKEN;
  if (!token || !body || body.token !== token) return send(res, 401, { error: 'token' });
  const v = validateOrder(body);
  if (v.ok && /^(wc|ext)-/i.test(v.order.cbOrderId)) return send(res, 400, { error: 'reserved id' }); // those come only with a shop key
  if (!v.ok) {
    console.warn('[orders] rejected', body.cb_order_id, v.error);
    return send(res, 400, { error: v.error });
  }
  try {
    const q = getQuery();
    const ip = clientIp(req);
    const site = new URL(origin).host.replace(/^www\./, '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 400);
    // where this buyer came from today (anonymous visit statistics) — looked up alongside the rate check; never fails the order
    const [recent, trafficSource] = await Promise.all([countRecentByIp(q, ip), trafficSourceFor(q, { site, ip, ua: userAgent, shopId: allowed.shopId }).catch(() => '')]);
    if (recent >= RATE_LIMIT) {
      console.warn('[orders] rate-limited', ip, body.cb_order_id);
      return send(res, 429, { error: 'rate' });
    }
    // ConvertBuilder numbers orders per store (each starts at 1): key them by the store's domain
    const cbOrderId = `${site}:${v.order.cbOrderId}`;
    // anyone can post to this public endpoint: with a ConvertBuilder connection the order is kept aside until ConvertBuilder confirms it
    const cfg = await cbConfig(q, allowed.shopId).catch(() => null);
    const r = await insertOrder(q, { ...v.order, cbOrderId, ip, userAgent: userAgent.slice(0, 300), trafficSource, shopId: allowed.shopId, cbCheck: cfg ? 'pending' : '' });
    if (r.id && r.inserted) await saveInvoice(q, r.id, v.order.invoice).catch((err) => console.error('[orders] invoice', err.message));
    let start = r.inserted && !cfg;
    if (r.inserted && cfg) {
      let known = false;
      try { known = await cbKnowsOrder(cfg, { number: v.order.cbOrderId, phoneNorm: v.order.phoneNorm }); } catch (err) { console.warn('[orders] ConvertBuilder check failed — waiting for its webhook', cbOrderId, err.message); }
      // the webhook may have confirmed it meanwhile: only the one that turns it starts it
      start = known && await confirmKeptAside(q, cbOrderId, allowed.shopId, v.order.phoneNorm);
      if (!known) console.warn('[orders] kept aside until ConvertBuilder confirms it', cbOrderId);
    }
    // stock, nekorekten.com, the owner's phone and the customer's WhatsApp confirmation — never fail the order for them
    if (start) await startOrder(q, { id: r.id, phoneNorm: v.order.phoneNorm }, '[orders]');
    else await syncStockSafe(q, r.id);
    return send(res, 200, { ok: true, inserted: r.inserted, duplicate: r.duplicate });
  } catch (err) {
    console.error('[orders] store failed', v.order.cbOrderId, err);
    return send(res, 500, { error: 'server' });
  }
}
