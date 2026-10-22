// WhatsApp Business (Cloud API) per shop through Meta's Embedded Signup: the shop's own number, the shop pays Meta.
// New orders get a "потвърдете поръчката" template with two quick replies; a tap confirms or cancels the order.
import { randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { assertReady } from './secretbox.js';
import { confirmLink, answerConfirm } from './confirm.js';
import { addOptouts } from './campaigns.js';
import { normalizePhone } from './phone.js';
import { notifyShop } from './push.js';

export const GRAPH = 'https://graph.facebook.com/v25.0';
export const TEMPLATE = 'potvarzhdenie_porachka_v1';
const MAX_WAIT_MS = 4000; // a new order never waits longer for WhatsApp
const FRESH_HOURS = 6; // only orders placed now get "потвърдете" (a sync of old orders stays quiet)
const SEEN_MAX = 2000;
const seen = new Set(); // Meta retries a delivery: each incoming message id is handled once (per instance)
const ID = /^\d{5,25}$/;
const money = (v, c) => `${Number(v).toFixed(2).replace('.', ',')} ${c === 'EUR' ? '€' : c}`;
const shortPlace = (s) => String(s || '').split(',')[0].trim();

export const waAppReady = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.WHATSAPP_CONFIG_ID);

function waError(err, status) {
  // Meta's user message says what to do; the technical message is often just "Invalid parameter"
  const m = String(err?.error_user_msg || err?.message || `HTTP ${status}`);
  if (Number(err?.code) === 190) return new Error('WhatsApp: връзката с Meta изтече — свържете WhatsApp отново');
  return new Error(`WhatsApp (Meta): ${m.slice(0, 200)}`);
}

async function graph(path, { method = 'GET', token, body, query, waitMs = 20000 } = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(u, {
      method,
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'WhatsApp: Meta не отговори навреме' : 'WhatsApp: няма връзка с Meta');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || data?.error) throw Object.assign(waError(data?.error, res.status), { code: Number(data?.error?.code) || null, subcode: Number(data?.error?.error_subcode) || null });
  return data;
}

/** After Embedded Signup: code → business token; check the WABA and number; subscribe our webhooks; register the number. */
export async function connectWhatsApp(q, shopId, { code, wabaId, phoneNumberId }) {
  assertReady();
  if (!waAppReady()) throw new Error('WhatsApp още не е настроен на платформата');
  if (!code || !ID.test(String(wabaId || '')) || !ID.test(String(phoneNumberId || ''))) throw new Error('Свързването не завърши — опитайте отново');
  // one number = one shop: the webhook finds the shop by the number
  const [taken] = await q(`select 1 from zd.integrations where provider = 'whatsapp' and config->>'phoneNumberId' = $1 and shop_id <> $2::uuid
     and coalesce(config->>'active', 'true') <> 'false'`, [String(phoneNumberId), shopId]);
  if (taken) throw new Error('Този WhatsApp номер вече е свързан с друг магазин');
  const t = await graph('/oauth/access_token', { query: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code: String(code) } });
  const token = t?.access_token;
  if (!token) throw new Error('WhatsApp: Meta не върна ключ — опитайте отново');
  const [waba, phone] = await Promise.all([
    graph(`/${wabaId}`, { token, query: { fields: 'id,name' } }),
    graph(`/${phoneNumberId}`, { token, query: { fields: 'id,display_phone_number,verified_name' } }),
  ]);
  const numbers = await graph(`/${wabaId}/phone_numbers`, { token, query: { fields: 'id' } });
  if (!(Array.isArray(numbers?.data) ? numbers.data : []).some((n) => String(n.id) === String(phoneNumberId))) throw new Error('Номерът не е в избрания WhatsApp Business акаунт — опитайте отново');
  await graph(`/${wabaId}/subscribed_apps`, { method: 'POST', token });
  const pin = String(randomInt(0, 1000000)).padStart(6, '0');
  try {
    await graph(`/${phoneNumberId}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin } });
  } catch (err) {
    if (!/already registered/i.test(err.message) && err.code !== 133005) throw err; // the number already works with Cloud API
  }
  await saveIntegration(q, 'whatsapp', {
    config: {
      wabaId: String(wabaId), phoneNumberId: String(phoneNumberId), phone: phone.display_phone_number || '', name: phone.verified_name || waba.name || '',
      templateName: '', templateStatus: '', autoConfirm: false, active: true, connectedAt: new Date().toISOString(), lastError: null,
    },
    secret: JSON.stringify({ token, pin }), shopId,
  });
  return { phone: phone.display_phone_number || '', name: phone.verified_name || '' };
}

export async function whatsappStatus(q, shopId) {
  const i = await getIntegration(q, 'whatsapp', shopId);
  const c = i.config;
  return {
    connected: i.hasSecret && c.active !== false && Boolean(c.phoneNumberId), phone: c.phone || '', name: c.name || '', wabaId: c.wabaId || '',
    templateStatus: c.templateStatus || '', autoConfirm: Boolean(c.autoConfirm), lastError: c.lastError || null, connectedAt: c.connectedAt || null,
    ready: waAppReady(),
  };
}

async function settings(q, shopId) {
  const i = await getIntegration(q, 'whatsapp', shopId);
  if (!i.hasSecret || i.config.active === false || !i.config.phoneNumberId) return null;
  return { cfg: i.config, token: JSON.parse(await getSecret(q, 'whatsapp', shopId)).token };
}

/** The Bulgarian utility template "потвърдете поръчката" with two quick replies, submitted to Meta for approval. */
export async function submitTemplate(q, shopId) {
  const s = await settings(q, shopId);
  if (!s) throw new Error('Първо свържете WhatsApp');
  const r = await graph(`/${s.cfg.wabaId}/message_templates`, {
    method: 'POST', token: s.token,
    body: {
      name: TEMPLATE, language: 'bg', category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Здравейте, {{1}}! Получихме поръчката Ви от {{2}}: {{3}}. Доставка: {{4}}. Моля, потвърдете поръчката с бутона по-долу.',
          example: { body_text: [['Мария', 'Моят магазин', '1 × Книга — 22,57 €', 'ЕКОНТ – офис Плевен']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Потвърждавам' }, { type: 'QUICK_REPLY', text: 'Отказвам' }] },
      ],
    },
  }).catch(async (err) => {
    if (err.subcode === 2388024 || /already exists|duplicate|вече съществува/i.test(err.message)) return { status: 'PENDING' }; // submitted before: read its status with "Провери"
    throw err;
  });
  await saveIntegration(q, 'whatsapp', { config: { templateName: TEMPLATE, templateStatus: r.status || 'PENDING', lastError: null }, shopId });
  return { templateStatus: r.status || 'PENDING' };
}

/** Meta's decision on our template (PENDING / APPROVED / REJECTED). */
export async function refreshTemplate(q, shopId) {
  const s = await settings(q, shopId);
  if (!s) throw new Error('Първо свържете WhatsApp');
  const d = await graph(`/${s.cfg.wabaId}/message_templates`, { token: s.token, query: { name: TEMPLATE, fields: 'name,status,language' } });
  const t = (Array.isArray(d?.data) ? d.data : []).find((x) => x.name === TEMPLATE && x.language === 'bg');
  const status = t?.status || '';
  await saveIntegration(q, 'whatsapp', { config: { templateName: t ? TEMPLATE : '', templateStatus: status }, shopId });
  return { templateStatus: status };
}

export async function setAutoConfirm(q, shopId, on) {
  const s = await settings(q, shopId);
  if (!s) throw new Error('Първо свържете WhatsApp');
  if (on && s.cfg.templateStatus !== 'APPROVED') throw new Error('Автоматичното изпращане се включва след одобрението на шаблона от Meta');
  await saveIntegration(q, 'whatsapp', { config: { autoConfirm: Boolean(on) }, shopId });
  return { autoConfirm: Boolean(on) };
}

/** Stops: our app leaves the shop's WhatsApp account (best effort) and the token is forgotten. */
export async function disconnectWhatsApp(q, shopId) {
  const s = await settings(q, shopId).catch(() => null);
  if (s) await graph(`/${s.cfg.wabaId}/subscribed_apps`, { method: 'DELETE', token: s.token }).catch((err) => console.error('[whatsapp] unsubscribe failed', err.message));
  await saveIntegration(q, 'whatsapp', { config: { active: false, autoConfirm: false }, shopId });
  await q(`update zd.integrations set secret_enc = null where provider = 'whatsapp' and shop_id = $1::uuid`, [shopId]);
}

/**
 * A new order of a shop with WhatsApp on: the approved template with the customer's personal button payloads (yes/no:<token>).
 * Never throws and never waits long — a WhatsApp problem must not touch the order.
 */
/** Limits on automatic messages for orders ConvertBuilder has not confirmed, so a forged order cannot spam people from the shop's number. */
const AUTO_LIMIT = { perHour: 30, mobile: /^\+3598[789]\d{7}$/ };
async function autoAllowed(q, o) {
  if (o.cb_check === 'pending') return false; // kept aside: only the shop's own button sends
  if (o.cb_check === 'ok') return true;
  if (!AUTO_LIMIT.mobile.test(o.phone_norm)) return false;
  const [n] = await q(`select count(*) filter (where phone_norm = $2 and wa_auto_at > now() - interval '24 hours')::int as phone,
       count(*) filter (where wa_auto_at > now() - interval '1 hour')::int as hour
     from zd.orders where shop_id = $1::uuid and id <> $3::uuid and wa_auto_at > now() - interval '24 hours'`, [o.shop_id, o.phone_norm, o.id]);
  return n.phone === 0 && n.hour < AUTO_LIMIT.perHour;
}

export async function sendOrderConfirmation(q, orderId, { force = false } = {}) {
  try {
    const [o] = await q(`select id, shop_id, name, phone_norm, items, total, currency, office_text, delivery_type, city, cb_check from zd.orders
       where id = $1::uuid and status = 'new' and created_at > now() - interval '${FRESH_HOURS} hours'`, [orderId]);
    if (!o || !o.phone_norm) return { sent: false };
    const s = await settings(q, o.shop_id);
    if (!s || s.cfg.templateStatus !== 'APPROVED' || (!s.cfg.autoConfirm && !force)) return { sent: false };
    if (!force && !(await autoAllowed(q, o))) return { sent: false, limited: true };
    const link = await confirmLink(q, { orderId: o.id, scopeShopId: o.shop_id });
    const token = new URL(link.link).searchParams.get('t');
    const [shop] = await q(`select name, domain from zd.shops where id = $1::uuid`, [o.shop_id]);
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items || [];
    const what = `${items.map((it) => `${it.qty} × ${it.name}`).join(', ') || 'поръчка'} — ${money(o.total, o.currency)}`.slice(0, 200);
    const where = ['speedy_address', 'econt_address'].includes(o.delivery_type) ? `до адрес в ${o.city || ''}`.trim() : shortPlace(o.office_text);
    const text = (v) => ({ type: 'text', text: String(v || '—').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 200) }); // Meta refuses new lines and long spaces in parameters
    await graph(`/${s.cfg.phoneNumberId}/messages`, {
      method: 'POST', token: s.token, waitMs: MAX_WAIT_MS,
      body: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: o.phone_norm.replace(/^\+/, ''), type: 'template',
        template: {
          name: TEMPLATE, language: { code: 'bg' },
          components: [
            { type: 'body', parameters: [text(String(o.name || '').trim().split(/\s+/)[0]), text(shop?.name || shop?.domain), text(what), text(where)] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `yes:${token}` }] },
            { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `no:${token}` }] },
          ],
        },
      },
    });
    if (!force) await q(`update zd.orders set wa_auto_at = now() where id = $1::uuid`, [o.id]);
    return { sent: true };
  } catch (err) {
    console.error('[whatsapp] order confirmation failed', orderId, err.message);
    // the shop sees why messages do not go out (no payment method, paused template, expired connection…)
    const [o] = await q(`select shop_id from zd.orders where id = $1::uuid`, [orderId]).catch(() => []);
    if (o) await saveIntegration(q, 'whatsapp', { config: { lastError: err.message, lastErrorAt: new Date().toISOString() }, shopId: o.shop_id }).catch(() => {});
    return { sent: false, error: err.message };
  }
}

/** A sample of the confirmation template to the admin's own number (sample values, buttons do nothing). */
export async function sendTest(q, shopId, phone) {
  const to = normalizePhone(phone);
  if (!to) throw new Error('Въведете вашия телефон за пробата');
  const s = await settings(q, shopId);
  if (!s) throw new Error('Първо свържете WhatsApp');
  if (s.cfg.templateStatus !== 'APPROVED') throw new Error('Шаблонът още не е одобрен от Meta');
  const [shop] = await q(`select name, domain from zd.shops where id = $1::uuid`, [shopId]);
  const text = (v) => ({ type: 'text', text: v });
  await graph(`/${s.cfg.phoneNumberId}/messages`, {
    method: 'POST', token: s.token,
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'template',
      template: { name: TEMPLATE, language: { code: 'bg' }, components: [
        { type: 'body', parameters: [text('Проба'), text(shop?.name || shop?.domain || 'Магазин'), text('1 × Продукт — 10,00 €'), text('офис на Еконт')] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'test' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'test' }] },
      ] },
    },
  });
  return { ok: true };
}

/* ---- webhook: Meta → us ---- */
export function signatureOk(raw, header) {
  const secret = process.env.META_APP_SECRET;
  const got = String(header || '');
  if (!secret || !got.startsWith('sha256=')) return false;
  const want = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/** " на 0888… или shop@…" — how a customer reaches the shop (its own phone/email from Данни за магазина). */
async function contactLine(q, shopId) {
  const [s] = await q(`select phone, email from zd.shops where id = $1::uuid`, [shopId]).catch(() => []);
  const ways = [s?.phone, s?.email].filter(Boolean);
  return ways.length ? ` на ${ways.join(' или ')}` : '';
}

async function shopByPhoneId(q, phoneNumberId) {
  const [r] = await q(`select shop_id from zd.integrations where provider = 'whatsapp' and config->>'phoneNumberId' = $1 and coalesce(config->>'active', 'true') <> 'false'`, [String(phoneNumberId || '')]);
  return r?.shop_id || null;
}

async function reply(q, shopId, to, body) {
  const s = await settings(q, shopId);
  if (!s) return;
  // a reply right after the customer's tap is inside the free 24 h service window
  await graph(`/${s.cfg.phoneNumberId}/messages`, { method: 'POST', token: s.token, waitMs: MAX_WAIT_MS, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } } })
    .catch((err) => console.error('[whatsapp] reply failed', err.message));
}

/** Button taps (yes/no:<token>) answer the order like the confirmation link; "STOP" joins the shop's STOP list. */
export async function handleWebhook(q, payload) {
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value || {};
      const shopId = await shopByPhoneId(q, v.metadata?.phone_number_id);
      if (!shopId) continue;
      const names = Object.fromEntries((Array.isArray(v.contacts) ? v.contacts : []).map((c) => [String(c.wa_id), c.profile?.name || '']));
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        if (m.id) {
          if (seen.has(m.id)) continue; // a retry of a message we already handled
          if (seen.size > SEEN_MAX) seen.clear();
          seen.add(m.id);
        }
        const from = String(m.from || '').replace(/\D/g, '');
        if (m.type === 'button' || m.type === 'interactive') {
          const p = String(m.button?.payload || m.interactive?.button_reply?.id || '');
          const [answer, token] = p.split(':');
          if (!['yes', 'no'].includes(answer) || !token) continue;
          // the token belongs to an order of this shop only
          const [o] = await q(`select id from zd.orders where confirm_token = $1 and shop_id = $2::uuid`, [token, shopId]);
          if (!o) continue;
          try {
            await answerConfirm(q, token, answer);
            await reply(q, shopId, from, answer === 'yes' ? 'Благодарим! Поръчката е потвърдена и ще бъде изпратена скоро.' : `Поръчката е отказана. Ако е грешка — свържете се с нас${await contactLine(q, shopId)}.`);
          } catch (err) {
            // only our own (Bulgarian) messages go to the customer, never technical ones
            await reply(q, shopId, from, /[А-Яа-я]/.test(err.message) ? err.message : `Не успяхме да запишем отговора — свържете се с нас${await contactLine(q, shopId)}.`);
          }
        } else if (m.type === 'text' && /^\s*(stop|стоп)\s*$/i.test(String(m.text?.body || ''))) {
          await addOptouts(q, shopId, `+${from}`);
          await reply(q, shopId, from, 'Готово — няма да получавате повече рекламни съобщения от нас.');
        } else if (m.type === 'text') {
          // a Cloud API number has no WhatsApp app: the shop hears about the customer's message here
          await notifyShop(q, shopId, { title: '💬 Клиент писа в WhatsApp', body: `${names[from] || `+${from}`}: ${String(m.text?.body || '').slice(0, 140)}` });
        }
      }
    }
  }
}
