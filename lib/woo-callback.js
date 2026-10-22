// Tells a shop's own site (the WooCommerce plugin) what happened to one of its orders here: a waybill was made, cancelled, or the
// order was cancelled. Signed with the shop's key; only to a URL on the shop's own domain; a slow or failing site never
// fails the waybill — the error shows in the key status instead.
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
 * Never throws; only WooCommerce orders (source 'woocommerce') are announced.
 */
export async function notifySite(q, orderId, event) {
  let shopId = null;
  try {
    const [o] = await q(`select o.id, o.shop_id, o.cb_order_id, o.source, o.waybill_number, o.waybill_courier, o.waybill_demo, s.domain
      from zd.orders o join zd.shops s on s.id = o.shop_id where o.id = $1::uuid`, [orderId]);
    if (!o || o.source !== 'woocommerce') return false;
    shopId = o.shop_id;
    const st = await keyStatus(q, o.shop_id);
    const key = await shopKeySecret(q, o.shop_id);
    if (!st.restUrl || !key) return false;
    if (host(st.restUrl) !== String(o.domain).replace(/^www\./, '').toLowerCase()) {
      await noteKeyUse(q, o.shop_id, { lastError: `Сайтът ${host(st.restUrl) || st.restUrl} не е домейнът на магазина (${o.domain}) — обратната връзка е спряна` });
      return false;
    }
    const live = o.waybill_number && !['creating', 'unknown'].includes(o.waybill_number) && !o.waybill_demo;
    const body = JSON.stringify({
      api: 1, event, wcId: String(o.cb_order_id).replace(/^.*:wc-/, ''),
      number: event === 'shipped' && live ? o.waybill_number : '', courier: event === 'shipped' && live ? o.waybill_courier : '',
      courierName: event === 'shipped' && live ? COURIER_NAME[o.waybill_courier] || '' : '',
      trackUrl: event === 'shipped' && live ? trackUrlOf(o.waybill_courier, o.waybill_number) : null,
      trackingPage: `${base()}/p/${await ensureConfirmToken(q, o.id)}`,
    });
    const { timestamp, signature } = signBody(key, body);
    const url = `${st.restUrl.replace(/\/$/, '')}/ordyx/v1/order`;
    const res = await fetch(url, {
      method: 'POST', body, signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'X-Ordyx-Timestamp': timestamp, 'X-Ordyx-Signature': signature },
    });
    if (!res.ok) throw new Error(`сайтът отговори ${res.status}`);
    await noteKeyUse(q, o.shop_id, { lastCallbackAt: new Date().toISOString(), lastError: null });
    return true;
  } catch (err) {
    console.error('[woo] callback failed', orderId, event, err?.message);
    if (shopId) await noteKeyUse(q, shopId, { lastError: `Обратна връзка към сайта (${event}): ${err?.message || err}` }).catch(() => {});
    return false;
  }
}
