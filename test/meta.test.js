import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { insertOrder } from '../lib/orders-repo.js';
import { normalizeAccountId, parseInsight, metaError } from '../lib/meta.js';
import { adSpendTotals } from '../lib/ads.js';
import { getProfit } from '../lib/costs.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.CRON_SECRET = 'cron';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const headers = { cookie: `zdo_admin=${signSession('secret')}` };
const post = async (body) => { const res = fakeRes(); await router(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers, body: JSON.stringify(body) }), res); return res; };
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

/** fake Graph API: account 123 (EUR) with insights, token GOOD-TOKEN; records calls */
function graph({ currency = 'EUR', days = [] } = {}) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(String(url)); calls.push(u);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.searchParams.get('access_token') !== 'GOOD-TOKEN') return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } }) };
    if (u.pathname === '/v26.0/act_123') return ok({ id: 'act_123', name: 'adhd реклами', currency, account_status: 1 });
    if (u.pathname === '/v26.0/act_123/insights') {
      const page = Number(u.searchParams.get('after') || 0);
      const data = days.slice(page, page + 2);
      return ok({ data, paging: page + 2 < days.length ? { next: `https://graph.facebook.com/v26.0/act_123/insights?access_token=GOOD-TOKEN&after=${page + 2}` } : {} });
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 } }) };
  };
  f.calls = calls;
  return f;
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error; globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const day = (date, spend, extra = {}) => ({ date_start: date, date_stop: date, spend: String(spend), impressions: '1000', clicks: '25',
  actions: [{ action_type: 'link_click', value: '25' }, { action_type: 'omni_purchase', value: '3' }, { action_type: 'purchase', value: '2' }],
  action_values: [{ action_type: 'purchase', value: '41.10' }, { action_type: 'omni_purchase', value: '60' }], ...extra });

test('ad account ids, insight rows and Meta errors in Bulgarian', () => {
  assert.equal(normalizeAccountId(' act_1234567 '), '1234567');
  assert.throws(() => normalizeAccountId('abc'), /само цифри/);
  assert.deepEqual(parseInsight(day('2026-10-06', 12.5)), { day: '2026-10-06', spend: 12.5, impressions: 1000, clicks: 25, purchases: 2, purchaseValue: 41.1 });
  assert.match(metaError({ code: 190, message: 'x' }).message, /невалиден или изтекъл/);
  assert.match(metaError({ code: 100, error_subcode: 33, message: 'x' }).message, /няма достъп/);
  assert.match(metaError({ code: 200, message: 'x' }).message, /ads_read/);
  assert.match(metaError({ code: 17, message: 'x' }).message, /ограничи/);
});

test('admin connects a Meta ad account; the token is sealed and never returned; a bad token is refused', async () => {
  let res = await withFetch(graph(), () => post({ action: 'save_meta', accountId: 'act_123', token: 'BAD' }));
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /невалиден или изтекъл/);
  res = await withFetch(graph(), () => post({ action: 'save_meta', accountId: 'act_123', token: 'GOOD-TOKEN' }));
  assert.deepEqual(json(res), { ok: true, accountName: 'adhd реклами', currency: 'EUR' });
  const st = await (async () => { const r = fakeRes(); await router(fakeReq({ url: '/api/admin/integrations', headers }), r); return json(r); })();
  assert.deepEqual([st.meta.connected, st.meta.accountId, st.meta.accountName, st.meta.currency], [true, '123', 'adhd реклами', 'EUR']);
  assert.equal(JSON.stringify(st).includes('GOOD-TOKEN'), false);
  const [row] = await q(`select secret_enc from zd.integrations where provider = 'meta'`);
  assert.ok(row.secret_enc && !row.secret_enc.includes('GOOD-TOKEN'));
  res = await withFetch(graph(), () => post({ action: 'save_meta', accountId: '999', token: '' }));
  assert.match(json(res).error, /въведете ключа/, 'the stored token only goes to the account it was saved for');
});

test('sync pulls daily spend (all pages) into ad_spend; profit and totals include it, BGN converted to EUR', async () => {
  await withFetch(graph(), () => post({ action: 'save_meta', accountId: '123', token: 'GOOD-TOKEN' }));
  const days = [day(today(), 10), day('2026-10-01', 5), day('2026-10-02', 7.5)];
  let res = await withFetch(graph({ days }), () => post({ action: 'sync_meta', from: '2026-10-01', to: today() }));
  assert.deepEqual(json(res).result, { days: 3 });
  const totals = await adSpendTotals(q, { from: today(), to: today() });
  assert.deepEqual(totals, { spend: 10, impressions: 1000, clicks: 25, purchases: 2, purchaseValue: 41.1, unconverted: [] });
  await insertOrder(q, { cbOrderId: 'adhdbg.eu:1', name: 'К', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: '',
    officeText: 'ЕКОНТ', city: 'Х', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 30 }], total: 30, currency: 'EUR',
    paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '' });
  const p = await getProfit(q, { from: today(), to: today() });
  assert.deepEqual([p.adSpend, p.profitBeforeAds, p.profit], [10, 30, 20]);
  await q(`update zd.ad_spend set currency = 'BGN', spend = 19.56`);
  assert.equal((await adSpendTotals(q, { from: today(), to: today() })).spend, 10, '19.56 лв. = 10 €');
  await q(`update zd.ad_spend set currency = 'USD', spend = 12`);
  assert.deepEqual((await adSpendTotals(q, { from: today(), to: today() })).unconverted, [{ currency: 'USD', amount: 12 }]);
});

test('the nightly job also pulls the last 7 days of Meta spend', async () => {
  const { default: refresh } = await import('../api/cron/refresh.js');
  await withFetch(graph(), () => post({ action: 'save_meta', accountId: '123', token: 'GOOD-TOKEN' }));
  const g = graph({ days: [day(today(), 4)] });
  const res = fakeRes();
  await withFetch(async (url, init) => (String(url).includes('graph.facebook.com') ? g(url, init) : { ok: false, status: 503, json: async () => ({}) }),
    () => refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res));
  assert.deepEqual(json(res).meta, { days: 1 });
  const range = JSON.parse(g.calls.find((u) => u.pathname.endsWith('/insights')).searchParams.get('time_range'));
  assert.equal(range.until, today());
  assert.equal((Date.parse(range.until) - Date.parse(range.since)) / 864e5, 6);
});

test('only the connected ad account counts; switching accounts drops the old spend from totals and profit', async () => {
  await withFetch(graph(), () => post({ action: 'save_meta', accountId: '123', token: 'GOOD-TOKEN' }));
  await q(`insert into zd.ad_spend (platform, account_id, day, spend, currency) values ('meta', '123', $1::date, 10, 'EUR'), ('meta', '999', $1::date, 50, 'EUR')`, [today()]);
  assert.equal((await adSpendTotals(q, { from: today(), to: today() })).spend, 10);
  assert.equal((await getProfit(q, { from: today(), to: today() })).adSpend, 10);
});

test('a broken or partial Meta answer keeps the stored days; errors are Bulgarian and Meta-specific', async () => {
  await withFetch(graph(), () => post({ action: 'save_meta', accountId: '123', token: 'GOOD-TOKEN' }));
  await q(`insert into zd.ad_spend (platform, account_id, day, spend, currency) values ('meta', '123', $1::date, 10, 'EUR')`, [today()]);
  let res = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ paging: {} }) }), () => post({ action: 'sync_meta', from: today(), to: today() }));
  assert.equal(res.statusCode, 400);
  assert.equal((await q(`select count(*)::int as n from zd.ad_spend`))[0].n, 1, 'nothing deleted');
  res = await withFetch(async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }, () => post({ action: 'sync_meta', from: today(), to: today() }));
  assert.match(json(res).error, /Meta не отговори/);
  res = await withFetch(async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } }), () => post({ action: 'test_meta' }));
  assert.match(json(res).error, /Meta/);
  assert.doesNotMatch(json(res).error, /ConvertBuilder/);
  const st = await (async () => { const r = fakeRes(); await router(fakeReq({ url: '/api/admin/integrations', headers }), r); return json(r); })();
  assert.match(st.meta.lastError, /Meta не отговори|Meta/);
  assert.doesNotMatch(st.meta.lastError, /aborted/);
});

test('with a store selected, ad figures are not mixed into that store (no subtraction, no ad cards)', async () => {
  const { getStats } = await import('../lib/stats.js');
  await withFetch(graph(), () => post({ action: 'save_meta', accountId: '123', token: 'GOOD-TOKEN' }));
  await q(`insert into zd.ad_spend (platform, account_id, day, spend, currency) values ('meta', '123', $1::date, 10, 'EUR')`, [today()]);
  assert.equal((await getProfit(q, { from: today(), to: today(), store: 'other.bg' })).adSpend, 0);
  assert.equal((await getStats(q, { from: today(), to: today(), store: 'other.bg' })).ads, null);
  assert.equal((await getStats(q, { from: today(), to: today() })).ads.spend, 10);
});
