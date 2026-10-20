// BOX NOW Partner API with the shop's own OAuth client (Client ID / Secret from BOX NOW): starting points, delivery requests,
// labels, cancel, parcel states. Test mode talks only to BOX NOW's stage host.
import { normalizePhone } from './phone.js';

export const BOXNOW_HOSTS = { live: 'https://api-production.boxnow.bg', demo: 'https://api-stage.boxnow.bg' };
const MAX_KG = 20; // the biggest locker compartment takes 20 kg
const COD_MAX = 5000; // BOX NOW: amountToBeCollected in (0, 5000)
const TRACK_PARALLEL = 3;

const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = (v) => (v === '' || v == null ? NaN : Number(String(v).replace(',', '.')));
const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const host = (creds) => (creds.demo ? BOXNOW_HOSTS.demo : BOXNOW_HOSTS.live);

/** rejected = BOX NOW clearly said no (nothing was done); false = unknown (timeout, lost connection, odd answer). */
const fail = (message, rejected, code = null) => Object.assign(new Error(message), { rejected, code });

const LOGIN = 'BOX NOW: грешен Client ID или Client Secret (данните за Partner API от BOX NOW)';
const MESSAGES = {
  P400: 'BOX NOW: невалидни данни за пратката',
  P401: 'BOX NOW: невалидно място на изпращане — проверете в настройките откъде тръгват пратките',
  P402: 'BOX NOW: невалиден автомат на получателя — изберете друг автомат',
  P403: 'BOX NOW не позволява изпращане от автомат до същия автомат за вашия профил',
  P405: 'BOX NOW: невалиден телефон — нужен е пълен номер, напр. +359 88 123 4567',
  C404: 'BOX NOW: невалиден телефон — нужен е пълен номер, напр. +359 88 123 4567',
  P406: 'BOX NOW: изберете размер на пратката (малка, средна или голяма)',
  P408: 'BOX NOW: наложеният платеж трябва да е между 0 и 5000',
  P410: 'BOX NOW: тази поръчка вече има заявка в BOX NOW',
  P411: 'BOX NOW не позволява наложен платеж за вашия профил — уговорете го с BOX NOW или изпратете с предплащане',
  P414: 'BOX NOW: пратката не е от вашия профил',
  P420: 'BOX NOW: пратката не може да се анулира (вече пътува, доставена или върната)',
  P421: 'BOX NOW: невалидно тегло',
  P440: 'BOX NOW: профилът ви управлява няколко партньора — пишете ни, за да го настроим',
  P441: 'BOX NOW: профилът ви управлява няколко партньора — пишете ни, за да го настроим',
  P466: 'BOX NOW: имате просрочено плащане към BOX NOW — заявки не могат да се създават',
  X403: 'BOX NOW: профилът ви е спрян — свържете се с BOX NOW',
};

const tokens = new Map(); // host|client → { token, until }
export function clearBoxnowTokens() { tokens.clear(); }

async function send(fetchImpl, url, init, what) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    throw fail(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `BOX NOW не отговори навреме${what}` : `Няма връзка с BOX NOW${what}`, false);
  }
}

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok && data != null) return data;
  // BOX NOW answers its refusals as JSON {code, message} with a 4xx; a server error or an odd answer may still have done it
  if (res.status >= 400 && res.status < 500 && data && (data.code || data.message)) {
    const code = clean(data.code);
    throw fail(MESSAGES[code] || `BOX NOW: ${clean(data.message) || code || `грешка ${res.status}`}`, true, code || null);
  }
  throw fail(`BOX NOW върна неочакван отговор (HTTP ${res.status})`, false);
}

async function token(creds, fetchImpl, fresh = false) {
  const key = `${host(creds)}|${creds.username}|${creds.password}`;
  const t = tokens.get(key);
  if (t && !fresh && t.until > Date.now()) return t.token;
  const res = await send(fetchImpl, `${host(creds)}/api/v1/auth-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: creds.username, client_secret: creds.password }),
  }, ' — опитайте отново');
  if (res.status === 400 || res.status === 401 || res.status === 403) throw fail(LOGIN, true, 'login');
  const d = await readJson(res);
  if (!d?.access_token) throw fail('BOX NOW не върна ключ за достъп', false);
  tokens.set(key, { token: d.access_token, until: Date.now() + (Math.max(Number(d.expires_in) || 3600, 120) - 60) * 1000 });
  return d.access_token;
}

/** One Partner API call with the shop's token (renewed once when BOX NOW says it expired). raw → the Response itself. */
export async function boxnowCall(creds, { method = 'GET', path, body, query, accept = 'application/json', raw = false }, fetchImpl = fetch) {
  const url = new URL(path, host(creds));
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const once = async (fresh) => send(fetchImpl, url.toString(), {
    method,
    headers: { Authorization: `Bearer ${await token(creds, fetchImpl, fresh)}`, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, method === 'GET' ? ' — опитайте отново' : '');
  let res = await once(false);
  if (res.status === 401) res = await once(true); // a 401 means nothing was done: safe to repeat with a new token
  if (res.status === 401) throw fail(LOGIN, true, 'login');
  return raw ? res : readJson(res);
}

/** The shop's warehouses (where BOX NOW collects) and the "any locker" start, if its profile may drop parcels in lockers. */
export async function getProfile(creds, fetchImpl = fetch) {
  const list = (d) => (Array.isArray(d?.data) ? d.data : []);
  const warehouses = list(await boxnowCall(creds, { path: '/api/v1/origins', query: { locationType: 'warehouse' } }, fetchImpl)).map((w) => ({
    id: clean(w.id), name: clean(w.name) || clean(w.title), address: [clean(w.addressLine1), clean(w.addressLine2)].filter(Boolean).join(', '),
  })).filter((w) => w.id);
  let anyApmId = null;
  try {
    anyApmId = clean(list(await boxnowCall(creds, { path: '/api/v1/origins', query: { locationType: 'any-apm' } }, fetchImpl))[0]?.id) || null;
  } catch (err) {
    if (err.code === 'login') throw err; // otherwise: this profile may not start from a locker
  }
  return { warehouses, anyApmId };
}

/** Order + shop settings (+ values typed in the waybill window) → BOX NOW delivery request. Throws Bulgarian messages. */
export function buildDelivery(order, settings, input = {}) {
  const locker = String(order.officeId || '').startsWith('boxnow:') ? order.officeId.slice(7) : '';
  if (order.courier !== 'boxnow' || !locker) throw new Error('Поръчката не е до автомат на BOX NOW');
  const s = settings || {};
  if (!clean(s.originId)) throw new Error('В настройките на BOX NOW изберете откъде тръгват пратките (склад или автомат)');
  const senderPhone = normalizePhone(s.senderPhone);
  if (!senderPhone) throw new Error('В настройките на BOX NOW въведете телефон на подателя');
  const receiverPhone = normalizePhone(order.phone);
  if (!receiverPhone) throw new Error('Поръчката няма валиден телефон на получателя');

  const weight = num(input.weight ?? s.weight ?? 1);
  if (!(weight > 0 && weight <= MAX_KG)) throw new Error(`Тегло: от 0,01 до ${MAX_KG} кг (най-голямата клетка на автомата)`);
  const fromLocker = s.originType === 'any-apm';
  const size = Number(input.size ?? s.size ?? 0);
  if (fromLocker && ![1, 2, 3].includes(size)) throw new Error('Изберете размер на пратката: малка, средна или голяма');
  const cod = input.cod == null || input.cod === '' ? (['cod', ''].includes(order.paymentMethod || '') ? Number(order.total) : 0) : num(input.cod);
  if (!(cod >= 0)) throw new Error('Наложен платеж: невалидна сума');
  if (cod >= COD_MAX) throw new Error('Наложен платеж: до 4999,99 (ограничение на BOX NOW)');
  const items = (order.items || []).map((it) => `${it.qty} × ${clean(it.name)}`).join(', ');
  const orderNumber = `${String(order.id).slice(0, 8)}-${Date.now().toString(36)}`; // BOX NOW never accepts an order number twice

  return {
    orderNumber, invoiceValue: money(order.total),
    paymentMode: cod > 0 ? 'cod' : 'prepaid', amountToBeCollected: money(cod),
    allowReturn: s.allowReturn !== false,
    origin: { locationId: clean(s.originId), contactName: clean(s.senderName).slice(0, 80), contactNumber: senderPhone, contactEmail: clean(s.senderEmail) },
    destination: { locationId: locker, contactName: clean(order.name).slice(0, 80), contactNumber: receiverPhone, contactEmail: clean(order.email) || clean(s.senderEmail) },
    items: [{
      id: `${orderNumber}-1`, name: (clean(input.description) || clean(s.description) || items || 'Поръчка').slice(0, 100), value: money(order.total), weight,
      ...(fromLocker || input.size ? { compartmentSize: size } : {}),
    }],
  };
}

export async function createDelivery(creds, request, fetchImpl = fetch) {
  const d = await boxnowCall(creds, { method: 'POST', path: '/api/v1/delivery-requests', body: request }, fetchImpl);
  const parcels = (Array.isArray(d?.parcels) ? d.parcels : []).map((p) => clean(p?.id)).filter(Boolean);
  if (!parcels.length) throw fail('BOX NOW не върна номер на пратка', false);
  return { number: parcels[0], parcels, reference: clean(d.id ?? d.referenceNumber), price: null, currency: '', pdf: null }; // the price is per the shop's BOX NOW contract
}

export async function cancelParcel(creds, id, fetchImpl = fetch) {
  await boxnowCall(creds, { method: 'POST', path: `/api/v1/parcels/${encodeURIComponent(id)}:cancel` }, fetchImpl);
}

/** The parcel's label as PDF bytes (BOX NOW prints only through the API, with the shop's login). */
export async function labelPdf(creds, id, fetchImpl = fetch) {
  const res = await boxnowCall(creds, { path: `/api/v1/parcels/${encodeURIComponent(id)}/label.pdf`, accept: 'application/pdf', raw: true }, fetchImpl);
  const type = String(res.headers?.get?.('content-type') || '');
  if (res.ok && type.includes('application/pdf')) return Buffer.from(await res.arrayBuffer());
  await readJson(res);
  throw fail('BOX NOW не върна PDF', false);
}

const STATE_TEXT = {
  new: 'Регистрирана', 'in-transit': 'На път', 'in-depot': 'В склад на BOX NOW', 'final-destination': 'В автомата, чака получателя',
  delivered: 'Доставена', returned: 'Върната на подателя', cancelled: 'Анулирана', canceled: 'Анулирана', 'cancelled-return': 'Връщането е анулирано',
  'expired-return': 'Не е взета — връща се', 'wait-for-load': 'В автомата, чака куриер за връщане', lost: 'Изгубена', missing: 'Липсва',
};
const STATUS = { delivered: 'delivered', returned: 'returned' };

/** One parcel's state; BOX NOW lists only prepaid parcels unless asked for cash-on-delivery ones. */
async function parcelState(creds, id, fetchImpl) {
  for (const paymentMode of [undefined, 'cod']) {
    const d = await boxnowCall(creds, { path: '/api/v1/parcels', query: { parcelId: id, paymentMode } }, fetchImpl);
    const p = (Array.isArray(d?.data) ? d.data : []).find((x) => clean(x?.id) === id);
    if (p) return p;
  }
  return null;
}

export async function shipmentStatuses(creds, numbers, fetchImpl = fetch) {
  const answers = new Array(numbers.length);
  let next = 0;
  const worker = async () => {
    while (next < numbers.length) {
      const i = next++;
      answers[i] = await parcelState(creds, String(numbers[i]), fetchImpl);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRACK_PARALLEL, numbers.length) }, worker));
  const out = [];
  answers.forEach((p, i) => {
    if (!p) return;
    const state = clean(p.state);
    const arrived = state === 'final-destination'
      ? (Array.isArray(p.events) ? p.events : []).filter((e) => e?.type === 'final-destination').map((e) => Date.parse(e.createTime)).filter(Number.isFinite)
      : [];
    out.push({ number: String(numbers[i]), status: STATUS[state] || null, text: STATE_TEXT[state] || state, atOffice: arrived.length ? new Date(Math.min(...arrived)).toISOString() : null });
  });
  return out;
}
