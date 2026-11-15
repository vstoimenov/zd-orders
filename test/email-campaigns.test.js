// E-mail campaigns: who gets them, what they look like, the sending in batches through Resend, what comes back, the unsubscribe link.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { recipientsByEmail, saveCampaign } from '../lib/campaigns.js';
import { renderEmail, previewEmail, startSend, sendSome, progress, applyEmailEvent, addEmailOptouts, listEmailOptouts } from '../lib/email-campaigns.js';
import { unsubToken, readUnsub, unsubUrl, webhookOk, fromAddress } from '../lib/email.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, n = 0;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); n = 0;
  delete process.env.RESEND_API_KEY;
  await q(`update zd.shops set name = 'Крем БГ', email = 'shop@krem.bg' where id = $1::uuid`, [SHOP]);
});
async function order({ email = `k${++n}@x.bg`, name = 'Мария Иванова', status = 'delivered', product = 'Крем за лице', phone = null } = {}) {
  const ph = phone || `+3598880${String(n).padStart(5, '0')}`;
  const r = await insertOrder(q, {
    cbOrderId: `s:${n}:${Math.random()}`, name, phone: ph, phoneNorm: ph, email, deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'x', city: 'x', postCode: '',
    addressText: '', items: [{ name: product, qty: 1, price: 25 }], total: 30, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: String(n), shopId: SHOP,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  return r;
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error; globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const post = async (body, cookie = owner) => { const res = fakeRes(); await router({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, headers: { cookie }, body: JSON.stringify(body), socket: {} }, res); return res; };

test('recipients by e-mail: one person = one address, only valid ones, never the opted-out; the segment filters hold', async () => {
  await order({ email: 'Ana@X.bg', name: 'Ана' }); await order({ email: 'ana@x.bg', name: 'Ана Петрова', product: 'Серум' });
  await order({ email: 'bad-address' }); await order({ email: '' }); await order({ email: 'new@x.bg', status: 'new' });
  await order({ email: 'gone@x.bg' });
  await addEmailOptouts(q, SHOP, 'gone@x.bg\nnot-an-email');
  const list = await recipientsByEmail(q, SHOP, {});
  assert.deepEqual(list.map((r) => [r.email, r.name, r.product, r.orders]), [['ana@x.bg', 'Ана Петрова', 'Серум', 2]]);
  assert.equal((await recipientsByEmail(q, SHOP, { statuses: ['new'] })).length, 1);
  assert.equal((await recipientsByEmail(q, SHOP, { minOrders: 3 })).length, 0);
  assert.equal((await recipientsByEmail(q, SHOP, { product: 'сер' })).length, 1);
  assert.deepEqual((await listEmailOptouts(q, SHOP)).map((o) => o.email), ['gone@x.bg']);
});

test('the e-mail: the shop on top, paragraphs, the button and picture only with real links, the variables, the unsubscribe footer; nothing unescaped', () => {
  const r = renderEmail({ shop: 'Крем <БГ>', subject: 'За {име}', body: 'Здравейте, {име}!\n\nВтори <абзац>\nнов ред', buttonText: 'Виж', buttonUrl: 'https://krem.bg/x', imageUrl: 'javascript:alert(1)',
    unsub: 'https://app.ordyx.eu/api/admin/email?u=t', vars: { name: 'Мария Иванова', shop: 'Крем БГ', product: 'крем', link: 'https://krem.bg' } });
  assert.equal(r.subject, 'За Мария');
  assert.match(r.html, /Крем &lt;БГ&gt;/);
  assert.match(r.html, /Здравейте, Мария!<\/p>/);
  assert.match(r.html, /Втори &lt;абзац&gt;<br>нов ред/);
  assert.match(r.html, /href="https:\/\/krem\.bg\/x"[^>]*>Виж</);
  assert.doesNotMatch(r.html, /javascript:/);
  assert.doesNotMatch(r.html, /<img/);
  assert.match(r.html, /Отпишете се/);
  assert.match(r.text, /Отписване: https:\/\/app\.ordyx\.eu/);
  assert.equal(fromAddress('Крем "БГ", <x>'), 'Крем БГ x <no-reply@ordyx.eu>');
});

test('the unsubscribe token names the shop and address and cannot be forged; the signed webhook is accepted, others not', () => {
  const t = unsubToken(SHOP, 'Ana@X.bg ');
  assert.deepEqual(readUnsub(t), { shopId: SHOP, email: 'ana@x.bg' });
  assert.equal(readUnsub(t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a')), null);
  assert.equal(readUnsub(`${SHOP}.${Buffer.from('other@x.bg').toString('base64url')}.${t.split('.')[2]}`), null);
  assert.match(unsubUrl(SHOP, 'ana@x.bg', 'c1'), /\/api\/admin\/email\?u=.+&c=c1$/);
  const secret = Buffer.from('supersecret').toString('base64'), raw = '{"type":"email.opened"}', ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(secret, 'base64')).update(`msg_1.${ts}.${raw}`).digest('base64');
  const headers = { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
  assert.equal(webhookOk(raw, headers, `whsec_${secret}`), true);
  assert.equal(webhookOk(raw, { ...headers, 'svix-signature': 'v1,AAAA' }, `whsec_${secret}`), false);
  assert.equal(webhookOk(raw, { ...headers, 'svix-timestamp': String(Number(ts) - 1000) }, `whsec_${secret}`), false);
  assert.equal(webhookOk(raw, headers, ''), false);
});

test('an e-mail campaign is saved with its subject and button, previewed, sent in batches through Resend; the progress follows what comes back', async () => {
  for (let i = 0; i < 3; i++) await order({ email: `p${i}@x.bg`, name: `Клиент ${i}` });
  await assert.rejects(saveCampaign(q, SHOP, { channel: 'email', name: 'Промо', subject: 'Здравей', message: 'x', buttonText: 'Виж', buttonUrl: 'krem.bg' }), /http/);
  const c = await saveCampaign(q, SHOP, { channel: 'email', name: 'Промо', subject: 'Здравей, {име}', message: 'Нови продукти в {магазин}: {продукт}', buttonText: 'Виж', buttonUrl: 'https://krem.bg', consent: true, status: 'ready' });
  assert.equal(c.channel, 'email'); assert.equal(c.recipients, 3); assert.equal(c.subject, 'Здравей, {име}'); assert.equal(c.buttonUrl, 'https://krem.bg');
  const pv = await previewEmail(q, SHOP, { subject: c.subject, message: c.message, segment: {} });
  assert.equal(pv.count, 3); assert.match(pv.subject, /^Здравей, Клиент/); assert.match(pv.html, /Крем БГ/); assert.equal(pv.configured, false);
  await assert.rejects(startSend(q, SHOP, c.id), /не е включено/);
  process.env.RESEND_API_KEY = 're_test';
  const calls = [];
  const resend = async (url, init) => {
    const msgs = JSON.parse(init.body); calls.push({ url, auth: init.headers.Authorization, msgs });
    return { ok: true, status: 200, json: async () => ({ data: msgs.map((_, i) => ({ id: `em_${calls.length}_${i}` })) }) };
  };
  const p = await withFetch(resend, () => startSend(q, SHOP, c.id));
  assert.deepEqual([p.total, p.queued, p.sent, p.done], [3, 0, 3, true]);
  assert.equal(calls.length, 1); assert.equal(calls[0].auth, 'Bearer re_test'); assert.match(calls[0].url, /\/emails\/batch$/);
  const m = calls[0].msgs.find((x) => x.to[0] === 'p1@x.bg');
  assert.equal(m.from, 'Крем БГ <no-reply@ordyx.eu>'); assert.equal(m.reply_to, 'shop@krem.bg'); assert.equal(m.subject, 'Здравей, Клиент');
  assert.match(m.html, /Крем за лице/); assert.match(m.headers['List-Unsubscribe'], /api\/admin\/email\?u=/); assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(m.tags[0], { name: 'campaign', value: c.id });
  const [row] = await q(`select status, sent_count from zd.campaigns where id = $1::uuid`, [c.id]);
  assert.deepEqual([row.status, row.sent_count], ['sent', 3]);
  await assert.rejects(saveCampaign(q, SHOP, { id: c.id, channel: 'email', name: 'x', subject: 's', message: 'm' }), /не се променя/);
  // what Resend reports back
  const [s1] = await q(`select provider_id from zd.email_sends where email = 'p1@x.bg'`);
  assert.deepEqual(await applyEmailEvent(q, { type: 'email.delivered', data: { email_id: s1.provider_id } }), { ok: true });
  await applyEmailEvent(q, { type: 'email.clicked', data: { email_id: s1.provider_id } });
  const [s2] = await q(`select provider_id from zd.email_sends where email = 'p2@x.bg'`);
  await applyEmailEvent(q, { type: 'email.bounced', data: { email_id: s2.provider_id } });
  assert.deepEqual(await applyEmailEvent(q, { type: 'email.opened', data: { email_id: 'em_nope' } }), { ignored: true });
  const pr = await progress(q, c.id);
  assert.deepEqual([pr.delivered, pr.opened, pr.clicked, pr.bounced], [1, 1, 1, 1]);
  assert.deepEqual((await listEmailOptouts(q, SHOP)).map((o) => [o.email, o.reason]), [['p2@x.bg', 'bounce']]);
  // a second campaign no longer reaches the bounced address
  assert.equal((await recipientsByEmail(q, SHOP, {})).length, 2);
});

test('a failed batch is marked, nothing is lost; the next call sends what is left', async () => {
  for (let i = 0; i < 2; i++) await order({ email: `f${i}@x.bg` });
  const c = await saveCampaign(q, SHOP, { channel: 'email', name: 'x', subject: 's', message: 'm', consent: true });
  process.env.RESEND_API_KEY = 're_test';
  let p = await withFetch(async () => ({ ok: false, status: 429, json: async () => ({ message: 'rate limit' }) }), () => startSend(q, SHOP, c.id));
  assert.equal(p.failed, 2); assert.match(p.error, /rate limit/);
  assert.equal((await q(`select status from zd.campaigns where id = $1::uuid`, [c.id]))[0].status, 'sending');
  const { retryFailed } = await import('../lib/email-campaigns.js');
  p = await withFetch(async (_u, init) => ({ ok: true, status: 200, json: async () => ({ data: JSON.parse(init.body).map((_, i) => ({ id: `r_${i}` })) }) }), () => retryFailed(q, SHOP, c.id));
  assert.deepEqual([p.sent, p.failed, p.done], [2, 0, true]);
});

test('the public route: the link unsubscribes (GET page, one-click POST) and the webhook needs the signature; the admin actions need a login', async () => {
  await order({ email: 'u@x.bg' });
  const call = async (method, url, extra = {}) => { const res = fakeRes(); await router({ method, url, headers: {}, socket: {}, ...extra }, res); return res; };
  let res = await call('GET', `/api/admin/email?u=${encodeURIComponent(unsubToken(SHOP, 'u@x.bg'))}&c=00000000-0000-4000-8000-00000000c001`);
  assert.equal(res.statusCode, 200); assert.match(res.body, /Отписахте се/); assert.match(res.body, /Крем БГ/);
  assert.deepEqual((await listEmailOptouts(q, SHOP)).map((o) => [o.email, o.reason]), [['u@x.bg', 'campaign:00000000-0000-4000-8000-00000000c001']]);
  assert.equal((await recipientsByEmail(q, SHOP, {})).length, 0);
  res = await call('GET', '/api/admin/email?u=bogus'); assert.equal(res.statusCode, 404);
  res = await call('POST', `/api/admin/email?u=${encodeURIComponent(unsubToken(SHOP, 'u@x.bg'))}`); assert.equal(res.statusCode, 200);
  res = await call('POST', '/api/admin/email?webhook=1', { body: '{"type":"email.opened"}' }); assert.equal(res.statusCode, 401);
  res = await post({ action: 'email_optouts' }, ''); assert.equal(res.statusCode, 401);
  res = await post({ action: 'email_optouts' }); assert.equal(json(res).optouts.length, 1);
  res = await post({ action: 'email_progress', id: '00000000-0000-4000-8000-00000000c001' }); assert.equal(res.statusCode, 400);
});
