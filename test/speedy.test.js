import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeedyOffices, fetchSpeedyMap } from '../lib/speedy.js';

const entry = (id, name, type, pickUp = 1) =>
  `${id}: {oID: ${id}, officeName: '${name}', officeIcon: iconMarker, officeIconFocused: iconMarkerFocused, officeDescription: null, Y: 42.1, X: 24.7, officeType: '${type}', dropOffAllowed: 1, pickUpAllowed: ${pickUp}} ,`;

const HTML = `<script> var speedy_offices = {
  ${entry(190, 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', 'OFFICE')}
  ${entry(9364, 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)', 'APT')}
  ${entry(77, 'ДОБРИЧ', 'OFFICE')}
  ${entry(5, 'СОФИЯ - БЕЗ ПРИЕМАНЕ', 'OFFICE', 0)}
  ${entry(88, "СОФИЯ - Д\\'АРТ ЦЕНТЪР", 'APT')}
  ${entry(190, 'АЙТОС - ДУБЛИКАТ', 'OFFICE')}
}; </script>`;

test('parseSpeedyOffices reads the offices embedded in the public Speedy map', () => {
  assert.deepEqual(parseSpeedyOffices(HTML), [
    { id: 'speedy:190', courier: 'speedy', code: '190', name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', city: 'Айтос', cityId: null, postCode: '', address: '', isAutomat: false, lat: 42.1, lng: 24.7 },
    { id: 'speedy:9364', courier: 'speedy', code: '9364', name: 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)', city: 'Стара Загора', cityId: null, postCode: '', address: '', isAutomat: true, lat: 42.1, lng: 24.7 },
    { id: 'speedy:77', courier: 'speedy', code: '77', name: 'ДОБРИЧ', city: 'Добрич', cityId: null, postCode: '', address: '', isAutomat: false, lat: 42.1, lng: 24.7 },
    { id: 'speedy:88', courier: 'speedy', code: '88', name: "СОФИЯ - Д'АРТ ЦЕНТЪР", city: 'София', cityId: null, postCode: '', address: '', isAutomat: true, lat: 42.1, lng: 24.7 },
  ]);
});

test('parseSpeedyOffices capitalizes the city inside brackets too', () => {
  const html = "var speedy_offices = { 263: {oID: 263, officeName: 'БЯЛА (ВАРНА)', officeIcon: iconMarker, officeIconFocused: iconMarkerFocused, officeDescription: null, Y: 43.4, X: 27.9, officeType: 'OFFICE', dropOffAllowed: 1, pickUpAllowed: 1} };";
  assert.equal(parseSpeedyOffices(html)[0].city, 'Бяла (Варна)');
});

test('parseSpeedyOffices tolerates a page without offices', () => {
  assert.deepEqual(parseSpeedyOffices('<html></html>'), []);
  assert.deepEqual(parseSpeedyOffices(null), []);
});

test('fetchSpeedyMap downloads the public map page and fails on HTTP errors', async () => {
  let called;
  const ok = async (url) => { called = url; return { ok: true, text: async () => HTML }; };
  assert.equal(await fetchSpeedyMap(ok), HTML);
  assert.match(called, /^https:\/\/services\.speedy\.bg\/officesmap_v2\/googleMaps\.php/);
  await assert.rejects(fetchSpeedyMap(async () => ({ ok: false, status: 502 })), /HTTP 502/);
});

test('attachPostCodes gives Speedy offices the post code of their city (bracket = region)', async () => {
  const { attachPostCodes } = await import('../lib/speedy.js');
  const cities = [
    { id: 1, name: 'Варна', postCode: '9000', region: 'Варна', hasOffice: true },
    { id: 2, name: 'Бяла', postCode: '9101', region: 'Варна', hasOffice: true },
    { id: 3, name: 'Бяла', postCode: '7100', region: 'Русе', hasOffice: true },
  ];
  const offices = [
    { id: 'speedy:1', city: 'Варна', postCode: '' },
    { id: 'speedy:263', city: 'Бяла (Варна)', postCode: '' },
    { id: 'speedy:5', city: 'Бяла', postCode: '' },
    { id: 'speedy:9', city: 'Нямагоград', postCode: '' },
  ];
  assert.deepEqual(attachPostCodes(offices, cities).map((o) => o.postCode), ['9000', '9101', '9101', '']);
});

test('parseSpeedyOffices drops "(АВТОМАТ)" from the city name', () => {
  const html = "var speedy_offices = { 7: {oID: 7, officeName: 'ПЛОДОВИТОВО (АВТОМАТ)', officeIcon: iconMarker, officeIconFocused: iconMarkerFocused, officeDescription: null, Y: 42.2, X: 25.5, officeType: 'APT', dropOffAllowed: 1, pickUpAllowed: 1} };";
  assert.equal(parseSpeedyOffices(html)[0].city, 'Плодовитово');
});

test('attachPostCodes falls back to the nearest Econt office when the city is unknown', async () => {
  const { attachPostCodes } = await import('../lib/speedy.js');
  const points = [{ lat: 43.21, lng: 27.91, postCode: '9000' }, { lat: 42.70, lng: 23.32, postCode: '1000' }];
  const [o] = attachPostCodes([{ id: 'speedy:9', city: 'Белослав', postCode: '', lat: 43.19, lng: 27.70 }], [], points);
  assert.equal(o.postCode, '9000');
});
