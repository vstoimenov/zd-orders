import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.ADMIN_PASSWORD = 'pw';
process.env.INTEGRATIONS_SECRET = 'test-secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const cookie = () => `zdo_admin=${signSession('secret')}`;
const call = async (opts) => { const res = fakeRes(); await router(fakeReq(opts), res); return res; };

test('one function serves every admin route at its old address', async () => {
  let res = await call({ method: 'POST', url: '/api/admin/login', body: JSON.stringify({ password: 'pw' }) });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], /zdo_admin=/);
  for (const r of ['orders', 'stats', 'costs', 'integrations']) {
    res = await call({ url: `/api/admin/${r}`, headers: { cookie: cookie() } });
    assert.equal(res.statusCode, 200, r);
  }
  res = await call({ url: '/api/admin/stats?from=2026-10-01&to=2026-10-07', headers: { cookie: cookie() } });
  assert.equal(json(res).period.from, '2026-10-01', 'query string still reaches the handler');
});

test('unknown admin paths are 404, also for prototype names', async () => {
  for (const p of ['/api/admin/nope', '/api/admin/constructor', '/api/admin/__proto__', '/api/admin/']) {
    const res = await call({ url: p, headers: { cookie: cookie() } });
    assert.equal(res.statusCode, 404, p);
  }
});

test('logout clears the session cookie', async () => {
  const res = await call({ method: 'DELETE', url: '/api/admin/login', headers: { cookie: cookie() } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], /zdo_admin=;.*Max-Age=0/);
});

test('the shop name shown in the sidebar: saved name, else the ConvertBuilder domain, else a default', async () => {
  const status = async () => json(await call({ url: '/api/admin/integrations', headers: { cookie: cookie() } })).shop;
  assert.deepEqual(await status(), { name: '', display: 'Моят магазин' });
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu' }, secret: 'K' });
  assert.deepEqual(await status(), { name: '', display: 'adhdbg.eu' });
  let res = await call({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: JSON.stringify({ action: 'save_shop', name: '  adhd  ' }) });
  assert.deepEqual(json(res), { ok: true, shop: { name: 'adhd', display: 'adhd' } });
  assert.deepEqual(await status(), { name: 'adhd', display: 'adhd' });
  res = await call({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: JSON.stringify({ action: 'save_shop', name: 'x'.repeat(61) }) });
  assert.equal(res.statusCode, 400);
});
