// A banned person gets nothing: the account is off and logged out, the e-mail and browser cannot come back, the IP for 30 days.
// The owner is never locked out.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession, newSignupLink } from '../lib/users.js';
import { blockUser, unblockUser, isBlocked, getBlocklist, resetBlocklistCache, blockIp, unblockIp } from '../lib/blocklist.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.ADMIN_PASSWORD = 'owner-pass-123';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, bad, badCookie;
const BAD_IP = '95.43.175.191', BAD_FBP = 'fb.1.1794779148405.620502726102585597';
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); resetBlocklistCache();
  const c = await createClient(q, { email: 'kopirach@abv.bg', name: 'Копирач', shopIds: [SHOP] });
  await acceptInvite(q, c.token, 'client-pass-1');
  [bad] = await q(`select id, session_version from zd.users where email = 'kopirach@abv.bg'`);
  await q(`update zd.users set track = $2::text::jsonb where id = $1::uuid`, [bad.id, JSON.stringify({ ip: BAD_IP, fbp: BAD_FBP })]);
  badCookie = `zdo_admin=${clientSession('secret', bad)}`;
});
const call = async ({ method = 'GET', url, cookie = '', ip = '1.1.1.1', body }) => {
  const res = fakeRes();
  await router({ method, url, headers: { cookie, 'x-forwarded-for': ip }, body: body && JSON.stringify(body), socket: {} }, res);
  return res;
};

test('blocking: the account is off and logged out; its e-mail, browser and IP are on the list', async () => {
  assert.equal((await call({ url: `/api/admin/orders?shop=${SHOP}`, cookie: badCookie })).statusCode, 200);
  const list = await blockUser(q, bad.id, { reason: 'копира идеи' });
  assert.deepEqual(list.emails, ['kopirach@abv.bg']); assert.deepEqual(list.browsers, [BAD_FBP]);
  assert.equal(list.people[0].ip, BAD_IP); assert.equal(list.people[0].reason, 'копира идеи');
  const [u] = await q(`select active, session_version from zd.users where id = $1::uuid`, [bad.id]);
  assert.equal(u.active, false); assert.equal(u.session_version, bad.session_version + 1);
  assert.equal((await call({ url: `/api/admin/orders?shop=${SHOP}`, cookie: badCookie })).statusCode, 401, 'the old session is dead');
});

test('a banned IP or browser gets 403 on every admin call, even with a fresh account; the e-mail cannot register again', async () => {
  await blockUser(q, bad.id);
  let res = await call({ url: '/api/admin/me', ip: BAD_IP });
  assert.equal(res.statusCode, 403); assert.match(json(res).error, /отказан/);
  res = await call({ url: '/api/admin/me', cookie: `_fbp=${BAD_FBP}`, ip: '8.8.8.8' });
  assert.equal(res.statusCode, 403, 'another network, the same phone');
  const { code } = await newSignupLink(q);
  res = await call({ method: 'POST', url: '/api/admin/signup', ip: '7.7.7.7', body: { code, name: 'Пак аз', email: 'Kopirach@abv.bg', password: 'parola-123', plan: 'free' } });
  assert.equal(res.statusCode, 403);
  assert.equal((await q(`select count(*)::int as n from zd.users where lower(email) = 'kopirach@abv.bg'`))[0].n, 1);
  res = await call({ method: 'POST', url: '/api/admin/signup', ip: '7.7.7.7', body: { code, name: 'Друг', email: 'drug@x.bg', password: 'parola-123', plan: 'free' } });
  assert.equal(res.statusCode, 200, 'someone else from a clean address registers');
});

test('the owner is never locked out: the password login and the owner session pass from a banned IP', async () => {
  await blockUser(q, bad.id);
  assert.equal((await call({ url: '/api/admin/users', cookie: owner, ip: BAD_IP })).statusCode, 200);
  const res = await call({ method: 'POST', url: '/api/admin/login', ip: BAD_IP, body: { password: 'owner-pass-123' } });
  assert.equal(res.statusCode, 200);
});

test('an IP alone can be banned, and lifted; a bad address is refused', async () => {
  const req = (ip, cookie = '') => ({ headers: { 'x-forwarded-for': ip, cookie }, socket: {} });
  await blockIp(q, BAD_IP, { reason: 'копира идеи' });
  assert.equal(await isBlocked(q, req(BAD_IP)), true);
  assert.equal(await isBlocked(q, req('2.2.2.2')), false);
  assert.equal(await isBlocked(q, req('2.2.2.2'), 'kopirach@abv.bg'), false, 'only the IP is banned');
  assert.equal((await call({ url: '/api/admin/me', ip: BAD_IP })).statusCode, 403);
  await assert.rejects(blockIp(q, 'evil'), /IP/);
  await unblockIp(q, BAD_IP);
  assert.equal(await isBlocked(q, req(BAD_IP)), false);
});

test('the owner blocks and unblocks from Клиенти; a client cannot; the list shows who is blocked', async () => {
  const other = await createClient(q, { email: 'c2@x.bg', name: 'Друг', shopIds: [] });
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: badCookie, body: { action: 'block', id: other.id } })).statusCode, 403);
  let res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'block', id: bad.id } });
  assert.equal(res.statusCode, 200);
  res = await call({ url: '/api/admin/users', cookie: owner });
  assert.equal(json(res).users.find((u) => u.email === 'kopirach@abv.bg').blocked, true);
  assert.equal(json(res).users.find((u) => u.email === 'c2@x.bg').blocked, false);
  await unblockUser(q, bad.id);
  const left = await getBlocklist(q, { fresh: true });
  assert.deepEqual([left.emails, left.browsers, left.people], [[], [], []]);
  await assert.rejects(unblockUser(q, bad.id), /не е блокиран/);
});
