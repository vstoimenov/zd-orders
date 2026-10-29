import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession, renewedSession } from '../lib/users.js';
import router from '../api/admin/[route].js';
import { resetLoginLimitForTests } from '../lib/admin/login.js';

// The owner logged in on the phone with his email (an account made as a test client on 11.10) and was a client there: no calls,
// no „Клиенти“. An account marked is_owner (set in the database only — nothing in the admin can set it) is the owner.
process.env.ADMIN_SECRET = 'secret';
process.env.ADMIN_PASSWORD = 'owner-pass';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP_A = '00000000-0000-4000-8000-000000000001';
let q;

const req = ({ method = 'GET', url, cookie, body }) => ({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: { remoteAddress: '1.1.1.1' } });
async function call(opts) { const res = fakeRes(); await router(req(opts), res); return res; }
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0];
async function login(email) {
  const res = await call({ method: 'POST', url: '/api/admin/login', body: { email, password: 'client-pass-1' } });
  assert.equal(res.statusCode, 200);
  return { role: json(res).role, cookie: cookieOf(res) };
}

beforeEach(async () => {
  q = await makeTestQuery();
  setQueryForTests(q);
  resetLoginLimitForTests();
  delete process.env.VOICE_PUBLIC;
  const { token } = await createClient(q, { email: 'owner@mail.bg', name: 'Собственик', shopIds: [SHOP_A] });
  await acceptInvite(q, token, 'client-pass-1');
});

test('an account marked as the owner is the owner — an open phone session included, without logging in again', async () => {
  const before = await login('owner@mail.bg');
  assert.equal(before.role, 'client', 'precondition: a plain account is a client');
  assert.equal((await call({ url: '/api/admin/users', cookie: before.cookie })).statusCode, 403);

  await q(`update zd.users set is_owner = true where email = 'owner@mail.bg'`);
  assert.equal(json(await call({ url: '/api/admin/me', cookie: before.cookie })).role, 'owner', 'the session already open on the phone');
  assert.equal((await call({ url: '/api/admin/users', cookie: before.cookie })).statusCode, 200, '„Клиенти“ opens');
  const call403 = await call({ method: 'POST', url: `/api/admin/voice?shop=${SHOP_A}`, cookie: before.cookie, body: { action: 'call', id: '00000000-0000-4000-8000-0000000000ff' } });
  assert.notEqual(call403.statusCode, 403, 'calls are not refused as „скоро“');

  const again = await login('owner@mail.bg');
  assert.equal(again.role, 'owner', 'a new login with the email answers „owner“');
});

test('the phone fills in the owner\'s email: the owner\'s password works with it too — even while wrong guesses locked the account', async () => {
  await q(`update zd.users set is_owner = true, locked_until = now() + interval '15 minutes' where email = 'owner@mail.bg'`);
  const res = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'Owner@Mail.bg ', password: 'owner-pass' } });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).role, 'owner');
  assert.match(cookieOf(res), /^zdo_admin=c\./, 'an account session: renewed on the phone and ended by a new password');
  assert.equal(json(await call({ url: '/api/admin/me', cookie: cookieOf(res) })).role, 'owner');
});

test('the owner\'s password opens no other account: a client\'s email with it is refused', async () => {
  const { token } = await createClient(q, { email: 'client@mail.bg', name: 'Клиент', shopIds: [SHOP_A] });
  await acceptInvite(q, token, 'client-pass-1');
  const res = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'client@mail.bg', password: 'owner-pass' } });
  assert.equal(res.statusCode, 401);
});

test('a stopped owner account or a changed password ends its sessions, like any account', async () => {
  await q(`update zd.users set is_owner = true where email = 'owner@mail.bg'`);
  const { cookie } = await login('owner@mail.bg');
  await q(`update zd.users set session_version = session_version + 1 where email = 'owner@mail.bg'`);
  assert.equal((await call({ url: '/api/admin/me', cookie })).statusCode, 401);
  const fresh = await login('owner@mail.bg');
  await q(`update zd.users set active = false where email = 'owner@mail.bg'`);
  assert.equal((await call({ url: '/api/admin/me', cookie: fresh.cookie })).statusCode, 401);
});

test('the owner account\'s session gets a fresh week in its last days; the password-only owner token is never renewed', async () => {
  const [u] = await q(`update zd.users set is_owner = true where email = 'owner@mail.bg' returning id, session_version`);
  const nowSec = Math.floor(Date.now() / 1000);
  const old = clientSession('secret', u, nowSec - 5 * 24 * 3600); // 2 days left
  const asked = { headers: { cookie: `zdo_admin=${old}` } };
  const res = fakeRes();
  await router({ method: 'GET', url: '/api/admin/me', headers: asked.headers, socket: { remoteAddress: '1.1.1.1' } }, res);
  assert.equal(json(res).role, 'owner');
  assert.match(cookieOf(res), /^zdo_admin=c\./, 'renewed as a revocable account session');
  assert.equal(renewedSession({ headers: { cookie: `zdo_admin=${signSession('secret')}` } }, { owner: true }), null);
});
