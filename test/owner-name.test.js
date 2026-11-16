// The owner's own name for the greeting („Добро утро, Виктор“) and the card in the menu: set by the owner, never by a client.
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
const owner = `zdo_admin=${signSession('secret')}`;
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const call = async (cookie, method = 'GET', body) => { const res = fakeRes(); await router({ method, url: '/api/admin/me', headers: { cookie }, body: body && JSON.stringify(body), socket: {} }, res); return res; };

test('the owner has no name until they set one; then /me greets them by it', async () => {
  assert.deepEqual(json(await call(owner)), { role: 'owner', name: '', email: '' });
  const res = await call(owner, 'POST', { name: '  Виктор   Стоименов ', email: 'v@ordyx.eu' });
  assert.deepEqual(json(res), { ok: true, name: 'Виктор Стоименов', email: 'v@ordyx.eu' });
  assert.deepEqual(json(await call(owner)), { role: 'owner', name: 'Виктор Стоименов', email: 'v@ordyx.eu' });
  assert.equal((await call(owner, 'POST', { name: 'X', email: 'не-имейл' })).statusCode, 400);
});

test('a client cannot set the owner\'s name and still sees its own', async () => {
  const c = await createClient(q, { email: 'c@x.bg', name: 'Мария', shopIds: [] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  const client = `zdo_admin=${clientSession('secret', u)}`;
  assert.equal((await call(client, 'POST', { name: 'Хакер' })).statusCode, 403);
  const d = json(await call(client));
  assert.equal(d.role, 'client'); assert.equal(d.name, 'Мария');
});
