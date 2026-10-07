import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { classify, deviceOf, isBot, visitorId } from '../lib/visits.js';
import visitApi from '../api/visit.js';
import ordersApi from '../api/orders.js';

process.env.ALLOWED_ORIGINS = 'https://adhdbg.eu, https://www.adhdbg.eu';
process.env.ORDER_TOKEN = 'tok';
process.env.INTEGRATIONS_SECRET = 'test-secret';
delete process.env.NEKOREKTEN_API_KEY;
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const beacon = (b, { origin = 'https://www.adhdbg.eu', ua = UA, ip = '1.2.3.4' } = {}) => {
  const res = fakeRes();
  return visitApi(fakeReq({ method: 'POST', url: '/api/visit', headers: { origin, 'user-agent': ua, 'x-forwarded-for': ip }, body: JSON.stringify(b) }), res).then(() => res);
};

test('traffic source: UTM first, then click ids, then the referrer; internal or empty is direct', () => {
  const c = (search, referrer) => classify({ search, referrer, site: 'adhdbg.eu' });
  assert.deepEqual(c('?utm_source=FB&utm_campaign=Есен', 'https://google.com/'), { source: 'fb', campaign: 'Есен' });
  assert.deepEqual(c('?fbclid=abc', ''), { source: 'facebook', campaign: '' });
  assert.deepEqual(c('?gclid=x', ''), { source: 'google', campaign: '' });
  assert.deepEqual(c('?ttclid=x', ''), { source: 'tiktok', campaign: '' });
  assert.deepEqual(c('', 'https://l.facebook.com/l.php?u=x'), { source: 'facebook', campaign: '' });
  assert.deepEqual(c('', 'https://www.instagram.com/'), { source: 'instagram', campaign: '' });
  assert.deepEqual(c('', 'https://www.google.bg/'), { source: 'google', campaign: '' });
  assert.deepEqual(c('', 'https://blog.example.com/post'), { source: 'blog.example.com', campaign: '' });
  assert.deepEqual(c('', 'https://www.adhdbg.eu/kniga'), { source: 'direct', campaign: '' });
  assert.deepEqual(c('', ''), { source: 'direct', campaign: '' });
});

test('devices, bots and a daily-changing anonymous visitor id', () => {
  assert.equal(deviceOf(UA), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'), 'desktop');
  assert.equal(isBot('facebookexternalhit/1.1'), true);
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), true);
  assert.equal(isBot(UA), false);
  const a = visitorId({ ip: '1.2.3.4', ua: UA, site: 'adhdbg.eu', day: '2026-10-07' });
  assert.equal(a, visitorId({ ip: '1.2.3.4', ua: UA, site: 'adhdbg.eu', day: '2026-10-07' }));
  assert.notEqual(a, visitorId({ ip: '1.2.3.4', ua: UA, site: 'adhdbg.eu', day: '2026-10-08' }), 'a new day is a new id');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a.includes('1.2.3.4'), false);
});

test('POST /api/visit stores an anonymous visit; ignores bots and foreign sites', async () => {
  let res = await beacon({ p: '/kniga', s: '?utm_source=facebook&utm_campaign=adhd', r: '' });
  assert.equal(res.statusCode, 204);
  res = await beacon({ p: '/x' }, { ua: 'Googlebot/2.1' });
  assert.equal(res.statusCode, 204);
  res = await beacon({ p: '/x' }, { origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
  const rows = await q(`select site, path, source, campaign, device, visitor from zd.visits`);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].site, rows[0].path, rows[0].source, rows[0].campaign, rows[0].device], ['adhdbg.eu', '/kniga', 'facebook', 'adhd', 'mobile']);
  assert.equal(JSON.stringify(rows).includes('1.2.3.4'), false, 'no IP stored');
});

test('a checkout order gets the traffic source of the same visitor that day', async () => {
  await beacon({ p: '/kniga', s: '?fbclid=1', r: '' });
  await beacon({ p: '/chekout', s: '', r: 'https://adhdbg.eu/kniga' });
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: 'https://adhdbg.eu', 'user-agent': UA, 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({
    token: 'tok', cb_order_id: '90', name: 'Мария', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1',
    office_text: 'ЕКОНТ – офис (1)', city: 'Х', items: [], total: 20 }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal((await q(`select traffic_source from zd.orders`))[0].traffic_source, 'facebook');
});
