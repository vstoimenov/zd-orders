// Order confirmation by phone: a voice agent (separate server, VOICE_CALL_URL) calls the customer, says the name, products,
// total and "до два работни дни" and asks to confirm. ORDYX holds only VOICE_CALL_SECRET: it signs the request, the agent's
// server checks it and calls (its LiveKit/ElevenLabs/Zadarma keys never come here). The answer comes back signed with the same secret.
import { createHmac } from 'node:crypto';
import { safeEqual } from './http.js';
import { syncStockSafe } from './stock.js';
import { notifyOrderEvent } from './push.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SKEW_S = 300; // an older signed answer does not count
const OPEN = ['new', 'confirmed'];
const ANSWERS = { no: '📞 Клиентът не потвърди по телефона', unclear: '📞 Неясен отговор по телефона', no_answer: '📞 Клиентът не вдигна' };

export const voiceConfigured = () => Boolean(process.env.VOICE_CALL_URL && process.env.VOICE_CALL_SECRET);
const sign = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** „📞 Обади се“: the order (within the admin's shops) → the agent's server. Throws Bulgarian messages. */
export async function startVoiceCall(q, { orderId, scopeShopId = null, scopeShopIds = null }, { fetchImpl = fetch } = {}) {
  if (!voiceConfigured()) throw new Error('Обажданията по телефона не са настроени');
  const [o] = UUID.test(String(orderId || '')) ? await q(
    `select id, name, phone_norm, items, total, currency, status, waybill_number from zd.orders
     where id = $1::uuid and ($2::text is null or shop_id = $2::uuid) and ($3::uuid[] is null or shop_id = any($3::uuid[]))`,
    [orderId, scopeShopId, scopeShopIds],
  ) : [];
  if (!o) return null;
  if (!OPEN.includes(o.status) || o.waybill_number) throw new Error('Поръчката вече е изпратена или затворена');
  if (!o.phone_norm) throw new Error('Поръчката няма телефон');
  const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items || [];
  const body = JSON.stringify({
    order_id: o.id, customer_name: String(o.name || '').trim(), phone: o.phone_norm,
    items: items.map((it) => ({ name: String(it.name || ''), qty: Number(it.qty) || 1 })), total: Number(o.total), currency: o.currency || 'EUR',
  });
  const ts = String(Math.floor(Date.now() / 1000));
  let r;
  try {
    r = await fetchImpl(process.env.VOICE_CALL_URL, {
      method: 'POST', body, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Ordyx-Time': ts, 'X-Ordyx-Signature': sign(process.env.VOICE_CALL_SECRET, ts, body) },
    });
  } catch {
    throw new Error('Сървърът за обаждания не отговаря. Опитайте пак.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(/[А-Яа-я]/.test(String(d.error || '')) ? d.error : 'Обаждането не тръгна. Опитайте пак.');
  return { ok: true };
}

/** The agent's signed answer: "yes" confirms the order (as the customer's link does); anything else only tells the shop. */
export async function voiceResult(q, raw, headers, { now = Date.now() } = {}) {
  const secret = process.env.VOICE_CALL_SECRET;
  const ts = String(headers['x-ordyx-time'] || '');
  if (!secret || !/^\d{9,11}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_S) return { status: 401 };
  if (!safeEqual(sign(secret, ts, raw), String(headers['x-ordyx-signature'] || ''))) return { status: 401 };
  let b;
  try { b = JSON.parse(raw); } catch { return { status: 400 }; }
  if (!UUID.test(String(b.order_id || ''))) return { status: 400 };
  if (b.answer === 'yes') {
    const changed = await q(
      `update zd.orders set confirm_answer = 'yes', confirm_answered_at = now(),
         status_changed_at = case when status <> 'confirmed' then now() else status_changed_at end, status = 'confirmed'
       where id = $1::uuid and status = any($2::text[]) and waybill_number = '' returning id`,
      [b.order_id, OPEN],
    );
    if (!changed.length) return { status: 200, applied: false }; // sent or closed meanwhile: the answer does not count
    await syncStockSafe(q, b.order_id);
    await notifyOrderEvent(q, b.order_id, '✅ Клиентът потвърди по телефона');
    return { status: 200, applied: true };
  }
  if (ANSWERS[b.answer]) await notifyOrderEvent(q, b.order_id, ANSWERS[b.answer]);
  return { status: 200, applied: false };
}
