// Payments the owner records and the client's „Профил“: plan, the next payment, every payment with its invoice.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { chooseSubscription, addPayment, listPayments, nextPayment, subscriptionView, SUB_COLS } from '../lib/plans.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const owner = `zdo_admin=${signSession('secret')}`;
const call = async ({ method = 'GET', url, cookie, body }) => { const res = fakeRes(); await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body) }, res); return res; };
const BEFORE = new Date('2026-11-20T10:00:00Z');
async function client() {
  const c = await createClient(q, { email: 'k@shop.bg', name: 'Клиент' });
  const u = await acceptInvite(q, c.token, 'client-pass-1');
  return { id: c.id, cookie: `zdo_admin=${clientSession('secret', { id: c.id, session_version: u.session_version })}` };
}

test('the first payment marks the plan paid; each payment pays a month from the day after the last one', async () => {
  const { id } = await client();
  await chooseSubscription(q, id, { plan: 'growth', billing: 'monthly' }, BEFORE);
  let r = await addPayment(q, id, { paidAt: '2026-12-04', invoiceNo: '1000000001', invoiceUrl: 'https://inv.example/1.pdf' }, new Date('2026-12-04T10:00:00Z'));
  assert.equal(r.subscription.paidAt.slice(0, 10), '2026-12-04');
  assert.equal(r.subscription.lockedUntil.slice(0, 10), '2027-12-04');
  await addPayment(q, id, { paidAt: '2027-01-03', amount: '58,20' }, new Date('2027-01-03T10:00:00Z'));
  const list = await listPayments(q, id);
  assert.deepEqual(list.map((p) => [p.paidAt, p.amount, p.periodFrom, p.periodTo]), [
    ['2027-01-03', 58.2, '2027-01-04', '2027-02-03'], ['2026-12-04', 58.2, '2026-12-04', '2027-01-03']]);
  assert.equal(list[1].invoiceUrl, 'https://inv.example/1.pdf');
  const sub = subscriptionView((await q(`select ${SUB_COLS} from zd.users where id = $1::uuid`, [id]))[0], new Date('2027-01-05T10:00:00Z'));
  assert.deepEqual(nextPayment(sub, list), { date: '2027-02-04', amount: 58.2, regularFrom: '2027-12-04' });
  await assert.rejects(addPayment(q, id, { invoiceUrl: 'javascript:alert(1)' }), /https/);
});

test('a yearly payment pays 12 months; before any payment the next one is due when the free days end', async () => {
  const { id } = await client();
  const s = await chooseSubscription(q, id, { plan: 'starter', billing: 'yearly' }, BEFORE);
  assert.deepEqual(nextPayment(s, []), { date: '2026-12-04', amount: 321.6, regularFrom: null });
  await addPayment(q, id, { paidAt: '2026-12-04' }, new Date('2026-12-04T10:00:00Z'));
  assert.deepEqual((await listPayments(q, id)).map((p) => [p.amount, p.periodFrom, p.periodTo]), [[321.6, '2026-12-04', '2027-12-03']]);
});

test('„Профил“: the client sees its own plan, payments and invoices; the owner records them; nobody else', async () => {
  const { id, cookie } = await client();
  assert.equal((await call({ url: '/api/admin/profile' })).statusCode, 401);
  let p = json(await call({ url: '/api/admin/profile', cookie }));
  assert.deepEqual([p.email, p.subscription, p.payments, p.next], ['k@shop.bg', null, [], null]);
  await chooseSubscription(q, id, { plan: 'business', billing: 'monthly' }, BEFORE);
  const res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'sub_paid', id, paidAt: '2026-12-01', invoiceNo: '77', invoiceUrl: 'https://inv.example/77' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(await call({ method: 'POST', url: '/api/admin/users', cookie, body: { action: 'sub_paid', id } })).error !== undefined, true, 'a client cannot record a payment');
  p = json(await call({ url: '/api/admin/profile', cookie }));
  assert.equal(p.plan.name, 'Business');
  assert.deepEqual(p.payments.map((x) => [x.amount, x.invoiceNo, x.invoiceUrl]), [[88.2, '77', 'https://inv.example/77']]);
  assert.equal(p.next.date, '2027-01-01');
  assert.deepEqual(json(await call({ url: '/api/admin/profile', cookie: owner })), { owner: true });
});
