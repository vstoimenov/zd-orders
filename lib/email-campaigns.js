// E-mail campaigns of one shop: who gets them (buyers with an address, never the opted-out), what they look like, the sending in
// batches with what the provider reports back, and the opt-out list.
import { recipientsByEmail, renderMessage, shopCtx } from './campaigns.js';
import { sendBatch, fromAddress, unsubUrl, validEmail, normEmail, BATCH, emailConfigured } from './email.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

/** The e-mail as the customer sees it: the shop's name on top, the text in paragraphs, an optional picture and button, the legal footer. */
export function renderEmail({ shop, subject, body, buttonText = '', buttonUrl = '', imageUrl = '', unsub, vars = {} }) {
  const text = renderMessage(body, vars), subj = renderMessage(subject, vars);
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#14140f">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const img = safeUrl(imageUrl) ? `<img src="${esc(safeUrl(imageUrl))}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;margin:0 0 18px">` : '';
  const btn = buttonText && safeUrl(buttonUrl)
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 18px"><tr><td style="background:#ffd21f;border-radius:10px"><a href="${esc(safeUrl(buttonUrl))}" style="display:inline-block;padding:12px 22px;font-weight:700;font-size:15px;color:#14140f;text-decoration:none">${esc(renderMessage(buttonText, vars))}</a></td></tr></table>` : '';
  const html = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subj)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f1;font-family:Inter,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:16px;border:1px solid #e6e4dc">
<tr><td style="padding:22px 28px 6px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6d6c66">${esc(shop)}</td></tr>
<tr><td style="padding:8px 28px 4px">${img}${paras}${btn}</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #e6e4dc;font-size:12px;line-height:1.5;color:#6d6c66">Получавате този имейл, защото сте поръчвали от ${esc(shop)}.
<a href="${esc(unsub)}" style="color:#6d6c66">Отпишете се</a> с едно натискане — няма да ви пишем повече.</td></tr>
</table></td></tr></table></body></html>`;
  const plain = `${text}\n\n—\nПолучавате този имейл, защото сте поръчвали от ${shop}. Отписване: ${unsub}`;
  return { subject: subj, html, text: plain };
}

function campaignVars(ctx, r) { return { ...ctx, name: r.name, product: r.product }; }

/** The preview for the editor: how many people, the first of them rendered. */
export async function previewEmail(q, shopId, { subject = '', message = '', buttonText = '', buttonUrl = '', imageUrl = '', segment = {} }) {
  const [list, ctx] = await Promise.all([recipientsByEmail(q, shopId, segment), shopCtx(q, shopId)]);
  const first = list[0] || { name: 'Мария Иванова', email: 'maria@example.com', product: 'продукта' };
  const r = renderEmail({ shop: ctx.shop, subject, body: message, buttonText, buttonUrl, imageUrl, unsub: unsubUrl(shopId, first.email), vars: campaignVars(ctx, first) });
  return { count: list.length, sample: list.slice(0, 5).map((x) => ({ email: x.email, name: x.name })), subject: r.subject, html: r.html, configured: emailConfigured() };
}

async function loadCampaign(q, shopId, id) {
  if (!UUID.test(String(id || ''))) throw new Error('Няма такава кампания');
  const [c] = await q(`select * from zd.campaigns where id = $1::uuid and shop_id = $2::uuid`, [id, shopId]);
  if (!c) throw new Error('Няма такава кампания');
  if (c.channel !== 'email') throw new Error('Това не е имейл кампания');
  return { ...c, segment: typeof c.segment === 'string' ? JSON.parse(c.segment) : c.segment || {} };
}
const checkable = (c) => {
  if (!String(c.subject || '').trim()) throw new Error('Напишете тема на имейла');
  if (!String(c.message || '').trim()) throw new Error('Напишете текста на имейла');
  if (!c.consent) throw new Error('Потвърдете, че клиентите може да получават такива имейли (отметката в кампанията)');
};

/** One message to the shop's own address, with sample data, to see it in a real inbox. */
export async function sendTestEmail(q, shopId, id, to) {
  const c = await loadCampaign(q, shopId, id);
  if (!String(c.subject || '').trim() || !String(c.message || '').trim()) throw new Error('Напишете тема и текст на имейла');
  const email = normEmail(to);
  if (!validEmail(email)) throw new Error('Невалиден имейл адрес');
  const ctx = await shopCtx(q, shopId);
  const r = renderEmail({ shop: ctx.shop, subject: `[тест] ${c.subject}`, body: c.message, buttonText: c.button_text, buttonUrl: c.button_url, imageUrl: c.image_url,
    unsub: unsubUrl(shopId, email, c.id), vars: campaignVars(ctx, { name: 'Мария Иванова', product: 'продукта' }) });
  await sendBatch([{ from: fromAddress(ctx.shop), to: [email], subject: r.subject, html: r.html, text: r.text, ...(ctx.email ? { reply_to: ctx.email } : {}), tags: [{ name: 'kind', value: 'test' }] }]);
  return { ok: true };
}

/** „Изпрати“: the recipients of now are queued once, the campaign turns to „изпраща се“; the batches go out with sendSome. */
export async function startSend(q, shopId, id) {
  const c = await loadCampaign(q, shopId, id);
  checkable(c);
  if (c.status === 'sent') throw new Error('Кампанията вече е изпратена');
  if (!emailConfigured()) throw new Error('Изпращането на имейли още не е включено в платформата');
  const list = await recipientsByEmail(q, shopId, c.segment);
  if (!list.length) throw new Error('Няма клиенти с имейл по тези условия');
  await q(`insert into zd.email_sends (campaign_id, shop_id, email, name) select $1::uuid, $2::uuid, r.email, r.name
     from jsonb_to_recordset($3::text::jsonb) as r(email text, name text) on conflict (campaign_id, email) do nothing`,
    [c.id, shopId, JSON.stringify(list.map((r) => ({ email: r.email, name: r.name })))]);
  await q(`update zd.campaigns set status = 'sending', recipients = $3, updated_at = now() where id = $1::uuid and shop_id = $2::uuid`, [c.id, shopId, list.length]);
  return sendSome(q, shopId, id);
}

/** Sends the queued messages in batches of 100 while the budget lasts; the last call marks the campaign sent. Returns the progress. */
export async function sendSome(q, shopId, id, { budgetMs = 20000, now = () => Date.now() } = {}) {
  const c = await loadCampaign(q, shopId, id);
  const ctx = await shopCtx(q, shopId);
  const started = now();
  while (now() - started < budgetMs) {
    const rows = await q(`select id, email, name from zd.email_sends where campaign_id = $1::uuid and status = 'queued' order by created_at, id limit ${BATCH}`, [c.id]);
    if (!rows.length) break;
    // what the person bought last: for {продукт}
    const products = Object.fromEntries((await q(`select lower(o.email) as email, (array_agg(o.items order by o.created_at desc))[1] as items from zd.orders o
       where o.shop_id = $1::uuid and lower(o.email) = any($2::text[]) group by 1`, [shopId, rows.map((r) => r.email)]))
      .map((r) => { const it = typeof r.items === 'string' ? JSON.parse(r.items) : r.items || []; return [r.email, it[0]?.name || '']; }));
    const messages = rows.map((r) => {
      const m = renderEmail({ shop: ctx.shop, subject: c.subject, body: c.message, buttonText: c.button_text, buttonUrl: c.button_url, imageUrl: c.image_url,
        unsub: unsubUrl(shopId, r.email, c.id), vars: campaignVars(ctx, { name: r.name, product: products[r.email] || '' }) });
      return { from: fromAddress(ctx.shop), to: [r.email], subject: m.subject, html: m.html, text: m.text, ...(ctx.email ? { reply_to: ctx.email } : {}),
        headers: { 'List-Unsubscribe': `<${unsubUrl(shopId, r.email, c.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: [{ name: 'campaign', value: c.id }, { name: 'send', value: r.id }] };
    });
    try {
      const ids = await sendBatch(messages);
      await q(`update zd.email_sends s set status = 'sent', sent_at = now(), provider_id = nullif(x.pid, '') from
         jsonb_to_recordset($1::text::jsonb) as x(id uuid, pid text) where s.id = x.id`, [JSON.stringify(rows.map((r, i) => ({ id: r.id, pid: ids[i] || '' })))]);
    } catch (err) {
      // the whole batch failed (key, limits, network): these rows say why, the rest wait for the next call
      await q(`update zd.email_sends set status = 'failed', error = $2 where id = any($1::uuid[])`, [rows.map((r) => r.id), String(err.message || err).slice(0, 300)]);
      const p = await progress(q, c.id);
      return { ...p, error: err.message };
    }
  }
  const p = await progress(q, c.id);
  if (!p.queued) await q(`update zd.campaigns set status = 'sent', sent_at = coalesce(sent_at, now()), sent_count = $3, updated_at = now() where id = $1::uuid and shop_id = $2::uuid`, [c.id, shopId, p.sent]);
  return p;
}

/** The progress of one campaign of this shop. */
export async function campaignProgress(q, shopId, id) { const c = await loadCampaign(q, shopId, id); return progress(q, c.id); }
/** How a campaign went: queued, sent, delivered, opened, clicked, bounced, complained, failed, unsubscribed. */
export async function progress(q, campaignId) {
  const [r] = await q(`select count(*)::int as total, count(*) filter (where status = 'queued')::int as queued,
       count(*) filter (where status in ('sent', 'delivered'))::int as sent, count(*) filter (where status = 'delivered' or delivered_at is not null)::int as delivered,
       count(*) filter (where opened_at is not null)::int as opened, count(*) filter (where clicked_at is not null)::int as clicked,
       count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'complained')::int as complained,
       count(*) filter (where status = 'failed')::int as failed
     from zd.email_sends where campaign_id = $1::uuid`, [campaignId]);
  const [u] = await q(`select count(*)::int as n from zd.email_optouts where reason = $1`, [`campaign:${campaignId}`]);
  return { ...r, unsubscribed: u.n, done: r.total > 0 && r.queued === 0 };
}

/** The progress of every e-mail campaign of the shop at once (for the list). */
export async function progressAll(q, shopId) {
  const rows = await q(`select campaign_id, count(*)::int as total, count(*) filter (where status = 'queued')::int as queued,
       count(*) filter (where status in ('sent', 'delivered'))::int as sent, count(*) filter (where status = 'delivered' or delivered_at is not null)::int as delivered,
       count(*) filter (where opened_at is not null)::int as opened,
       count(*) filter (where clicked_at is not null)::int as clicked, count(*) filter (where status in ('bounced', 'complained'))::int as bounced,
       count(*) filter (where status = 'failed')::int as failed
     from zd.email_sends where shop_id = $1::uuid group by 1`, [shopId]);
  return Object.fromEntries(rows.map((r) => [r.campaign_id, { ...r, campaign_id: undefined }]));
}

/** Queues the failed rows again (after the key or the limit was fixed). */
export async function retryFailed(q, shopId, id) {
  const c = await loadCampaign(q, shopId, id);
  await q(`update zd.email_sends set status = 'queued', error = '' where campaign_id = $1::uuid and status = 'failed'`, [c.id]);
  await q(`update zd.campaigns set status = 'sending', updated_at = now() where id = $1::uuid and status = 'sent'`, [c.id]);
  return sendSome(q, shopId, id);
}

/* ---- opt-outs ---- */
export async function addEmailOptout(q, shopId, email, reason = '') {
  const e = normEmail(email);
  if (!validEmail(e)) return false;
  await q(`insert into zd.email_optouts (shop_id, email, reason) values ($1::uuid, $2, $3) on conflict do nothing`, [shopId, e, String(reason).slice(0, 80)]);
  return true;
}
export async function removeEmailOptout(q, shopId, email) { await q(`delete from zd.email_optouts where shop_id = $1::uuid and email = $2`, [shopId, normEmail(email)]); }
export async function listEmailOptouts(q, shopId) {
  return (await q(`select email, reason, created_at from zd.email_optouts where shop_id = $1::uuid order by created_at desc limit 5000`, [shopId]))
    .map((r) => ({ email: r.email, reason: r.reason, createdAt: new Date(r.created_at).toISOString() }));
}
/** The opt-outs typed in by hand: one address per line. */
export async function addEmailOptouts(q, shopId, text) {
  const list = [...new Set(String(text ?? '').split(/[\s,;]+/).map(normEmail).filter(validEmail))].slice(0, 5000);
  if (list.length) await q(`insert into zd.email_optouts (shop_id, email, reason) select $1::uuid, unnest($2::text[]), 'manual' on conflict do nothing`, [shopId, list]);
  return { added: list.length };
}

/* ---- what Resend reports back ---- */
const EVENTS = {
  'email.delivered': `status = case when status = 'sent' then 'delivered' else status end, delivered_at = coalesce(delivered_at, now())`,
  'email.opened': `opened_at = coalesce(opened_at, now())`,
  'email.clicked': `clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now())`,
  'email.bounced': `status = 'bounced'`,
  'email.complained': `status = 'complained'`,
};
export async function applyEmailEvent(q, event) {
  const set = EVENTS[event?.type];
  const pid = event?.data?.email_id;
  if (!set || !pid) return { ignored: true };
  const [row] = await q(`update zd.email_sends set ${set} where provider_id = $1 returning shop_id, email, campaign_id`, [String(pid)]);
  if (!row) return { ignored: true };
  if (event.type === 'email.bounced' || event.type === 'email.complained') await addEmailOptout(q, row.shop_id, row.email, event.type === 'email.bounced' ? 'bounce' : 'complaint');
  return { ok: true };
}
