// A shop's fulfilment warehouse: Ordyx sends it the orders that are ready to ship (signed webhook), the warehouse packs them,
// makes the waybill with its own courier account and reports back through api/fulfilment.js with the same key (Bearer).
// One generic integration — no code per warehouse. Ordyx makes no waybills for a shop with the warehouse on.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { open } from './secretbox.js';
import { signBody } from './woo-callback.js';
import { ensureConfirmToken } from './orders-repo.js';

export const PROVIDER = 'fulfilment';
const KEY = /^ordyx_ful_([A-Za-z0-9]{10})_[A-Za-z0-9_-]{32}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const keyId = () => Array.from(randomBytes(10), (b) => B62[b % 62]).join('');
const URL_OK = /^https:\/\/[^\s]+$/;
const SEND_ON = ['confirmed', 'new'];
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** A new warehouse key for the shop (shown once); the previous one stops working. */
export async function makeFulfilmentKey(q, shopId) {
  const id = keyId();
  const key = `ordyx_ful_${id}_${randomBytes(24).toString('base64url')}`;
  await saveIntegration(q, PROVIDER, { config: { keyId: id, createdAt: new Date().toISOString() }, secret: key, shopId });
  return { key };
}

/** The shop a warehouse key belongs to, or null (unknown, renewed, malformed). `enabled` tells whether orders are being sent. */
export async function fulfilmentByKey(q, key) {
  const m = KEY.exec(String(key || ''));
  if (!m) return null;
  const [r] = await q(
    `select i.shop_id, i.secret_enc, i.config, s.name from zd.integrations i join zd.shops s on s.id = i.shop_id
     where i.provider = $1 and i.config->>'keyId' = $2`, [PROVIDER, m[1]]);
  if (!r?.secret_enc) return null;
  const a = Buffer.from(open(r.secret_enc)), b = Buffer.from(String(key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : r.config || {};
  return { shopId: r.shop_id, name: r.name, enabled: cfg.enabled === true };
}

/** The sealed key itself, for signing what Ordyx sends to the warehouse. */
export const fulfilmentSecret = (q, shopId) => getSecret(q, PROVIDER, shopId);

export async function noteFulfilment(q, shopId, patch) { await saveIntegration(q, PROVIDER, { config: patch, shopId }); }

/** The warehouse's address and when orders go there; saving turns the integration on. Throws Bulgarian messages. */
export async function saveFulfilment(q, shopId, { url, sendOn } = {}) {
  const u = String(url || '').trim();
  if (!URL_OK.test(u) || u.length > 300) throw new Error('Адресът на склада трябва да започва с https://');
  const on = SEND_ON.includes(sendOn) ? sendOn : 'confirmed';
  const cur = await getIntegration(q, PROVIDER, shopId);
  // orders open before the shop connected are not sent by themselves (the shop may have shipped them already): only by „Изпрати неизпратените“
  const connectedAt = cur.config.connectedAt || new Date().toISOString();
  await saveIntegration(q, PROVIDER, { config: { url: u, sendOn: on, enabled: true, connectedAt, lastError: null }, shopId });
  return fulfilmentStatus(q, shopId);
}

/** Nothing new is sent; the key keeps accepting the warehouse's reports about parcels already there. */
export async function pauseFulfilment(q, shopId) { await saveIntegration(q, PROVIDER, { config: { enabled: false }, shopId }); }

/** Forgets the warehouse and its key — only when no order sent there still waits for its waybill and no cancel is still to be told. */
export async function deleteFulfilment(q, shopId) {
  const [{ n, c }] = await q(
    `select count(*) filter (where fulfil_sent_at is not null and waybill_number = '' and status in ('new', 'confirmed'))::int as n,
            count(*) filter (where fulfil_notify = 'cancelled')::int as c from zd.orders where shop_id = $1::uuid`,
    [shopId]);
  if (n > 0) throw new Error(`${n} поръчки са при склада и още не са изпратени`);
  if (c > 0) throw new Error(`${c} отказа чакат да стигнат до склада — опитайте „Изпрати неизпратените“ или малко по-късно`);
  await q(`delete from zd.integrations where provider = $1 and shop_id = $2::uuid`, [PROVIDER, shopId]);
}

export async function fulfilmentEnabled(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  return i.config.enabled === true;
}

/** What the admin may see — never the key. */
export async function fulfilmentStatus(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  const c = i.config;
  return {
    enabled: c.enabled === true, url: c.url || '', sendOn: SEND_ON.includes(c.sendOn) ? c.sendOn : 'confirmed', keyId: c.keyId || '', hasKey: i.hasSecret,
    createdAt: c.createdAt || null, lastSentAt: c.lastSentAt || null, lastReceivedAt: c.lastReceivedAt || null, lastError: c.lastError || null,
    due: c.enabled === true ? await countDue(q, shopId) : 0,
  };
}

/* ---- orders → warehouse ---- */

/** Paid at order time: no confirmation request is sent, so the order is ready at once. Anything else (cod, '', bank, …) waits. */
const PAID = ['card', 'paid'];
const isCod = (pm) => !PAID.includes(String(pm || ''));

/**
 * Which orders go to the warehouse: not sent yet, no waybill, not held by a ConvertBuilder check; confirmed by the customer — or
 * still new when the shop sends at once (`sendOn = 'new'`) or the order is paid (card: it never gets a confirmation request).
 * `o` = zd.orders, `c` = the shop's fulfilment integration row.
 */
export const DUE_SQL = `o.fulfil_sent_at is null and o.waybill_number = '' and o.cb_check <> 'pending'
  and (o.status = 'confirmed' or (o.status = 'new' and (c.config->>'sendOn' = 'new' or o.payment_method = any('{${PAID.join(',')}}'::text[]))))`;
const INTEGRATION_JOIN = `join zd.integrations c on c.shop_id = o.shop_id and c.provider = '${PROVIDER}'`;
const ENABLED = `c.config->>'enabled' = 'true'`;

/** The same rule for one loaded row and its integration config. */
export function isDue(o, cfg) {
  if (!cfg || cfg.enabled !== true) return false;
  if (o.fulfil_sent_at || o.waybill_number !== '' || o.cb_check === 'pending') return false;
  if (o.status === 'confirmed') return true;
  return o.status === 'new' && (cfg.sendOn === 'new' || !isCod(o.payment_method));
}

const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const num = (v) => Math.round(Number(v || 0) * 100) / 100;

/** The body the warehouse gets for a new order (spec: event 'order'). */
export async function buildOrderBody(q, r) {
  const items = (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) || [];
  const noSku = items.filter((it) => !it.sku).map((it) => String(it.name || ''));
  const skus = new Map();
  if (noSku.length) {
    for (const p of await q(`select name, sku from zd.product_costs where shop_id = $1::uuid and sku <> '' and name = any($2::text[])`, [r.shop_id, noSku])) skus.set(p.name, p.sku);
  }
  const t = String(r.delivery_type || '');
  const office = /_(office|locker)$/.test(t) ? { id: r.office_id || '', code: String(r.office_id || '').replace(/^[^:]*:/, ''), text: r.office_text || '' } : null;
  const address = /_address$/.test(t) ? { city: r.city || '', post_code: r.post_code || '', street: r.address_text || '' } : null;
  const delivery = { type: t, courier: r.courier || '', office, address, ...(t === 'other' ? { text: r.office_text || '' } : {}) };
  const cod = isCod(r.payment_method);
  const body = {
    api: 1, event: 'order',
    order: {
      id: r.id, number: r.cb_order_id, created_at: new Date(r.created_at).toISOString(), status: r.status,
      customer: { name: String(r.name || '').trim(), phone: r.phone_norm || r.phone || '', email: r.email || '' },
      delivery,
      items: items.map((it) => ({ sku: String(it.sku || skus.get(String(it.name || '')) || ''), name: String(it.name || ''), qty: Number(it.qty) || 1, price: num(it.price) })),
      total: num(r.total), currency: r.currency || 'EUR',
      payment: { method: cod ? 'cod' : r.payment_method, cod_amount: cod ? num(r.total) : 0 },
      tracking_page: `${base()}/p/${await ensureConfirmToken(q, r.id)}`,
    },
  };
  if (r.is_duplicate) body.duplicate = true;
  return body;
}

const TIMEOUT_MS = 5000;
async function target(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  const key = i.hasSecret ? await fulfilmentSecret(q, shopId) : null;
  return { cfg: i.config, url: i.config.url || '', key };
}
/** A success means the warehouse works: the error clears — unless it names one refused order, which stays until the shop deals with it. */
const PER_ORDER = 'Поръчка ';
const afterSuccess = (cfg) => ({ lastSentAt: new Date().toISOString(), ...(String(cfg.lastError || '').startsWith(PER_ORDER) ? {} : { lastError: null }) });

/** A clear refusal (4xx) is about this order, not the warehouse: the others are still tried. */
class Rejected extends Error {}

async function post(url, key, body, fetchImpl, timeoutMs) {
  const { timestamp, signature } = signBody(key, body);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: { 'Content-Type': 'application/json', 'X-Ordyx-Timestamp': timestamp, 'X-Ordyx-Signature': signature },
    });
  } catch {
    throw new Error('складът не отговаря');
  }
  if (res.status >= 300 && res.status < 400) throw new Error(`складът пренасочва (${res.status})`);
  if (res.status >= 400 && res.status < 500) throw new Rejected(`складът отговори ${res.status}`);
  if (!res.ok) throw new Error(`складът отговори ${res.status}`);
}

/**
 * Sends one event ('order' | 'cancelled') for the order to its shop's warehouse. Returns true when nothing is left to do (the
 * warehouse took it, or it was no longer needed), false when the warehouse failed (the event waits in fulfil_notify and the error
 * shows in the integration), 'rejected' when the warehouse refused this order (4xx). Never throws.
 * An 'order' is claimed first ('sending'), so two callers make one call and a cancel that lands meanwhile goes right after it.
 * A paused integration still gets cancels.
 */
export async function sendEvent(q, orderId, event, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let shopId = null, claimed = false;
  try {
    const [r] = await q(`select o.*, c.config as ful_config from zd.orders o left join zd.integrations c on c.shop_id = o.shop_id and c.provider = '${PROVIDER}' where o.id = $1::uuid`, [orderId]);
    if (!r) return true;
    shopId = r.shop_id;
    const cfg = typeof r.ful_config === 'string' ? JSON.parse(r.ful_config) : r.ful_config || {};
    const { url, key } = await target(q, shopId);
    if (event === 'order') {
      if (!isDue(r, cfg)) { // cancelled, shipped or sent meanwhile: nothing to send any more
        if (r.fulfil_notify === 'order') await q(`update zd.orders set fulfil_notify = '' where id = $1::uuid and fulfil_notify = 'order'`, [r.id]);
        return true;
      }
      if (!url || !key) { await noteFulfilment(q, shopId, { lastError: !url ? 'Въведете адреса на склада' : 'Няма ключ — направете ключ и го дайте на склада' }); return false; }
      const got = await q(`update zd.orders set fulfil_notify = 'sending' where id = $1::uuid and fulfil_sent_at is null and fulfil_notify <> 'sending' returning id`, [r.id]);
      if (!got.length) return true; // another caller is sending it right now
      claimed = true;
      await post(url, key, JSON.stringify(await buildOrderBody(q, r)), fetchImpl, timeoutMs);
      const [done] = await q(`update zd.orders set fulfil_sent_at = now(), fulfil_notify = '' where id = $1::uuid and fulfil_notify = 'sending' returning status`, [r.id]);
      await noteFulfilment(q, shopId, afterSuccess(cfg));
      if (done?.status === 'cancelled') await queueCancel(q, r.id, { fetchImpl, timeoutMs }); // cancelled while on its way: the warehouse hears it at once
      return true;
    }
    if (!r.fulfil_sent_at) { await q(`update zd.orders set fulfil_notify = '' where id = $1::uuid and fulfil_notify = 'cancelled'`, [r.id]); return true; } // never got there
    if (!url || !key) return false;
    await post(url, key, JSON.stringify({ api: 1, event, order: { id: r.id, number: r.cb_order_id } }), fetchImpl, timeoutMs);
    await q(`update zd.orders set fulfil_sent_at = null, fulfil_notify = '' where id = $1::uuid`, [r.id]);
    await noteFulfilment(q, shopId, afterSuccess(cfg));
    return true;
  } catch (err) {
    console.error('[fulfilment] send failed', orderId, event, err?.message);
    if (shopId) {
      if (claimed) await q(`update zd.orders set fulfil_notify = 'order' where id = $1::uuid and fulfil_notify = 'sending'`, [orderId]).catch(() => {});
      else if (event === 'cancelled') await q(`update zd.orders set fulfil_notify = 'cancelled' where id = $1::uuid`, [orderId]).catch(() => {});
      const what = event === 'cancelled' ? 'отказ' : 'поръчка';
      const text = err instanceof Rejected ? `${PER_ORDER}${orderId}: ${err.message} — провери я или я откажи` : `Към склада (${what}): ${err?.message || err}`;
      await noteFulfilment(q, shopId, { lastError: text }).catch(() => {});
    }
    return err instanceof Rejected ? 'rejected' : false;
  }
}

/** The order just became ready (confirmed / created): to the warehouse at once when it is due. Never throws. */
export async function queueFulfilment(q, orderId, opts = {}) {
  try {
    const [r] = await q(`select o.*, c.config as ful_config from zd.orders o left join zd.integrations c on c.shop_id = o.shop_id and c.provider = '${PROVIDER}' where o.id = $1::uuid`, [orderId]);
    if (!r) return;
    const cfg = typeof r.ful_config === 'string' ? JSON.parse(r.ful_config) : r.ful_config;
    if (!isDue(r, cfg) || r.fulfil_notify === 'sending') return;
    await q(`update zd.orders set fulfil_notify = 'order' where id = $1::uuid and fulfil_notify = ''`, [orderId]);
    await sendEvent(q, orderId, 'order', opts);
  } catch (err) {
    console.error('[fulfilment] queue failed', orderId, err?.message);
  }
}

/**
 * The order was cancelled: the warehouse hears it when it already has the order. One still on its way ('sending') is told right
 * after the send lands (sendEvent checks the status then). Never throws.
 */
export async function queueCancel(q, orderId, opts = {}) {
  try {
    const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [orderId]);
    if (!r) return;
    if (r.fulfil_notify === 'sending') return;
    if (!r.fulfil_sent_at) { await q(`update zd.orders set fulfil_notify = '' where id = $1::uuid and fulfil_notify = 'order'`, [orderId]); return; }
    await q(`update zd.orders set fulfil_notify = 'cancelled' where id = $1::uuid`, [orderId]);
    await sendEvent(q, orderId, 'cancelled', opts);
  } catch (err) {
    console.error('[fulfilment] cancel failed', orderId, err?.message);
  }
}

const RETRY_DAYS = 30;
// due orders of a shop with the warehouse on (only those that came after it connected, unless `all`), plus every cancel still to be told
const waiting = (all) => `o.created_at > now() - interval '${RETRY_DAYS} days' and (
    o.fulfil_notify = 'cancelled'
    or (${ENABLED} ${all ? '' : `and o.created_at > coalesce((c.config->>'connectedAt')::timestamptz, 'epoch'::timestamptz)`} and (${DUE_SQL})))`;

/**
 * Orders still to go to the warehouse (due, or an event that did not get through) — oldest first, within a time budget; a shop
 * whose warehouse fails (no answer, 5xx, redirect) is left for the next run, a refused order (4xx) only skips itself.
 * Nightly, when the shop opens Поръчки, and (with `all`) on „Изпрати неизпратените“.
 */
export async function retryDue(q, { shopId = null, budgetMs = 15000, max = Infinity, all = false, fetchImpl } = {}) {
  const rows = await q(`select o.id, o.shop_id, o.fulfil_notify from zd.orders o ${INTEGRATION_JOIN} where ${waiting(all)} and ($1::uuid is null or o.shop_id = $1::uuid) order by o.created_at limit 500`, [shopId]);
  const deadline = Date.now() + budgetMs, failed = new Set();
  let retried = 0, sent = 0;
  for (const r of rows) {
    const left = deadline - Date.now();
    if (retried >= max || left <= 0 || failed.has(r.shop_id)) continue;
    retried++;
    const res = await sendEvent(q, r.id, r.fulfil_notify === 'cancelled' ? 'cancelled' : 'order', { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: Math.min(TIMEOUT_MS, left) });
    if (res === true) sent++; else if (res === false) failed.add(r.shop_id);
  }
  return { retried, sent };
}

/** Orders of this shop waiting to go to the warehouse (all of them, including those from before it connected). */
export async function countDue(q, shopId) {
  const [{ n }] = await q(`select count(*)::int as n from zd.orders o ${INTEGRATION_JOIN} where ${waiting(true)} and o.shop_id = $1::uuid`, [shopId]);
  return n;
}

/** „Тествай връзката“: a signed ping; the warehouse answers 2xx. Throws Bulgarian messages. */
export async function pingWarehouse(q, shopId, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const { url, key } = await target(q, shopId);
  if (!url) throw new Error('Въведете адреса на склада');
  if (!key) throw new Error('Първо направете ключ');
  try {
    await post(url, key, JSON.stringify({ api: 1, event: 'ping' }), fetchImpl, timeoutMs);
  } catch (err) {
    const m = String(err.message);
    throw new Error(m === 'складът не отговаря' ? 'Складът не отговаря на този адрес' : m.startsWith('складът пренасочва') ? 'Складът пренасочва — дайте крайния адрес' : 'С' + m.slice(1));
  }
  await noteFulfilment(q, shopId, { lastError: null });
  return { ok: true };
}
