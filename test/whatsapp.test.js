import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { getSecret, getIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { sendOrderConfirmation } from '../lib/whatsapp.js';
import integrationsApi from '../lib/admin/integrations.js';
import webhook from '../api/wa/webhook.js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.META_APP_ID = '1136036008845539';
process.env.META_APP_SECRET = 'app-secret';
process.env.WHATSAPP_CONFIG_ID = '999000111';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
const SHOP = '00000000-0000-4000-8000-000000000001';
const cookie = `zdo_admin=${signSession('secret')}`;
let q, calls;

const ok = (d) => ({ ok: true, status: 200, json: async () => d });
const fail = (status, message, code = 100) => ({ ok: false, status, json: async () => ({ error: { message, code } }) });
/** fake Graph API for WhatsApp; records every call */
function graph(handlers = {}) {
  calls = [];
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path, query: Object.fromEntries(u.searchParams), body, auth: init.headers?.Authorization });
    for (const [k, h] of Object.entries(handlers)) if (path === k || path.startsWith(k)) return h({ path, body, u });
    if (path === '/oauth/access_token') return ok({ access_token: 'BUSINESS-TOKEN' });
    if (path === '/102290129340398') return ok({ id: '102290129340398', name: 'Магазин А WhatsApp' });
    if (path === '/106540352242922') return ok({ id: '106540352242922', display_phone_number: '+359 88 800 1234', verified_name: 'Магазин А' });
    if (path === '/102290129340398/subscribed_apps') return ok({ success: true });
    if (path === '/102290129340398/phone_numbers') return ok({ data: [{ id: '106540352242922' }] });
    if (path === '/106540352242922/register') return ok({ success: true });
    if (path === '/102290129340398/message_templates' && init.method === 'POST') return ok({ id: 'TPL1', status: 'PENDING', category: 'UTILITY' });
    if (path === '/102290129340398/message_templates') return ok({ data: [{ name: 'potvarzhdenie_porachka_v1', status: 'APPROVED', language: 'bg' }] });
    if (path === '/106540352242922/messages') return ok({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.1' }] });
    return fail(400, `unexpected ${path}`);
  };
}
async function withFetch(impl, fn) { const r = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = r; } }
const post = async (body, url = `/api/admin/integrations?shop=${SHOP}`) => { const res = fakeRes(); await integrationsApi(fakeReq({ method: 'POST', url, headers: { cookie }, body }), res); return res; };
async function connect() {
  const res = await withFetch(graph(), () => post({ action: 'wa_connect', code: 'CODE', wabaId: '102290129340398', phoneNumberId: '106540352242922' }));
  assert.equal(res.statusCode, 200, res.body);
  return res;
}
async function addOrder(patch = {}) {
  return (await insertOrder(q, {
    cbOrderId: `a-shop.bg:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис Плевен (5803), ул. Х', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
    total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP, ...patch,
  })).id;
}
const sign = (raw) => `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
function hook({ method = 'POST', url = '/api/wa/webhook', body, signature }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = { method, url, headers: { 'x-hub-signature-256': signature ?? sign(raw) }, socket: {} };
  req.on = (ev, cb) => { if (ev === 'data' && raw) cb(Buffer.from(raw)); if (ev === 'end') cb(); return req; };
  return req;
}
const tap = (payload, from = '359888123456', id = `wamid.${Math.random()}`) => ({ object: 'whatsapp_business_account', entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: '106540352242922' }, contacts: [{ wa_id: from }],
  messages: [{ from, id, timestamp: '1', type: 'button', button: { payload, text: payload.startsWith('yes') ? 'Потвърждавам' : 'Отказвам' } }] } }] }] });

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
});

test('the admin gets what the "Свържи WhatsApp" button needs (app id, configuration) — no secrets', async () => {
  const res = await post({ action: 'wa_config' });
  assert.deepEqual(json(res), { ok: true, appId: '1136036008845539', configId: '999000111', ready: true });
});

test('connecting: the code becomes a business token, the account is checked, webhooks subscribed, the number registered; the token is sealed', async () => {
  await connect();
  const paths = calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['GET /oauth/access_token', 'GET /102290129340398', 'GET /106540352242922', 'GET /102290129340398/phone_numbers', 'POST /102290129340398/subscribed_apps', 'POST /106540352242922/register']);
  assert.deepEqual(calls[0].query, { client_id: '1136036008845539', client_secret: 'app-secret', code: 'CODE' });
  assert.equal(calls[4].auth, 'Bearer BUSINESS-TOKEN');
  assert.equal(calls[5].body.messaging_product, 'whatsapp');
  assert.match(calls[5].body.pin, /^\d{6}$/);
  const secret = JSON.parse(await getSecret(q, 'whatsapp', SHOP));
  assert.equal(secret.token, 'BUSINESS-TOKEN');
  assert.equal(secret.pin, calls[5].body.pin);
  const st = json(await (async () => { const res = fakeRes(); await integrationsApi(fakeReq({ url: `/api/admin/integrations?shop=${SHOP}`, headers: { cookie } }), res); return res; })());
  assert.deepEqual({ ...st.whatsapp, connectedAt: undefined }, {
    connected: true, phone: '+359 88 800 1234', name: 'Магазин А', wabaId: '102290129340398', templateStatus: '', autoConfirm: false, lastError: null, connectedAt: undefined, ready: true,
  });
  assert.ok(!JSON.stringify(st).includes('BUSINESS-TOKEN'));
});

test('a number that is already registered still connects; a bad code is a Bulgarian error and stores nothing', async () => {
  const res = await withFetch(graph({ '/106540352242922/register': () => fail(400, 'Phone number already registered', 133005) }),
    () => post({ action: 'wa_connect', code: 'CODE', wabaId: '102290129340398', phoneNumberId: '106540352242922' }));
  assert.equal(res.statusCode, 200);
  q = await makeTestQuery(); setQueryForTests(q);
  const bad = await withFetch(graph({ '/oauth/access_token': () => fail(400, 'This authorization code has expired.', 100) }),
    () => post({ action: 'wa_connect', code: 'OLD', wabaId: '102290129340398', phoneNumberId: '106540352242922' }));
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /WhatsApp|Meta/);
  assert.equal((await getIntegration(q, 'whatsapp', SHOP)).hasSecret, false);
});

test('the confirmation template is submitted to Meta (utility, Bulgarian, two quick replies) and its approval is read back', async () => {
  await connect();
  await withFetch(graph(), () => post({ action: 'wa_template' }));
  const create = calls.find((c) => c.method === 'POST' && c.path === '/102290129340398/message_templates');
  assert.equal(create.body.category, 'UTILITY');
  assert.equal(create.body.language, 'bg');
  const body = create.body.components.find((c) => c.type === 'BODY');
  assert.match(body.text, /\{\{1\}\}/);
  assert.ok(body.example.body_text[0].length >= 4);
  const buttons = create.body.components.find((c) => c.type === 'BUTTONS').buttons;
  assert.deepEqual(buttons.map((b) => [b.type, b.text]), [['QUICK_REPLY', 'Потвърждавам'], ['QUICK_REPLY', 'Отказвам']]);
  assert.equal((await getIntegration(q, 'whatsapp', SHOP)).config.templateStatus, 'PENDING');
  const res = await withFetch(graph(), () => post({ action: 'wa_refresh' }));
  assert.equal(json(res).templateStatus, 'APPROVED');
});

test('with auto-confirm on, a new order gets the WhatsApp template with personal button payloads', async () => {
  await connect();
  await withFetch(graph(), () => post({ action: 'wa_template' }));
  await withFetch(graph(), () => post({ action: 'wa_refresh' }));
  await post({ action: 'wa_settings', autoConfirm: true });
  const id = await addOrder();
  await withFetch(graph(), () => sendOrderConfirmation(q, id));
  const send = calls.find((c) => c.path === '/106540352242922/messages');
  assert.equal(send.body.to, '359888123456');
  assert.equal(send.body.type, 'template');
  assert.equal(send.body.template.name, 'potvarzhdenie_porachka_v1');
  assert.equal(send.body.template.language.code, 'bg');
  const params = send.body.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
  assert.deepEqual(params, ['Мария', 'Магазин А', '1 × Книга — 22,57 €', 'ЕКОНТ – офис Плевен (5803)']);
  const btns = send.body.template.components.filter((c) => c.type === 'button');
  assert.match(btns[0].parameters[0].payload, /^yes:[A-Za-z0-9_-]{30,}$/);
  assert.match(btns[1].parameters[0].payload, /^no:[A-Za-z0-9_-]{30,}$/);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.confirmation.sent, true);
});

test('nothing is sent while auto-confirm is off or the template is not approved', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(graph(), () => sendOrderConfirmation(q, id));
  assert.equal(calls.filter((c) => c.path === '/106540352242922/messages').length, 0);
});

test('webhook verification answers Meta\'s challenge only with our verify token', async () => {
  let res = fakeRes();
  await webhook(hook({ method: 'GET', url: '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '12345');
  res = fakeRes();
  await webhook(hook({ method: 'GET', url: '/api/wa/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' }), res);
  assert.equal(res.statusCode, 403);
});

test('a tap on "Потвърждавам" confirms the order and thanks the customer; a forged webhook is refused', async () => {
  await connect();
  await withFetch(graph(), () => post({ action: 'wa_template' }));
  await withFetch(graph(), () => post({ action: 'wa_refresh' }));
  await post({ action: 'wa_settings', autoConfirm: true });
  const id = await addOrder();
  await withFetch(graph(), () => sendOrderConfirmation(q, id));
  const payload = calls.find((c) => c.path === '/106540352242922/messages').body.template.components.filter((c) => c.type === 'button')[0].parameters[0].payload;
  let res = fakeRes();
  await withFetch(graph(), () => webhook(hook({ body: tap(payload), signature: 'sha256=forged' }), res));
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await withFetch(graph(), () => webhook(hook({ body: tap(payload) }), res));
  assert.equal(res.statusCode, 200);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'confirmed');
  assert.equal(o.confirmation.answer, 'yes');
  const reply = calls.find((c) => c.path === '/106540352242922/messages' && c.body.type === 'text');
  assert.equal(reply.body.to, '359888123456');
  assert.match(reply.body.text.body, /потвърдена/);
});

test('"STOP" from a customer puts the number on the shop\'s STOP list', async () => {
  await connect();
  const body = { object: 'whatsapp_business_account', entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '106540352242922' }, messages: [{ from: '359888777666', id: 'w', timestamp: '1', type: 'text', text: { body: ' Stop ' } }] } }] }] };
  const res = fakeRes();
  await withFetch(graph(), () => webhook(hook({ body }), res));
  assert.equal(res.statusCode, 200);
  const [r] = await q(`select phone_norm from zd.campaign_optouts where shop_id = $1`, [SHOP]);
  assert.equal(r.phone_norm, '+359888777666');
});

test('a webhook for a number we do not know changes nothing', async () => {
  const res = fakeRes();
  await withFetch(graph(), () => webhook(hook({ body: tap('yes:' + 'a'.repeat(32)) }), res));
  assert.equal(res.statusCode, 200);
});

test('the test message goes only to the number the admin types, never to a customer', async () => {
  await connect();
  await withFetch(graph(), () => post({ action: 'wa_template' }));
  await withFetch(graph(), () => post({ action: 'wa_refresh' }));
  await addOrder();
  const res = await withFetch(graph(), () => post({ action: 'wa_test', phone: '0899 111 222' }));
  assert.equal(res.statusCode, 200);
  const send = calls.find((c) => c.path === '/106540352242922/messages');
  assert.equal(send.body.to, '359899111222');
  assert.equal(send.body.template.components.find((c) => c.type === 'button').parameters[0].payload, 'test');
  assert.equal((await withFetch(graph(), () => post({ action: 'wa_test', phone: '' }))).statusCode, 400);
});

/* ---- review fixes ---- */
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
async function readyToSend() {
  await connect();
  await withFetch(graph(), () => post({ action: 'wa_template' }));
  await withFetch(graph(), () => post({ action: 'wa_refresh' }));
  await post({ action: 'wa_settings', autoConfirm: true });
}

test('old orders and orders not "new" never get the confirmation message', async () => {
  await readyToSend();
  const old = await addOrder();
  await q(`update zd.orders set created_at = now() - interval '3 days' where id = $1`, [old]);
  const shipped = await addOrder();
  await q(`update zd.orders set status = 'shipped' where id = $1`, [shipped]);
  await withFetch(graph(), async () => { await sendOrderConfirmation(q, old); await sendOrderConfirmation(q, shipped); });
  assert.equal(calls.filter((c) => c.path === '/106540352242922/messages').length, 0);
});

test('a number already connected to another shop is refused', async () => {
  await connect();
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  const res = await withFetch(graph(), () => post({ action: 'wa_connect', code: 'CODE2', wabaId: '102290129340398', phoneNumberId: '106540352242922' }, `/api/admin/integrations?shop=${other}`));
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /друг магазин/);
});

test('a number that is not in the chosen WhatsApp account is refused', async () => {
  const res = await withFetch(graph({ '/102290129340398/phone_numbers': () => ok({ data: [{ id: '555000555000555' }] }) }),
    () => post({ action: 'wa_connect', code: 'CODE', wabaId: '102290129340398', phoneNumberId: '106540352242922' }));
  assert.equal(res.statusCode, 400);
});

test('a customer\'s own text reaches the shop as a notification; the cancel reply names how to reach the shop', async () => {
  await readyToSend();
  await q(`update zd.shops set phone = '0888 000 111' where id = $1`, [SHOP]);
  process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
  const pushed = [];
  setPushSenderForTests(async (s, p) => { pushed.push(JSON.parse(p)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/o', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '106540352242922' }, contacts: [{ profile: { name: 'Мария' }, wa_id: '359888123456' }],
    messages: [{ from: '359888123456', id: 'wamid.txt1', timestamp: '1', type: 'text', text: { body: 'Може ли да сменя офиса?' } }] } }] }] };
  await withFetch(graph(), () => webhook(hook({ body }), fakeRes()));
  assert.match(pushed.at(-1).title, /WhatsApp/);
  assert.match(pushed.at(-1).body, /Мария.*Може ли да сменя офиса\?/);
  const id = await addOrder();
  await withFetch(graph(), () => sendOrderConfirmation(q, id));
  const noPayload = calls.find((c) => c.path === '/106540352242922/messages').body.template.components.filter((c) => c.type === 'button')[1].parameters[0].payload;
  await withFetch(graph(), () => webhook(hook({ body: tap(noPayload) }), fakeRes()));
  const reply = calls.find((c) => c.body?.type === 'text');
  assert.match(reply.body.text.body, /0888 000 111/);
});

test('Meta retries of the same message are handled once', async () => {
  await readyToSend();
  const id = await addOrder();
  await withFetch(graph(), () => sendOrderConfirmation(q, id));
  const payload = calls.find((c) => c.path === '/106540352242922/messages').body.template.components.filter((c) => c.type === 'button')[0].parameters[0].payload;
  const again = tap(payload, '359888123456', 'wamid.retry');
  await withFetch(graph(), async () => { await webhook(hook({ body: again }), fakeRes()); await webhook(hook({ body: again }), fakeRes()); });
  assert.equal(calls.filter((c) => c.body?.type === 'text').length, 1);
});

test('a failed send is shown to the shop; Meta\'s user message is used', async () => {
  await readyToSend();
  const id = await addOrder();
  await withFetch(graph({ '/106540352242922/messages': () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid parameter', code: 131042, error_user_msg: 'Няма добавен метод за плащане' } }) }) }),
    () => sendOrderConfirmation(q, id));
  assert.match((await getIntegration(q, 'whatsapp', SHOP)).config.lastError, /метод за плащане/);
});

test('disconnecting forgets the token and unsubscribes our app', async () => {
  await connect();
  await withFetch(graph({ '/102290129340398/subscribed_apps': () => ok({ success: true }) }), () => post({ action: 'wa_disconnect' }));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/102290129340398/subscribed_apps'));
  assert.equal((await getIntegration(q, 'whatsapp', SHOP)).hasSecret, false);
});
