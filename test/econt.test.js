import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOffices, normalizeCities, fetchEcont, econtPoints } from '../lib/econt.js';

const country = { code3: 'BGR' };
const OFFICES = {
  offices: [
    { code: '7538', name: 'Айдемир', isAPS: false, address: { city: { id: 11, name: 'Айдемир', postCode: '7538', country }, fullAddress: ' Айдемир кв. Деленките ул. София №7' } },
    { code: '6752', name: 'Ардино', isAPS: true, address: { city: { id: 83, name: 'Ардино', postCode: '6750', country }, fullAddress: '', quarter: 'кв. Бостанджиите', street: 'ул. Бели брези', num: '21' } },
    { code: '9999', name: 'Букурещ', address: { city: { id: 5, name: 'Букурещ', postCode: '', country: { code3: 'ROU' } } } },
    { name: 'без код', address: { city: { id: 6, name: 'X', country } } },
  ],
};

test('normalizeOffices keeps BG offices with a code and strips the city from the address', () => {
  assert.deepEqual(normalizeOffices(OFFICES), [
    { id: 'econt:7538', courier: 'econt', code: '7538', name: 'Айдемир', city: 'Айдемир', cityId: 11, postCode: '7538', address: 'кв. Деленките ул. София №7', isAutomat: false },
    { id: 'econt:6752', courier: 'econt', code: '6752', name: 'Ардино', city: 'Ардино', cityId: 83, postCode: '6750', address: 'кв. Бостанджиите ул. Бели брези 21', isAutomat: true },
  ]);
});

test('normalizeOffices tolerates a bad payload', () => {
  assert.deepEqual(normalizeOffices(null), []);
  assert.deepEqual(normalizeOffices({ offices: 'x' }), []);
});

test('normalizeCities marks cities that have an office', () => {
  const offices = normalizeOffices(OFFICES);
  const cities = normalizeCities({ cities: [
    { id: 83, name: 'Ардино', postCode: '6750', regionName: 'Кърджали' },
    { id: 123, name: ' Равда ', postCode: '8238', regionName: null },
    { id: 'x', name: 'Лош' },
  ] }, offices);
  assert.deepEqual(cities, [
    { id: 83, name: 'Ардино', postCode: '6750', region: 'Кърджали', hasOffice: true },
    { id: 123, name: 'Равда', postCode: '8238', region: '', hasOffice: false },
  ]);
});

test('fetchEcont posts countryCode BGR and fails on HTTP errors', async () => {
  let call;
  const ok = async (url, init) => { call = { url, init }; return { ok: true, json: async () => ({ offices: [] }) }; };
  assert.deepEqual(await fetchEcont('getOffices', ok), { offices: [] });
  assert.equal(call.url, 'https://ee.econt.com/services/Nomenclatures/NomenclaturesService.getOffices.json');
  assert.deepEqual(JSON.parse(call.init.body), { countryCode: 'BGR' });
  await assert.rejects(fetchEcont('getCities', async () => ({ ok: false, status: 503 })), /HTTP 503/);
});

test('econtPoints lists the coordinates and post code of BG offices', () => {
  const json = { offices: [
    { code: '1', address: { city: { postCode: '9000', country: { code3: 'BGR' } }, location: { latitude: 43.2, longitude: 27.9 } } },
    { code: '2', address: { city: { postCode: '1000', country: { code3: 'BGR' } }, location: null } },
    { code: '3', address: { city: { postCode: '', country: { code3: 'BGR' } }, location: { latitude: 1, longitude: 2 } } },
  ] };
  assert.deepEqual(econtPoints(json), [{ lat: 43.2, lng: 27.9, postCode: '9000' }]);
});
