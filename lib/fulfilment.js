// A shop's fulfilment warehouse: Ordyx sends it the orders that are ready to ship (signed webhook), the warehouse packs them,
// makes the waybill with its own courier account and reports back through api/fulfilment.js with the same key (Bearer).
// One generic integration — no code per warehouse. Ordyx makes no waybills for a shop with the warehouse on.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { open } from './secretbox.js';

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
  await saveIntegration(q, PROVIDER, { config: { url: u, sendOn: on, enabled: true, lastError: null }, shopId });
  return fulfilmentStatus(q, shopId);
}

/** Nothing new is sent; the key keeps accepting the warehouse's reports about parcels already there. */
export async function pauseFulfilment(q, shopId) { await saveIntegration(q, PROVIDER, { config: { enabled: false }, shopId }); }

/** Forgets the warehouse and its key — only when no order sent there is still waiting for its waybill. */
export async function deleteFulfilment(q, shopId) {
  const [{ n }] = await q(
    `select count(*)::int as n from zd.orders where shop_id = $1::uuid and fulfil_sent_at is not null and waybill_number = '' and status in ('new', 'confirmed')`,
    [shopId]);
  if (n > 0) throw new Error(`${n} поръчки са при склада и още не са изпратени`);
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

/** Orders of this shop waiting to go to the warehouse (filled in by the outbound part). */
export async function countDue(q, shopId) { // eslint-disable-line no-unused-vars
  return 0;
}

export { iso };
