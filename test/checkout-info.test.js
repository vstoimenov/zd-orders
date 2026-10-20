import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { ETA_DEFAULT, getCheckoutInfo, getCheckoutText, saveCheckoutText } from '../lib/checkout-info.js';
import offices from '../api/offices.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'adhdbg.eu', approved = true where id = $1`, [SHOP]);
});

test('every shop starts with the same delivery-time line for each courier; the shop changes it per courier', async () => {
  assert.equal(ETA_DEFAULT, '1–2 работни дни');
  assert.deepEqual(await getCheckoutText(q, SHOP), { eta: { econt: ETA_DEFAULT, speedy: ETA_DEFAULT, boxnow: ETA_DEFAULT } });
  await saveCheckoutText(q, SHOP, { eta: { econt: ' до 24 часа ', speedy: '', boxnow: 'следващия ден' } });
  assert.deepEqual((await getCheckoutText(q, SHOP)).eta, { econt: 'до 24 часа', speedy: '', boxnow: 'следващия ден' }, 'empty = no line in the checkout');
  await assert.rejects(saveCheckoutText(q, SHOP, { eta: { econt: 'x'.repeat(41) } }), /до 40 знака/);
  await assert.rejects(saveCheckoutText(q, SHOP, { eta: { dhl: 'x' } }), /куриер/);
});

test('the widget asks once per page what to show for this shop: the BOX NOW switch and the delivery-time lines', async () => {
  await saveIntegration(q, 'boxnow', { config: { checkout: true }, shopId: SHOP });
  await saveCheckoutText(q, SHOP, { eta: { speedy: 'до 2 дни' } });
  assert.deepEqual(await getCheckoutInfo(q, 'www.adhdbg.eu'), { boxnow: true, eta: { econt: ETA_DEFAULT, speedy: 'до 2 дни', boxnow: ETA_DEFAULT } });
  assert.deepEqual(await getCheckoutInfo(q, 'other.bg'), { boxnow: false, eta: { econt: ETA_DEFAULT, speedy: ETA_DEFAULT, boxnow: ETA_DEFAULT } }, 'an unknown site gets the defaults and no BOX NOW');
  const res = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=shop&host=adhdbg.eu' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { boxnow: true, eta: { econt: ETA_DEFAULT, speedy: 'до 2 дни', boxnow: ETA_DEFAULT } });
  assert.match(res.headers['cache-control'], /s-maxage=300/);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('admin: the delivery-time lines are saved from Интеграции and shown in the status', async () => {
  const cookie = `zdo_admin=${signSession('secret')}`;
  const call = async (opts) => { const res = fakeRes(); await router(fakeReq({ url: `/api/admin/integrations?shop=${SHOP}`, headers: { cookie }, ...opts }), res); return res; };
  assert.deepEqual(json(await call({})).checkout, { eta: { econt: ETA_DEFAULT, speedy: ETA_DEFAULT, boxnow: ETA_DEFAULT } });
  const saved = await call({ method: 'POST', body: JSON.stringify({ action: 'save_checkout_text', eta: { econt: 'до 24 часа' } }) });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(json(await call({})).checkout.eta.econt, 'до 24 часа');
  const bad = await call({ method: 'POST', body: JSON.stringify({ action: 'save_checkout_text', eta: { econt: 'x'.repeat(41) } }) });
  assert.equal(bad.statusCode, 400);
});
