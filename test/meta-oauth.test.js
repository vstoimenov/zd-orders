import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { getIntegration, getSecret } from '../lib/integrations-repo.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
process.env.META_APP_ID = '111222333';
process.env.META_APP_SECRET = 'app-secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const admin = { cookie: `zdo_admin=${signSession('secret')}` };
const call = async (opts) => { const res = fakeRes(); await router(fakeReq(opts), res); return res; };
const REDIRECT = 'https://kurier.profitbrand.online/api/admin/meta';

/** fake Facebook: code → short token → long token (60 days) → ad accounts */
function facebook() {
  const calls = [];
  const f = async (url) => {
    const u = new URL(String(url)); calls.push(u);
    const ok = (d) => ({ ok: true, status: 200, json: async () => d });
    if (u.pathname === '/v26.0/oauth/access_token' && u.searchParams.get('code') === 'CODE') {
      assert.equal(u.searchParams.get('client_secret'), 'app-secret'); assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
      return ok({ access_token: 'SHORT', token_type: 'bearer', expires_in: 3600 });
    }
    if (u.pathname === '/v26.0/oauth/access_token' && u.searchParams.get('grant_type') === 'fb_exchange_token') return ok({ access_token: 'LONG', expires_in: 5184000 });
    if (u.pathname === '/v26.0/me/adaccounts' && u.searchParams.get('access_token') === 'LONG') {
      return ok({ data: [
        { account_id: '123', name: 'adhd реклами', currency: 'EUR', account_status: 1, business: { name: 'ProfitBrand' } },
        { account_id: '456', name: 'Стар акаунт', currency: 'BGN', account_status: 2 },
      ] });
    }
    if (u.pathname === '/v26.0/act_123') return ok({ id: 'act_123', name: 'adhd реклами', currency: 'EUR', account_status: 1 });
    return { ok: false, status: 400, json: async () => ({ error: { message: 'bad', code: 100 } }) };
  };
  f.calls = calls; return f;
}
async function withFetch(impl, fn) { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } }

test('"Вход с Facebook" starts only for the admin and sends them to Facebook with a one-time state', async () => {
  assert.equal((await call({ url: '/api/admin/meta?start=1' })).statusCode, 401);
  const res = await call({ url: '/api/admin/meta?start=1', headers: admin });
  assert.equal(res.statusCode, 302);
  const to = new URL(res.headers.location);
  assert.equal(to.origin + to.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  assert.equal(to.searchParams.get('client_id'), '111222333');
  assert.equal(to.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(to.searchParams.get('scope'), 'ads_read');
  assert.match(to.searchParams.get('state'), /^[0-9a-f]{64}$/);
});

test('coming back from Facebook stores a long-lived token and opens the account picker; the state works once', async () => {
  const start = await call({ url: '/api/admin/meta?start=1', headers: admin });
  const state = new URL(start.headers.location).searchParams.get('state');
  const res = await withFetch(facebook(), () => call({ url: `/api/admin/meta?code=CODE&state=${state}` })); // no admin cookie: SameSite=Strict is not sent back from facebook.com
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://kurier.profitbrand.online/admin/?meta=choose&shop=00000000-0000-4000-8000-000000000001#integrations');
  assert.equal(await getSecret(q, 'meta'), 'LONG');
  const i = await getIntegration(q, 'meta');
  assert.equal(i.config.accountId, '');
  assert.ok(Date.parse(i.config.tokenExpiresAt) > Date.now() + 50 * 864e5);
  const again = await withFetch(facebook(), () => call({ url: `/api/admin/meta?code=CODE&state=${state}` }));
  assert.match(again.headers.location, /meta_error=/, 'a used state is refused');
});

test('a forged, expired or cancelled login stores nothing', async () => {
  let res = await withFetch(facebook(), () => call({ url: '/api/admin/meta?code=CODE&state=' + 'a'.repeat(64) }));
  assert.match(decodeURIComponent(res.headers.location), /meta_error=Входът изтече или е невалиден/);
  const start = await call({ url: '/api/admin/meta?start=1', headers: admin });
  const state = new URL(start.headers.location).searchParams.get('state');
  res = await call({ url: `/api/admin/meta?error=access_denied&state=${state}` });
  assert.match(decodeURIComponent(res.headers.location), /meta_error=Входът беше отказан/);
  assert.equal((await getIntegration(q, 'meta')).hasSecret, false);
});

test('the admin picks an ad account from the list and it is connected', async () => {
  const start = await call({ url: '/api/admin/meta?start=1', headers: admin });
  const state = new URL(start.headers.location).searchParams.get('state');
  await withFetch(facebook(), () => call({ url: `/api/admin/meta?code=CODE&state=${state}` }));
  const post = (body) => call({ method: 'POST', url: '/api/admin/integrations', headers: admin, body: JSON.stringify(body) });
  let res = await withFetch(facebook(), () => post({ action: 'meta_accounts' }));
  assert.deepEqual(json(res).accounts, [
    { id: '123', name: 'adhd реклами', currency: 'EUR', active: true, business: 'ProfitBrand' },
    { id: '456', name: 'Стар акаунт', currency: 'BGN', active: false, business: '' },
  ]);
  res = await withFetch(facebook(), () => post({ action: 'save_meta', accountId: '123', token: '' }));
  assert.deepEqual(json(res), { ok: true, accountName: 'adhd реклами', currency: 'EUR' });
  const st = json(await call({ url: '/api/admin/integrations', headers: admin })).meta;
  assert.deepEqual([st.connected, st.accountId, st.oauth], [true, '123', true]);
  assert.ok(st.tokenExpiresAt);
});

test('without a Meta app configured the button is not offered; a pasted token can still list accounts', async () => {
  const id = process.env.META_APP_ID; delete process.env.META_APP_ID;
  try {
    assert.equal(json(await call({ url: '/api/admin/integrations', headers: admin })).meta.oauth, false);
    assert.equal((await call({ url: '/api/admin/meta?start=1', headers: admin })).statusCode, 302);
    const res = await withFetch(facebook(), () => call({ method: 'POST', url: '/api/admin/integrations', headers: admin, body: JSON.stringify({ action: 'meta_accounts', token: 'LONG' }) }));
    assert.equal(json(res).accounts.length, 2);
  } finally { process.env.META_APP_ID = id; }
});

test('with a Facebook Login for Business configuration the dialog uses config_id, and a never-expiring token is kept as such', async () => {
  process.env.META_CONFIG_ID = '987654';
  try {
    const start = await call({ url: '/api/admin/meta?start=1', headers: admin });
    const to = new URL(start.headers.location);
    assert.equal(to.searchParams.get('config_id'), '987654');
    assert.equal(to.searchParams.get('scope'), null, 'Meta recommends not sending scope together with a configuration');
    const state = to.searchParams.get('state');
    // a system-user token comes back without expires_in and cannot be exchanged
    const fb = async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.get('code') === 'CODE') return { ok: true, status: 200, json: async () => ({ access_token: 'SYSTEM-USER', token_type: 'bearer' }) };
      return { ok: false, status: 400, json: async () => ({ error: { message: 'cannot exchange', code: 100 } }) };
    };
    const res = await withFetch(fb, () => call({ url: `/api/admin/meta?code=CODE&state=${state}` }));
    assert.equal(res.headers.location, 'https://kurier.profitbrand.online/admin/?meta=choose&shop=00000000-0000-4000-8000-000000000001#integrations');
    assert.equal(await getSecret(q, 'meta'), 'SYSTEM-USER');
    assert.equal((await getIntegration(q, 'meta')).config.tokenExpiresAt, null);
  } finally { delete process.env.META_CONFIG_ID; }
});

test('the Facebook login comes back to the shop it was started for', async () => {
  const { createShop } = await import('../lib/shops.js');
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  const start = await call({ url: `/api/admin/meta?start=1&shop=${kids.id}`, headers: admin });
  const state = new URL(start.headers.location).searchParams.get('state');
  const res = await withFetch(facebook(), () => call({ url: `/api/admin/meta?code=CODE&state=${state}` }));
  assert.equal(res.headers.location, `https://kurier.profitbrand.online/admin/?meta=choose&shop=${kids.id}#integrations`);
  assert.equal(await getSecret(q, 'meta', kids.id), 'LONG');
  assert.equal(await getSecret(q, 'meta'), null, 'the default shop is untouched');
});
