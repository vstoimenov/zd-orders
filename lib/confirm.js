// Order confirmation by the customer: a personal link (sent from the shop's WhatsApp/SMS with one tap) → "Потвърждавам" / "Отказвам".
import { renderMessage, fill } from './campaigns.js';
import { ensureConfirmToken } from './orders-repo.js';
import { syncStockSafe } from './stock.js';
import { notifyOrderEvent } from './push.js';
import { trackUrl as econtTrack } from './econt-api.js';
import { trackUrl as speedyTrack } from './speedy-api.js';
import { SHOP_NOTES } from './waybills.js';
import { notifySite } from './woo-callback.js';
import { queueFulfilment, queueCancel } from './fulfilment.js';
import { canChangeDelivery, boxnowForCustomers, changeDelivery } from './delivery-change.js';
import { saveInvoice } from './invoice.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{30,64}$/;
const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
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
  const token = o.confirm_token || await ensureConfirmToken(q, o.id);
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
  if (['speedy_address', 'econt_address'].includes(o.delivery_type) || /адрес/i.test(String(o.office_text || '').split(',')[0])) return o.city ? `до адрес ${/^[ВвФф]/.test(o.city) ? 'във' : 'в'} ${o.city}` : 'до адрес';
  return shortPlace(o.office_text);
}

const OPEN = ['new', 'confirmed'];
async function byToken(q, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const [o] = await q(
    `select o.id, o.name, o.items, o.total, o.currency, o.payment_method, o.office_id, o.office_text, o.delivery_type, o.city, o.status, o.status_changed_at,
       o.created_at, o.confirm_answer, o.confirm_answered_at, o.packed_at, o.waybill_number, o.waybill_courier, o.waybill_demo, o.waybill_created_at,
       o.waybill_status, o.waybill_checked_at, o.waybill_at_office_since, o.waybill_track_url, o.fulfil_sent_at, o.invoice, o.shop_id, s.name as shop_name, s.domain as shop_domain, s.phone as shop_phone
     from zd.orders o join zd.shops s on s.id = o.shop_id where o.confirm_token = $1`, [token]);
  return o || null;
}
const canAnswer = (o) => OPEN.includes(o.status) && !o.waybill_number;
export async function orderIdByToken(q, token) { return (await byToken(q, token))?.id || null; }

/* ---- tracking: where the order is (the customer's order page) ---- */
const LIVE = (n) => Boolean(n) && !['creating', 'unknown'].includes(n);
const COURIER_NAME = { econt: 'Еконт', speedy: 'Спиди', boxnow: 'BOX NOW' };
const iso = (d) => (d ? new Date(d).toISOString() : null);
const isAddress = (o) => /address/.test(String(o.delivery_type || '')) || /адрес/i.test(String(o.office_text || '').split(',')[0]);
const trackUrlOf = (courier, n) => (courier === 'econt' ? econtTrack(n) : courier === 'speedy' ? speedyTrack(n) : null);

/** Steps with their time when known; a step counts as done when a later one is done (e.g. sent without the packing mark). */
async function tracking(q, o) {
  const live = LIVE(o.waybill_number) && !o.waybill_demo; // a test waybill on a real order means nothing to the buyer
  const sent = live || ['shipped', 'delivered', 'returned'].includes(o.status);
  const delivered = o.status === 'delivered';
  const atOffice = o.status === 'shipped' && o.waybill_at_office_since ? iso(o.waybill_at_office_since) : null;
  const steps = [
    { key: 'placed', at: iso(o.created_at), done: true },
    { key: 'confirmed', at: o.confirm_answer === 'yes' ? iso(o.confirm_answered_at) : null, done: o.confirm_answer === 'yes' || o.status === 'confirmed' },
    { key: 'packed', at: iso(o.packed_at), done: Boolean(o.packed_at) },
    { key: 'shipped', at: live ? iso(o.waybill_created_at) : o.status === 'shipped' ? iso(o.status_changed_at) : null, done: sent },
    ...(isAddress(o) ? [] : [{ key: 'at_office', at: atOffice, done: Boolean(atOffice) }]),
    { key: 'delivered', at: delivered ? iso(o.status_changed_at) : null, done: delivered },
  ];
  for (let i = steps.length - 2; i >= 0; i--) if (steps[i + 1].done) steps[i].done = true;
  const stage = ['cancelled', 'returned'].includes(o.status) ? o.status : [...steps].reverse().find((s) => s.done).key;
  let office = null;
  if (!isAddress(o) && o.office_id) {
    const [f] = await q(`select name, city, address, hours, lat, lng from zd.offices where id = $1`, [o.office_id]);
    if (f) office = { name: f.name, city: f.city, address: f.address, hours: f.hours || '', lat: f.lat == null ? null : Number(f.lat), lng: f.lng == null ? null : Number(f.lng) };
  }
  const courier = live ? o.waybill_courier : '';
  return {
    stage, steps, shopPhone: o.shop_phone || '',
    courier, courierName: COURIER_NAME[courier] || '', number: live ? o.waybill_number : '', trackUrl: live ? o.waybill_track_url || trackUrlOf(courier, o.waybill_number) : null,
    courierText: live && !SHOP_NOTES.includes(o.waybill_status) ? o.waybill_status || '' : '', checkedAt: live ? iso(o.waybill_checked_at) : null, atOfficeSince: atOffice, office,
  };
}

/** The customer's order page: first name, products, total, office or city — no phone, email or street — and where the order is. */
export async function confirmPage(q, token) {
  const o = await byToken(q, token);
  if (!o) return null;
  const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items || [];
  return {
    shop: o.shop_name || o.shop_domain, name: String(o.name || '').trim().split(/\s+/)[0] || '',
    items: items.map((it) => ({ name: it.name, qty: it.qty })), total: Number(o.total), currency: o.currency, cod: o.payment_method === 'cod',
    createdAt: iso(o.created_at), delivery: deliveryText(o), answer: o.confirm_answer, canAnswer: canAnswer(o), tracking: await tracking(q, o),
    // the customer may still move it to another office / address (nothing sent yet)
    invoice: (typeof o.invoice === 'string' ? JSON.parse(o.invoice) : o.invoice) || {}, canInvoice: canChangeDelivery(o),
    canChangeDelivery: canChangeDelivery(o), deliveryType: o.delivery_type, shopDomain: o.shop_domain || '', boxnow: await boxnowForCustomers(q, o.shop_id),
  };
}

/** The ready "your order is on its way" message with the short link — only once the order has a live waybill. */
export async function trackingLink(q, { orderId, scopeShopId = null, scopeShopIds = null }) {
  const out = await confirmLink(q, { orderId, scopeShopId, scopeShopIds });
  if (!out) return null;
  const [o] = await q(`select o.name, o.waybill_number, o.waybill_courier, o.waybill_demo, s.name as shop_name, s.domain as shop_domain, o.phone_norm, o.confirm_token
    from zd.orders o join zd.shops s on s.id = o.shop_id where o.id = $1::uuid`, [orderId]);
  if (!LIVE(o.waybill_number)) throw new Error('Още няма товарителница — първо я създайте');
  if (o.waybill_demo) throw new Error('Това е тестова товарителница — клиентът не може да я проследи');
  const link = `${base()}/p/${o.confirm_token}${process.env.ZD_DEMO === '1' ? '?demo=1' : ''}`;
  const first = String(o.name || '').trim().split(/\s+/)[0];
  const message = `Здравейте${first ? `, ${first}` : ''}! Поръчката Ви от ${o.shop_name || o.shop_domain} е изпратена с ${COURIER_NAME[o.waybill_courier] || 'куриер'} (${o.waybill_number}). Проследете я тук: ${link}`;
  const phone = String(o.phone_norm || '');
  return {
    link, message,
    whatsapp: phone ? `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}` : null,
    sms: phone ? `sms:${phone}?&body=${encodeURIComponent(message)}` : null,
  };
}

/** "yes" → confirmed, "no" → cancelled (stock comes back); only while the order is not sent yet. The shop's devices hear about it. */
export async function answerConfirm(q, token, answer, { channel = 'link' } = {}) {
  const o = await byToken(q, token);
  if (!o) return null;
  if (!['yes', 'no'].includes(answer)) throw new Error('Невалиден отговор');
  if (!canAnswer(o)) throw new Error('Поръчката вече е изпратена или затворена — за промени се свържете с магазина');
  const status = answer === 'yes' ? 'confirmed' : 'cancelled';
  const changed = await q(
    `update zd.orders set confirm_answer = $2, confirm_answered_at = now(), confirm_channel = $5,
       status_changed_at = case when status <> $3 then now() else status_changed_at end, status = $3
     where id = $1::uuid and status = any($4::text[]) and waybill_number = '' returning id`,
    [o.id, answer, status, OPEN, channel === 'whatsapp' ? 'whatsapp' : 'link'],
  );
  // the shop sent it meanwhile (or a waybill is being made): the answer did not count
  if (!changed.length) throw new Error('Поръчката вече е изпратена или затворена — за промени се свържете с магазина');
  await syncStockSafe(q, o.id);
  if (o.confirm_answer !== answer) await notifyOrderEvent(q, o.id, answer === 'yes' ? '✅ Клиентът потвърди поръчката' : '❌ Клиентът отказа поръчката');
  if (answer === 'no') await notifySite(q, o.id, 'cancelled'); // a WooCommerce order: its site cancels it too (never throws)
  if (answer === 'yes') await queueFulfilment(q, o.id); else await queueCancel(q, o.id); // the shop's warehouse, when it has one
  return { ok: true, answer };
}

/** The customer moves the order to another office / address from the order page. */
export async function changeDeliveryByToken(q, token, input) {
  const o = await byToken(q, token);
  if (!o) return null;
  await changeDelivery(q, o.id, input, { by: 'customer' });
  return { ok: true };
}

/** The customer adds invoice details from the order page (until the order is shipped). */
export async function invoiceByToken(q, token, input) {
  const o = await byToken(q, token);
  if (!o) return null;
  if (!canChangeDelivery(o)) throw new Error('Поръчката вече е изпратена — за фактура се свържете с магазина');
  await saveInvoice(q, o.id, input, { strict: true });
  return { ok: true };
}
