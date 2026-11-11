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

test('the filter: all metrics on by default; a switched-off one goes at once and stays off until switched on again', async () => {
  const { setWatched } = await import('../lib/advisor/repo.js');
  await returnsRising();
  let a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.watched.length, 16);
  assert.ok(a.watched.every((w) => w.on), 'everything on by default');
  assert.equal(a.cards[0].rule, 'returns_up');
  const all = a.watched.map((w) => w.rule);
  const res = fakeRes();
  await router(fakeReq({ method: 'POST', url: '/api/admin/advisor', headers: { cookie: owner }, body: JSON.stringify({ action: 'watch', watched: all.filter((r) => r !== 'returns_up') }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).watched.find((w) => w.rule === 'returns_up').on, false);
  a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.cards.find((c) => c.rule === 'returns_up'), undefined, 'gone at once, the same day');
  await q(`delete from zd.advisor_daily`);
  assert.equal((await getAdvisor(q, SHOP, DAY)).cards.find((c) => c.rule === 'returns_up'), undefined, 'and on the next days');
  await setWatched(q, SHOP, all, DAY);
  assert.equal((await getAdvisor(q, SHOP, DAY)).cards[0].rule, 'returns_up', 'back when switched on');
  await assert.rejects(setWatched(q, SHOP, 'returns_up', DAY), /Невалиден избор/);
});

test('the shop profile: „rarely“ silences the repeat-purchase metrics; refresh runs today again', async () => {
  const { setProfile } = await import('../lib/advisor/repo.js');
  await returnsRising();
  let a = await getAdvisor(q, SHOP, DAY);
  assert.deepEqual(a.profile, { value: '', suggested: '', secondOrderDays: null });
  let res = fakeRes();
  await router(fakeReq({ method: 'POST', url: '/api/admin/advisor', headers: { cookie: owner }, body: JSON.stringify({ action: 'profile', value: 'rarely' }) }), res);
  assert.equal(json(res).profile, 'rarely');
  await setProfile(q, SHOP, 'rarely', DAY); // the API works on today; the test's fixed day is worked out again here
  a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.profile.value, 'rarely');
  await assert.rejects(setProfile(q, SHOP, 'weekly', DAY), /Невалиден избор/);
  const first = a.cards.map((c) => c.id);
  res = fakeRes();
  await router(fakeReq({ method: 'POST', url: '/api/admin/advisor', headers: { cookie: owner }, body: JSON.stringify({ action: 'refresh' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.notDeepEqual((await getAdvisor(q, SHOP)).cards.map((c) => c.id), first, 'new cards after a refresh');
});

/* ---- stage 4 ---- */
test('month summary inside Ordyx until seen; one push per shop and month on the first days', async () => {
  const { monthSummary, markSummarySeen, sendMonthlySummaries } = await import('../lib/advisor/repo.js');
  await returnsRising();
  const [card] = (await getAdvisor(q, SHOP, DAY)).cards;
  await answerCard(q, SHOP, { id: card.id, action: 'act' }, DAY);
  await q(`update zd.advisor_cards set created_at = '2026-10-10T12:00:00Z', updated_at = '2026-10-10T12:00:00Z'`); // the cards of October
  await q(`update zd.advisor_cards set state = 'done', result = 'success', euros = 42.5, updated_at = '2026-10-25T12:00:00Z' where id = $1::uuid`, [card.id]);
  const s = await monthSummary(q, SHOP, '2026-11-02');
  assert.equal(s.month, '2026-10');
  assert.equal(s.acted, 1);
  assert.equal(s.won, 1);
  assert.match(s.text, /^През октомври приложи 1 съвет, 1 даде резултат — около 43 € на месец\.$/);
  assert.equal((await getAdvisor(q, SHOP, '2026-11-02')).month.month, '2026-10', 'shown on the card');
  await markSummarySeen(q, SHOP, '2026-10');
  await q(`delete from zd.advisor_daily`);
  assert.equal((await getAdvisor(q, SHOP, '2026-11-02')).month, null, 'not again once seen');

  const sent = [];
  const notify = async (qq, shopId, msg) => { sent.push({ shopId, ...msg }); };
  assert.deepEqual(await sendMonthlySummaries(q, notify, '2026-11-15'), { sent: 0 }, 'only on the first days');
  assert.deepEqual(await sendMonthlySummaries(q, notify, '2026-11-01'), { sent: 1 });
  assert.match(sent[0].body, /приложи 1 съвет/);
  assert.match(sent[0].url, /#dash$/);
  assert.deepEqual(await sendMonthlySummaries(q, notify, '2026-11-02'), { sent: 0 }, 'once a month');
});

test('a quiet month: no summary; a month of cards not acted on says so', async () => {
  const { monthSummary } = await import('../lib/advisor/repo.js');
  assert.equal(await monthSummary(q, SHOP, '2026-11-02'), null);
  await returnsRising();
  await getAdvisor(q, SHOP, DAY);
  await q(`update zd.advisor_cards set created_at = '2026-10-10T12:00:00Z', updated_at = '2026-10-10T12:00:00Z'`);
  assert.match((await monthSummary(q, SHOP, '2026-11-02')).text, /видя \d+ проблема?, но не приложи нито един/);
});

test('unused cards expire (kept for the report); the owner’s report and thresholds', async () => {
  const { advisorReport, saveLimits } = await import('../lib/advisor/repo.js');
  const { LIMITS, setLimits } = await import('../lib/advisor/rules.js');
  await returnsRising();
  await getAdvisor(q, SHOP, '2026-11-09');
  await getAdvisor(q, SHOP, DAY);
  assert.equal((await q(`select count(*)::int as n from zd.advisor_cards where state = 'expired'`))[0].n >= 1, true);
  const r = await advisorReport(q, { days: 3650 });
  const ret = r.rules.find((x) => x.rule === 'returns_up');
  assert.equal(ret.shown, 2, 'shown on two days');
  assert.equal(r.limits.worse, 0.2);

  let res = fakeRes();
  await router(fakeReq({ url: '/api/admin/advisor?report=1', headers: { cookie: owner } }), res);
  assert.equal(json(res).rules.length, 16);
  await assert.rejects(saveLimits(q, { loses: 1.2, edge: 1.1 }), /трябва да растат/);
  res = fakeRes();
  await router(fakeReq({ method: 'POST', url: '/api/admin/advisor', headers: { cookie: owner }, body: JSON.stringify({ action: 'limits', limits: { worse: 0.9, minOrders: 1000 } }) }), res);
  assert.deepEqual(json(res).limits, { worse: 0.2, minOrders: 30, loses: 0.9, edge: 1.1, scale: 1.6 }, 'out-of-range values keep the default');
  await saveLimits(q, { minOrders: 200 });
  await q(`delete from zd.advisor_daily`); await q(`delete from zd.advisor_cards`);
  const a = await getAdvisor(q, SHOP, DAY);
  assert.equal(a.ready, false, '90 orders are under 200 now');
  assert.equal(a.cards.find((c) => c.rule === 'returns_up'), undefined, 'growth and leak cards wait for more orders');
  assert.equal(LIMITS.minOrders, 200);
  setLimits(null); // other tests use the defaults
});
