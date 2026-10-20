import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOffices, normalizeCities, fetchEcont, econtPoints } from '../lib/econt.js';

const country = { code3: 'BGR' };
const OFFICES = {
  offices: [
    { code: '7538', name: 'Айдемир', isAPS: false, address: { city: { id: 11, name: 'Айдемир', postCode: '7538', country }, fullAddress: ' Айдемир кв. Деленките ул. София №7', location: { latitude: 44.1009192550187, longitude: 27.1950400265455 } },
      normalBusinessHoursFrom: Date.UTC(2026, 9, 20, 6, 0), normalBusinessHoursTo: Date.UTC(2026, 9, 20, 15, 0), halfDayBusinessHoursFrom: Date.UTC(2026, 9, 20, 6, 0), halfDayBusinessHoursTo: Date.UTC(2026, 9, 20, 12, 0) },
    { code: '6752', name: 'Ардино', isAPS: true, address: { city: { id: 83, name: 'Ардино', postCode: '6750', country }, fullAddress: '', quarter: 'кв. Бостанджиите', street: 'ул. Бели брези', num: '21' },
      normalBusinessHoursFrom: Date.UTC(2026, 9, 19, 21, 0), normalBusinessHoursTo: Date.UTC(2026, 9, 20, 20, 59), halfDayBusinessHoursFrom: Date.UTC(2026, 9, 19, 21, 0), halfDayBusinessHoursTo: Date.UTC(2026, 9, 20, 20, 59) },
    { code: '1001', name: 'Лозенец', isAPS: false, address: { city: { id: 41, name: 'София', postCode: '1000', country }, fullAddress: ' София ул. Бяла черква 2', location: { latitude: 42.67, longitude: 23.32 } },
      normalBusinessHoursFrom: Date.UTC(2026, 9, 20, 6, 0), normalBusinessHoursTo: Date.UTC(2026, 9, 20, 15, 0), halfDayBusinessHoursFrom: null, halfDayBusinessHoursTo: null },
    { code: '9999', name: 'Букурещ', address: { city: { id: 5, name: 'Букурещ', postCode: '', country: { code3: 'ROU' } } } },
    { name: 'без код', address: { city: { id: 6, name: 'X', country } } },
  ],
};

test('normalizeOffices keeps BG offices with a code and strips the city from the address', () => {
  assert.deepEqual(normalizeOffices(OFFICES), [
    { id: 'econt:7538', courier: 'econt', code: '7538', name: 'Айдемир', city: 'Айдемир', cityId: 11, postCode: '7538', address: 'кв. Деленките ул. София №7', isAutomat: false, lat: 44.1009192550187, lng: 27.1950400265455, hours: 'пн–пт 09:00–18:00 · сб 09:00–15:00' },
    { id: 'econt:6752', courier: 'econt', code: '6752', name: 'Ардино', city: 'Ардино', cityId: 83, postCode: '6750', address: 'кв. Бостанджиите ул. Бели брези 21', isAutomat: true, lat: null, lng: null, hours: '24/7' },
    { id: 'econt:1001', courier: 'econt', code: '1001', name: 'Лозенец', city: 'София', cityId: 41, postCode: '1000', address: 'ул. Бяла черква 2', isAutomat: false, lat: 42.67, lng: 23.32, hours: 'пн–пт 09:00–18:00' },
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
