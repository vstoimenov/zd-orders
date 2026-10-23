// What the shop's fulfilment warehouse reports back (api/fulfilment.js, Bearer = the warehouse key): the waybill it made and the
// parcel's progress. A waybill from here is "external": Ordyx neither refreshes nor cancels it; the buyer's page tracks it.
import { getQuery } from './db.js';
import { fulfilmentByKey, noteFulfilment } from './fulfilment.js';
import { overKeyLimit } from './shop-keys.js';
import { notifySite } from './woo-callback.js';
import { notifyOrderEvent } from './push.js';
import { syncStockSafe } from './stock.js';
import { readJson, send } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COURIERS = ['econt', 'speedy', 'boxnow', 'other'];
const EVENTS = ['shipped', 'delivered', 'returned', 'cancelled'];
const OPEN = ['new', 'confirmed'];
const NOT_FOUND = { status: 404, body: { error: 'Няма такава поръчка' } };
const bad = (error) => ({ status: 400, body: { error } });
const SHIPPED_STATUS = 'Изпратена от склада';
const DONE_STATUS = { delivered: 'Доставена', returned: 'Върната' };

/** One report about one order of the key's shop → what to answer. Throws only on a database failure. */
export async function applyReport(q, shopId, body) {
  const b = body || {};
  const id = String(b.order_id || '');
  if (!UUID.test(id)) return NOT_FOUND;
  const [o] = await q(`select id, status, waybill_number, external_status from zd.orders where id = $1::uuid and shop_id = $2::uuid`, [id, shopId]);
  if (!o) return NOT_FOUND;
  if (!EVENTS.includes(b.event)) return bad('Непознато събитие');
  await noteFulfilment(q, shopId, { lastReceivedAt: new Date().toISOString() });

  if (b.event === 'shipped') {
    const w = b.waybill || {};
    const number = String(w.number || '').trim();
    if (!number || number.length > 40 || ['creating', 'unknown'].includes(number)) return bad('waybill.number е задължителен (до 40 знака)');
    if (!COURIERS.includes(w.courier)) return bad('waybill.courier трябва да е econt, speedy, boxnow или other');
    const trackUrl = typeof w.track_url === 'string' && /^https:\/\/[^\s]+$/.test(w.track_url) ? w.track_url.slice(0, 300) : '';
    // the row decides, not an earlier read: a buyer's cancel or a second report landing meanwhile is seen here
    const [was] = await q(
      `with before as (select id, status, waybill_number, waybill_external, external_status from zd.orders where id = $1::uuid for update)
       update zd.orders o set waybill_number = $2, waybill_courier = $3, waybill_external = true, waybill_track_url = $4, waybill_demo = false,
         waybill_status = case when o.status in ('delivered', 'returned') then o.waybill_status else $5 end,
         waybill_created_at = coalesce(o.waybill_created_at, now()), waybill_checked_at = null, waybill_refresh_at = null,
         status = case when o.status = any($6::text[]) then 'shipped' else o.status end,
         status_changed_at = case when o.status = any($6::text[]) then now() else o.status_changed_at end,
         fulfil_notify = case when o.fulfil_notify in ('order', 'sending') then '' else o.fulfil_notify end,
         external_status = case when o.status = 'cancelled' then 'shipped_after_cancel' else o.external_status end
       from before where o.id = before.id and (before.waybill_number = '' or before.waybill_external)
       returning before.status as prev_status, before.waybill_number as prev_number, before.external_status as prev_external`,
      [o.id, number, w.courier, trackUrl, SHIPPED_STATUS, OPEN]);
    if (!was) { // an Ordyx waybill already exists: two parcels — the shop must sort it out, the record stays as it is
      await notifyOrderEvent(q, o.id, '⚠️ Складът изпрати поръчка, която вече има товарителница');
      return { status: 409, body: { error: 'Поръчката вече има товарителница, направена в Ordyx — свържете се с магазина' } };
    }
    if (was.prev_status === 'cancelled') { // a real parcel, maybe with cash on delivery: recorded and flagged, the order stays cancelled
      if (was.prev_external !== 'shipped_after_cancel') await notifyOrderEvent(q, o.id, '⚠️ Складът изпрати отказана поръчка');
      return { status: 200, body: { ok: true, status: 'cancelled', warning: 'Поръчката е отказана в Ordyx — пратката е записана, магазинът е предупреден' } };
    }
    if (!was.prev_number) { // the first report; a corrected number later changes nothing else
      await syncStockSafe(q, o.id);
      await notifySite(q, o.id, 'shipped'); // the shop's own site gets the number and the tracking page, as for Ordyx waybills
      await notifyOrderEvent(q, o.id, '📦 Складът изпрати поръчката');
    }
    return { status: 200, body: { ok: true, status: 'shipped' } };
  }

  if (b.event === 'delivered' || b.event === 'returned') {
    const moved = await q(`update zd.orders set status = $2, status_changed_at = now(), waybill_status = $3 where id = $1::uuid and status = 'shipped' returning id`,
      [o.id, b.event, DONE_STATUS[b.event]]);
    if (!moved.length) return { status: 200, body: { ok: true, applied: false } };
    await syncStockSafe(q, o.id);
    return { status: 200, body: { ok: true, status: b.event } };
  }

  // cancelled: the warehouse cannot fulfil it — only while nothing was shipped
  // the warehouse gives the order back: it is no longer "at the warehouse", so a re-opened order can be sent again or get an Ordyx waybill
  const done = await q(`update zd.orders set status = 'cancelled', status_changed_at = now(), fulfil_notify = '', fulfil_sent_at = null where id = $1::uuid and status = any($2::text[]) and waybill_number = '' returning id`, [o.id, OPEN]);
  if (!done.length) return { status: 200, body: { ok: true, applied: false } };
  await syncStockSafe(q, o.id);
  await notifySite(q, o.id, 'cancelled');
  await notifyOrderEvent(q, o.id, '❌ Складът отказа поръчката');
  return { status: 200, body: { ok: true, status: 'cancelled' } };
}

/** POST /api/fulfilment with the warehouse key; GET = ping. */
export default async function inboundHandler(req, res) {
  const q = getQuery();
  try {
    const shop = await fulfilmentByKey(q, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!shop) return send(res, 401, { error: 'Невалиден ключ — направете нов в Ordyx → Интеграции → Fulfilment склад' });
    if (overKeyLimit(`ful:${shop.shopId}`)) return send(res, 429, { error: 'rate' });
    if (req.method === 'GET') return send(res, 200, { ok: true, shop: shop.name });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const r = await applyReport(q, shop.shopId, readJson(req) || {});
    return send(res, r.status, r.body);
  } catch (err) {
    console.error('[fulfilment] report failed', err);
    return send(res, 500, { error: 'server' });
  }
}
