// Speedy Web API with the shop's own contract (API user/password from Speedy): profile, price, waybills, print, tracking.
export const SPEEDY_BASE = 'https://api.speedy.bg/v1';
export const trackUrl = (number) => `https://www.speedy.bg/bg/track-shipment?shipmentNumber=${encodeURIComponent(number)}`;

const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = (v) => (v === '' || v == null ? NaN : Number(String(v).replace(',', '.')));
const DELIVERED = -14;
const RETURNED = [111, 123, 124]; // returned to sender, refused by recipient, delivered back to sender
const TRACK_MAX = 10;

/** rejected = Speedy clearly said no (nothing was done); false = unknown (timeout, lost connection, odd answer). */
const fail = (message, rejected) => Object.assign(new Error(message), { rejected });

function speedyError(e) {
  const m = clean(e?.message);
  if (/invalid\.credentials/i.test(m)) return 'Спиди: грешен API потребител или парола (това са данните от договора, не от MySpeedy)';
  return `Спиди: ${m || `грешка ${e?.code ?? ''}`.trim()}`;
}

async function post(path, creds, body, fetchImpl) {
  try {
    return await fetchImpl(`${SPEEDY_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ userName: creds.username, password: creds.password, language: 'BG', ...body }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    throw fail(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Спиди не отговори навреме — опитайте отново' : 'Няма връзка със Спиди — опитайте отново', false);
  }
}

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  // Speedy answers its own errors as JSON (usually HTTP 200); a server error or a non-JSON answer may still have done it
  if (data?.error && res.status < 500) throw fail(speedyError(data.error), true);
  if (!res.ok || data == null) throw fail(`Спиди върна неочакван отговор (HTTP ${res.status})`, false);
  return data;
}

export async function speedyCall(creds, path, body, fetchImpl = fetch) {
  return readJson(await post(path, creds, body, fetchImpl));
}

/** Contract clients (who sends: name, company or person, address) and the parcel services of the contract. */
export async function getProfile(creds, fetchImpl = fetch) {
  const [c, s] = await Promise.all([speedyCall(creds, 'client/contract', {}, fetchImpl), speedyCall(creds, 'services', {}, fetchImpl)]);
  const clients = (Array.isArray(c?.clients) ? c.clients : []).filter((x) => x?.clientId).map((x) => ({
    id: Number(x.clientId), name: clean(x.clientName), company: x.privatePerson === false,
    text: [clean(x.clientName), clean(x.objectName), clean(x.address?.fullAddressString)].filter(Boolean).join(' · '),
  }));
  if (!clients.length) throw new Error('Спиди не върна клиент по договора — проверете API потребителя');
  const services = (Array.isArray(s?.services) ? s.services : []).filter((x) => x?.id && (!x.cargoType || x.cargoType === 'PARCEL'))
    .map((x) => ({ id: Number(x.id), name: clean(x.name) }));
  return { clients, services };
}

const phone = (v) => { const p = String(v ?? '').trim(); return (p.startsWith('+') ? '+' : '') + p.replace(/\D/g, ''); };

/** Order + shop settings (+ values typed in the waybill window) → Speedy shipment. Throws Bulgarian messages for the admin. */
export function buildShipment(order, settings, input = {}) {
  if (order.courier !== 'speedy') throw new Error('Поръчката не е със Спиди');
  const s = settings || {};
  if (!s.clientId || !s.sender) throw new Error('В настройките на Спиди изберете подател и откъде изпращате');
  const senderPhone = phone(s.senderPhone);
  if (senderPhone.replace('+', '').length < 6) throw new Error('В настройките на Спиди въведете телефон на подателя');
  const contact = clean(s.senderContact);
  if (s.clientCompany && !contact) throw new Error('Подателят по договора е фирма — в настройките на Спиди въведете лице за контакт');
  const name = clean(order.name).slice(0, 60);
  if (name.length < 3) throw new Error('Името на получателя трябва да е поне 3 знака');

  let to;
  if (order.deliveryType === 'speedy_address') {
    const note = clean(order.addressText);
    if (!note || !clean(order.city)) throw new Error('Поръчката няма пълен адрес за доставка');
    to = { address: { countryId: 100, siteName: clean(order.city).slice(0, 50), postCode: clean(order.postCode).slice(0, 10), addressNote: note.slice(0, 200) } };
  } else {
    const office = String(order.officeId || '').startsWith('speedy:') ? Number(order.officeId.slice(7)) : NaN;
    if (!Number.isInteger(office) || office <= 0) throw new Error('Поръчката няма офис на Спиди');
    to = { pickupOfficeId: office };
  }

  const weight = num(input.weight ?? s.weight ?? 1);
  if (!(weight > 0 && weight <= 50)) throw new Error('Тегло: от 0,01 до 50 кг');
  const packCount = input.packCount == null || input.packCount === '' ? 1 : Number(input.packCount);
  if (!Number.isInteger(packCount) || packCount < 1 || packCount > 10) throw new Error('Брой пакети: от 1 до 10');
  const cod = input.cod == null || input.cod === '' ? (['cod', ''].includes(order.paymentMethod || '') ? Number(order.total) : 0) : num(input.cod);
  if (!(cod >= 0 && cod <= 10000)) throw new Error('Наложен платеж: сума от 0 до 10 000');
  const items = (order.items || []).map((it) => `${it.qty} × ${clean(it.name)}`).join(', ');
  const contents = (clean(input.description) || clean(s.description) || items || 'стоки').slice(0, 100);
  const serviceId = Number(s.serviceId) || 505;
  const review = input.review === undefined ? s.review : input.review;

  const additionalServices = {};
  if (cod > 0) additionalServices.cod = { amount: Math.round(cod * 100) / 100, currencyCode: order.currency || 'EUR', processingType: 'CASH' };
  if (review) additionalServices.obpd = { option: review === 'TEST' ? 'TEST' : 'OPEN', returnShipmentServiceId: serviceId, returnShipmentPayer: 'SENDER' };
  const payer = (input.payer || s.payer || 'receiver') === 'sender' ? 'SENDER' : 'RECIPIENT';

  return {
    sender: {
      clientId: Number(s.clientId), phone1: { number: senderPhone }, ...(contact ? { contactName: contact.slice(0, 60) } : {}),
      ...(s.sender.type === 'office' ? { dropoffOfficeId: Number(s.sender.officeId) } : {}),
    },
    recipient: { clientName: name, privatePerson: true, phone1: { number: phone(order.phone) }, ...to },
    service: { serviceId, autoAdjustPickupDate: true, ...(Object.keys(additionalServices).length ? { additionalServices } : {}) },
    content: { parcelsCount: packCount, totalWeight: weight, contents, package: 'BOX' },
    payment: { courierServicePayer: payer },
    ref1: clean(order.cbOrderId).slice(0, 30),
  };
}

/** The price of a shipment (total with VAT, as the shop pays or the receiver pays). */
export async function calculateShipment(creds, shipment, fetchImpl = fetch) {
  const sh = shipment || {};
  const r = sh.recipient || {};
  const d = await speedyCall(creds, 'calculate', {
    sender: { clientId: sh.sender?.clientId, ...(sh.sender?.dropoffOfficeId ? { dropoffOfficeId: sh.sender.dropoffOfficeId } : {}) },
    recipient: r.pickupOfficeId ? { privatePerson: true, pickupOfficeId: r.pickupOfficeId }
      : { privatePerson: true, addressLocation: { countryId: r.address?.countryId, siteName: r.address?.siteName, postCode: r.address?.postCode } },
    service: { serviceIds: [sh.service?.serviceId], autoAdjustPickupDate: true, ...(sh.service?.additionalServices ? { additionalServices: sh.service.additionalServices } : {}) },
    content: { parcelsCount: sh.content?.parcelsCount, totalWeight: sh.content?.totalWeight },
    payment: sh.payment,
  }, fetchImpl);
  const c = Array.isArray(d?.calculations) ? d.calculations[0] : null;
  if (!c) throw fail('Спиди не върна цена', false);
  if (c.error) throw fail(speedyError(c.error), true);
  return { price: Number(c.price?.total) || 0, currency: clean(c.price?.currency) || 'EUR', payer: sh.payment?.courierServicePayer || 'RECIPIENT' };
}

export async function createShipment(creds, shipment, fetchImpl = fetch) {
  const d = await speedyCall(creds, 'shipment', shipment, fetchImpl);
  if (!d?.id) throw fail('Спиди не върна номер на товарителница', false);
  return { number: String(d.id), price: Number(d.price?.total) || 0, currency: clean(d.price?.currency) || 'EUR', pdf: null };
}

export async function cancelShipment(creds, number, fetchImpl = fetch) {
  await speedyCall(creds, 'shipment/cancel', { shipmentId: String(number), comment: 'Анулирана от магазина' }, fetchImpl);
}

/** The waybill as PDF bytes (A4 waybill or A6 sticker). */
export async function printWaybill(creds, number, paperSize = 'A4', fetchImpl = fetch) {
  const res = await post('print', creds, { paperSize: paperSize === 'A6' ? 'A6' : 'A4', parcels: [{ parcel: { id: String(number) } }] }, fetchImpl);
  const type = String(res.headers?.get?.('content-type') || '');
  if (res.ok && type.includes('application/pdf')) return Buffer.from(await res.arrayBuffer());
  await readJson(res);
  throw fail('Спиди не върна PDF', false);
}

/** Speedy scans → 'delivered' | 'returned' | null (still on its way). */
export function statusFromSpeedy(operations) {
  const codes = (Array.isArray(operations) ? operations : []).map((o) => Number(o?.operationCode));
  if (codes.some((c) => RETURNED.includes(c))) return 'returned';
  if (codes.includes(DELIVERED)) return 'delivered';
  return null;
}

export async function shipmentStatuses(creds, numbers, fetchImpl = fetch) {
  const out = [];
  for (let i = 0; i < numbers.length; i += TRACK_MAX) {
    const d = await speedyCall(creds, 'track', { parcels: numbers.slice(i, i + TRACK_MAX).map((n) => ({ id: String(n) })) }, fetchImpl);
    for (const p of Array.isArray(d?.parcels) ? d.parcels : []) {
      if (!p?.parcelId || p.error) continue;
      const ops = Array.isArray(p.operations) ? p.operations : [];
      out.push({ number: String(p.parcelId), status: statusFromSpeedy(ops), text: clean(ops.at(-1)?.description) });
    }
  }
  return out;
}
