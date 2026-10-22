// Per-shop API keys for servers that send orders (the WooCommerce plugin, custom sites). One key per shop, sealed like courier
// passwords (lib/secretbox.js) so Ordyx can also sign its calls back to the shop's site; making a new one stops the old at once.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getIntegration, saveIntegration } from './integrations-repo.js';
import { open } from './secretbox.js';

const PROVIDER = 'api';
const KEY = /^ordyx_live_([A-Za-z0-9]{10})_[A-Za-z0-9_-]{32}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const keyId = () => Array.from(randomBytes(10), (b) => B62[b % 62]).join('');

/** A new key for the shop (shown once); the previous one stops working. */
export async function makeShopKey(q, shopId) {
  const id = keyId();
  const key = `ordyx_live_${id}_${randomBytes(24).toString('base64url')}`;
  await saveIntegration(q, PROVIDER, { config: { keyId: id, createdAt: new Date().toISOString(), lastError: null }, secret: key, shopId });
  return { key };
}

/** The shop a key belongs to, or null (unknown, renewed, malformed). */
export async function shopByKey(q, key) {
  const m = KEY.exec(String(key || ''));
  if (!m) return null;
  const [r] = await q(
    `select i.shop_id, i.secret_enc, s.name, s.domain, s.approved, s.currency from zd.integrations i join zd.shops s on s.id = i.shop_id
     where i.provider = $1 and i.config->>'keyId' = $2`, [PROVIDER, m[1]]);
  if (!r?.secret_enc) return null;
  const a = Buffer.from(open(r.secret_enc)), b = Buffer.from(String(key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { shopId: r.shop_id, name: r.name, domain: r.domain, approved: r.approved, currency: r.currency };
}

/** The sealed key itself, for signing callbacks to the shop's site. */
export async function shopKeySecret(q, shopId) {
  const [r] = await q(`select secret_enc from zd.integrations where provider = $1 and shop_id = $2::uuid`, [PROVIDER, shopId]);
  return r?.secret_enc ? open(r.secret_enc) : null;
}

/** What the admin may see — never the key. */
export async function keyStatus(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  const c = i.config;
  return {
    hasKey: i.hasSecret, keyId: c.keyId || '', createdAt: c.createdAt || null, lastOrderAt: c.lastOrderAt || null, lastError: c.lastError || null,
    mode: c.mode || '', pluginVersion: c.pluginVersion || '', restUrl: c.restUrl || '', lastSeenAt: c.lastSeenAt || null,
  };
}

export async function noteKeyUse(q, shopId, patch) { await saveIntegration(q, PROVIDER, { config: patch, shopId }); }

/** What the sender says about itself in X-Ordyx-Site (JSON): its REST URL, mode and version. */
export function siteInfo(header) {
  try {
    const v = JSON.parse(String(header || ''));
    const restUrl = typeof v.restUrl === 'string' && /^https?:\/\/[^\s]+$/.test(v.restUrl) ? v.restUrl.slice(0, 300) : '';
    return { restUrl, mode: ['checkout', 'orders'].includes(v.mode) ? v.mode : '', pluginVersion: String(v.version || '').slice(0, 20) };
  } catch { return null; }
}

/* 600 requests an hour per key (per server instance) */
const LIMIT = 600;
const hits = new Map();
export function resetKeyLimitsForTests() { hits.clear(); }
export function overKeyLimit(id) {
  const now = Date.now();
  const list = (hits.get(id) || []).filter((t) => now - t < 3600000);
  if (hits.size > 5000) hits.clear();
  list.push(now);
  hits.set(id, list);
  return list.length > LIMIT;
}
