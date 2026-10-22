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

test('buildLabel: Econt to an address — the receiver address replaces the office', () => {
  const label = buildLabel({ ...order, deliveryType: 'econt_address', officeId: '', officeText: '', city: 'Варна', postCode: '9000', addressText: 'ул. Тайна 5, ап. 3' }, settings, {});
  assert.equal(label.receiverOfficeCode, undefined);
  assert.deepEqual(label.receiverAddress, { city: { country: { code3: 'BGR' }, name: 'Варна', postCode: '9000' }, other: 'ул. Тайна 5, ап. 3' });
  assert.throws(() => buildLabel({ ...order, deliveryType: 'econt_address', officeId: '', city: '', addressText: 'ул. Х' }, settings, {}), /адрес/);
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
  const r = recorder(reply(200, { label: { shipmentNumber: '1051604331075', totalPrice: 3.78, currency: 'EUR', receiverDueAmount: 3.78, senderDueAmount: 0, pdfURL: 'http://demo.econt.com/x.pdf' } }));
  const w = await createLabel(creds, { a: 1 }, 'create', r.impl);
  assert.deepEqual(r.calls[0].body, { label: { a: 1 }, mode: 'create' });
  assert.match(r.calls[0].url, /Shipments\/LabelService\.createLabel\.json$/);
  assert.deepEqual(w, { number: '1051604331075', price: 3.78, currency: 'EUR', receiverDue: 3.78, senderDue: 0, pdf: 'http://demo.econt.com/x.pdf' });
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
    { number: '1', status: 'delivered', text: 'Доставена', atOffice: null },
    { number: '2', status: null, text: 'Приета в офис', atOffice: null },
  ]);
  assert.match(r.calls[0].url, /ShipmentService\.getShipmentStatuses\.json$/);
});

test('trackUrl points to Econt\'s tracking page', () => {
  assert.equal(trackUrl('1051604331075'), 'https://www.econt.com/services/track-shipment/1051604331075');
});

test('buildLabel: a company profile sends the authorised person (упълномощено лице) and requires one', () => {
  const company = { ...settings, profileCompany: true, senderAgent: 'Иван Кирязов' };
  assert.deepEqual(buildLabel(order, company, {}).senderAgent, { name: 'Иван Кирязов', phones: ['0888888888'] });
  assert.throws(() => buildLabel(order, { ...company, senderAgent: '' }, {}), /упълномощено лице/);
  assert.equal(buildLabel(order, settings, {}).senderAgent, undefined, 'a person sends without one');
});

test('getProfile tells whether the profile is a company', async () => {
  const r = recorder(reply(200, { profiles: [{ client: { name: 'ЕТ', phones: [], juridicalEntity: true }, addresses: [] }] }));
  assert.equal((await getProfile(creds, r.impl)).company, true);
});

test('only a clear Econt answer counts as a rejection: timeouts, lost connections and odd answers are unknown', async () => {
  const rejected = await econtCall(creds, 'A/B.c', {}, async () => reply(517, { message: 'Невалиден офис', innerErrors: [] })).catch((e) => e);
  assert.equal(rejected.rejected, true);
  const lost = await econtCall(creds, 'A/B.c', {}, async () => { throw new TypeError('fetch failed'); }).catch((e) => e);
  assert.equal(lost.rejected, false);
  const gateway = await econtCall(creds, 'A/B.c', {}, async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } })).catch((e) => e);
  assert.equal(gateway.rejected, false);
  const odd = await econtCall(creds, 'A/B.c', {}, async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })).catch((e) => e);
  assert.equal(odd.rejected, false, 'a 200 that is not JSON may still have created something');
  const noNumber = await createLabel(creds, {}, 'create', async () => reply(200, { label: { totalPrice: 1 } })).catch((e) => e);
  assert.equal(noNumber.rejected, false);
});

test('createLabel keeps the PDF only when it is an Econt address', async () => {
  const w = (pdfURL) => createLabel(creds, {}, 'create', async () => reply(200, { label: { shipmentNumber: '1', totalPrice: 1, pdfURL } }));
  assert.equal((await w('http://demo.econt.com/ee/api_export.php?x=1')).pdf, 'http://demo.econt.com/ee/api_export.php?x=1');
  assert.equal((await w('https://ee.econt.com/x.pdf')).pdf, 'https://ee.econt.com/x.pdf');
  assert.equal((await w('javascript:alert(1)')).pdf, null);
  assert.equal((await w('https://evil.com/econt.com')).pdf, null);
  assert.equal((await w('https://econt.com.evil.com/x')).pdf, null);
});

test('a server error from Econt is unclear even with a message (the waybill may exist); 517 is a clear refusal', async () => {
  const e500 = await econtCall(creds, 'A/B.c', {}, async () => reply(500, { message: 'Internal error' })).catch((e) => e);
  assert.equal(e500.rejected, false);
  const e517 = await econtCall(creds, 'A/B.c', {}, async () => reply(517, { message: 'Невалиден офис' })).catch((e) => e);
  assert.equal(e517.rejected, true);
});

/* ---- parcel waiting at the receiver's office ---- */
import { atOfficeFromEcont } from '../lib/econt-api.js';
test('atOfficeFromEcont: the first arrival at the receiver office, only while not delivered or returned', () => {
  const ev = (destinationType, officeCode, time) => ({ destinationType, officeCode, time });
  const base = { receiverOfficeCode: '5803', trackingEvents: [ev('courier', '1107', '2026-10-10T08:00:00+03:00'), ev('office', '1107', '2026-10-10T09:00:00+03:00'), ev('office', '5803', '2026-10-11T10:00:00+03:00'), ev('in_delivery_office', '5803', '2026-10-12T09:00:00+03:00')] };
  assert.equal(atOfficeFromEcont(base), new Date('2026-10-11T10:00:00+03:00').toISOString());
  assert.equal(atOfficeFromEcont({ ...base, deliveryTime: 5 }), null, 'collected');
  assert.equal(atOfficeFromEcont({ ...base, trackingEvents: [...base.trackingEvents, ev('return', '5803', '2026-10-18T09:00:00+03:00')] }), null, 'going back');
  assert.equal(atOfficeFromEcont({ receiverOfficeCode: '5803', trackingEvents: [ev('office', '1107', '2026-10-10T09:00:00+03:00')] }), null, 'only the sender office so far');
  assert.equal(atOfficeFromEcont({ receiverOfficeCode: '', trackingEvents: [ev('office', '1107', '2026-10-10T09:00:00+03:00')] }), null, 'address delivery');
  assert.equal(atOfficeFromEcont({ trackingEvents: [{ ...ev('office', '5803', '2026-10-11T10:00:00+03:00'), isReceipt: true }], receiverOfficeCode: '5803' }), null, 'return receipts do not count');
});

test('getProfile lists the e-Econt pay-out templates for cash on delivery; buildLabel sends the chosen one', async () => {
  const r = recorder(reply(200, { profiles: [{ client: { name: 'ЕТ Консулт', phones: ['359883525008'] }, addresses: [], cdPayOptions: [
    { num: 'CD41012', method: 'bank', IBAN: 'BG18RZBB91550123456789', bankCurrency: 'EUR' },
    { num: 'CD41027', method: 'office', officeCode: '1032' },
    { num: 'CD41025', method: 'address', address: { city: { name: 'Бургас' } } },
  ] }] }));
  const p = await getProfile(creds, r.impl);
  assert.deepEqual(p.payOptions, [
    { num: 'CD41012', text: 'По банка · IBAN …6789 (EUR)' },
    { num: 'CD41027', text: 'В брой в офис на Еконт 1032' },
    { num: 'CD41025', text: 'На адрес · Бургас' },
  ]);
  assert.deepEqual(buildLabel(order, { ...settings, cdPayOption: { num: 'CD41012' } }, {}).services.cdPayOptions, { num: 'CD41012' });
  assert.equal(buildLabel(order, { ...settings, cdPayOption: { num: 'CD41012' } }, { cod: '0' }).services?.cdPayOptions, undefined, 'no cash on delivery, nothing to pay out');
  assert.equal(buildLabel(order, settings, {}).services?.cdPayOptions, undefined, 'none chosen: e-Econt\'s default');
});
