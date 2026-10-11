// Order confirmation by the customer: a personal link (sent from the shop's WhatsApp/SMS with one tap) → "Потвърждавам" / "Отказвам".
import { randomBytes } from 'node:crypto';
import { renderMessage, fill } from './campaigns.js';
import { syncStockSafe } from './stock.js';
import { notifyOrderEvent } from './push.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{30,64}$/;
const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');
export const DEFAULT_TEMPLATE = 'Здравейте, {име}! Получихме поръчката Ви от {магазин}: {продукт} — {сума}, доставка до {доставка}. Моля, потвърдете я тук: {линк_потвърждение}';
const money = (v, c) => `${Number(v).toFixed(2).replace('.', ',')} ${c === 'EUR' ? '€' : c}`;
const shortPlace = (s) => String(s || '').split(',')[0].trim();

export async function getTemplate(q, shopId) {
  const [r] = await q(`select value from zd.settings where key = $1`, [`confirm_msg:${shopId}`]);
  const v = r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : null;
  return typeof v?.text === 'string' && v.text ? v.text : DEFAULT_TEMPLATE;
}
export async function setTemplate(q, shopId, text) {
  if (!shopId) throw new Error('Изберете магазин');
  const s = String(text ?? '').trim();
  if (!s.includes('{линк_потвърждение}')) throw new Error('Съобщението трябва да съдържа {линк_потвърждение}');
  if (s.length > 700) throw new Error('Съобщението е до 700 знака');
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('text', $2::text)) on conflict (key) do update set value = excluded.value`, [`confirm_msg:${shopId}`, s]);
  return s;
}

/** The order's personal link (created once) and the ready message with WhatsApp / SMS links — within the admin's shops only. */
export async function confirmLink(q, { orderId, scopeShopId = null, scopeShopIds = null }) {
  const [o] = UUID.test(String(orderId || '')) ? await q(
    `select o.*, s.name as shop_name, s.domain as shop_domain from zd.orders o join zd.shops s on s.id = o.shop_id
     where o.id = $1::uuid and ($2::text is null or o.shop_id = $2::uuid) and ($3::uuid[] is null or o.shop_id = any($3::uuid[]))`,
    [orderId, scopeShopId, scopeShopIds],
  ) : [];
  if (!o) return null;
  let token = o.confirm_token;
  if (!token) {
    token = randomBytes(24).toString('base64url');
    const [r] = await q(`update zd.orders set confirm_token = coalesce(confirm_token, $2) where id = $1::uuid returning confirm_token`, [o.id, token]);
    token = r.confirm_token;
  }
  const link = `${base()}/confirm/?t=${token}${process.env.ZD_DEMO === '1' ? '&demo=1' : ''}`; // the demo's own sandbox answers it
  const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items || [];
  const message = fill(renderMessage(await getTemplate(q, o.shop_id), { name: o.name, product: items.map((it) => it.name).join(', '), shop: o.shop_name || o.shop_domain }),
    { '{сума}': money(o.total, o.currency), '{доставка}': deliveryText(o), '{линк_потвърждение}': link });
  const phone = String(o.phone_norm || '');
  return {
    link, message,
    whatsapp: phone ? `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}` : null,
    sms: phone ? `sms:${phone}?&body=${encodeURIComponent(message)}` : null,
  };
}

/** Where it goes, without a street address: the office, or "до адрес в <city>". */
function deliveryText(o) {
  if (o.delivery_type === 'speedy_address' || /адрес/i.test(String(o.office_text || '').split(',')[0])) return o.city ? `до адрес ${/^[ВвФф]/.test(o.city) ? 'във' : 'в'} ${o.city}` : 'до адрес';
  return shortPlace(o.office_text);
}

const OPEN = ['new', 'confirmed'];
async function byToken(q, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const [o] = await q(
    `select o.id, o.name, o.items, o.total, o.currency, o.office_text, o.delivery_type, o.city, o.status, o.confirm_answer, o.waybill_number, o.shop_id, s.name as shop_name, s.domain as shop_domain
     from zd.orders o join zd.shops s on s.id = o.shop_id where o.confirm_token = $1`, [token]);
  return o || null;
}
const canAnswer = (o) => OPEN.includes(o.status) && !o.waybill_number;

/** What the customer sees: first name, products, total, office or city — no phone, email or street. Once closed: only the answer. */
export async function confirmPage(q, token) {
  const o = await byToken(q, token);
  if (!o) return null;
  const shop = o.shop_name || o.shop_domain;
  if (!canAnswer(o)) return { shop, answer: o.confirm_answer, canAnswer: false };
  const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items || [];
  return {
    shop: o.shop_name || o.shop_domain, name: String(o.name || '').trim().split(/\s+/)[0] || '',
    items: items.map((it) => ({ name: it.name, qty: it.qty })), total: Number(o.total), currency: o.currency, delivery: deliveryText(o),
    answer: o.confirm_answer, canAnswer: canAnswer(o),
  };
}

/** "yes" → confirmed, "no" → cancelled (stock comes back); only while the order is not sent yet. The shop's devices hear about it. */
export async function answerConfirm(q, token, answer) {
  const o = await byToken(q, token);
  if (!o) return null;
  if (!['yes', 'no'].includes(answer)) throw new Error('Невалиден отговор');
  if (!canAnswer(o)) throw new Error('Поръчката вече е изпратена или затворена — за промени се свържете с магазина');
  const status = answer === 'yes' ? 'confirmed' : 'cancelled';
  const changed = await q(
    `update zd.orders set confirm_answer = $2, confirm_answered_at = now(),
       status_changed_at = case when status <> $3 then now() else status_changed_at end, status = $3
     where id = $1::uuid and status = any($4::text[]) and waybill_number = '' returning id`,
    [o.id, answer, status, OPEN],
  );
  // the shop sent it meanwhile (or a waybill is being made): the answer did not count
  if (!changed.length) throw new Error('Поръчката вече е изпратена или затворена — за промени се свържете с магазина');
  await syncStockSafe(q, o.id);
  if (o.confirm_answer !== answer) await notifyOrderEvent(q, o.id, answer === 'yes' ? '✅ Клиентът потвърди поръчката' : '❌ Клиентът отказа поръчката');
  return { ok: true, answer };
}
