import { test } from 'node:test';
import assert from 'node:assert/strict';
import { econtCall, getProfile, buildLabel, createLabel, deleteLabels, shipmentStatuses, statusFromEcont, trackUrl } from '../lib/econt-api.js';

const creds = { username: 'iasp-dev', password: '1Asp-dev', demo: true };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
function recorder(answer) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return typeof answer === 'function' ? answer(calls.length) : answer; };
  return { calls, impl };
}

const order = {
  name: 'Мария Иванова', phone: '0888123456', courier: 'econt', deliveryType: 'econt_office', officeId: 'econt:1127',
  officeText: 'Офис София Младост', total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  items: [{ name: 'Книга', qty: 2, price: 20 }, { name: 'Стикери', qty: 1, price: 2.57 }],
};
const settings = {
  profileName: 'ЕТ Консулт', senderName: '', senderPhone: '0888888888', sender: { type: 'office', officeCode: '1107' },
  payer: 'receiver', weight: 1, description: '', review: false,
};

test('econtCall posts JSON with basic auth to the demo or live host', async () => {
  const r = recorder(reply(200, { ok: 1 }));
  assert.deepEqual(await econtCall(creds, 'Profile/ProfileService.getClientProfiles', {}, r.impl), { ok: 1 });
  assert.equal(r.calls[0].url, 'https://demo.econt.com/ee/services/Profile/ProfileService.getClientProfiles.json');
  assert.equal(r.calls[0].init.method, 'POST');
  assert.equal(r.calls[0].init.headers.Authorization, `Basic ${Buffer.from('iasp-dev:1Asp-dev').toString('base64')}`);
  await econtCall({ ...creds, demo: false }, 'X/Y.z', {}, r.impl);
  assert.equal(r.calls[1].url, 'https://ee.econt.com/services/X/Y.z.json');
});

test('Econt errors come back as one Bulgarian message from the nested errors', async () => {
  const bad = reply(517, { type: 'ExInvalidParam', message: ' ', innerErrors: [{ message: 'получател: ', innerErrors: [{ message: 'Необходим е телефон или e-mail адрес на клиента.' }] }] });
  await assert.rejects(econtCall(creds, 'A/B.c', {}, async () => bad), /Еконт: получател: Необходим е телефон или e-mail адрес на клиента\./);
  const auth = reply(517, { type: 'ExInvalidParam', message: 'Невалидно потребителско име и/или парола.', innerErrors: [] });
  await assert.rejects(econtCall(creds, 'A/B.c', {}, async () => auth), /Еконт: Невалидно потребителско име и\/или парола\./);
  await assert.rejects(econtCall(creds, 'A/B.c', {}, async () => { throw new TypeError('fetch failed'); }), /Няма връзка с Еконт/);
});

test('getProfile returns the client name, phones and readable addresses', async () => {
  const r = recorder(reply(200, { profiles: [{ client: { name: 'ЕТ Консулт', phones: ['359883525008'] }, addresses: [
    { id: 15979342, city: { name: 'София', postCode: '1000' }, quarter: 'жк Студентски град', street: 'ул. Проф. Александър Фол', num: '2', other: '' },
  ] }] }));
  const p = await getProfile(creds, r.impl);
  assert.equal(p.name, 'ЕТ Консулт');
  assert.deepEqual(p.phones, ['359883525008']);
  assert.deepEqual(p.addresses, [{
    id: '15979342', text: 'София 1000, жк Студентски град, ул. Проф. Александър Фол 2',
    address: { city: { country: { code3: 'BGR' }, name: 'София', postCode: '1000' }, quarter: 'жк Студентски град', street: 'ул. Проф. Александър Фол', num: '2', other: '' },
  }]);
});

test('buildLabel: office to office, receiver pays, COD = order total, description from the items', () => {
  const label = buildLabel(order, settings, {});
  assert.deepEqual(label, {
    senderClient: { name: 'ЕТ Консулт', phones: ['0888888888'] },
    senderOfficeCode: '1107',
    receiverClient: { name: 'Мария Иванова', phones: ['0888123456'] },
    receiverOfficeCode: '1127',
    packCount: 1, shipmentType: 'PACK', weight: 1,
    shipmentDescription: '2 × Книга, 1 × Стикери',
    services: { cdAmount: 22.57, cdType: 'get', cdCurrency: 'EUR' },
    paymentReceiverMethod: 'cash',
  });
});

test('buildLabel: sender address, sender pays, review, typed values win', () => {
  const address = { city: { country: { code3: 'BGR' }, name: 'София', postCode: '1000' }, street: 'бул. Гешов', num: '2' };
  const label = buildLabel(order, { ...settings, senderName: 'Моят магазин', sender: { type: 'address', address }, payer: 'sender', review: true, description: 'книги' },
    { weight: '2,5', packCount: 2, cod: '0', description: '' });
  assert.equal(label.senderClient.name, 'Моят магазин');
  assert.deepEqual(label.senderAddress, address);
  assert.equal(label.senderOfficeCode, undefined);
  assert.equal(label.paymentReceiverMethod, undefined);
  assert.equal(label.weight, 2.5);
  assert.equal(label.packCount, 2);
  assert.equal(label.shipmentDescription, 'книги');
  assert.deepEqual(label.services, { payAfterAccept: true }, 'no COD when 0');
});

test('buildLabel refuses what Econt would refuse, in Bulgarian', () => {
  assert.throws(() => buildLabel({ ...order, courier: 'speedy', officeId: 'speedy:5' }, settings, {}), /не е до офис на Еконт/);
  assert.throws(() => buildLabel(order, { ...settings, sender: null }, {}), /изберете откъде изпращате/i);
  assert.throws(() => buildLabel(order, { ...settings, senderPhone: '' }, {}), /телефон на подателя/);
  assert.throws(() => buildLabel({ ...order, phone: '' }, settings, {}), /телефон на получателя/);
  assert.throws(() => buildLabel(order, settings, { weight: '0' }), /Тегло/);
  assert.throws(() => buildLabel(order, settings, { weight: '80' }), /Тегло/);
  assert.throws(() => buildLabel(order, settings, { cod: '-1' }), /Наложен платеж/);
  assert.throws(() => buildLabel(order, settings, { packCount: 0 }), /Брой пакети/);
});

test('createLabel calculates or creates and returns the waybill', async () => {
  const r = recorder(reply(200, { label: { shipmentNumber: '1051604331075', totalPrice: 3.78, currency: 'EUR', receiverDueAmount: 3.78, senderDueAmount: 0, pdfURL: 'http://demo/x.pdf' } }));
  const w = await createLabel(creds, { a: 1 }, 'create', r.impl);
  assert.deepEqual(r.calls[0].body, { label: { a: 1 }, mode: 'create' });
  assert.match(r.calls[0].url, /Shipments\/LabelService\.createLabel\.json$/);
  assert.deepEqual(w, { number: '1051604331075', price: 3.78, currency: 'EUR', receiverDue: 3.78, senderDue: 0, pdf: 'http://demo/x.pdf' });
  await assert.rejects(createLabel(creds, {}, 'create', async () => reply(200, { label: { totalPrice: 1 } })), /не върна номер/);
  await assert.rejects(createLabel(creds, {}, 'delete', r.impl), /mode/);
});

test('deleteLabels fails with Econt\'s reason for that waybill', async () => {
  const ok = recorder(reply(200, { results: [{ shipmentNum: '1', error: null }] }));
  await deleteLabels(creds, ['1'], ok.impl);
  assert.deepEqual(ok.calls[0].body, { shipmentNumbers: ['1'] });
  await assert.rejects(deleteLabels(creds, ['1'], async () => reply(200, { results: [{ shipmentNum: '1', error: { message: 'Пратката е изпратена' } }] })), /Пратката е изпратена/);
});

test('statusFromEcont: returned beats delivered, receipts are ignored', () => {
  assert.equal(statusFromEcont({ deliveryTime: null, trackingEvents: [] }), null);
  assert.equal(statusFromEcont({ deliveryTime: 1791493200000, trackingEvents: [] }), 'delivered');
  assert.equal(statusFromEcont({ deliveryTime: null, trackingEvents: [{ destinationType: 'client' }] }), 'delivered');
  assert.equal(statusFromEcont({ deliveryTime: 1, trackingEvents: [{ destinationType: 'returned_to_sender' }] }), 'returned');
  assert.equal(statusFromEcont({ deliveryTime: null, trackingEvents: [{ destinationType: 'is_returning_to_sender' }] }), 'returned');
  assert.equal(statusFromEcont({ deliveryTime: 1, trackingEvents: [{ destinationType: 'return', isReceipt: true }] }), 'delivered', 'return receipt (обратна разписка) is not a returned parcel');
});

test('shipmentStatuses maps each number to our status and Econt\'s text', async () => {
  const r = recorder(reply(200, { shipmentStatuses: [
    { status: { shipmentNumber: '1', deliveryTime: 5, trackingEvents: [], shortDeliveryStatus: 'Доставена' }, error: null },
    { status: { shipmentNumber: '2', deliveryTime: null, trackingEvents: [], shortDeliveryStatus: 'Приета в офис' }, error: null },
    { status: null, error: { message: 'няма такава' } },
  ] }));
  assert.deepEqual(await shipmentStatuses(creds, ['1', '2', '3'], r.impl), [
    { number: '1', status: 'delivered', text: 'Доставена' },
    { number: '2', status: null, text: 'Приета в офис' },
  ]);
  assert.match(r.calls[0].url, /ShipmentService\.getShipmentStatuses\.json$/);
});

test('trackUrl points to Econt\'s tracking page', () => {
  assert.equal(trackUrl('1051604331075'), 'https://www.econt.com/services/track-shipment/1051604331075');
});
