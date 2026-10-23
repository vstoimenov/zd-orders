// Tells a shop's own site what happened to one of its orders here: a waybill was made, cancelled, or the order was cancelled.
// WooCommerce (source 'woocommerce') gets it at <restUrl>/ordyx/v1/order, a custom site (source 'api') at its webhookUrl.
// Signed with the shop's key; only to a URL on the shop's own domain; a slow or failing site never fails the waybill — the
// error shows in the key status and the night job tries again.
import { createHmac } from 'node:crypto';
import { keyStatus, shopKeySecret, noteKeyUse } from './shop-keys.js';
import { ensureConfirmToken } from './orders-repo.js';
import { trackUrl as econtTrack } from './econt-api.js';
import { trackUrl as speedyTrack } from './speedy-api.js';

export const SITE_TIMEOUT_MS = 5000;
const COURIER_NAME = { econt: 'Еконт', speedy: 'Спиди', boxnow: 'BOX NOW' };
const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const trackUrlOf = (courier, n) => (courier === 'econt' ? econtTrack(n) : courier === 'speedy' ? speedyTrack(n) : null);

/** Signs a body the way the plugin checks it: HMAC-SHA256(key, `${timestamp}.${body}`). */
export function signBody(key, body, timestamp = Math.floor(Date.now() / 1000)) {
  return { timestamp: String(timestamp), signature: createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex') };
}

/**
 * event: 'shipped' (a live waybill) | 'waybill_cancelled' | 'cancelled' (the order). Returns true when the site took it.
 * Never throws; only orders a site sent with its key (source 'woocommerce' or 'api') are announced.
 */
export async function notifySite(q, orderId, event) {
  let shopId = null;
  try {
    const [o] = await q(`select o.id, o.shop_id, o.cb_order_id, o.source, o.waybill_number, o.waybill_courier, o.waybill_demo, s.domain
      from zd.orders o join zd.shops s on s.id = o.shop_id where o.id = $1::uuid`, [orderId]);
    if (!o || !['woocommerce', 'api'].includes(o.source)) return false;
    shopId = o.shop_id;
    const st = await keyStatus(q, o.shop_id);
    const key = await shopKeySecret(q, o.shop_id);
    const target = o.source === 'woocommerce' ? (st.restUrl ? `${st.restUrl.replace(/\/$/, '')}/ordyx/v1/order` : '') : st.webhookUrl;
    if (!target || !key) return false; // no site to tell: nothing waits either
    if (host(target) !== String(o.domain).replace(/^www\./, '').toLowerCase()) {
      await noteKeyUse(q, o.shop_id, { lastError: `Сайтът ${host(target) || target} не е домейнът на магазина (${o.domain}) — обратната връзка е спряна` });
      return false;
    }
    const live = o.waybill_number && !['creating', 'unknown'].includes(o.waybill_number) && !o.waybill_demo;
    const externalId = String(o.cb_order_id).replace(/^.*:(wc|ext)-/, '');
    const body = JSON.stringify({
      api: 1, event, ...(o.source === 'woocommerce' ? { wcId: externalId } : { externalId }),
      number: event === 'shipped' && live ? o.waybill_number : '', courier: event === 'shipped' && live ? o.waybill_courier : '',
      courierName: event === 'shipped' && live ? COURIER_NAME[o.waybill_courier] || '' : '',
      trackUrl: event === 'shipped' && live ? trackUrlOf(o.waybill_courier, o.waybill_number) : null,
      trackingPage: `${base()}/p/${await ensureConfirmToken(q, o.id)}`,
    });
    const { timestamp, signature } = signBody(key, body);
    const res = await fetch(target, {
      method: 'POST', body, signal: AbortSignal.timeout(SITE_TIMEOUT_MS), redirect: 'manual', // a redirect would turn the POST into a GET
      headers: { 'Content-Type': 'application/json', 'X-Ordyx-Timestamp': timestamp, 'X-Ordyx-Signature': signature },
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`сайтът пренасочва (${res.status}) — в WordPress → Settings адресът на сайта трябва да е точният (https)`);
    if (!res.ok) throw new Error(`сайтът отговори ${res.status}`);
    await q(`update zd.orders set site_notify = '' where id = $1::uuid`, [o.id]);
    await noteKeyUse(q, o.shop_id, { lastCallbackAt: new Date().toISOString(), lastError: null });
    return true;
  } catch (err) {
    console.error('[woo] callback failed', orderId, event, err?.message);
    if (shopId) {
      await q(`update zd.orders set site_notify = $2 where id = $1::uuid`, [orderId, event]).catch(() => {}); // the night job tries again
      await noteKeyUse(q, shopId, { lastError: `Обратна връзка към сайта (${event}): ${err?.message || err}` }).catch(() => {});
    }
    return false;
  }
}

/** Callbacks the site did not take (last 3 days): tried again by the nightly job. */
export async function retryCallbacks(q) {
  const rows = await q(`select id, site_notify from zd.orders where site_notify <> '' and source in ('woocommerce', 'api') and created_at > now() - interval '3 days' order by created_at limit 200`);
  let delivered = 0;
  for (const r of rows) if (await notifySite(q, r.id, r.site_notify)) delivered++;
  return { retried: rows.length, delivered };
}
