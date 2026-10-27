import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { autoCallDue } from '../lib/voice-auto.js';
import router from '../api/admin/[route].js';
import cron from '../api/cron/refresh.js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
const realFetch = globalThis.fetch;
// 11:00 in Sofia (UTC+2 after 25.10)
const NOON = new Date('2026-10-27T09:00:00Z');
let q, calls, agentStatus;

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  process.env.VOICE_CALL_URL = 'https://voice.example/ordyx/call';
  process.env.VOICE_CALL_SECRET = 'voice-secret';
  calls = []; agentStatus = 200;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify(agentStatus === 200 ? { ok: true } : { error: 'Номерът не е мобилен' }), { status: agentStatus }); };
  await q(`update zd.shops set voice_auto = true where id = $1`, [SHOP]);
});
afterEach(() => { globalThis.fetch = realFetch; });

let seq = 0;
const order = async (minutesAgo, patch = {}) => {
  const { id } = await insertOrder(q, {
    cbOrderId: `va-${++seq}`, name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'офис', city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
    total: 20, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP,
  });
  await q(`update zd.orders set created_at = $2::timestamptz - make_interval(mins => $3) where id = $1::uuid`, [id, NOON.toISOString(), minutesAgo]);
  for (const [k, v] of Object.entries(patch)) await q(`update zd.orders set ${k} = $2 where id = $1::uuid`, [id, v]);
  return id;
};
const calledIds = () => calls.map((c) => c.body.order_id);

test('an hour after the order the agent calls once; the next tick does not call again', async () => {
  const id = await order(70);
  const r = await autoCallDue(q, { now: NOON });
  assert.equal(r.called, 1);
  assert.deepEqual(calledIds(), [id]);
  assert.ok((await q(`select voice_auto_at from zd.orders where id = $1::uuid`, [id]))[0].voice_auto_at);
  await autoCallDue(q, { now: NOON });
  assert.equal(calls.length, 1);
});

test('not called: too fresh, older than a day, already confirmed, sent, without a phone, switch off, or already called by hand', async () => {
  await order(30);
  await order(25 * 60);
  await order(90, { status: 'confirmed' });
  await order(90, { waybill_number: '1055' });
  await order(90, { phone_norm: '' });
  await order(90, { voice_auto_at: NOON.toISOString() });
  const other = (await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`))[0].id;
  const off = await order(90); await q(`update zd.orders set shop_id = $2 where id = $1::uuid`, [off, other]);
  assert.equal((await autoCallDue(q, { now: NOON })).called, 0);
  assert.equal(calls.length, 0);
});

test('only between 9:00 and 20:00 Sofia time: a night order is called in the morning', async () => {
  const id = await order(60 * 11); // placed 22:00 the evening before
  assert.equal((await autoCallDue(q, { now: new Date('2026-10-26T21:30:00Z') })).called, 0, '23:30 in Sofia');
  assert.equal((await autoCallDue(q, { now: new Date('2026-10-27T06:59:00Z') })).called, 0, '08:59 in Sofia');
  await autoCallDue(q, { now: NOON });
  assert.deepEqual(calledIds(), [id]);
});

test('an agent refusal is not retried every tick and does not stop the other calls', async () => {
  const a = await order(80), b = await order(75);
  agentStatus = 400;
  const r = await autoCallDue(q, { now: NOON });
  assert.equal(r.failed, 2);
  agentStatus = 200;
  await autoCallDue(q, { now: NOON });
  assert.deepEqual(calledIds().sort(), [a, b].sort(), 'each tried once');
});

test('a call by hand marks the order, so the automatic one does not ring again', async () => {
  const id = await order(70);
  const res = fakeRes();
  await router({ method: 'POST', url: `/api/admin/voice?shop=${SHOP}`, headers: { cookie: owner }, body: JSON.stringify({ action: 'call', id }), socket: {} }, res);
  assert.equal(res.statusCode, 200);
  await autoCallDue(q, { now: NOON });
  assert.equal(calls.length, 1);
});

test('the owner switches it per shop; a client cannot; the shop list says whether it is on', async () => {
  const post = async (cookie, on) => { const res = fakeRes(); await router({ method: 'POST', url: `/api/admin/voice?shop=${SHOP}`, headers: { cookie }, body: JSON.stringify({ action: 'auto', on }), socket: {} }, res); return res; };
  const r = await post(owner, false);
  assert.equal(r.statusCode, 200); assert.equal(json(r).voiceAuto, false);
  const shops = fakeRes(); await router({ method: 'GET', url: '/api/admin/shops', headers: { cookie: owner }, socket: {} }, shops);
  assert.equal(json(shops).shops.find((s) => s.id === SHOP).voiceAuto, false);
  const c = await createClient(q, { email: 'c@x.bg', name: 'К', shopIds: [SHOP] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  assert.equal((await post(`zdo_admin=${clientSession('secret', u)}`, true)).statusCode, 403);
});

test('the tick: /api/cron/refresh?job=voice runs only the calls, with its own secret', async () => {
  process.env.VOICE_TICK_SECRET = 'tick-secret';
  await order(70);
  const run = async (auth) => { const res = fakeRes(); await cron({ method: 'GET', url: '/api/cron/refresh?job=voice', headers: auth ? { authorization: auth } : {} }, res); return res; };
  assert.equal((await run('Bearer wrong')).statusCode, 401);
  assert.equal((await run()).statusCode, 401);
  const ok = await run('Bearer tick-secret');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(calls.every((c) => c.url === 'https://voice.example/ordyx/call'), 'no courier refresh, no other jobs');
});

test('the tick can prove itself with a one-time code the database wrote (no shared secret): valid once, fresh only', async () => {
  delete process.env.VOICE_TICK_SECRET;
  await order(70);
  const run = async (nonce) => { const res = fakeRes(); await cron({ method: 'GET', url: `/api/cron/refresh?job=voice&nonce=${encodeURIComponent(nonce)}`, headers: {} }, res); return res; };
  const mint = async (n, ago = '0 seconds') => q(`insert into zd.settings (key, value) values ('voice_tick_nonce', jsonb_build_object('nonce', $1::text, 'at', now() - $2::interval))
    on conflict (key) do update set value = excluded.value`, [n, ago]);
  await mint('11111111-2222-4333-8444-555555555555');
  assert.equal((await run('wrong-code-0000')).statusCode, 401);
  assert.equal((await run('11111111-2222-4333-8444-555555555555')).statusCode, 200);
  assert.equal((await run('11111111-2222-4333-8444-555555555555')).statusCode, 401, 'used up');
  await mint('66666666-2222-4333-8444-555555555555', '10 minutes');
  assert.equal((await run('66666666-2222-4333-8444-555555555555')).statusCode, 401, 'too old');
  assert.equal((await run('')).statusCode, 401);
});
