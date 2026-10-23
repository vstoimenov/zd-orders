import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { makeFulfilmentKey, fulfilmentByKey, fulfilmentSecret, saveFulfilment, pauseFulfilment, deleteFulfilment, fulfilmentStatus, fulfilmentEnabled } from '../lib/fulfilment.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

test('migration 026 adds the fulfilment columns', async () => {
  const [r] = await q(`select fulfil_sent_at, fulfil_notify, waybill_external, waybill_track_url from zd.orders limit 1`);
  assert.equal(r, undefined); // no orders, but the columns exist
});

test('a fulfilment key is made once, found by its id with a timing-safe compare, and replaced by a new one', async () => {
  const { key } = await makeFulfilmentKey(q, SHOP);
  assert.match(key, /^ordyx_ful_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
  assert.equal((await fulfilmentByKey(q, key)).shopId, SHOP);
  assert.equal(await fulfilmentByKey(q, key.slice(0, -1) + (key.endsWith('x') ? 'y' : 'x')), null);
  assert.equal(await fulfilmentByKey(q, 'ordyx_live_abc'), null);
  assert.equal(await fulfilmentSecret(q, SHOP), key);
  const { key: key2 } = await makeFulfilmentKey(q, SHOP);
  assert.equal(await fulfilmentByKey(q, key), null);
  assert.equal((await fulfilmentByKey(q, key2)).shopId, SHOP);
});

test('settings: https only, sendOn defaults to confirmed, saving enables, pausing keeps the key', async () => {
  await assert.rejects(saveFulfilment(q, SHOP, { url: 'http://sklad.bg/hook' }), /https/);
  const st = await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook', sendOn: 'weird' });
  assert.equal(st.enabled, true); assert.equal(st.sendOn, 'confirmed'); assert.equal(st.url, 'https://sklad.bg/hook');
  assert.equal(await fulfilmentEnabled(q, SHOP), true);
  const { key } = await makeFulfilmentKey(q, SHOP);
  await pauseFulfilment(q, SHOP);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
  assert.equal((await fulfilmentByKey(q, key)).enabled, false);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, true);
});

test('deleting is refused while a sent order is still unshipped', async () => {
  await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' });
  await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text, city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, shop_id, status, fulfil_sent_at)
    values ('t:1', 'Иван', '0888', '+359888', '', 'econt_office', 'econt', 'econt:1', 'x', 'София', '', '', '[]', 10, 'EUR', 'cod', '', '', '', $1::uuid, 'confirmed', now())`, [SHOP]);
  await assert.rejects(deleteFulfilment(q, SHOP), /1 поръчки са при склада/);
  await q(`update zd.orders set waybill_number = '123', status = 'shipped'`);
  await deleteFulfilment(q, SHOP);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, false);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
});
