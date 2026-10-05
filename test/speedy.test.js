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
    { id: 'speedy:190', courier: 'speedy', code: '190', name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', city: 'Айтос', cityId: null, postCode: '', address: '', isAutomat: false },
    { id: 'speedy:9364', courier: 'speedy', code: '9364', name: 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)', city: 'Стара Загора', cityId: null, postCode: '', address: '', isAutomat: true },
    { id: 'speedy:77', courier: 'speedy', code: '77', name: 'ДОБРИЧ', city: 'Добрич', cityId: null, postCode: '', address: '', isAutomat: false },
    { id: 'speedy:88', courier: 'speedy', code: '88', name: "СОФИЯ - Д'АРТ ЦЕНТЪР", city: 'София', cityId: null, postCode: '', address: '', isAutomat: true },
  ]);
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
