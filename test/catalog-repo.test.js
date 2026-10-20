import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { replaceOffices, replaceCities, listOffices, listCities } from '../lib/catalog-repo.js';

const office = (code, city, extra = {}) => ({ id: `econt:${code}`, courier: 'econt', code, name: `Офис ${code}`, city, cityId: 1, postCode: '4000', address: 'ул. Х 1', isAutomat: false, lat: 42.7, lng: 23.3, hours: 'пн–пт 09:00–18:00', ...extra });

test('replaceOffices upserts, removes vanished offices and lists them sorted', async () => {
  const q = await makeTestQuery();
  assert.deepEqual(await replaceOffices(q, 'econt', [office('2', 'София'), office('1', 'Пловдив'), office('3', 'София')]), { upserted: 3, removed: 0 });
  assert.deepEqual(await replaceOffices(q, 'econt', [office('1', 'Пловдив', { name: 'Ново име', isAutomat: true }), office('2', 'София')]), { upserted: 2, removed: 1 });
  assert.deepEqual(await listOffices(q, 'econt'), [
    { id: 'econt:1', code: '1', name: 'Ново име', city: 'Пловдив', postCode: '4000', address: 'ул. Х 1', isAutomat: true, lat: 42.7, lng: 23.3, hours: 'пн–пт 09:00–18:00' },
    { id: 'econt:2', code: '2', name: 'Офис 2', city: 'София', postCode: '4000', address: 'ул. Х 1', isAutomat: false, lat: 42.7, lng: 23.3, hours: 'пн–пт 09:00–18:00' },
  ]);
});

test('an empty list never wipes the cache', async () => {
  const q = await makeTestQuery();
  await replaceOffices(q, 'econt', [office('1', 'Пловдив')]);
  assert.deepEqual(await replaceOffices(q, 'econt', []), { upserted: 0, removed: 0 });
  assert.equal((await listOffices(q, 'econt')).length, 1);
  await replaceCities(q, [{ id: 1, name: 'Пловдив', postCode: '4000', region: 'Пловдив', hasOffice: true }]);
  assert.deepEqual(await replaceCities(q, []), { upserted: 0, removed: 0 });
  assert.equal((await listCities(q)).length, 1);
});

test('listCities puts cities with an office first', async () => {
  const q = await makeTestQuery();
  await replaceCities(q, [
    { id: 3, name: 'Арда', postCode: '4790', region: 'Смолян', hasOffice: false },
    { id: 2, name: 'Бургас', postCode: '8000', region: 'Бургас', hasOffice: true },
    { id: 1, name: 'Айтос', postCode: '8500', region: 'Бургас', hasOffice: true },
  ]);
  assert.deepEqual((await listCities(q)).map((c) => c.name), ['Айтос', 'Бургас', 'Арда']);
  assert.deepEqual((await listCities(q))[0], { id: 1, name: 'Айтос', postCode: '8500', region: 'Бургас', hasOffice: true });
});

test('replaceOffices refuses a list that shrank by more than 20%', async () => {
  const q = await makeTestQuery();
  const many = Array.from({ length: 10 }, (_, i) => office(String(i + 1), 'Град'));
  await replaceOffices(q, 'speedy', many.map((o) => ({ ...o, id: `speedy:${o.code}` })));
  const r = await replaceOffices(q, 'speedy', many.slice(0, 7).map((o) => ({ ...o, id: `speedy:${o.code}` })), { minRatio: 0.8 });
  assert.equal(r.skipped, true);
  assert.equal((await listOffices(q, 'speedy')).length, 10);
  const ok = await replaceOffices(q, 'speedy', many.slice(0, 9).map((o) => ({ ...o, id: `speedy:${o.code}` })), { minRatio: 0.8 });
  assert.deepEqual(ok, { upserted: 9, removed: 1 });
});

test('an office without coordinates or hours is stored with nulls and empty hours', async () => {
  const q = await makeTestQuery();
  await replaceOffices(q, 'speedy', [{ id: 'speedy:1', courier: 'speedy', code: '1', name: 'X', city: 'Y', cityId: null, postCode: '', address: '', isAutomat: false }]);
  const [o] = await listOffices(q, 'speedy');
  assert.deepEqual([o.lat, o.lng, o.hours], [null, null, '']);
});
