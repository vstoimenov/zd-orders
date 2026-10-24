// „Свържи WhatsApp“ without a popup: the admin goes to Meta's Embedded Signup page and comes back with a code (lib/admin/wa-oauth.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { getIntegration, getSecret } from '../lib/integrations-repo.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
process.env.META_APP_ID = '1136036008845539';
process.env.META_APP_SECRET = 'app-secret';
process.env.WHATSAPP_CONFIG_ID = '2264338437759839';
delete process.env.WHATSAPP_PUBLIC;
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const admin = { cookie: `zdo_admin=${signSession('secret')}` };
const call = async (opts) => { const res = fakeRes(); await router(fakeReq(opts), res); return res; };
const REDIRECT = 'https://app.ordyx.eu/api/admin/waconnect';
const stateOf = (res) => new URL(res.headers.location).searchParams.get('state');
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0];

/** fake Meta: code → business token; debug_token names the WhatsApp account the customer shared; its number; subscribe + register */
function meta({ wabas = ['102290129340398'], phones = [{ id: '106540352242922', display_phone_number: '+359 88 800 1234', verified_name: 'Магазин А' }] } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ u, init });
    const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
    const ok = (d) => ({ ok: true, status: 200, json: async () => d });
    if (path === '/oauth/access_token' && u.searchParams.get('code') === 'CODE') {
      assert.equal(u.searchParams.get('client_secret'), 'app-secret'); assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
      return ok({ access_token: 'BUSINESS-TOKEN', token_type: 'bearer' });
    }
    if (path === '/debug_token') {
      assert.equal(u.searchParams.get('input_token'), 'BUSINESS-TOKEN');
      return ok({ data: { app_id: '1136036008845539', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: wabas }, { scope: 'whatsapp_business_messaging', target_ids: wabas }] } });
    }
    for (const w of wabas) {
      if (path === `/${w}`) return ok({ id: w, name: `WABA ${w}` });
      if (path === `/${w}/phone_numbers`) return ok({ data: w === wabas[wabas.length - 1] ? phones : [] });
      if (path === `/${w}/subscribed_apps`) return ok({ success: true });
    }
    for (const p of phones) {
      if (path === `/${p.id}`) return ok(p);
      if (path === `/${p.id}/register`) return ok({ success: true });
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: `unexpected ${path}`, code: 100 } }) };
  };
  f.calls = calls; return f;
}
async function withFetch(impl, fn) { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } }

test('„Свържи WhatsApp“ sends the owner to Meta\'s Embedded Signup page with a one-time state and no popup', async () => {
  assert.equal((await call({ url: '/api/admin/waconnect?start=1' })).statusCode, 401);
  const res = await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: admin });
  assert.equal(res.statusCode, 302);
  const u = new URL(res.headers.location);
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v25.0/dialog/oauth');
  assert.equal(u.searchParams.get('client_id'), '1136036008845539');
  assert.equal(u.searchParams.get('config_id'), '2264338437759839');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('override_default_response_type'), 'true');
  assert.deepEqual(JSON.parse(u.searchParams.get('extras')), { setup: {}, sessionInfoVersion: '3' });
  assert.match(stateOf(res), /^[0-9a-f]{64}$/);
  assert.match(cookieOf(res), new RegExp(`^zdo_wa=${stateOf(res)}$`));
});

test('coming back with the code: the shared WhatsApp account and number are found, subscribed, registered and stored sealed', async () => {
  const start = await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: admin });
  const state = stateOf(start);
  const m = meta();
  const res = await withFetch(m, () => call({ url: `/api/admin/waconnect?code=CODE&state=${state}`, headers: { cookie: `zdo_wa=${state}` } }));
  assert.equal(res.statusCode, 302, res.body);
  assert.equal(res.headers.location, `https://app.ordyx.eu/admin/?wa=ok&shop=${SHOP}#integrations`);
  const i = await getIntegration(q, 'whatsapp', SHOP);
  assert.equal(i.config.wabaId, '102290129340398'); assert.equal(i.config.phoneNumberId, '106540352242922'); assert.equal(i.config.phone, '+359 88 800 1234');
  assert.equal(i.config.active, true); assert.equal(i.config.manual, false);
  assert.equal(JSON.parse(await getSecret(q, 'whatsapp', SHOP)).token, 'BUSINESS-TOKEN');
  assert.ok(m.calls.some((c) => c.u.pathname.endsWith('/102290129340398/subscribed_apps') && c.init.method === 'POST'));
  assert.ok(m.calls.some((c) => c.u.pathname.endsWith('/106540352242922/register')));
  const again = await withFetch(meta(), () => call({ url: `/api/admin/waconnect?code=CODE&state=${state}`, headers: { cookie: `zdo_wa=${state}` } }));
  assert.match(decodeURIComponent(again.headers.location), /wa_error=/, 'a used state is refused');
});

test('several shared accounts: the one that has a number wins; no number at all is a clear error; a refusal on Meta too', async () => {
  const start = await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: admin });
  const state = stateOf(start);
  const res = await withFetch(meta({ wabas: ['111111111111111', '102290129340398'] }), () => call({ url: `/api/admin/waconnect?code=CODE&state=${state}`, headers: { cookie: `zdo_wa=${state}` } }));
  assert.match(res.headers.location, /wa=ok/);
  assert.equal((await getIntegration(q, 'whatsapp', SHOP)).config.wabaId, '102290129340398');
  q = await makeTestQuery(); setQueryForTests(q);
  const s2 = stateOf(await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: admin }));
  const none = await withFetch(meta({ phones: [] }), () => call({ url: `/api/admin/waconnect?code=CODE&state=${s2}`, headers: { cookie: `zdo_wa=${s2}` } }));
  assert.match(decodeURIComponent(none.headers.location), /wa_error=.*номер/);
  assert.equal((await getIntegration(q, 'whatsapp', SHOP)).hasSecret, false);
  const s3 = stateOf(await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: admin }));
  const denied = await call({ url: `/api/admin/waconnect?error=access_denied&state=${s3}`, headers: { cookie: `zdo_wa=${s3}` } });
  assert.match(decodeURIComponent(denied.headers.location), /wa_error=.*отказ/i);
});

test('a client cannot start it until the platform opens it; a stale or foreign state is refused', async () => {
  const c = await createClient(q, { email: 'client@example.com', name: 'Клиент', shopIds: [SHOP] });
  const u = await acceptInvite(q, c.token, 'client-pass-1');
  const client = { cookie: `zdo_admin=${clientSession('secret', { id: c.id, session_version: u.session_version })}` };
  const res = await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: client });
  assert.match(decodeURIComponent(res.headers.location), /wa_error=/);
  process.env.WHATSAPP_PUBLIC = '1';
  const open = await call({ url: `/api/admin/waconnect?start=1&shop=${SHOP}`, headers: client });
  assert.match(open.headers.location, /facebook\.com/);
  delete process.env.WHATSAPP_PUBLIC;
  const foreign = await withFetch(meta(), () => call({ url: `/api/admin/waconnect?code=CODE&state=${'a'.repeat(64)}`, headers: { cookie: `zdo_wa=${'a'.repeat(64)}` } }));
  assert.match(decodeURIComponent(foreign.headers.location), /wa_error=Свързването изтече/);
});
