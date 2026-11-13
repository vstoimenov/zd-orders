// Partners: a client's link, a registration through it, 50% of every payment of the referred client, payouts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { chooseSubscription, addPayment } from '../lib/plans.js';
import { ensureRefCode, affiliateSummary } from '../lib/affiliate.js';
import { resetSignupLimitForTests } from '../lib/admin/signup.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); resetSignupLimitForTests(); });
const owner = `zdo_admin=${signSession('secret')}`;
const call = async ({ method = 'GET', url, cookie, body }) => { const res = fakeRes(); await router({ method, url, headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': '1.1.1.1' }, body: body === undefined ? undefined : JSON.stringify(body), socket: { remoteAddress: '1.1.1.1' } }, res); return res; };
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0];

test('a registration through a partner link earns the partner 50% of each payment; the owner pays it out', async () => {
  const c = await createClient(q, { email: 'partner@x.bg', name: 'Петър Партньоров' });
  const u = await acceptInvite(q, c.token, 'partner-pass-1');
  const partnerCookie = `zdo_admin=${clientSession('secret', { id: c.id, session_version: u.session_version })}`;
  const code = await ensureRefCode(q, c.id);
  assert.match(code, /^[a-z0-9]{8}$/);
  assert.equal(await ensureRefCode(q, c.id), code, 'the same link every time');
  const link = new URL(json(await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'signup_link' } })).link).searchParams.get('signup');
  const res = await call({ method: 'POST', url: '/api/admin/signup', body: { code: link, ref: code, name: 'Ана Клиентова', email: 'ana@shop.bg', password: 'ana-pass-123', website: '', plan: 'growth', billing: 'monthly' } });
  assert.equal(res.statusCode, 200, res.body);
  const [ana] = await q(`select id, referred_by from zd.users where email = 'ana@shop.bg'`);
  assert.equal(ana.referred_by, c.id);
  await addPayment(q, ana.id, { paidAt: '2026-12-04', amount: 58.2 });
  await addPayment(q, ana.id, { paidAt: '2027-01-04', amount: 58.2 });
  let s = await affiliateSummary(q, c.id);
  assert.deepEqual([s.earned, s.paidOut, s.balance, s.clients.length, s.clients[0].name, s.clients[0].paying], [58.2, 0, 58.2, 1, 'Ана', true]);
  assert.deepEqual(s.commissions.map((x) => x.commission), [29.1, 29.1]);
  const list = json(await call({ url: '/api/admin/users', cookie: owner }));
  assert.deepEqual(list.partners.map((p) => [p.email, p.clients, p.earned, p.balance]), [['partner@x.bg', 1, 58.2, 58.2]]);
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'payout', id: c.id, amount: '29,10', paidAt: '2027-01-10' } })).statusCode, 200);
  assert.ok(json(await call({ method: 'POST', url: '/api/admin/users', cookie: partnerCookie, body: { action: 'payout', id: c.id, amount: 1 } })).error, 'only the owner pays out');
  const p = json(await call({ url: '/api/admin/profile', cookie: partnerCookie })).partner;
  assert.deepEqual([p.earned, p.paidOut, p.balance], [58.2, 29.1, 29.1]);
  assert.equal(p.link, `https://ordyx.eu/?ref=${code}`);
  assert.equal(JSON.stringify(p).includes('ana@shop.bg'), false, 'the partner never sees the client\'s e-mail');
});

test('an unknown or malformed code changes nothing; the first referrer stays', async () => {
  const link = new URL(json(await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'signup_link' } })).link).searchParams.get('signup');
  const res = await call({ method: 'POST', url: '/api/admin/signup', body: { code: link, ref: 'nope!!', name: 'Б', email: 'b@shop.bg', password: 'b-pass-1234', website: '' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await q(`select referred_by from zd.users where email = 'b@shop.bg'`))[0].referred_by, null);
});

test('a commission only for the referred client\'s first 12 months of payments (from its first payment)', async () => {
  const c = await createClient(q, { email: 'p2@x.bg', name: 'Партньор' });
  const code = await ensureRefCode(q, c.id);
  const link = new URL(json(await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'signup_link' } })).link).searchParams.get('signup');
  await call({ method: 'POST', url: '/api/admin/signup', body: { code: link, ref: code, name: 'Вера', email: 'vera@shop.bg', password: 'vera-pass-123', website: '', plan: 'starter', billing: 'monthly' } });
  const [v] = await q(`select id from zd.users where email = 'vera@shop.bg'`);
  for (const d of ['2026-12-04', '2027-06-04', '2027-12-03', '2027-12-04', '2028-01-04']) await addPayment(q, v.id, { paidAt: d, amount: 40.2 });
  const s = await affiliateSummary(q, c.id);
  assert.deepEqual(s.commissions.map((x) => x.paidAt).sort(), ['2026-12-04', '2027-06-04', '2027-12-03'], 'the 12 months end on 2027-12-04');
  assert.equal(s.earned, 60.3);
  const list = json(await call({ url: '/api/admin/users', cookie: owner })).partners;
  assert.equal(list.find((p) => p.email === 'p2@x.bg').earned, 60.3);
});
