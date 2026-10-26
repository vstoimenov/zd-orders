// 📞 The automatic call: an hour after a new order the voice agent calls the customer — shops that switched it on, in the day only.
// A tick (pg_cron → /api/cron/refresh?job=voice every few minutes) claims due orders by setting voice_auto_at first, so an order
// is tried once: two ticks never ring the same customer, and a refused call (a landline, the agent down) is not retried.
import { startVoiceCall, voiceConfigured } from './voice-call.js';

const FROM_H = 9, TO_H = 20; // Sofia time: no calls at night — an evening order is called in the morning (still within the day it may wait)
const sofiaHour = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hourCycle: 'h23' }).format(d));

export async function autoCallDue(q, { now = new Date(), max = 10, budgetMs = 20000 } = {}) {
  const out = { called: 0, failed: 0 };
  if (!voiceConfigured()) return out;
  const h = sofiaHour(now);
  if (h < FROM_H || h >= TO_H) return out;
  const claimed = await q(
    `update zd.orders set voice_auto_at = $1::timestamptz
     where id in (
       select o.id from zd.orders o join zd.shops s on s.id = o.shop_id
       where o.status = 'new' and o.voice_auto_at is null and s.voice_auto and o.phone_norm <> '' and o.waybill_number = '' and o.fulfil_sent_at is null
         and o.created_at <= $1::timestamptz - interval '1 hour' and o.created_at > $1::timestamptz - interval '24 hours'
       order by o.created_at limit $2 for update of o skip locked)
     returning id`,
    [now.toISOString(), max],
  );
  const started = Date.now();
  for (let i = 0; i < claimed.length; i++) {
    if (Date.now() - started > budgetMs) { // out of time: the rest goes back for the next tick
      await q(`update zd.orders set voice_auto_at = null where id = any($1::uuid[])`, [claimed.slice(i).map((r) => r.id)]);
      break;
    }
    try {
      if (await startVoiceCall(q, { orderId: claimed[i].id })) out.called++;
    } catch (err) {
      out.failed++;
      console.error('[voice] automatic call failed', claimed[i].id, err.message);
    }
  }
  return out;
}
