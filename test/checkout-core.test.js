import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/checkout.js', import.meta.url), 'utf8');
const window = { __ZDO_TEST__: true };
vm.runInNewContext(src, { window, console });
const core = window.__zdoCore;
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm realm

const OFFICES = [
  { id: 'econt:1', code: '1', name: 'Пловдив Център', city: 'Пловдив', postCode: '4000', address: 'ул. Гладстон 1', isAutomat: false },
  { id: 'econt:2', code: '2', name: 'Тракия', city: 'Пловдив', postCode: '4000', address: 'бул. Освобождение 31', isAutomat: true },
  { id: 'econt:3', code: '3', name: 'Лозенец', city: 'София', postCode: '1000', address: 'ул. Бяла черква 2', isAutomat: false },
];

test('searchOffices matches every word in city, name or address', () => {
  assert.deepEqual(plain(core.searchOffices(OFFICES, 'плов')).map((o) => o.id), ['econt:1', 'econt:2']);
  assert.deepEqual(plain(core.searchOffices(OFFICES, 'ПЛОВДИВ тракия')).map((o) => o.id), ['econt:2']);
  assert.deepEqual(plain(core.searchOffices(OFFICES, 'черква')).map((o) => o.id), ['econt:3']);
  assert.deepEqual(plain(core.searchOffices(OFFICES, '  ')), []);
  assert.equal(core.searchOffices(OFFICES, 'плов', 1).length, 1);
});

test('searchCities puts prefix matches first', () => {
  const cities = [{ id: 1, name: 'Долни Воден' }, { id: 2, name: 'Вода' }, { id: 3, name: 'Пловдив' }];
  assert.deepEqual(plain(core.searchCities(cities, 'вод')).map((c) => c.id), [2, 1]);
  assert.deepEqual(plain(core.searchCities(cities, '')), []);
});

const econt = OFFICES[1];
const speedy = { id: 'speedy:79', code: '79', name: 'ПЛОВДИВ - ОФИС', address: 'ул. Константин Стоилов 19', city: 'ПЛОВДИВ', postCode: '4000', isAutomat: false };

test('formatSelection builds the text ConvertBuilder stores', () => {
  assert.deepEqual(plain(core.formatSelection({ type: 'econt_office', office: econt })),
    { address: 'ЕКОНТ – автомат Тракия (2), бул. Освобождение 31', city: 'Пловдив', zip: '4000', officeId: 'econt:2' });
  assert.deepEqual(plain(core.formatSelection({ type: 'speedy_office', office: speedy })),
    { address: 'СПИДИ – офис ПЛОВДИВ - ОФИС (79), ул. Константин Стоилов 19', city: 'ПЛОВДИВ', zip: '4000', officeId: 'speedy:79' });
  assert.deepEqual(plain(core.formatSelection({ type: 'speedy_office', office: null, fallback: true, city: 'Варна', officeText: 'до Мол Варна' })),
    { address: 'СПИДИ – офис: до Мол Варна', city: 'Варна', zip: '', officeId: '' });
  assert.deepEqual(plain(core.formatSelection({ type: 'speedy_address', city: 'Варна', postCode: '9000', street: 'ул. Роза 5, ет. 2' })),
    { address: 'СПИДИ – адрес: ул. Роза 5, ет. 2', city: 'Варна', zip: '9000', officeId: '' });
  assert.equal(core.formatSelection({ type: 'econt_office', office: null }), null);
  assert.equal(core.formatSelection({ type: 'speedy_address', city: 'Варна', street: ' ' }), null);
  assert.equal(core.formatSelection({ type: '' }), null);
});

test('validateSelection explains what is missing', () => {
  assert.equal(core.validateSelection({ type: '' }), 'Моля, изберете начин на доставка.');
  assert.equal(core.validateSelection({ type: 'econt_office', office: null }), 'Моля, изберете офис или автомат на Еконт.');
  assert.equal(core.validateSelection({ type: 'speedy_office', office: null }), 'Моля, изберете офис на Спиди от картата.');
  assert.equal(core.validateSelection({ type: 'speedy_office', office: null, fallback: true, city: '', officeText: 'x' }), 'Моля, въведете населено място.');
  assert.equal(core.validateSelection({ type: 'econt_office', office: null, fallback: true, city: 'Русе', officeText: '' }), 'Моля, въведете име или адрес на офиса.');
  assert.equal(core.validateSelection({ type: 'speedy_address', city: 'Русе', street: '' }), 'Моля, въведете адрес за доставка.');
  assert.equal(core.validateSelection({ type: 'econt_office', office: econt }), '');
});

test('pickOptionIndex finds ConvertBuilder shipping methods by label', () => {
  const labels = ['До офис ECONT 4.07€ (7.96 лв)', 'До офис speedy 4.07€ (7.96 лв)', 'До адрес speedy 4.04€ (7.90 лв)'];
  assert.equal(core.pickOptionIndex(labels, 'econt_office'), 0);
  assert.equal(core.pickOptionIndex(labels, 'speedy_office'), 1);
  assert.equal(core.pickOptionIndex(labels, 'speedy_address'), 2);
  assert.equal(core.pickOptionIndex(labels.slice(0, 1), 'speedy_address'), -1);
  assert.equal(core.pickOptionIndex(labels, ''), -1);
});

test('parseSpeedyMessage trusts only the Speedy map', () => {
  const data = { id: 79, name: 'ПЛОВДИВ - ОФИС', type: 'OFFICE', address: { fullAddressString: 'ул. Константин Стоилов 19', siteName: 'ПЛОВДИВ', postCode: '4000' } };
  assert.equal(core.parseSpeedyMessage('https://evil.example', data), null);
  assert.deepEqual(plain(core.parseSpeedyMessage('https://services.speedy.bg', data)),
    { id: 'speedy:79', code: '79', name: 'ПЛОВДИВ - ОФИС', address: 'ул. Константин Стоилов 19', city: 'ПЛОВДИВ', postCode: '4000', isAutomat: false });
  assert.equal(plain(core.parseSpeedyMessage('https://services.speedy.bg', JSON.stringify({ ...data, type: 'APT' }))).isAutomat, true);
  assert.equal(core.parseSpeedyMessage('https://services.speedy.bg', { id: 'abc' }), null);
  assert.equal(core.parseSpeedyMessage('https://services.speedy.bg', 'abc'), null);
  assert.equal(core.parseSpeedyMessage('https://services.speedy.bg', 'not json'), null);
});

test('parseSpeedyMessage accepts a bare numeric office id from the Speedy origin', () => {
  const bare = { id: 'speedy:79', code: '79', name: '', address: '', city: '', postCode: '', isAutomat: false };
  assert.deepEqual(plain(core.parseSpeedyMessage('https://services.speedy.bg', 79)), bare);
  assert.deepEqual(plain(core.parseSpeedyMessage('https://services.speedy.bg', '79')), bare);
  assert.equal(core.parseSpeedyMessage('https://evil.example', 79), null);
  assert.equal(core.parseSpeedyMessage('https://services.speedy.bg', 'abc'), null);
});

test('formatSelection formats a nameless Speedy office', () => {
  const nameless = { id: 'speedy:79', code: '79', name: '', address: '', city: '', postCode: '', isAutomat: false };
  assert.deepEqual(plain(core.formatSelection({ type: 'speedy_office', office: nameless })),
    { address: 'СПИДИ – офис №79', city: '', zip: '', officeId: 'speedy:79' });
});

test('buildOrderPayload prefers the accepted CB order and falls back to the form', () => {
  const detail = {
    id: 'CB-77', total: 22.57, currency: 'EUR',
    order: { customerName: 'Мария', customerEmail: 'm@x.bg', paymentType: 'cod', shippingAddress: { phone: '+359888123456' },
      items: [{ productId: 'p1', title: 'Да се заобичаме с думи', quantity: 1, price: 18.5 }] },
  };
  const fields = { name: 'Форма', email: 'f@x.bg', phone: '0899', address: '', city: '', zip: '' };
  assert.deepEqual(plain(core.buildOrderPayload(detail, { type: 'econt_office', office: econt }, fields, 'https://x/checkout')), {
    token: core.TOKEN, cb_order_id: 'CB-77', name: 'Мария', email: 'm@x.bg', phone: '+359888123456',
    delivery_type: 'econt_office', office_id: 'econt:2', office_text: 'ЕКОНТ – автомат Тракия (2), бул. Освобождение 31',
    city: 'Пловдив', post_code: '4000', address_text: '', items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }],
    total: 22.57, currency: 'EUR', payment_method: 'cod', page_url: 'https://x/checkout',
  });
  const p = plain(core.buildOrderPayload({ id: 'CB-78', order: {} }, { type: 'speedy_address', city: 'Варна', street: 'ул. Роза 5' }, fields, 'u'));
  assert.equal(p.name, 'Форма');
  assert.equal(p.phone, '0899');
  assert.equal(p.address_text, 'ул. Роза 5');
  assert.deepEqual(p.items, []);
});

test('buildOrderPayload tolerates missing fields', () => {
  let p;
  assert.doesNotThrow(() => { p = plain(core.buildOrderPayload({ id: 'X', order: {} }, { type: '' }, null, 'u')); });
  assert.equal(p.cb_order_id, 'X');
});

test('buildOrderPayload falls back to detail.items with alternate keys', () => {
  const p = plain(core.buildOrderPayload({ id: 'Y', items: [{ id: 'p9', quantity: 2, item_price: 9 }], order: {} }, { type: '' }, {}, 'u'));
  assert.deepEqual(p.items, [{ name: 'p9', qty: 2, price: 9 }]);
});
