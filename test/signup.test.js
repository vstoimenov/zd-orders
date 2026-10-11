import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import { resetSignupLimitForTests } from '../lib/admin/signup.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const owner = `zdo_admin=${signSession('secret')}`;
let q;
const call = async ({ method = 'GET', url, cookie, body, ip = '1.1.1.1' }) => {
  const res = fakeRes();
  await router({ method, url, headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip }, body: body === undefined ? undefined : JSON.stringify(body), socket: { remoteAddress: ip } }, res);
  return res;
};
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0];
async function signupLink() {
  const res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'signup_link' } });
  assert.equal(res.statusCode, 200);
  return new URL(json(res).link).searchParams.get('signup');
}
const form = (code, patch = {}) => ({ code, name: 'Иван Петров', email: 'ivan@shop.bg', password: 'ivan-pass-123', website: '', ...patch });

beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); resetSignupLimitForTests(); });

test('the owner makes a registration link; with it anyone registers and is logged in with no shops', async () => {
  const code = await signupLink();
  assert.match(code, /^[A-Za-z0-9_-]{20,}$/);
  assert.deepEqual(json(await call({ url: `/api/admin/signup?code=${code}` })), { ok: true });
  const res = await call({ method: 'POST', url: '/api/admin/signup', body: form(code) });
  assert.equal(res.statusCode, 200);
  const me = json(await call({ url: '/api/admin/me', cookie: cookieOf(res) }));
  assert.deepEqual(me, { role: 'client', email: 'ivan@shop.bg', name: 'Иван Петров' });
  assert.deepEqual(json(await call({ url: '/api/admin/shops', cookie: cookieOf(res) })).shops, []);
  const users = json(await call({ url: '/api/admin/users', cookie: owner })).users;
  assert.equal(users[0].email, 'ivan@shop.bg');
  assert.equal(users[0].hasPassword, true);
});

test('the link shows on the clients page; a new link stops the old one; it can be switched off', async () => {
  const first = await signupLink();
  assert.equal(json(await call({ url: '/api/admin/users', cookie: owner })).signup.link, `https://kurier.profitbrand.online/admin/?signup=${first}`);
  const second = await signupLink();
  assert.equal((await call({ method: 'POST', url: '/api/admin/signup', body: form(first) })).statusCode, 400);
  await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'signup_off' } });
  assert.equal(json(await call({ url: '/api/admin/users', cookie: owner })).signup, null);
  const off = await call({ method: 'POST', url: '/api/admin/signup', body: form(second) });
  assert.equal(off.statusCode, 400);
  assert.match(json(off).error, /линк/i);
});

test('registration checks: a real email, a password of 8+, a used email, the bot trap', async () => {
  const code = await signupLink();
  assert.equal((await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { email: 'nope' }) })).statusCode, 400);
  assert.equal((await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { password: 'short' }) })).statusCode, 400);
  assert.equal((await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { name: '' }) })).statusCode, 400);
  await call({ method: 'POST', url: '/api/admin/signup', body: form(code) });
  const dup = await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { email: 'IVAN@shop.bg' }), ip: '2.2.2.2' });
  assert.equal(dup.statusCode, 400);
  assert.match(json(dup).error, /вече/);
  const bot = await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { email: 'bot@spam.bg', website: 'http://spam' }), ip: '3.3.3.3' });
  assert.equal(bot.statusCode, 400);
  assert.equal((await q(`select count(*)::int as n from zd.users where email = 'bot@spam.bg'`))[0].n, 0);
});

test('one address registers only a few accounts', async () => {
  const code = await signupLink();
  let last;
  for (let i = 0; i < 6; i++) last = await call({ method: 'POST', url: '/api/admin/signup', body: form(code, { email: `u${i}@shop.bg` }) });
  assert.equal(last.statusCode, 429);
});

test('only the owner manages the registration link', async () => {
  const code = await signupLink();
  const reg = await call({ method: 'POST', url: '/api/admin/signup', body: form(code) });
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: cookieOf(reg), body: { action: 'signup_link' } })).statusCode, 403);
});

test('the owner\'s phone hears about every new registration', async () => {
  const sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push({ endpoint: s.endpoint, p: JSON.parse(payload) }); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
  const code = await signupLink();
  await call({ method: 'POST', url: '/api/admin/signup', body: form(code) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].p.title, /Нова регистрация/);
  assert.match(sent[0].p.body, /Иван Петров · ivan@shop\.bg/);
  assert.equal(sent[0].p.url, '/admin/#clients');
});
