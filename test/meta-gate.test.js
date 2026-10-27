import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.META_APP_ID = 'app'; process.env.META_APP_SECRET = 'app-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, client;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  delete process.env.META_PUBLIC;
  const c = await createClient(q, { email: 'c@x.bg', name: 'К', shopIds: [SHOP] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  client = `zdo_admin=${clientSession('secret', u)}`;
});
const call = async (cookie, { method = 'GET', url = `/api/admin/integrations?shop=${SHOP}`, body } = {}) => {
  const res = fakeRes(); await router({ method, url, headers: { cookie }, body: body && JSON.stringify(body), socket: {} }, res); return res;
};

test('Meta ads are „скоро“ for clients until the app is approved (META_PUBLIC=1); the owner connects as before', async () => {
  assert.equal(json(await call(client)).meta.open, false);
  assert.equal(json(await call(owner)).meta.open, true);
  const refused = await call(client, { method: 'POST', body: { action: 'save_meta', accountId: '123', token: 't' } });
  assert.equal(refused.statusCode, 403); assert.match(json(refused).error, /скоро/i);
  assert.equal((await call(client, { method: 'POST', body: { action: 'meta_accounts', token: 't' } })).statusCode, 403);
  const login = await call(client, { url: `/api/admin/meta?start=1&shop=${SHOP}` });
  assert.equal(login.statusCode, 302); assert.match(decodeURIComponent(login.getHeader ? login.getHeader('Location') : login.headers.location), /скоро/i);
  process.env.META_PUBLIC = '1';
  assert.equal(json(await call(client)).meta.open, true);
});

test('the „Първи стъпки“ guide knows whether Meta can be connected yet', async () => {
  assert.equal(json(await call(client, { url: `/api/admin/onboarding?shop=${SHOP}` })).metaOpen, false);
  assert.equal(json(await call(owner, { url: `/api/admin/onboarding?shop=${SHOP}` })).metaOpen, true);
});

test('the platform token reads only the account the shop linked by sharing; a shop cannot swap in another shop\'s account', async () => {
  const { metaConfig } = await import('../lib/meta.js');
  const { saveIntegration } = await import('../lib/integrations-repo.js');
  const { seal } = await import('../lib/secretbox.js');
  await q(`insert into zd.settings (key, value) values ('meta_platform', jsonb_build_object('token', $1::text, 'systemUserId', '9', 'businessId', '8'))`, [seal('PLATFORM')]);
  const B = (await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`))[0].id;
  await q(`insert into zd.user_shops (user_id, shop_id) select id, $1::uuid from zd.users where email = 'c@x.bg'`, [B]);
  await saveIntegration(q, 'meta', { config: { mode: 'partner', partnerAccountId: '111', accountId: '111', active: true }, shopId: SHOP });
  await saveIntegration(q, 'meta', { config: { mode: 'partner', partnerAccountId: '222', accountId: '222', active: true }, shopId: B });
  assert.equal((await metaConfig(q, B)).token, 'PLATFORM', 'its own shared account');
  process.env.META_PUBLIC = '1';
  const swap = await call(client, { method: 'POST', url: `/api/admin/integrations?shop=${B}`, body: { action: 'save_meta', accountId: '111', token: 'junk' } });
  assert.equal(swap.statusCode, 400); assert.match(json(swap).error, /друг магазин/);
  await saveIntegration(q, 'meta', { config: { accountId: '333' }, shopId: B }); // any other way the account changes
  assert.equal(await metaConfig(q, B), null, 'not the shared account any more: no platform token');
});

test('the old popup WhatsApp connect is the owner\'s only too, until WHATSAPP_PUBLIC=1', async () => {
  delete process.env.WHATSAPP_PUBLIC;
  const r = await call(client, { method: 'POST', body: { action: 'wa_connect', code: 'x', wabaId: '1', phoneNumberId: '2' } });
  assert.equal(r.statusCode, 403);
});

test('switching Meta off works even when another shop uses the same ad account', async () => {
  const { saveIntegration } = await import('../lib/integrations-repo.js');
  const B = (await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`))[0].id;
  await saveIntegration(q, 'meta', { config: { accountId: '555', active: true }, secret: 't', shopId: SHOP });
  await saveIntegration(q, 'meta', { config: { accountId: '555', active: true }, secret: 't', shopId: B });
  const r = await call(owner, { method: 'POST', url: `/api/admin/integrations?shop=${B}`, body: { action: 'save_meta', accountId: '555', active: false } });
  assert.equal(r.statusCode, 200, r.body);
});
