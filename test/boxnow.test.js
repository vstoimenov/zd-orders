import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { replaceOffices } from '../lib/catalog-repo.js';
import { parseBoxnowLockers, fetchBoxnowLockers, BOXNOW_LOCKERS_URL } from '../lib/boxnow.js';
import offices from '../api/offices.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

/** two real entries from the public list (2026-10-20) + one not in service */
export const LOCKERS = { data: [
  { id: '1840', type: 'apm', lat: '42.64480928803469', lng: '23.339724129024635', addressLine1: 'ул. Проф. арх. Храбър Попов №14', addressLine2: 'София', postalCode: '1700', title: 'Stud. Grad New Avenue', name: 'BOX NOW - New Avenue, ул. Проф. Храбър Попов 14, София - 24/7', country: 'BG', image: '', note: '24/7', region: 'bg-BG', state: 'boxnow-ready', expectedDeliveryTime: '2026-10-21T19:00:00.000Z' },
  { id: '5365', type: 'apm', lat: '42.70295', lng: '23.31272', addressLine1: 'Цар Симеон 170 ', addressLine2: 'Пловдив ', postalCode: '4000', title: 'Test 1', name: 'Test Locker 1', country: 'BG', image: '', note: '', region: 'bg-BG', state: 'only-delivery', expectedDeliveryTime: '' },
  { id: '9999', type: 'apm', addressLine1: 'x', addressLine2: 'Варна', postalCode: '9000', name: 'BOX NOW - Затворен', state: 'disabled' },
] };

test('the public BOX NOW list becomes lockers in our office list; lockers out of service are left out', () => {
  assert.deepEqual(parseBoxnowLockers(LOCKERS), [
    { id: 'boxnow:1840', courier: 'boxnow', code: '1840', name: 'New Avenue, ул. Проф. Храбър Попов 14, София - 24/7', city: 'София', cityId: null, postCode: '1700', address: 'ул. Проф. арх. Храбър Попов №14', isAutomat: true },
    { id: 'boxnow:5365', courier: 'boxnow', code: '5365', name: 'Test Locker 1', city: 'Пловдив', cityId: null, postCode: '4000', address: 'Цар Симеон 170', isAutomat: true },
  ]);
  assert.throws(() => parseBoxnowLockers({ nope: 1 }), /BOX NOW/);
});

test('the list is read from BOX NOW\'s public address; an error status is an error', async () => {
  let asked;
  const lockers = await fetchBoxnowLockers(async (url) => { asked = String(url); return { ok: true, json: async () => LOCKERS }; });
  assert.equal(asked, BOXNOW_LOCKERS_URL);
  assert.equal(BOXNOW_LOCKERS_URL, 'https://locationapi-production.boxnow.bg/v1/apms_bg-BG.json');
  assert.equal(lockers.length, 2);
  await assert.rejects(fetchBoxnowLockers(async () => ({ ok: false, status: 503 })), /HTTP 503/);
});

test('BOX NOW lockers are stored and served by /api/offices?courier=boxnow', async () => {
  await replaceOffices(q, 'boxnow', parseBoxnowLockers(LOCKERS));
  const res = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=boxnow' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).offices.map((o) => [o.id, o.city, o.isAutomat]), [['boxnow:5365', 'Пловдив', true], ['boxnow:1840', 'София', true]]);
});

test('orders to a BOX NOW locker are accepted by the database', async () => {
  const [o] = await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, delivery_type, courier, office_id, office_text, total, currency)
    values ('b1', 'Мария', '0888123456', '+359888123456', 'boxnow_locker', 'boxnow', 'boxnow:1840', 'BOX NOW – автомат New Avenue (1840)', 10, 'EUR') returning courier`);
  assert.equal(o.courier, 'boxnow');
});
