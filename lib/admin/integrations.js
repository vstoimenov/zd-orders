import { randomBytes } from 'node:crypto';
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { getIntegration, saveIntegration, getSecret } from '../integrations-repo.js';
import { getCheckoutText, saveCheckoutText } from '../checkout-info.js';
import { DEFAULT_SHOP, resolveShop, updateShop, claimDomain } from '../shops.js';
import { normalizeDomain, testConnection, ensureWebhook, removeWebhook } from '../convertbuilder.js';
import { syncOrders } from '../cb-sync.js';
import { readJson, send, searchParams } from '../http.js';
import { humanize } from '../errors-bg.js';
import { assertReady } from '../secretbox.js';
import { connectWhatsApp, whatsappStatus, submitTemplate, refreshTemplate, setAutoConfirm, disconnectWhatsApp, sendTest, waAppReady } from '../whatsapp.js';
import { econtProfile, saveEcont, econtStatus, syncEcontStatuses, speedyProfile, saveSpeedy, speedyStatus, syncSpeedyStatuses, boxnowProfile, saveBoxnow, boxnowStatus, syncBoxnowStatuses } from '../waybills.js';
import { normalizeAccountId, testAccount, syncMeta, metaConfig, listAdAccounts, metaAppConfigured, savePlatform, partnerStatus, linkPartnerAccount } from '../meta.js';
import { notifyOwner } from '../push.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const fail = (res, err) => send(res, 400, { error: humanize(err) });

// each shop's webhook carries ?shop=<id>; the default shop keeps the plain address it was first registered with
const webhookTarget = (shopId) => `${base()}/api/cb/webhook${shopId === DEFAULT_SHOP ? '' : `?shop=${shopId}`}`;

async function status(q, shop) {
  const [cb, meta, offices, econtApi, speedyApi, whatsapp, boxnow, boxnowApi, checkout] = await Promise.all([
    getIntegration(q, 'convertbuilder', shop.id),
    getIntegration(q, 'meta', shop.id),
    q(`select courier, count(*)::int as n, max(updated_at) as updated from zd.offices group by courier`),
    econtStatus(q, shop.id),
    speedyStatus(q, shop.id),
    whatsappStatus(q, shop.id),
    getIntegration(q, 'boxnow', shop.id),
    boxnowStatus(q, shop.id),
    getCheckoutText(q, shop.id),
  ]);
  const c = cb.config;
  const byCourier = Object.fromEntries(offices.map((r) => [r.courier, { offices: r.n, updatedAt: r.updated ? new Date(r.updated).toISOString() : null }]));
  return {
    shop,
    convertbuilder: {
      configured: cb.hasSecret, connected: cb.hasSecret && c.active !== false && Boolean(c.domain), domain: c.domain || '', active: c.active !== false,
      webhook: Boolean(c.webhookId), connectedAt: c.connectedAt || null, lastSyncAt: c.lastSyncAt || null, lastSyncResult: c.lastSyncResult || null,
      lastError: c.lastError || null,
    },
    nekorekten: { enabled: Boolean(process.env.NEKOREKTEN_API_KEY) }, // platform service, key only in the platform's env
    econt: byCourier.econt || { offices: 0, updatedAt: null },
    speedy: byCourier.speedy || { offices: 0, updatedAt: null },
    boxnow: { ...(byCourier.boxnow || { offices: 0, updatedAt: null }), checkout: boxnow.config.checkout === true }, // lockers in this shop's checkout
    econtApi, // waybills with the shop's own e-Econt profile
    speedyApi, // waybills with the shop's own Speedy contract
    boxnowApi, // waybills with the shop's own BOX NOW Partner API client
    checkout, // texts the widget shows (delivery-time line per courier)
    whatsapp, // the shop's own WhatsApp Business number (Embedded Signup)
    meta: {
      configured: meta.hasSecret || meta.config.mode === 'partner', mode: meta.config.mode || '', partner: await partnerStatus(q),
      connected: (meta.hasSecret || meta.config.mode === 'partner') && meta.config.active !== false && Boolean(meta.config.accountId),
      accountId: meta.config.accountId || '', accountName: meta.config.accountName || '', currency: meta.config.currency || '',
      oauth: metaAppConfigured(), tokenExpiresAt: meta.config.tokenExpiresAt || null,
      active: meta.config.active !== false, lastSyncAt: meta.config.lastSyncAt || null, lastSyncResult: meta.config.lastSyncResult || null,
      lastError: meta.config.lastError || null,
    },
  };
}

async function saveConvertBuilder(q, b, shop) {
  assertReady(); // nothing may change at ConvertBuilder if the key could not be stored afterwards
  const shopId = shop.id;
  const domain = normalizeDomain(b.domain);
  if (shop.domain === 'shop.local') throw new Error('Първо въведете домейна на магазина (където е чекаутът) в „Данни за магазина“');
  // orders are keyed by the shop's domain — the same key the checkout widget uses, so the two never split an order
  const store = shop.domain;
  const current = await getIntegration(q, 'convertbuilder', shopId);
  const typedKey = String(b.apiKey || '').trim();
  // the stored key only ever goes to the domain it was saved for
  if (!typedKey && (!current.hasSecret || current.config.domain !== domain)) {
    throw new Error(current.hasSecret ? 'При смяна на домейна въведете API ключа отново' : 'Въведете API ключ');
  }
  const apiKey = typedKey || (await getSecret(q, 'convertbuilder', shopId));
  const cfg = { domain, apiKey };
  const target = webhookTarget(shopId);
  const config = { domain, store, currency: shop.currency, lastError: null };
  if (b.active === false) {
    // switching off must work even with a revoked key: remove our webhook if ConvertBuilder still lets us
    try { await removeWebhook(cfg, target); } catch (err) { console.error('[admin] webhook removal failed', err.message); }
    await saveIntegration(q, 'convertbuilder', { config: { ...config, active: false, webhookId: null, webhookSecret: null }, secret: typedKey || undefined, shopId });
    return { active: false };
  }
  const test = await testConnection(cfg);
  Object.assign(config, { active: true, connectedAt: new Date().toISOString(), webhookSecret: randomBytes(32).toString('hex') });
  try {
    config.webhookId = (await ensureWebhook(cfg, target, config.webhookSecret)).id;
  } catch (err) {
    // the old hook may already be deleted: do not keep showing it as registered
    await saveIntegration(q, 'convertbuilder', { config: { webhookId: null }, shopId });
    throw err;
  }
  await saveIntegration(q, 'convertbuilder', { config, secret: typedKey || undefined, shopId });
  return { active: true, ...test };
}

/**
 * Meta ad account. A pasted token is reused only for the account it was saved for; a Facebook-login token (oauth) may be
 * bound to any account it can read (that is what the picker offers). Switching off needs no working token.
 */
async function saveMeta(q, b, shopId) {
  assertReady();
  const accountId = normalizeAccountId(b.accountId);
  const current = await getIntegration(q, 'meta', shopId);
  const typed = String(b.token || '').trim();
  const reusable = current.hasSecret && (current.config.oauth === true || !current.config.accountId || current.config.accountId === accountId);
  if (!typed && !reusable) {
    throw new Error(current.hasSecret ? 'При смяна на акаунта въведете ключа отново' : 'Въведете ключа (access token)');
  }
  if (b.active === false) {
    await saveIntegration(q, 'meta', { config: { accountId, active: false }, secret: typed || undefined, shopId });
    return { active: false };
  }
  const a = await testAccount({ accountId, token: typed || (await getSecret(q, 'meta', shopId)) });
  await saveIntegration(q, 'meta', {
    config: {
      accountId, accountName: a.name, currency: a.currency, active: true, connectedAt: new Date().toISOString(), lastError: null,
      ...(typed ? { oauth: false, tokenExpiresAt: null } : {}), // a pasted (System User) token replaces a Facebook login
    },
    secret: typed || undefined, shopId,
  });
  return { accountName: a.name, currency: a.currency };
}

/** GET status · POST {action}: save_convertbuilder {domain, apiKey, active} | test_convertbuilder | sync_convertbuilder {from, to}
 *  (nekorekten.com is a platform service: its key is only in the platform's env). Keys are sealed in the DB and never sent back. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  let shop;
  try { ({ shop } = await resolveShop(q, searchParams(req).get('shop'), { strict: req.method !== 'GET', user })); } catch (err) { return fail(res, err); }
  const shopId = shop.id;
  if (req.method === 'GET') {
    try { return send(res, 200, await status(q, shop)); } catch (err) { console.error('[admin] integrations', err); return send(res, 500, { error: 'server' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  try {
    switch (b.action) {
      case 'save_shop': {
        // a fresh install sets its checkout domain once; afterwards it stays (orders are keyed by it)
        if (b.domain && shop.domain === 'shop.local' && user.owner && !(await claimDomain(q, shopId, b.domain))) throw new Error('Този домейн вече е на друг магазин');
        const saved = await updateShop(q, shopId, b);
        const cb = await getIntegration(q, 'convertbuilder', shopId);
        // ConvertBuilder orders are stored in the shop's currency
        if (cb.hasSecret && cb.config.currency !== saved.currency) await saveIntegration(q, 'convertbuilder', { config: { currency: saved.currency }, shopId });
        return send(res, 200, { ok: true, shop: saved });
      }
      case 'save_meta': return send(res, 200, { ok: true, ...(await saveMeta(q, b, shopId)) });
      case 'meta_platform': // the owner's one-time setup for "Свържи чрез споделяне"
        if (!user.owner) return send(res, 403, { error: 'Само собственикът може да настрои това' });
        return send(res, 200, { ok: true, ...(await savePlatform(q, b)) });
      case 'meta_partner': {
        const linked = await linkPartnerAccount(q, { shopId, accountId: b.accountId });
        await notifyOwner(q, { title: '📊 Свързан рекламен акаунт', body: `${shop.display || shop.name || shop.domain}: ${linked.accountName} (${normalizeAccountId(b.accountId)})`, url: '/admin/#integrations' });
        return send(res, 200, { ok: true, ...linked });
      }
      case 'meta_accounts': {
        const token = String(b.token || '').trim() || (await getSecret(q, 'meta', shopId));
        if (!token) throw new Error('Първо влезте с Facebook или поставете ключ');
        return send(res, 200, { ok: true, accounts: await listAdAccounts(token) });
      }
      case 'test_meta': {
        const cfg = await metaConfig(q, shopId);
        if (!cfg) throw new Error('Meta рекламите не са свързани');
        const a = await testAccount(cfg);
        return send(res, 200, { ok: true, accountName: a.name, currency: a.currency });
      }
      case 'sync_meta': return send(res, 200, { ok: true, result: await syncMeta(q, { from: b.from || undefined, to: b.to || undefined, shopId }) });
      case 'econt_profile': return send(res, 200, { ok: true, profile: await econtProfile(q, shopId, b) });
      case 'save_econt': return send(res, 200, { ok: true, ...(await saveEcont(q, shopId, b)) });
      case 'sync_econt': return send(res, 200, { ok: true, result: await syncEcontStatuses(q, shopId) });
      case 'wa_config': return send(res, 200, { ok: true, appId: process.env.META_APP_ID || '', configId: process.env.WHATSAPP_CONFIG_ID || '', ready: waAppReady() });
      case 'wa_connect': return send(res, 200, { ok: true, ...(await connectWhatsApp(q, shopId, b)) });
      case 'wa_template': return send(res, 200, { ok: true, ...(await submitTemplate(q, shopId)) });
      case 'wa_refresh': return send(res, 200, { ok: true, ...(await refreshTemplate(q, shopId)) });
      case 'wa_settings': return send(res, 200, { ok: true, ...(await setAutoConfirm(q, shopId, b.autoConfirm === true)) });
      case 'wa_disconnect': await disconnectWhatsApp(q, shopId); return send(res, 200, { ok: true });
      case 'meta_disconnect': { // the Meta token is forgotten at once (data deletion); the ad spend already counted stays in the profit history
        await saveIntegration(q, 'meta', { config: { active: false, oauth: false, mode: '', accountId: '', accountName: '', lastError: null }, shopId });
        await q(`update zd.integrations set secret_enc = null where provider = 'meta' and shop_id = $1::uuid`, [shopId]);
        return send(res, 200, { ok: true });
      }
      case 'wa_test': return send(res, 200, await sendTest(q, shopId, b.phone)); // only to the admin's own number
      case 'save_checkout_text': return send(res, 200, { ok: true, ...(await saveCheckoutText(q, shopId, b)) });
      case 'boxnow_checkout': // BOX NOW lockers in this shop's checkout (with a BOX NOW method in its ConvertBuilder)
        await saveIntegration(q, 'boxnow', { config: { checkout: b.on === true }, shopId });
        return send(res, 200, { ok: true, checkout: b.on === true });
      case 'boxnow_profile': return send(res, 200, { ok: true, profile: await boxnowProfile(q, shopId, b) });
      case 'save_boxnow': return send(res, 200, { ok: true, ...(await saveBoxnow(q, shopId, b)) });
      case 'sync_boxnow': return send(res, 200, { ok: true, result: await syncBoxnowStatuses(q, shopId) });
      case 'speedy_profile': return send(res, 200, { ok: true, profile: await speedyProfile(q, shopId, b) });
      case 'save_speedy': return send(res, 200, { ok: true, ...(await saveSpeedy(q, shopId, b)) });
      case 'sync_speedy': return send(res, 200, { ok: true, result: await syncSpeedyStatuses(q, shopId) });
      case 'save_convertbuilder': return send(res, 200, { ok: true, ...(await saveConvertBuilder(q, b, shop)) });
      case 'test_convertbuilder': {
        const i = await getIntegration(q, 'convertbuilder', shopId);
        if (!i.hasSecret) throw new Error('ConvertBuilder не е свързан');
        return send(res, 200, { ok: true, ...(await testConnection({ domain: i.config.domain, apiKey: await getSecret(q, 'convertbuilder', shopId) })) });
      }
      case 'sync_convertbuilder': return send(res, 200, { ok: true, result: await syncOrders(q, { from: b.from, to: b.to, shopId }) });
      default: return send(res, 400, { error: 'unknown action' });
    }
  } catch (err) {
    console.error('[admin] integrations action failed', b.action, err.message);
    return fail(res, err);
  }
}
