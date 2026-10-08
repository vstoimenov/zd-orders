import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speedyCall, getProfile, buildShipment, calculateShipment, createShipment, cancelShipment, printWaybill, shipmentStatuses, statusFromSpeedy, trackUrl,
} from '../lib/speedy-api.js';

const creds = { username: '999111', password: 'secret' };
const reply = (status, body) => ({ ok: status < 300, status, headers: new Map([['content-type', 'application/json']]), json: async () => body });
function recorder(answer) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return typeof answer === 'function' ? answer(calls.at(-1)) : answer; };
  return { calls, impl };
}

const officeOrder = {
  name: 'Мария Иванова', phone: '0888 123-456', courier: 'speedy', deliveryType: 'speedy_office', officeId: 'speedy:66',
  officeText: 'СПИДИ – офис Плевен', city: 'Плевен', postCode: '5800', addressText: '', total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  cbOrderId: 'adhdbg.eu:82', items: [{ name: 'Книга', qty: 2, price: 20 }],
};
const addressOrder = { ...officeOrder, deliveryType: 'speedy_address', officeId: '', officeText: 'СПИДИ – адрес: ул. Роза 5', city: 'Варна', postCode: '9000', addressText: 'ул. Роза 5, ет. 2' };
const settings = {
  clientId: 77001, clientCompany: false, sender: { type: 'office', officeId: 12, text: 'София Център' }, senderPhone: '0888888888', senderContact: '',
  payer: 'receiver', weight: 1, description: '', review: '', serviceId: 505,
};

test('speedyCall posts JSON with the login in the body to api.speedy.bg', async () => {
  const r = recorder(reply(200, { clientId: 1 }));
  assert.deepEqual(await speedyCall(creds, 'client', { a: 1 }, r.impl), { clientId: 1 });
  assert.equal(r.calls[0].url, 'https://api.speedy.bg/v1/client');
  assert.equal(r.calls[0].init.method, 'POST');
  assert.deepEqual(r.calls[0].body, { userName: '999111', password: 'secret', language: 'BG', a: 1 });
});

test('Speedy errors: a clear refusal vs. an unclear answer', async () => {
  const refused = await speedyCall(creds, 'x', {}, async () => reply(200, { error: { message: 'Невалиден офис', code: 180, component: '$.recipient.pickupOfficeId' } })).catch((e) => e);
  assert.match(refused.message, /^Спиди: Невалиден офис/);
  assert.equal(refused.rejected, true);
  const login = await speedyCall(creds, 'x', {}, async () => reply(200, { error: { message: 'bg.error.invalid.credentials (EE1)', code: 1 } })).catch((e) => e);
  assert.match(login.message, /потребител или парола/);
  assert.equal(login.rejected, true);
  const lost = await speedyCall(creds, 'x', {}, async () => { throw new TypeError('fetch failed'); }).catch((e) => e);
  assert.match(lost.message, /Няма връзка със Спиди/);
  assert.equal(lost.rejected, false);
  const server = await speedyCall(creds, 'x', {}, async () => reply(502, {})).catch((e) => e);
  assert.equal(server.rejected, false);
  const odd = await speedyCall(creds, 'x', {}, async () => ({ ok: true, status: 200, headers: new Map(), json: async () => { throw new SyntaxError('x'); } })).catch((e) => e);
  assert.equal(odd.rejected, false);
});

test('getProfile lists the contract clients (senders) and the parcel services', async () => {
  const r = recorder((c) => (c.url.endsWith('/client/contract')
    ? reply(200, { clients: [{ clientId: 77001, clientName: 'ЕТ Книги', objectName: 'Склад', privatePerson: false, address: { fullAddressString: 'гр. София, ул. Пиротска 5' } }] })
    : reply(200, { services: [{ id: 505, name: 'СТАНДАРТ 24 ЧАСА', cargoType: 'PARCEL' }, { id: 412, name: 'ПАЛЕТНА УСЛУГА', cargoType: 'PALLET' }] })));
  assert.deepEqual(await getProfile(creds, r.impl), {
    clients: [{ id: 77001, name: 'ЕТ Книги', company: true, text: 'ЕТ Книги · Склад · гр. София, ул. Пиротска 5' }],
    services: [{ id: 505, name: 'СТАНДАРТ 24 ЧАСА' }],
  });
});

test('buildShipment: to an office, COD = total, receiver pays, phone cleaned, reference = order number', () => {
  assert.deepEqual(buildShipment(officeOrder, settings, {}), {
    sender: { clientId: 77001, phone1: { number: '0888888888' }, dropoffOfficeId: 12 },
    recipient: { clientName: 'Мария Иванова', privatePerson: true, phone1: { number: '0888123456' }, pickupOfficeId: 66 },
    service: { serviceId: 505, autoAdjustPickupDate: true, additionalServices: { cod: { amount: 22.57, currencyCode: 'EUR', processingType: 'CASH' } } },
    content: { parcelsCount: 1, totalWeight: 1, contents: '2 × Книга', package: 'BOX' },
    payment: { courierServicePayer: 'RECIPIENT' },
    ref1: 'adhdbg.eu:82',
  });
});

test('buildShipment: to an address, pickup from the contract address, sender pays, review, company contact', () => {
  const s = buildShipment(addressOrder, { ...settings, clientCompany: true, senderContact: 'Иван Петров', sender: { type: 'client', text: 'Склад' }, payer: 'sender', review: 'TEST' },
    { weight: '2,5', packCount: 2, cod: '0', description: 'книги' });
  assert.deepEqual(s.sender, { clientId: 77001, phone1: { number: '0888888888' }, contactName: 'Иван Петров' });
  assert.deepEqual(s.recipient.address, { countryId: 100, siteName: 'Варна', postCode: '9000', addressNote: 'ул. Роза 5, ет. 2' });
  assert.equal(s.recipient.pickupOfficeId, undefined);
  assert.deepEqual(s.service.additionalServices, { obpd: { option: 'TEST', returnShipmentServiceId: 505, returnShipmentPayer: 'SENDER' } });
  assert.deepEqual(s.content, { parcelsCount: 2, totalWeight: 2.5, contents: 'книги', package: 'BOX' });
  assert.deepEqual(s.payment, { courierServicePayer: 'SENDER' });
});

test('buildShipment refuses what Speedy would refuse, in Bulgarian', () => {
  assert.throws(() => buildShipment({ ...officeOrder, courier: 'econt' }, settings, {}), /не е със Спиди/);
  assert.throws(() => buildShipment({ ...officeOrder, officeId: '' }, settings, {}), /офис/);
  assert.throws(() => buildShipment({ ...addressOrder, addressText: '' }, settings, {}), /адрес/);
  assert.throws(() => buildShipment({ ...officeOrder, name: 'М' }, settings, {}), /поне 3 знака/);
  assert.throws(() => buildShipment(officeOrder, { ...settings, clientCompany: true, senderContact: '' }, {}), /лице за контакт/);
  assert.throws(() => buildShipment(officeOrder, { ...settings, senderPhone: '' }, {}), /телефон на подателя/);
  assert.throws(() => buildShipment(officeOrder, { ...settings, clientId: null }, {}), /настройките на Спиди/);
  assert.throws(() => buildShipment(officeOrder, settings, { weight: '0' }), /Тегло/);
  assert.throws(() => buildShipment(officeOrder, settings, { cod: '-5' }), /Наложен платеж/);
});

test('calculateShipment asks /calculate for the same route and returns the total with VAT', async () => {
  const r = recorder(reply(200, { calculations: [{ serviceId: 505, price: { amount: 5, vat: 1, total: 6, currency: 'EUR' } }] }));
  const p = await calculateShipment(creds, buildShipment(officeOrder, settings, {}), r.impl);
  assert.deepEqual(p, { price: 6, currency: 'EUR', payer: 'RECIPIENT' });
  const body = r.calls[0].body;
  assert.match(r.calls[0].url, /\/v1\/calculate$/);
  assert.deepEqual(body.sender, { clientId: 77001, dropoffOfficeId: 12 });
  assert.deepEqual(body.recipient, { privatePerson: true, pickupOfficeId: 66 });
  assert.deepEqual(body.service.serviceIds, [505]);
  assert.deepEqual(body.content, { parcelsCount: 1, totalWeight: 1 });
  const addr = recorder(reply(200, { calculations: [{ serviceId: 505, price: { total: 7, currency: 'EUR' } }] }));
  await calculateShipment(creds, buildShipment(addressOrder, settings, {}), addr.impl);
  assert.deepEqual(addr.calls[0].body.recipient, { privatePerson: true, addressLocation: { countryId: 100, siteName: 'Варна', postCode: '9000' } });
  await assert.rejects(calculateShipment(creds, {}, async () => reply(200, { calculations: [{ error: { message: 'Услугата не е позволена' } }] })), /Услугата не е позволена/);
});

test('createShipment returns the number; no number is an unclear answer', async () => {
  const r = recorder(reply(200, { id: '61234567890', parcels: [{ seqNo: 1, id: '61234567890' }], price: { total: 6.1, currency: 'EUR' } }));
  assert.deepEqual(await createShipment(creds, { a: 1 }, r.impl), { number: '61234567890', price: 6.1, currency: 'EUR', pdf: null });
  assert.match(r.calls[0].url, /\/v1\/shipment$/);
  assert.equal(r.calls[0].body.a, 1);
  const none = await createShipment(creds, {}, async () => reply(200, {})).catch((e) => e);
  assert.equal(none.rejected, false);
});

test('cancelShipment sends a comment and fails with Speedy\'s reason', async () => {
  const r = recorder(reply(200, {}));
  await cancelShipment(creds, '61234567890', r.impl);
  assert.match(r.calls[0].url, /\/v1\/shipment\/cancel$/);
  assert.equal(r.calls[0].body.shipmentId, '61234567890');
  assert.ok(r.calls[0].body.comment);
  await assert.rejects(cancelShipment(creds, '1', async () => reply(200, { error: { message: 'Пратката е взета от куриер' } })), /взета от куриер/);
});

test('printWaybill returns the PDF bytes, or Speedy\'s error', async () => {
  const pdf = Buffer.from('%PDF-1.4 x');
  const r = recorder({ ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length) });
  const out = await printWaybill(creds, '61234567890', 'A6', r.impl);
  assert.equal(out.toString(), '%PDF-1.4 x');
  assert.deepEqual(r.calls[0].body.parcels, [{ parcel: { id: '61234567890' } }]);
  assert.equal(r.calls[0].body.paperSize, 'A6');
  await assert.rejects(printWaybill(creds, '1', 'A4', async () => reply(200, { error: { message: 'Няма достъп' } })), /Няма достъп/);
});

test('statusFromSpeedy: returned beats delivered', () => {
  assert.equal(statusFromSpeedy([{ operationCode: 1 }, { operationCode: 12 }]), null);
  assert.equal(statusFromSpeedy([{ operationCode: 12 }, { operationCode: -14 }]), 'delivered');
  assert.equal(statusFromSpeedy([{ operationCode: 123 }]), 'returned');
  assert.equal(statusFromSpeedy([{ operationCode: -14 }, { operationCode: 124 }]), 'returned');
});

test('shipmentStatuses tracks 10 at a time and keeps the last description', async () => {
  const numbers = Array.from({ length: 12 }, (_, i) => String(100 + i));
  const r = recorder((c) => reply(200, { parcels: c.body.parcels.map((p) => ({ parcelId: p.id, operations: [{ operationCode: 1, description: 'Пристигане' }, { operationCode: p.id === '100' ? -14 : 12, description: p.id === '100' ? 'Доставена' : 'За доставка' }] })) }));
  const out = await shipmentStatuses(creds, numbers, r.impl);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].body.parcels.length, 10);
  assert.deepEqual(out[0], { number: '100', status: 'delivered', text: 'Доставена' });
  assert.deepEqual(out[1], { number: '101', status: null, text: 'За доставка' });
  assert.equal(out.length, 12);
});

test('trackUrl points to Speedy\'s tracking page', () => {
  assert.equal(trackUrl('61234567890'), 'https://www.speedy.bg/bg/track-shipment?shipmentNumber=61234567890');
});
