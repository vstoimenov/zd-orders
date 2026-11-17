// Speedy's offices from its official API (a connected shop's contract): with street and post code, so „Стефан Стамболов 30“
// finds the new Pazardzhik office; the public map page stays the fallback; a short list never wipes the kept one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { parseSpeedyApiOffices } from '../lib/speedy.js';
import { refreshSpeedy } from '../api/cron/refresh.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const API = [
  { id: 1550, name: 'ПАЗАРДЖИК - СТЕФАН СТАМБОЛОВ', type: 'OFFICE', pickUpAllowed: true, address: { siteName: 'ПАЗАРДЖИК', postCode: '4400', localAddressString: 'ул. Стефан Стамболов 30', x: 24.33, y: 42.19 } },
  { id: 9757, name: 'ПАЗАРДЖИК - БИЛЛА ГЕОРГИ БЕНКОВСКИ (АВТОМАТ)', type: 'APT', address: { siteName: 'ПАЗАРДЖИК', postCode: '4400', fullAddressString: 'гр. ПАЗАРДЖИК ул. Георги Бенковски 2', x: 24.32, y: 42.2 } },
  { id: 5, name: 'СОФИЯ - БЕЗ ПРИЕМАНЕ', type: 'OFFICE', pickUpAllowed: false, address: { siteName: 'СОФИЯ' } },
];
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

test('the API list: street address, post code, automat or office, only offices that hand out parcels', () => {
  const rows = parseSpeedyApiOffices(API);
  assert.deepEqual(rows.map((r) => [r.id, r.city, r.postCode, r.address, r.isAutomat]), [
    ['speedy:1550', 'Пазарджик', '4400', 'ул. Стефан Стамболов 30', false],
    ['speedy:9757', 'Пазарджик', '4400', 'гр. ПАЗАРДЖИК ул. Георги Бенковски 2', true],
  ]);
});

test('the nightly refresh uses a connected shop Speedy contract, then falls back to the public map', async () => {
  await saveIntegration(q, 'speedy', { shopId: SHOP, config: { username: 'u1' }, secret: JSON.stringify({ username: 'u1', password: 'p1' }) });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (String(url).includes('location/office')) return new Response(JSON.stringify({ offices: API }), { status: 200 });
    return new Response('', { status: 500 });
  };
  const r = await refreshSpeedy(q, [], [], { fetchImpl });
  assert.deepEqual([r.source, r.upserted], ['api', 2]);
  assert.ok(calls.some((u) => String(u).includes('location/office')));
  const [o] = await q(`select name, address, post_code from zd.offices where id = 'speedy:1550'`);
  assert.deepEqual([o.name, o.address, o.post_code], ['ПАЗАРДЖИК - СТЕФАН СТАМБОЛОВ', 'ул. Стефан Стамболов 30', '4400']);
  // the API says no: the map is read instead
  const mapHtml = "var speedy_offices = { 77: {oID: 77, officeName: 'ДОБРИЧ', officeIcon: a, officeIconFocused: b, officeDescription: null, Y: 43.5, X: 27.8, officeType: 'OFFICE', dropOffAllowed: 1, pickUpAllowed: 1}, 1550: {oID: 1550, officeName: 'ПАЗАРДЖИК - СТЕФАН СТАМБОЛОВ', officeIcon: a, officeIconFocused: b, officeDescription: null, Y: 42.1, X: 24.3, officeType: 'OFFICE', dropOffAllowed: 1, pickUpAllowed: 1} };";
  const viaMap = async (url) => String(url).includes('location/office') ? new Response(JSON.stringify({ error: { message: 'invalid.credentials' } }), { status: 200 }) : new Response(mapHtml, { status: 200 });
  const m = await refreshSpeedy(q, [], [], { fetchImpl: viaMap });
  assert.equal(m.source, 'map');
});
