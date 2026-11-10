import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { getAdvisor, answerCard } from '../lib/advisor/repo.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
const DAY = '2026-11-10';
const ago = (n, day = DAY) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 864e5).toISOString();
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); n = 0; });

async function order({ status = 'delivered', daysAgo = 1, shippedDaysAgo = null, day = DAY } = {}) {
  const phone = `+3598881${String(++n).padStart(5, '0')}`;
  const r = await insertOrder(q, {
    cbOrderId: `s.bg:${n}`, name: 'Мария', phone, phoneNorm: phone, email: '', deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ',
    city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Крем', qty: 1, price: 35 }], total: 40, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  await q(`update zd.orders set created_at = $2::timestamptz, waybill_created_at = $3::timestamptz where id = $1::uuid`, [r.id, ago(daysAgo, day), ago(shippedDaysAgo ?? daysAgo - 1, day)]);
}
/** A shop with 40 orders a month whose returns rose from 10% to 30%. */
async function returnsRising() {
  for (let i = 0; i < 40; i++) await order({ daysAgo: 1 + (i % 25) });
  for (let i = 0; i < 20; i++) await order({ daysAgo: 30 + (i % 15), status: i < 6 ? 'returned' : 'delivered' });
  for (let i = 0; i < 30; i++) await order({ daysAgo: 60 + (i % 60), status: i < 3 ? 'returned' : 'delivered' });
}

test('the first look of the day: the returns card with euros, a button, the check date; the same cards on the second look', async () => {
  await returnsRising();
  const a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.ready, true);
  assert.equal(a.cards[0].rule, 'returns_up');
  assert.match(a.cards[0].texts.problem, /Върнатите пратки са 26,1%, а обичайно при теб са 10%/);
  assert.match(a.cards[0].texts.cost, /около \d+ € на месец/);
  assert.equal(a.cards[0].texts.action.view, 'orders');
  assert.match(a.cards[0].texts.check, /10\.12\.2026/);
  assert.deepEqual(a.missing.map((x) => x.key), ['meta', 'costs']);
  const again = await getAdvisor(q, SHOP, DAY);
  assert.deepEqual(again.cards.map((c) => c.id), a.cards.map((c) => c.id), 'computed once a day');
});

test('act → the check runs; on its day the result is judged with euros, then the rule rests', async () => {
  await returnsRising();
  const [card] = (await getAdvisor(q, SHOP, DAY)).cards;
  const acted = await answerCard(q, SHOP, { id: card.id, action: 'act' }, DAY);
  assert.equal(acted.state, 'checking');
  assert.equal(acted.checkUntil, '2026-12-10');
  // a month later: the recent parcels came back less often
  const LATER = '2026-12-11';
  await q(`update zd.orders set status = 'delivered'`);
  for (let i = 0; i < 20; i++) await order({ daysAgo: 25 + (i % 15), day: LATER, status: i < 1 ? 'returned' : 'delivered' });
  const b = await getAdvisor(q, SHOP, LATER);
  assert.equal(b.checking.length, 0);
  assert.equal(b.results[0].rule, 'returns_up');
  assert.equal(b.results[0].result, 'success');
  assert.match(b.results[0].resultText, /^Стана: от 26,1% на \d/);
  assert.ok(b.brought.euros > 0);
  assert.equal(b.cards.find((c) => c.rule === 'returns_up'), undefined, 'not offered again for 30 days');
});

test('dismiss hides the rule; few orders → no growth cards; „all shops“ and other shops are refused', async () => {
  await returnsRising();
  const [card] = (await getAdvisor(q, SHOP, DAY)).cards;
  await answerCard(q, SHOP, { id: card.id, action: 'dismiss', reason: 'not_for_me' }, DAY);
  await q(`delete from zd.advisor_daily`);
  assert.equal((await getAdvisor(q, SHOP, DAY)).cards.find((c) => c.rule === 'returns_up'), undefined);
  await assert.rejects(answerCard(q, SHOP, { id: 'x', action: 'act' }), /Няма такъв съвет/);

  let res = fakeRes();
  await router(fakeReq({ url: '/api/admin/advisor?shop=all', headers: { cookie: owner } }), res);
  assert.deepEqual(json(res), { all: true });
  res = fakeRes();
  await router(fakeReq({ url: '/api/admin/advisor', headers: { cookie: owner } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok('cards' in json(res));
  res = fakeRes();
  await router(fakeReq({ url: '/api/admin/advisor', headers: {} }), res);
  assert.equal(res.statusCode, 401);
});

test('a new shop with few orders: no cards, says what data is missing', async () => {
  for (let i = 0; i < 5; i++) await order({ daysAgo: 2 });
  const a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.ready, false);
  assert.deepEqual(a.cards, []);
  assert.equal(a.chance, null);
  assert.ok(a.missing.find((x) => x.key === 'meta'));
});
