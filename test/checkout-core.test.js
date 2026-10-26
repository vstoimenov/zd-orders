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

test('visitPayload sends only page, query and referrer, trimmed', () => {
  const v = JSON.parse(core.visitPayload({ pathname: '/kniga', search: '?utm_source=facebook&fbclid=1' }, { referrer: 'https://l.facebook.com/' }));
  assert.deepEqual(v, { p: '/kniga', s: '?utm_source=facebook&fbclid=1', r: 'https://l.facebook.com/' });
  const long = JSON.parse(core.visitPayload({ pathname: '/' + 'x'.repeat(500), search: '' }, { referrer: '' }));
  assert.equal(long.p.length, 200);
});

test('a free shipping method shows as "Безплатна"', () => {
  assert.equal(core.optionPrice('Доставка до офис на Еконт €0.00'), 'Безплатна');
  assert.equal(core.optionPrice('Доставка до офис на Спиди 0,00 лв.'), 'Безплатна');
  assert.equal(core.optionPrice('Доставка до офис на Спиди €3.50'), '€3.50');
});

test('shippingView: only what ConvertBuilder offers; none at all = a clear message, not three made-up choices', () => {
  const v = plain(core.shippingView(['Доставка до офис на Спиди €2.48', 'Доставка до офис на Еконт €3.55']));
  assert.deepEqual(v, { mode: 'normal', available: { econt_office: true, econt_address: false, speedy_office: true, speedy_address: false, boxnow_locker: false } });
  assert.equal(plain(core.shippingView([])).mode, 'none');
  assert.deepEqual(plain(core.shippingView(['Куриер до врата €5.00'])), { mode: 'all', available: { econt_office: true, econt_address: false, speedy_office: true, speedy_address: true, boxnow_locker: false } }, 'unknown names: the classic choices, the shop prices them — BOX NOW only when the shop offers it');
});

const locker = { id: 'boxnow:1840', code: '1840', name: 'New Avenue, ул. Проф. Храбър Попов 14, София - 24/7', city: 'София', postCode: '1700', address: 'ул. Проф. арх. Храбър Попов №14', isAutomat: true };

test('BOX NOW: found by its ConvertBuilder method, shown next to Econt, written as a locker', () => {
  const labels = ['Доставка до офис на Еконт €3.55', 'Автомат BOX NOW 3,50 €'];
  assert.equal(core.pickOptionIndex(labels, 'boxnow_locker'), 1);
  assert.equal(core.pickOptionIndex(['До автомат на Бокс Нау 2.99€'], 'boxnow_locker'), 0);
  assert.equal(core.pickOptionIndex(['До офис ECONT 4.07€'], 'boxnow_locker'), -1);
  assert.deepEqual(plain(core.shippingView(labels)), { mode: 'normal', available: { econt_office: true, econt_address: false, speedy_office: false, speedy_address: false, boxnow_locker: false } }, 'not switched on in Ordyx');
  assert.deepEqual(plain(core.shippingView(labels, { boxnow: true })), { mode: 'normal', available: { econt_office: true, econt_address: false, speedy_office: false, speedy_address: false, boxnow_locker: true } });
  assert.equal(plain(core.shippingView(['Автомат BOX NOW 3,50 €'])).mode, 'none', 'only BOX NOW offered but not switched on: no made-up choices');
  assert.equal(plain(core.shippingView(['Автомат BOX NOW 3,50 €'], { boxnow: true })).mode, 'normal');
  assert.deepEqual(plain(core.shippingView(['Куриер до врата €5.00', 'Автомат BOX NOW 3,50 €'])), { mode: 'all', available: { econt_office: true, econt_address: false, speedy_office: true, speedy_address: true, boxnow_locker: false } }, 'an unknown method next to a switched-off BOX NOW: the classic choices as before');
  assert.deepEqual(plain(core.formatSelection({ type: 'boxnow_locker', office: locker })),
    { address: 'BOX NOW – автомат New Avenue, ул. Проф. Храбър Попов 14, София - 24/7 (1840), ул. Проф. арх. Храбър Попов №14', city: 'София', zip: '1700', officeId: 'boxnow:1840' });
  assert.deepEqual(plain(core.formatSelection({ type: 'boxnow_locker', office: null, fallback: true, city: 'Варна', officeText: 'до Лидл' })),
    { address: 'BOX NOW – автомат: до Лидл', city: 'Варна', zip: '', officeId: '' });
  assert.equal(core.validateSelection({ type: 'boxnow_locker', office: null }), 'Моля, изберете автомат на BOX NOW.');
  assert.equal(core.validateSelection({ type: 'boxnow_locker', office: locker }), '');
});

/* ---- abandoned carts: what the widget sends once a phone is typed ---- */
test('cartPayload maps a store cart', () => {
  const cart = core.cartFrom({ storeCart: { items: [{ title: 'Балсам', quantity: 2, price: 13.9 }], total: 27.8 }, currency: 'EUR' });
  const p = plain(core.cartPayload({ name: ' Мария ', email: 'm@x.bg', phone: '0888 123 456' }, cart, 'ЕКОНТ – офис Плевен', 'https://a-shop.bg/store/checkout'));
  assert.deepEqual(p, { e: 'cart', phone: '0888 123 456', name: 'Мария', email: 'm@x.bg', items: [{ name: 'Балсам', qty: 2, price: 13.9 }], total: 27.8, currency: 'EUR', delivery: 'ЕКОНТ – офис Плевен', page: 'https://a-shop.bg/store/checkout' });
});

test('cartFrom prefers the checkout event, then the store cart, then the analytics data layer', () => {
  const ev = { order: { items: [{ title: 'Книга', quantity: 1, price: 12.9 }], total: 15.38, currency: 'EUR' } };
  assert.deepEqual(plain(core.cartFrom({ eventOrder: ev, storeCart: { items: [{ title: 'Друго', quantity: 1, price: 1 }], total: 1 } })), { items: [{ name: 'Книга', qty: 1, price: 12.9 }], total: 15.38, currency: 'EUR' });
  const dl = [['event', 'begin_checkout', { currency: 'EUR', items: [{ name: 'Книга "ADHD"', price: 12.9, quantity: 1 }, { name: 'DR AMEN ', price: 0, quantity: 1 }] }]];
  assert.deepEqual(plain(core.cartFrom({ dataLayer: dl })), { items: [{ name: 'Книга "ADHD"', qty: 1, price: 12.9 }, { name: 'DR AMEN', qty: 1, price: 0 }], total: 12.9, currency: 'EUR' });
  assert.deepEqual(plain(core.cartFrom({})), { items: [], total: 0, currency: 'EUR' });
});

test('cartPayload is null without a valid phone', () => {
  const cart = core.cartFrom({});
  assert.equal(core.cartPayload({ name: 'Х', phone: '' }, cart, '', 'https://a-shop.bg/'), null);
  assert.equal(core.cartPayload({ name: 'Х', phone: '0888 12' }, cart, '', 'https://a-shop.bg/'), null);
  assert.ok(core.cartPayload({ name: 'Х', phone: '+359 888 123 456' }, cart, '', 'https://a-shop.bg/'));
  assert.ok(core.cartPayload({ name: 'Х', phone: '+44 7700 900123' }, cart, '', 'https://a-shop.bg/'));
  assert.ok(core.cartPayload({ name: 'Х', phone: '888 123 456' }, cart, '', 'https://a-shop.bg/'), 'the field after a +359 country picker');
});

test('cartPayload trims to 50 items', () => {
  const items = Array.from({ length: 80 }, (_, i) => ({ title: 'П' + i, quantity: 1, price: 1 }));
  const p = core.cartPayload({ phone: '0888123456' }, core.cartFrom({ storeCart: { items, total: 80 } }), '', 'https://a-shop.bg/');
  assert.equal(p.items.length, 50);
});

/* ---- „Намери ме“: distance in the browser, nearest points, opening hours ---- */
const SOFIA = { lat: 42.6977, lng: 23.3219 }, PLOVDIV = { lat: 42.1354, lng: 24.7453 };

test('distanceM is the straight line in metres; distanceText rounds the way a person reads it', () => {
  const d = core.distanceM(SOFIA, PLOVDIV);
  assert.ok(d > 130000 && d < 134000, `Sofia–Plovdiv ≈ 132 km, got ${d}`);
  assert.equal(core.distanceText(650), '650 m');
  assert.equal(core.distanceText(1234), '1,2 km');
  assert.equal(core.distanceText(40), '50 m');
  assert.equal(core.distanceText(12345), '12,3 km');
  assert.equal(core.distanceText(null), '');
});

test('nearestOffices sorts by distance, leaves out points without coordinates and respects the limit', () => {
  const list = [
    { id: 'a', lat: 42.14, lng: 24.75 },           // Plovdiv
    { id: 'none' },                                 // no coordinates
    { id: 'b', lat: 42.70, lng: 23.33 },           // Sofia centre
    { id: 'c', lat: 42.65, lng: 23.38 },           // Sofia south
    { id: 'zero', lat: null, lng: null },
  ];
  assert.deepEqual(plain(core.nearestOffices(list, SOFIA, 10)).map((o) => o.id), ['b', 'c', 'a'], 'a point without coordinates is never "nearest"');
  assert.deepEqual(plain(core.nearestOffices([{ id: 'none' }, { id: 'zero', lat: null, lng: null }], SOFIA, 8)), [], 'nothing located yet (e.g. before the first refresh): an empty list, not the alphabet');
  assert.deepEqual(plain(core.nearestOffices(list, SOFIA, 2)).map((o) => o.id), ['b', 'c']);
  assert.ok(core.nearestOffices(list, SOFIA, 2)[0]._dist < 1000, 'distance kept on the point for the list');
  assert.deepEqual(plain(core.nearestOffices(list, null, 3)), [], 'no location: nothing to sort by');
});

test('the hours line and the address never leak into what ConvertBuilder stores', () => {
  const o = { ...econt, hours: 'пн–пт 09:00–18:00 · сб 09:00–15:00' };
  assert.equal(core.hoursLine(o), 'пн–пт 09:00–18:00 · сб 09:00–15:00');
  assert.equal(core.hoursLine({ ...econt, hours: '24/7' }), 'денонощно (24/7)');
  assert.equal(core.hoursLine({ ...econt }), '');
  assert.equal(plain(core.formatSelection({ type: 'econt_office', office: o })).address, 'ЕКОНТ – автомат Тракия (2), бул. Освобождение 31');
  assert.equal(core.officeLabel(o), 'Пловдив – автомат Тракия');
});

/* ---- the map: loaded only on tap, free tiles, markers limited to the view ---- */
test('the map library and style are pinned (no keys, no Google)', () => {
  assert.equal(core.MAP_SCRIPT, 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.js');
  assert.equal(core.MAP_CSS, 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.css');
  assert.equal(core.MAP_STYLE, 'https://tiles.openfreemap.org/styles/liberty');
});

test('markerPoints keeps the points inside the view, nearest to its centre first, capped, without coordinate-less points', () => {
  const sofia = { south: 42.60, west: 23.20, north: 42.80, east: 23.45 };
  const pts = [
    { id: 'far', lat: 42.14, lng: 24.75 },
    { id: 'edge', lat: 42.79, lng: 23.44 },
    { id: 'centre', lat: 42.70, lng: 23.32 },
    { id: 'none' },
    { id: 'null', lat: null, lng: null },
  ];
  assert.deepEqual(plain(core.markerPoints(pts, sofia, 400)).map((o) => o.id), ['centre', 'edge']);
  assert.deepEqual(plain(core.markerPoints(pts, sofia, 1)).map((o) => o.id), ['centre']);
  const many = Array.from({ length: 500 }, (_, i) => ({ id: String(i), lat: 42.65 + (i % 50) * 0.002, lng: 23.25 + Math.floor(i / 50) * 0.01 }));
  assert.equal(core.markerPoints(many, sofia, 400).length, 400);
  assert.deepEqual(plain(core.markerPoints([{ id: 'nan', lat: NaN, lng: NaN }, { id: 'ok', lat: 42.7, lng: 23.3 }], sofia, 10)).map((o) => o.id), ['ok'], 'NaN never reaches the map');
});

/* ---- courier logos and the delivery-time line ---- */
test('each option shows its courier logo from our own domain and the shop\'s delivery-time line', () => {
  assert.equal(core.logoFor('https://kurier.profitbrand.online', 'econt_office'), 'https://kurier.profitbrand.online/logos/econt.svg');
  assert.equal(core.logoFor('https://x', 'speedy_address'), 'https://x/logos/speedy.svg');
  assert.equal(core.logoFor('https://x', 'boxnow_locker'), 'https://x/logos/boxnow.svg');
  const info = { boxnow: true, eta: { econt: '1–2 работни дни', speedy: '', boxnow: 'до 24 часа' } };
  assert.equal(core.etaFor(info, 'econt_office'), '1–2 работни дни');
  assert.equal(core.etaFor(info, 'speedy_office'), '', 'the shop switched the line off for Speedy');
  assert.equal(core.etaFor(info, 'speedy_address'), '');
  assert.equal(core.etaFor(info, 'boxnow_locker'), 'до 24 часа');
  assert.equal(core.etaFor(null, 'econt_office'), '', 'nothing before the shop info arrived');
});

test('buildOrderPayload sends invoice details only when the buyer asked for an invoice', () => {
  const detail = { id: '9', total: 10, order: { items: [{ name: 'К', quantity: 1, price: 10 }] } };
  const sel = { type: 'econt_office', office: OFFICES[0] };
  assert.equal(plain(core.buildOrderPayload(detail, sel, {}, '')).invoice, undefined);
  assert.deepEqual(plain(core.buildOrderPayload(detail, sel, { invoice: { company: 'Ф ООД', eik: '206123456' } }, '')).invoice, { company: 'Ф ООД', eik: '206123456' });
});

test('visiblePart: with two checkout copies on the page (the first hidden by ConvertBuilder), the widget goes into the one the customer sees', () => {
  const node = (cls = '', parent = null, display = '') => ({ parentElement: parent, classList: { contains: (c) => cls.split(' ').includes(c) }, style: { display } });
  const page = node();
  const hiddenInfo = node('col12 checkout-info none', page), shownInfo = node('col12 checkout-info', page);
  const hiddenPart = node('', node('col20', hiddenInfo)), shownPart = node('', node('col20', shownInfo));
  assert.equal(core.visiblePart([hiddenPart, shownPart]), shownPart);
  assert.equal(core.visiblePart([node('', node('', page, 'none')), shownPart]), shownPart, 'an inline display:none hides it too');
  assert.equal(core.visiblePart([hiddenPart]), hiddenPart, 'a single copy is the checkout, shown or not (tiarra: hidden until the cart has items)');
  assert.equal(core.visiblePart([hiddenPart, node('', node('x none', page))]), null, 'several, none shown yet: wait');
  assert.equal(core.visiblePart([]), null);
});

test('ConvertBuilder method names in either word order: „ЕКОНТ Офис“ is the Econt office, „ЕКОНТ до адрес“ an Econt address (dokatospish)', () => {
  const labels = ['ЕКОНТ Офис €3.50', 'ЕКОНТ до адрес €4.50'];
  assert.equal(core.pickOptionIndex(labels, 'econt_office'), 0);
  assert.equal(core.pickOptionIndex(labels, 'econt_address'), 1);
  assert.equal(core.pickOptionIndex(labels, 'speedy_office'), -1);
  assert.equal(core.pickOptionIndex(['Спиди офис'], 'speedy_office'), 0);
  assert.equal(core.pickOptionIndex(['Speedy до адрес'], 'speedy_address'), 0);
  assert.equal(core.pickOptionIndex(['До адрес със Спиди'], 'econt_address'), -1);
  assert.deepEqual(plain(core.shippingView(labels)), { mode: 'normal', available: { econt_office: true, econt_address: true, speedy_office: false, speedy_address: false, boxnow_locker: false } });
});

test('an Econt address is written like a Speedy one and sent with the street', () => {
  const sel = { type: 'econt_address', city: 'Плевен', postCode: '5800', street: 'ул. Х 1' };
  assert.deepEqual(plain(core.formatSelection(sel)), { address: 'ЕКОНТ – адрес: ул. Х 1', city: 'Плевен', zip: '5800', officeId: '' });
  assert.match(core.validateSelection({ type: 'econt_address', city: 'Плевен', street: '' }), /адрес/);
  assert.equal(core.validateSelection(sel), '');
  const p = plain(core.buildOrderPayload({ id: '1', order: { items: [] } }, sel, {}));
  assert.equal(p.delivery_type, 'econt_address'); assert.equal(p.address_text, 'ул. Х 1'); assert.equal(p.office_text, 'ЕКОНТ – адрес: ул. Х 1');
});

test('our inputs never float: a ConvertBuilder theme that floats every input would collapse the address panel (dokatospish)', () => {
  assert.match(src, /\.zdo-input\{[^}]*float:none!important/);
});

test('„Намери ме“ / „Виж на картата“ grow with their text instead of spilling out on a narrow form', () => {
  assert.match(src, /\.zdo-tool\{[^}]*min-height:40px/);
  assert.doesNotMatch(src, /\.zdo-tool\{[^}]*[^-]height:40px/);
});
