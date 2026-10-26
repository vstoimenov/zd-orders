import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, ensureConfirmToken } from '../lib/orders-repo.js';
import { getStats } from '../lib/stats.js';
import { answerConfirm } from '../lib/confirm.js';
import { voiceResult } from '../lib/voice-call.js';
import { signSession } from '../lib/auth.js';
import { fakeReq, fakeRes } from './helpers/http.js';
import ordersApi from '../lib/admin/orders.js';
import { createHmac } from 'node:crypto';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
let seq = 0;
const order = async (deliveryType, status = 'new', total = 10) => {
  const courier = deliveryType.split('_')[0];
  const { id } = await insertOrder(q, {
    cbOrderId: `s-${++seq}`, name: 'М', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType, courier,
    officeId: '', officeText: 'x', city: 'София', postCode: '', addressText: /_address$/.test(deliveryType) ? 'ул. 1' : '', items: [{ name: 'К', qty: 1, price: total }],
    total, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP,
  });
  await q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
  return id;
};
const period = () => { const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' }); return { from: d, to: d }; }; // Sofia's day, as the stats count it

test('the delivery mix: courier × kind with shares, delivered, returned and the return rate', async () => {
  for (let i = 0; i < 6; i++) await order('econt_office', 'delivered');
  await order('econt_office', 'returned');
  await order('econt_office', 'new');
  await order('boxnow_locker', 'delivered');
  await order('speedy_address', 'cancelled');
  const s = await getStats(q, { ...period(), shopId: SHOP });
  const econt = s.deliveryMix.find((r) => r.courier === 'econt' && r.kind === 'office');
  assert.deepEqual({ ...econt, revenue: undefined }, { courier: 'econt', kind: 'office', orders: 8, share: 0.8, delivered: 6, returned: 1, returnRate: 1 / 7, revenue: undefined });
  assert.equal(econt.revenue, 80);
  assert.equal(s.deliveryMix[0].courier, 'econt', 'sorted by orders');
  const box = s.deliveryMix.find((r) => r.kind === 'locker');
  assert.equal(box.returnRate, 0);
  const sp = s.deliveryMix.find((r) => r.courier === 'speedy');
  assert.equal(sp.kind, 'address'); assert.equal(sp.returnRate, null, 'nothing finished yet'); assert.equal(sp.revenue, 0, 'cancelled is no revenue');
  assert.deepEqual(s.deliveryHighlights.most, { courier: 'econt', kind: 'office', share: 0.8 });
  assert.equal(s.deliveryHighlights.fewestReturns, null, 'no row has 10 finished parcels yet');
});

test('the fewest-returns highlight needs at least 10 finished parcels; an empty period has no highlights', async () => {
  for (let i = 0; i < 10; i++) await order('boxnow_locker', 'delivered');
  for (let i = 0; i < 9; i++) await order('econt_office', 'delivered');
  await order('econt_office', 'returned');
  const s = await getStats(q, { ...period(), shopId: SHOP });
  assert.deepEqual(s.deliveryHighlights.fewestReturns, { courier: 'boxnow', kind: 'locker', returnRate: 0 });
  q = await makeTestQuery(); setQueryForTests(q);
  const e = await getStats(q, { ...period(), shopId: SHOP });
  assert.deepEqual(e.deliveryMix, []); assert.deepEqual(e.deliveryHighlights, { most: null, fewestReturns: null });
});

test('confirmations by channel: link, voice, manual (admin), none', async () => {
  process.env.VOICE_CALL_SECRET = 's';
  const a = await order('econt_office');
  await answerConfirm(q, await ensureConfirmToken(q, a), 'yes');
  const b = await order('econt_office');
  await answerConfirm(q, await ensureConfirmToken(q, b), 'no');
  const c = await order('econt_office');
  const ts = String(Math.floor(Date.now() / 1000)), body = JSON.stringify({ order_id: c, answer: 'yes' });
  await voiceResult(q, body, { 'x-ordyx-time': ts, 'x-ordyx-signature': createHmac('sha256', 's').update(`${ts}.${body}`).digest('hex') });
  const d = await order('econt_office');
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'PATCH', url: '/api/admin/orders', headers: { cookie: `zdo_admin=${signSession('secret')}` }, body: JSON.stringify({ id: d, status: 'confirmed' }) }), res);
  await order('econt_office');
  const s = await getStats(q, { ...period(), shopId: SHOP });
  const by = Object.fromEntries(s.confirmations.map((r) => [r.channel, r]));
  assert.deepEqual(by.link, { channel: 'link', orders: 2, confirmed: 1, cancelled: 1 });
  assert.deepEqual(by.voice, { channel: 'voice', orders: 1, confirmed: 1, cancelled: 0 });
  assert.deepEqual(by.manual, { channel: 'manual', orders: 1, confirmed: 1, cancelled: 0 });
  assert.deepEqual(by.none, { channel: 'none', orders: 1, confirmed: 0, cancelled: 0 });
});
