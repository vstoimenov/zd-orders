import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(readFileSync(new URL('../public/couriers-eu.js', import.meta.url), 'utf8'), { window });
const EU = window.ORDYX_EU;
const ids = (list) => list.map((k) => k.id).join(','); // arrays from the vm realm do not deep-equal ours
const landing = readFileSync(new URL('../public/landing/index.html', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');

test('24 countries with cash on delivery, Bulgaria first, each with a Bulgarian name and its couriers', () => {
  assert.equal(EU.countries.length, 24);
  assert.equal(new Set(EU.countries.map((c) => c.code)).size, 24, 'no country twice');
  assert.equal(EU.countries[0].code, 'BG');
  for (const c of EU.countries) {
    assert.match(c.name, /^[А-Яа-я ]+$/, `${c.code} has a Bulgarian name`);
    assert.ok(c.couriers.length > 0, `${c.code} has couriers`);
    for (const id of c.couriers) assert.ok(EU.couriers[id], `${c.code}: unknown courier ${id}`);
    assert.match(EU.currencies[c.currency] || '', /^[а-я ]+$/, `${c.code}: cash on delivery in ${c.currency} has a Bulgarian name`);
  }
  for (const r of EU.regions) for (const code of r.countries) assert.ok(EU.country(code), `region ${r.name}: unknown country ${code}`);
  assert.equal(EU.regions.flatMap((r) => r.countries).length, 24, 'every country sits in exactly one region');
});

test('only what Ordyx does today shows as working: Еконт, Спиди and BOX NOW in Bulgaria — everything else is „скоро“', () => {
  const live = EU.countries.flatMap((c) => (c.live || []).map((id) => `${c.code}:${id}`));
  assert.equal(live.join(','), 'BG:econt,BG:speedy,BG:boxnow');
  assert.equal(ids(EU.soon('BG')), 'sameday,pigeon,dhl,fedex');
  assert.equal(ids(EU.soon('RO')), EU.country('RO').couriers.join(','), 'abroad every courier is still to come');
  assert.equal(EU.soon('XX').length, 0, 'an unknown country has nothing to show');
});

test('the landing promises Europe from the shared list, in its own words — no one else\'s name or numbers', () => {
  assert.match(landing, /<script src="\/couriers-eu\.js"><\/script>/);
  assert.match(landing, /id="europe"/);
  assert.match(landing, /id="euList"/);
  assert.match(landing, /id="euPanel"/);
  assert.doesNotMatch(landing, /bigarena|БигАрена/i);
  assert.doesNotMatch(landing, /20M|20 млн/);
  assert.doesNotMatch(landing, /<li>пращаш само с международни куриери<\/li>/, 'the fit list no longer contradicts the promise');
});

test('Интеграции → Куриери picks a country; its couriers come from the shared list and the Bulgarian cards stay for Bulgaria', () => {
  assert.match(admin, /<script src="\/couriers-eu\.js"><\/script>/);
  assert.match(admin, /<select id="iCountry"/);
  assert.match(admin, /id="iCountryCouriers"/);
  assert.doesNotMatch(admin, /<b>Pigeon Express<\/b> <span class="chip">скоро<\/span>/, 'Pigeon is drawn from the list, not twice');
  assert.match(admin, /var EU = window\.ORDYX_EU;/);
  assert.match(admin, /if \(EU\) \{/, 'the page still works if the list did not load');
});
