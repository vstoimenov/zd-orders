import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/phone.js';
import { validateOrder } from '../lib/order.js';

test('normalizePhone handles Bulgarian formats', () => {
  assert.equal(normalizePhone('0888 123 456'), '+359888123456');
  assert.equal(normalizePhone('+359 888-123-456'), '+359888123456');
  assert.equal(normalizePhone('00359888123456'), '+359888123456');
  assert.equal(normalizePhone('888123456'), '+359888123456');
  assert.equal(normalizePhone('+359 0888 123 456'), '+359888123456');
  assert.equal(normalizePhone('00359 0888123456'), '+359888123456');
  assert.equal(normalizePhone('+359888123'), null);
  assert.equal(normalizePhone('02 987 6543'), '+35929876543');
  assert.equal(normalizePhone('+40 721 234 567'), '+40721234567');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

const base = {
  cb_order_id: 'A1', name: '  Мария  Иванова ', phone: '0888123456', email: 'm@x.bg',
  delivery_type: 'econt_office', office_id: 'econt:7538', office_text: 'ЕКОНТ – офис Айдемир (7538), ул. София 7',
  city: 'Айдемир', post_code: '7538', items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }],
  total: '22.57', currency: 'eur', payment_method: 'cod', page_url: 'https://x/checkout',
};

test('validateOrder normalizes a valid Econt order', () => {
  const r = validateOrder(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, {
    cbOrderId: 'A1', name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:7538',
    officeText: 'ЕКОНТ – офис Айдемир (7538), ул. София 7', city: 'Айдемир', postCode: '7538', addressText: '',
    items: [{ name: 'Да се заобичаме с думи', qty: 1, price: 18.5 }], total: 22.57, currency: 'EUR',
    paymentMethod: 'cod', pageUrl: 'https://x/checkout',
  });
});

test('validateOrder rejects bad input with a reason', () => {
  const bad = (patch) => validateOrder({ ...base, ...patch }).error;
  assert.equal(validateOrder(null).error, 'invalid body');
  assert.equal(bad({ cb_order_id: '' }), 'cb_order_id required');
  assert.equal(bad({ delivery_type: 'pigeon' }), 'invalid delivery_type');
  assert.equal(bad({ delivery_type: 'constructor' }), 'invalid delivery_type');
  assert.equal(bad({ delivery_type: 'toString' }), 'invalid delivery_type');
  assert.equal(bad({ delivery_type: '__proto__' }), 'invalid delivery_type');
  assert.equal(bad({ office_text: '' }), 'office required');
  assert.equal(bad({ delivery_type: 'speedy_address', address_text: '' }), 'address required');
  assert.equal(bad({ total: 'abc' }), 'invalid total');
  assert.equal(bad({ items: 'x' }), 'items required');
});

test('validateOrder accepts a Speedy address order and cleans items', () => {
  const r = validateOrder({ ...base, delivery_type: 'speedy_address', office_id: '', office_text: 'СПИДИ – адрес: ул. Роза 5',
    city: 'Варна', address_text: 'ул. Роза 5', items: [{ name: 'Тесте', qty: '2', price: '37' }, { name: '' }, null] });
  assert.equal(r.ok, true);
  assert.equal(r.order.courier, 'speedy');
  assert.deepEqual(r.order.items, [{ name: 'Тесте', qty: 2, price: 37 }]);
});

test('validateOrder accepts a missing name and an unrecognised phone (ConvertBuilder already took the order)', () => {
  const r = validateOrder({ ...base, name: '', phone: '123' });
  assert.equal(r.ok, true);
  assert.equal(r.order.name, '');
  assert.equal(r.order.phone, '123');
  assert.equal(r.order.phoneNorm, '');
});

test('validateOrder accepts an order to a BOX NOW locker; the locker is required', () => {
  const r = validateOrder({ ...base, delivery_type: 'boxnow_locker', office_id: 'boxnow:1840', office_text: 'BOX NOW – автомат New Avenue (1840), ул. Храбър Попов 14', city: 'София', post_code: '1700' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.order.deliveryType, r.order.courier, r.order.officeId], ['boxnow_locker', 'boxnow', 'boxnow:1840']);
  assert.deepEqual(validateOrder({ ...base, delivery_type: 'boxnow_locker', office_text: '' }), { ok: false, error: 'office required' });
});
