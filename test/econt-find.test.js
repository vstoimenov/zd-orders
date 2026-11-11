import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { matchShipments, findEcontWaybills } from '../lib/waybills.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const H = 3600e3;
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); n = 0; });

test('a parcel joins the order of the same phone made before it; cash on delivery decides between two; each order once', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const orders = [
    { id: 'a', phoneNorm: '+359888111111', total: 40, createdAt: new Date(t0 - 30 * H).toISOString() },
    { id: 'b', phoneNorm: '+359888111111', total: 55, createdAt: new Date(t0 - 20 * H).toISOString() },
    { id: 'c', phoneNorm: '+359888222222', total: 30, createdAt: new Date(t0 - 20 * 24 * H).toISOString() }, // too old for a parcel today
  ];
  const sh = (number, phone, cod, at = t0) => ({ number, phones: [phone], cod, createdAt: new Date(at).toISOString() });
  const m = matchShipments([sh('1', '0888 111 111', 40), sh('2', '0888111111', 0), sh('3', '0888222222', 30), sh('4', '0899000000', 40)], orders);
  assert.deepEqual(m.map((x) => [x.shipment.number, x.orderId]), [['1', 'a'], ['2', 'b']], 'COD picks a; the next parcel takes the one left; c is too old; 4 has no order');
});

test('nightly: Econt parcels made outside Ordyx join their orders, which become shipped and then delivered or returned', async () => {
  await saveIntegration(q, 'econt', { config: { sender: { type: 'office', officeCode: '1', text: 'О' }, senderPhone: '0888', active: true }, secret: JSON.stringify({ username: 'u', password: 'p' }), shopId: SHOP });
  const mk = async (phone, total, hoursAgo) => {
    const r = await insertOrder(q, { cbOrderId: `s.bg:${++n}`, name: 'Мария', phone, phoneNorm: phone, email: '', deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ',
      city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Крем', qty: 1, price: total - 5 }], total, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP });
    await q(`update zd.orders set created_at = now() - make_interval(hours => $2) where id = $1::uuid`, [r.id, hoursAgo]);
    return r.id;
  };
  const delivered = await mk('+359888111111', 40, 100);
  const returned = await mk('+359888222222', 30, 200);
  const other = await mk('+359888333333', 20, 50);
  await q(`update zd.orders set waybill_number = '1000000009', waybill_courier = 'econt', status = 'shipped', waybill_created_at = now() where id = $1::uuid`, [other]); // already known
  const created = new Date(Date.now() - 90 * H).toISOString();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(url.split('/').pop());
    if (url.endsWith('getMyAWB.json')) return new Response(JSON.stringify({ results: [{ shipmentNumber: '1000000001' }, { shipmentNumber: '1000000002' }, { shipmentNumber: '1000000009' }], page: 1, totalPages: 1 }));
    assert.deepEqual(body.shipmentNumbers, ['1000000001', '1000000002'], 'only parcels Ordyx does not know');
    return new Response(JSON.stringify({ shipmentStatuses: [
      { status: { shipmentNumber: '1000000001', createdTime: created, receiverClient: { phones: ['0888111111'] }, cdCollectedAmount: 40, deliveryTime: created, shortDeliveryStatus: 'Доставена', trackingEvents: [{ destinationType: 'client' }] } },
      { status: { shipmentNumber: '1000000002', createdTime: created, receiverClient: { phones: ['+359 888 222 222'] }, shortDeliveryStatus: 'Върната', trackingEvents: [{ destinationType: 'return' }] } },
    ] }));
  };
  const r = await findEcontWaybills(q, SHOP, { fetchImpl });
  assert.deepEqual(r, { found: 2, joined: 2 });
  const row = async (id) => (await q(`select status, waybill_number, waybill_courier, waybill_status from zd.orders where id = $1::uuid`, [id]))[0];
  assert.deepEqual(await row(delivered), { status: 'delivered', waybill_number: '1000000001', waybill_courier: 'econt', waybill_status: 'Доставена' });
  assert.equal((await row(returned)).status, 'returned');
  assert.equal((await row(other)).waybill_number, '1000000009', 'untouched');
  assert.deepEqual(calls, ['Shipments', 'Shipments'].map((x, i) => (i ? 'ShipmentService.getShipmentStatuses.json' : 'ShipmentService.getMyAWB.json')));
  assert.deepEqual(await findEcontWaybills(q, SHOP, { fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith('getMyAWB.json') ? { results: [{ shipmentNumber: '1000000001' }], totalPages: 1 } : { shipmentStatuses: [] })) }), { found: 0, joined: 0 }, 'the next night: nothing new');
});
