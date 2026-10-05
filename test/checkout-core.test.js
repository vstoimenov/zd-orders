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

test('searchOffices lists offices in the searched city before other places that mention it', () => {
  const list = [
    { id: 'speedy:263', code: '263', name: 'БЯЛА (ВАРНА)', city: 'Бяла (Варна)', address: '', isAutomat: false },
    { id: 'speedy:1', code: '1', name: 'ВАРНА - 3-ТИ МАРТ (АВТОМАТ)', city: 'Варна', address: '', isAutomat: true },
    { id: 'speedy:2', code: '2', name: 'ВАРНА - ЦЕНТЪР', city: 'Варна', address: '', isAutomat: false },
  ];
  assert.deepEqual(plain(core.searchOffices(list, 'варна')).map((o) => o.id), ['speedy:1', 'speedy:2', 'speedy:263']);
  assert.deepEqual(plain(core.searchOffices(list, 'варна', 2)).map((o) => o.id), ['speedy:1', 'speedy:2']);
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
  assert.equal(core.validateSelection({ type: 'speedy_office', office: null }), 'Моля, изберете офис или автомат на Спиди.');
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
  const cyr = ['Доставка до офис на Спиди $2.48', 'Доставка до офис на Еконт $3.55', 'Доставка до адрес със Спиди 5,10 лв.'];
  assert.equal(core.pickOptionIndex(cyr, 'econt_office'), 1);
  assert.equal(core.pickOptionIndex(cyr, 'speedy_office'), 0);
  assert.equal(core.pickOptionIndex(cyr, 'speedy_address'), 2);
});

test('optionPrice reads the price shown in a ConvertBuilder shipping label', () => {
  assert.equal(core.optionPrice('До офис ECONT 4.07€ (7.96 лв)'), '4.07 €');
  assert.equal(core.optionPrice('Доставка до офис на Спиди $2.48'), '$2.48');
  assert.equal(core.optionPrice('До адрес със Спиди 5,10 лв.'), '5.10 лв.');
  assert.equal(core.optionPrice('Безплатна доставка'), '');
});

test('formatSelection does not repeat "автомат" when the Speedy name already says it', () => {
  const apt = { id: 'speedy:9364', code: '9364', name: 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)', city: 'Стара Загора', postCode: '', address: '', isAutomat: true };
  assert.equal(plain(core.formatSelection({ type: 'speedy_office', office: apt })).address, 'СПИДИ – СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ) (9364)');
});

test('officeLabel shows the city only when the office name does not start with it', () => {
  assert.equal(core.officeLabel({ city: 'Пловдив', name: 'Тракия', isAutomat: true }), 'Пловдив – автомат Тракия');
  assert.equal(core.officeLabel({ city: 'Пловдив', name: 'Пловдив Център', isAutomat: false }), 'Пловдив Център');
  assert.equal(core.officeLabel({ city: 'Айтос', name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', isAutomat: false }), 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)');
  assert.equal(core.officeLabel({ city: 'Стара Загора', name: 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)', isAutomat: true }), 'СТАРА ЗАГОРА – СЛАВЯНСКА (УЛ.) (АВТОМАТ)');
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
