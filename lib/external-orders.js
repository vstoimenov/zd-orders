// Orders a shop's own site sends with its key (POST /api/orders, Authorization: Bearer ordyx_live_…): the WooCommerce plugin and
// custom sites. No Origin/ORDER_TOKEN, no per-IP limit — 600 requests an hour per key instead. GET answers „Провери връзката“.
import { getQuery } from './db.js';
import { validateOrder } from './order.js';
import { upsertExternalOrder } from './orders-repo.js';
import { shopByKey, noteKeyUse, siteInfo, overKeyLimit } from './shop-keys.js';
import { startOrder } from './cb-sync.js';
import { syncStockSafe } from './stock.js';
import { notifyOrderEvent } from './push.js';
import { queueCancel } from './fulfilment.js';
import { saveInvoice } from './invoice.js';
import { readJson, send } from './http.js';

const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SOURCES = { woocommerce: 'wc', api: 'ext' };

/** Cancelled on the shop's site: cancelled here while nothing was sent; otherwise kept, marked and the shop is told. */
async function cancelExternal(q, shopId, cbOrderId) {
  const [o] = await q(`select id, status, waybill_number from zd.orders where cb_order_id = $1 and shop_id = $2::uuid`, [cbOrderId, shopId]);
  if (!o) return { found: false };
  if (o.status === 'cancelled') return { found: true, cancelled: true }; // already (by Ordyx, or the buyer refused): nothing to tell
  const [done] = await q(`update zd.orders set status = 'cancelled', status_changed_at = now() where id = $1::uuid and waybill_number = '' and status in ('new', 'confirmed') returning id`, [o.id]);
  if (done) {
    await syncStockSafe(q, o.id); // the stock comes back
    await queueCancel(q, o.id); // the warehouse hears it when it already has the order
    return { found: true, cancelled: true };
  }
  const [changed] = await q(`update zd.orders set external_status = 'cancelled' where id = $1::uuid and external_status <> 'cancelled' returning id`, [o.id]);
  if (changed) await notifyOrderEvent(q, o.id, '⚠️ Поръчката е отказана в WooCommerce — вече е изпратена');
  return { found: true, cancelled: false };
}

export async function keyedOrders(req, res) {
  const q = getQuery();
  try {
    const shop = await shopByKey(q, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!shop) return send(res, 401, { error: 'Невалиден ключ — направете нов в Ordyx → Интеграции' });
    if (overKeyLimit(shop.shopId)) return send(res, 429, { error: 'rate' });
    if (!shop.approved) return send(res, 403, { error: 'Магазинът чака одобрение от Ordyx' });
    const site = siteInfo(req.headers['x-ordyx-site']);
    // what the site reports about itself; a custom site may also clear its webhook by sending webhookUrl: ''
    const seen = { lastSeenAt: new Date().toISOString(), ...(site ? Object.fromEntries(Object.entries(site).filter(([k, v]) => v || k === 'webhookUrl')) : {}) };
    if (req.method === 'GET') {
      await noteKeyUse(q, shop.shopId, seen);
      return send(res, 200, { ok: true, shop: { name: shop.name, domain: shop.domain } });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const body = readJson(req) || {};
    const source = Object.hasOwn(SOURCES, body.source) ? body.source : 'api';
    const externalId = String(body.external_id ?? '');
    if (!EXTERNAL_ID.test(externalId)) return send(res, 400, { error: 'external_id required' });
    const cbOrderId = `${shop.domain}:${SOURCES[source]}-${externalId}`;
    if (body.status === 'cancelled') {
      const r = await cancelExternal(q, shop.shopId, cbOrderId);
      return r.found ? send(res, 200, { ok: true, cancelled: r.cancelled }) : send(res, 404, { error: 'not found' });
    }
    // cash on delivery stays so even when the site later marks the order paid; anything else arrives only once paid
    const cod = body.payment_method === 'cod' || body.paid !== true;
    const v = validateOrder({ ...body, cb_order_id: externalId, payment_method: cod ? 'cod' : 'card' });
    if (!v.ok) {
      await noteKeyUse(q, shop.shopId, { ...seen, lastError: `Поръчка ${externalId}: ${v.error}` });
      return send(res, 400, { error: v.error });
    }
    const r = await upsertExternalOrder(q, { ...v.order, cbOrderId, shopId: shop.shopId, source });
    if (r.id && (r.inserted || r.updated)) await saveInvoice(q, r.id, v.order.invoice, { onlyIfEmpty: true }).catch((err) => console.error('[orders] invoice', err.message));
    if (r.conflict) return send(res, 409, { error: 'Този номер вече е зает от поръчка на друг източник' });
    // stock, the shop's phone, the WhatsApp confirmation (cash on delivery only); nekorekten.com is checked right after, not now —
    // the site waits for this answer and must not time out
    if (r.inserted) await startOrder(q, { id: r.id, phoneNorm: v.order.phoneNorm }, '[orders:key]', { confirm: cod, nekorekten: false });
    else if (r.updated) await syncStockSafe(q, r.id);
    await noteKeyUse(q, shop.shopId, { ...seen, lastOrderAt: new Date().toISOString(), lastError: null });
    return send(res, 200, { ok: true, inserted: r.inserted, updated: r.updated, locked: r.locked, duplicate: r.duplicate });
  } catch (err) {
    console.error('[orders:key] failed', err);
    return send(res, 500, { error: 'server' });
  }
}
