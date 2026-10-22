// Courier waybills from the admin with the shop's own courier login: Econt (e-Econt profile), Speedy (API user of its contract)
// and BOX NOW (OAuth client of its Partner API).
// Settings, price, create, cancel, print, nightly status sync — one set of rules for both couriers.
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { assertReady } from './secretbox.js';
import { getProfile, buildLabel, createLabel, deleteLabels, shipmentStatuses } from './econt-api.js';
import * as speedy from './speedy-api.js';
import * as boxnow from './boxnow-api.js';
import { normalizePhone } from './phone.js';
import { toOrder } from './orders-repo.js';
import { syncStockSafe } from './stock.js';
import { humanize } from './errors-bg.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (v) => String(v ?? '').trim();
const SYNC_DAYS = 90;
const SYNC_MAX = 500;
const CHUNK = 100;

/** e-Econt username/password: typed now, or the stored ones when the username is the same (they only ever go to Econt). */
async function credentials(q, shopId, b) {
  const current = await getIntegration(q, 'econt', shopId);
  const username = t(b.username) || current.config.username || '';
  if (!username) throw new Error('Въведете потребителското име от e-Econt');
  const demo = b.demo === undefined ? Boolean(current.config.demo) : Boolean(b.demo);
  let password = String(b.password || '');
  // a stored login only goes to the Econt system (live or test) it was saved for
  if (!password && current.hasSecret && Boolean(current.config.demo) === demo) {
    const stored = JSON.parse(await getSecret(q, 'econt', shopId));
    if (stored.username === username) password = stored.password;
  }
  if (!password) throw new Error('Въведете паролата от e-Econt');
  return { current, creds: { username, password, demo }, typed: Boolean(b.password) };
}

/** Which Econt client profile (company / person) to use: the one picked now, else the one saved for the same login. */
const chosenClient = (b, current, creds) => (b.clientId !== undefined ? t(b.clientId)
  : current.config.username === creds.username && Boolean(current.config.demo) === creds.demo ? t(current.config.clientId) : '');

/** Admin: profile name, phones and addresses (for choosing the sender address). */
export async function econtProfile(q, shopId, b) {
  const { current, creds } = await credentials(q, shopId, b);
  const p = await getProfile({ ...creds, clientId: chosenClient(b, current, creds) });
  return { clientId: p.clientId, profiles: p.profiles, payOptions: p.payOptions, name: p.name, company: p.company, phones: p.phones, addresses: p.addresses.map((a) => ({ id: a.id, text: a.text })) };
}

/** Saves a shop's Econt settings after checking the profile at Econt. Switching off needs no working login. */
export async function saveEcont(q, shopId, b) {
  assertReady();
  if (b.active === false) {
    await saveIntegration(q, 'econt', { config: { active: false }, shopId });
    return { active: false };
  }
  const { current, creds, typed } = await credentials(q, shopId, b);
  const payer = b.payer === 'receiver' ? 'receiver' : 'sender'; // the shop usually charges shipping in the order: it pays the courier
  const weight = Number(String(b.weight ?? '1').replace(',', '.'));
  if (!(weight > 0 && weight <= 50)) throw new Error('Тегло по подразбиране: от 0,01 до 50 кг');
  const description = t(b.description);
  if (description.length > 100) throw new Error('Описанието е до 100 знака');
  const senderName = t(b.senderName).slice(0, 80);
  const senderAgent = t(b.senderAgent).slice(0, 80);

  const profile = await getProfile({ ...creds, clientId: chosenClient(b, current, creds) });
  let sender;
  if (b.senderType === 'address') {
    const a = profile.addresses.find((x) => x.id === t(b.senderAddressId));
    if (!a) throw new Error('Изберете адрес от профила в Еконт');
    sender = { type: 'address', addressId: a.id, address: a.address, officeCode: '', text: a.text };
  } else {
    const code = t(b.senderOfficeCode);
    if (!/^\d{1,10}$/.test(code)) throw new Error('Изберете офис на Еконт, от който изпращате');
    const [o] = await q(`select name, city from zd.offices where courier = 'econt' and code = $1`, [code]);
    if (!o && !creds.demo) throw new Error('Няма такъв офис на Еконт');
    sender = { type: 'office', officeCode: code, addressId: '', address: null, text: o ? `${o.name}, ${o.city}` : `Офис ${code}` };
  }
  const senderPhone = t(b.senderPhone) || profile.phones[0] || '';
  if (!senderPhone) throw new Error('Въведете телефон на подателя');
  if (profile.company && !senderAgent) throw new Error('Профилът в Еконт е на фирма — въведете упълномощено лице (човекът, който предава пратките)');
  // how Econt pays out the cash on delivery: a template of the profile; not chosen again = kept; '' = e-Econt's default
  let cdPayOption = current.config.cdPayOption || null;
  if (b.cdPayOptionNum !== undefined) {
    const num = t(b.cdPayOptionNum);
    cdPayOption = num ? profile.payOptions.find((o) => o.num === num) || null : null;
    if (num && !cdPayOption) throw new Error('Изберете начин на изплащане на наложения платеж от профила в Еконт');
  }

  await saveIntegration(q, 'econt', {
    config: {
      username: creds.username, demo: creds.demo, clientId: profile.clientId, profileName: profile.name, profileCompany: profile.company, sender, senderName, senderAgent, senderPhone, payer, weight, description, cdPayOption,
      review: Boolean(b.review), active: true, connectedAt: new Date().toISOString(), lastError: null,
    },
    secret: typed ? JSON.stringify({ username: creds.username, password: creds.password }) : undefined,
    shopId,
  });
  return { active: true, profileName: profile.name, sender: sender.text };
}

/** What the admin shows (never the password). */
export async function econtStatus(q, shopId) {
  const i = await getIntegration(q, 'econt', shopId);
  const c = i.config;
  return {
    configured: i.hasSecret, connected: i.hasSecret && c.active !== false && Boolean(c.sender), active: c.active !== false,
    username: c.username || '', demo: Boolean(c.demo), clientId: c.clientId || '', profileName: c.profileName || '',
    sender: c.sender ? { type: c.sender.type, officeCode: c.sender.officeCode || '', addressId: c.sender.addressId || '', text: c.sender.text || '' } : null,
    senderName: c.senderName || '', senderAgent: c.senderAgent || '', profileCompany: Boolean(c.profileCompany), senderPhone: c.senderPhone || '', payer: c.payer || 'sender', weight: c.weight ?? 1,
    description: c.description || '', review: Boolean(c.review), cdPayOption: c.cdPayOption || null,
    lastSyncAt: c.lastSyncAt || null, lastSyncResult: c.lastSyncResult || null, lastError: c.lastError || null,
  };
}

/* ---- Speedy settings: the API user and password of the shop's Speedy contract ---- */

async function speedyCredentials(q, shopId, b) {
  const current = await getIntegration(q, 'speedy', shopId);
  const username = t(b.username) || current.config.username || '';
  if (!username) throw new Error('Въведете API потребителя от договора със Спиди');
  let password = String(b.password || '');
  if (!password && current.hasSecret) {
    const stored = JSON.parse(await getSecret(q, 'speedy', shopId));
    if (stored.username === username) password = stored.password;
  }
  if (!password) throw new Error('Въведете API паролата от договора със Спиди');
  return { creds: { username, password, demo: false }, typed: Boolean(b.password) };
}

/** Admin: who may send by the contract and which services it has. */
export async function speedyProfile(q, shopId, b) {
  const { creds } = await speedyCredentials(q, shopId, b);
  return speedy.getProfile(creds);
}

const REVIEW = ['', 'OPEN', 'TEST'];

/** Saves a shop's Speedy settings after checking the login at Speedy. Switching off needs no working login. */
export async function saveSpeedy(q, shopId, b) {
  assertReady();
  if (b.active === false) {
    await saveIntegration(q, 'speedy', { config: { active: false }, shopId });
    return { active: false };
  }
  const { creds, typed } = await speedyCredentials(q, shopId, b);
  const payer = b.payer === 'receiver' ? 'receiver' : 'sender'; // the shop usually charges shipping in the order: it pays the courier
  const weight = Number(String(b.weight ?? '1').replace(',', '.'));
  if (!(weight > 0 && weight <= 50)) throw new Error('Тегло по подразбиране: от 0,01 до 50 кг');
  const description = t(b.description);
  if (description.length > 100) throw new Error('Описанието е до 100 знака');
  const review = REVIEW.includes(b.review) ? b.review : '';
  const paperSize = b.paperSize === 'A6' ? 'A6' : 'A4';

  const profile = await speedy.getProfile(creds);
  const client = profile.clients.find((c) => String(c.id) === t(b.senderClientId)) || (profile.clients.length === 1 ? profile.clients[0] : null);
  if (!client) throw new Error('Изберете подател от договора');
  let sender;
  if (b.senderType === 'client') {
    sender = { type: 'client', officeId: null, text: `от адреса по договора: ${client.text}` };
  } else {
    const code = t(b.senderOfficeId);
    if (!/^\d{1,10}$/.test(code)) throw new Error('Изберете офис на Спиди, от който изпращате');
    const [o] = await q(`select name, city from zd.offices where courier = 'speedy' and code = $1`, [code]);
    if (!o) throw new Error('Няма такъв офис на Спиди');
    sender = { type: 'office', officeId: Number(code), text: o.name };
  }
  const ids = profile.services.map((x) => x.id);
  const serviceId = ids.includes(Number(b.serviceId)) ? Number(b.serviceId) : ids.includes(505) ? 505 : ids[0];
  if (!serviceId) throw new Error('Договорът няма услуга за колети — питайте Спиди');
  const senderPhone = t(b.senderPhone);
  if (!senderPhone) throw new Error('Въведете телефон на подателя');
  const senderContact = client.company ? t(b.senderContact).slice(0, 60) : ''; // Speedy forbids a contact person for private persons
  if (client.company && !senderContact) throw new Error('Подателят по договора е фирма — въведете лице за контакт');

  await saveIntegration(q, 'speedy', {
    config: {
      username: creds.username, clientId: client.id, clientName: client.name, clientCompany: client.company, sender, senderPhone, senderContact,
      payer, weight, description, review, serviceId, serviceName: profile.services.find((x) => x.id === serviceId)?.name || '', paperSize,
      active: true, connectedAt: new Date().toISOString(), lastError: null,
    },
    secret: typed ? JSON.stringify({ username: creds.username, password: creds.password }) : undefined,
    shopId,
  });
  return { active: true, profileName: client.name, sender: sender.text };
}

/* ---- BOX NOW settings: the OAuth Client ID / Secret of the shop's BOX NOW Partner API ---- */

/** Client ID/Secret: typed now, or the stored ones for the same Client ID and the same mode (a live secret never goes to stage). */
async function boxnowCredentials(q, shopId, b) {
  const current = await getIntegration(q, 'boxnow', shopId);
  const username = t(b.clientId) || current.config.username || '';
  if (!username) throw new Error('Въведете Client ID от BOX NOW');
  const demo = b.demo === undefined ? Boolean(current.config.demo) : Boolean(b.demo);
  let password = String(b.secret || '');
  if (!password && current.hasSecret && Boolean(current.config.demo) === demo) {
    const stored = JSON.parse(await getSecret(q, 'boxnow', shopId));
    if (stored.username === username) password = stored.password;
  }
  if (!password) throw new Error('Въведете Client Secret от BOX NOW');
  return { creds: { username, password, demo }, typed: Boolean(b.secret) };
}

/** Admin: the shop's warehouses at BOX NOW and whether it may drop parcels in any locker. */
export async function boxnowProfile(q, shopId, b) {
  const { creds } = await boxnowCredentials(q, shopId, b);
  return boxnow.getProfile(creds);
}

/** Saves a shop's BOX NOW waybill settings after checking the login at BOX NOW. Switching off needs no working login. */
export async function saveBoxnow(q, shopId, b) {
  assertReady();
  if (b.active === false) {
    await saveIntegration(q, 'boxnow', { config: { active: false }, shopId });
    return { active: false };
  }
  const { creds, typed } = await boxnowCredentials(q, shopId, b);
  const weight = Number(String(b.weight ?? '1').replace(',', '.'));
  if (!(weight > 0 && weight <= 20)) throw new Error('Тегло по подразбиране: от 0,01 до 20 кг');
  const description = t(b.description);
  if (description.length > 100) throw new Error('Описанието е до 100 знака');
  const senderName = t(b.senderName).slice(0, 80);
  if (!senderName) throw new Error('Въведете име на подателя');
  const senderPhone = t(b.senderPhone);
  if (!normalizePhone(senderPhone)) throw new Error('Въведете телефон на подателя (напр. 0888 123 456)');
  const senderEmail = t(b.senderEmail).slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw new Error('Въведете имейл на подателя (BOX NOW го иска и за клиенти без имейл)');
  // returns are never requested through the API (BOX NOW's guide: allowReturn always false)

  const profile = await boxnow.getProfile(creds);
  let sender, originId, size = null;
  if (b.originType === 'any-apm') {
    if (!profile.anyApmId) throw new Error('Профилът ви в BOX NOW не позволява пускане на пратки в автомат — изберете склад или питайте BOX NOW');
    size = Number(b.size);
    if (![1, 2, 3].includes(size)) throw new Error('Изберете размер на пратките по подразбиране: малка, средна или голяма');
    originId = profile.anyApmId;
    sender = { type: 'any-apm', text: 'Пускате пратките в автомат на BOX NOW' };
  } else {
    const w = profile.warehouses.find((x) => x.id === t(b.originId));
    if (!w) throw new Error('Изберете склад от профила в BOX NOW');
    originId = w.id;
    sender = { type: 'warehouse', text: [w.name, w.address].filter(Boolean).join(', ') };
  }

  await saveIntegration(q, 'boxnow', {
    config: {
      username: creds.username, demo: creds.demo, sender, originType: sender.type, originId, size, senderName, senderPhone, senderEmail, weight, description,
      active: true, connectedAt: new Date().toISOString(), lastError: null,
    },
    secret: typed ? JSON.stringify({ username: creds.username, password: creds.password }) : undefined,
    shopId,
  });
  return { active: true, sender: sender.text };
}

/** What the admin shows (never the secret). `checkout` = BOX NOW lockers in the shop's checkout (a separate switch). */
export async function boxnowStatus(q, shopId) {
  const i = await getIntegration(q, 'boxnow', shopId);
  const c = i.config;
  return {
    configured: i.hasSecret, connected: i.hasSecret && c.active !== false && Boolean(c.originId), active: c.active !== false, checkout: c.checkout === true,
    clientId: c.username || '', demo: Boolean(c.demo), sender: c.sender ? { type: c.sender.type, text: c.sender.text || '' } : null,
    originType: c.originType || 'warehouse', originId: c.originId || '', size: c.size || null, senderName: c.senderName || '', senderPhone: c.senderPhone || '',
    senderEmail: c.senderEmail || '', weight: c.weight ?? 1, description: c.description || '',
    lastSyncAt: c.lastSyncAt || null, lastSyncResult: c.lastSyncResult || null, lastError: c.lastError || null,
  };
}

export async function speedyStatus(q, shopId) {
  const i = await getIntegration(q, 'speedy', shopId);
  const c = i.config;
  return {
    configured: i.hasSecret, connected: i.hasSecret && c.active !== false && Boolean(c.sender && c.clientId), active: c.active !== false,
    username: c.username || '', clientId: c.clientId || null, profileName: c.clientName || '', clientCompany: Boolean(c.clientCompany),
    sender: c.sender ? { type: c.sender.type, officeId: c.sender.officeId || null, text: c.sender.text || '' } : null,
    senderPhone: c.senderPhone || '', senderContact: c.senderContact || '', payer: c.payer || 'sender', weight: c.weight ?? 1,
    description: c.description || '', review: c.review || '', serviceId: c.serviceId || null, serviceName: c.serviceName || '', paperSize: c.paperSize || 'A4',
    lastSyncAt: c.lastSyncAt || null, lastSyncResult: c.lastSyncResult || null, lastError: c.lastError || null,
  };
}

/* ---- one set of rules for every courier ---- */

/** What differs between couriers. build() turns order + settings + typed values into the courier's request. */
const COURIERS = {
  econt: {
    name: 'Еконт', site: 'e-Econt',
    ready: (cfg) => Boolean(cfg.sender),
    build: (order, cfg, input) => buildLabel(order, cfg, input),
    async preview(creds, label) {
      const p = await createLabel(creds, label, 'calculate');
      return { price: p.price, currency: p.currency, receiverDue: p.receiverDue, senderDue: p.senderDue };
    },
    create: (creds, label) => createLabel(creds, label, 'create'),
    cancel: (creds, number) => deleteLabels(creds, [number]),
    statuses: (creds, numbers) => shipmentStatuses(creds, numbers),
    defaults: (label, cfg) => ({
      cod: label.services?.cdAmount ?? 0, weight: label.weight, packCount: label.packCount, description: label.shipmentDescription,
      payer: cfg.payer || 'sender', review: Boolean(cfg.review),
    }),
  },
  speedy: {
    name: 'Спиди', site: 'MySpeedy',
    ready: (cfg) => Boolean(cfg.sender && cfg.clientId),
    // the window's review checkbox means the shop's review option (open, or open and test)
    build: (order, cfg, input) => speedy.buildShipment(order, cfg, input.review === undefined ? input : { ...input, review: input.review ? (cfg.review || 'OPEN') : '' }),
    async preview(creds, shipment) {
      const p = await speedy.calculateShipment(creds, shipment);
      const byReceiver = p.payer === 'RECIPIENT';
      return { price: p.price, currency: p.currency, receiverDue: byReceiver ? p.price : 0, senderDue: byReceiver ? 0 : p.price };
    },
    create: (creds, shipment) => speedy.createShipment(creds, shipment),
    /** Sending from the contract address: ask Speedy to send a courier. A failure there keeps the waybill and tells the admin. */
    async after(creds, cfg, w) {
      if (cfg.sender?.type !== 'client') return {};
      try {
        await speedy.orderPickup(creds, w.number, { contactName: cfg.senderContact, phone: cfg.senderPhone });
        return { pickup: 'ordered' };
      } catch (err) {
        console.error('[waybills] speedy pickup failed', w.number, err.message);
        return { pickup: 'failed', pickupError: `Куриер не беше поръчан (${err.message}) — поръчайте вземане в MySpeedy` };
      }
    },
    cancel: (creds, number) => speedy.cancelShipment(creds, number),
    statuses: (creds, numbers) => speedy.shipmentStatuses(creds, numbers),
    defaults: (shipment, cfg) => ({
      cod: shipment.service.additionalServices?.cod?.amount ?? 0, weight: shipment.content.totalWeight, packCount: shipment.content.parcelsCount,
      description: shipment.content.contents, payer: cfg.payer || 'sender', review: Boolean(cfg.review),
    }),
  },
  boxnow: {
    name: 'BOX NOW', site: 'Partner Portal на BOX NOW',
    ready: (cfg) => Boolean(cfg.sender && cfg.originId),
    build: (order, cfg, input) => boxnow.buildDelivery(order, cfg, input),
    routeText: (to, cfg) => (cfg.demo ? `тестов автомат на BOX NOW (${boxnow.BOXNOW_STAGE_LOCKER}) вместо ${to}` : to), // stage knows only its test lockers
    // BOX NOW has no price endpoint: the price is per the shop's BOX NOW contract
    preview: async () => ({ price: null, currency: '', receiverDue: null, senderDue: null }),
    create: (creds, req) => boxnow.createDelivery(creds, req),
    /** Sending from a locker: BOX NOW waits for the shop to drop the parcel and say so („Пуснах я в автомата“). */
    after: async (creds, cfg) => (cfg.originType === 'any-apm' ? { needsDrop: true, statusText: DROP_WAITING } : {}),
    cancel: (creds, number) => boxnow.cancelParcel(creds, number),
    statuses: (creds, numbers) => boxnow.shipmentStatuses(creds, numbers),
    defaults: (req, cfg) => ({
      cod: Number(req.amountToBeCollected), weight: req.items[0].weight, packCount: 1, description: req.items[0].name,
      payer: 'sender', review: false, size: req.items[0].compartmentSize ?? cfg.size ?? null, sizeRequired: cfg.originType === 'any-apm',
    }),
  },
};
const courierOf = (key) => (Object.hasOwn(COURIERS, key) ? COURIERS[key] : null);
const DROP_WAITING = 'Пуснете пратката в автомат на BOX NOW и натиснете „Пуснах я в автомата“';
const DROP_DONE = 'Пусната в автомат ✓';
const PICKUP_NOTE = 'Куриер не е поръчан — поръчайте вземане в MySpeedy';
/** notes for the shop kept in the courier text: the courier's own text never replaces them, and the buyer never sees them */
export const SHOP_NOTES = [DROP_WAITING, PICKUP_NOTE];

/** Settings + login of a shop connected to this courier, or null. */
async function courierSettings(q, key, shopId) {
  const c = courierOf(key);
  if (!c) return null;
  const i = await getIntegration(q, key, shopId);
  if (!i.hasSecret || i.config.active === false || !c.ready(i.config)) return null;
  const { username, password } = JSON.parse(await getSecret(q, key, shopId));
  return { cfg: i.config, creds: { username, password, demo: Boolean(i.config.demo) } };
}

/** The order within the admin's shop (null scope = all shops the admin may see: scopeShopIds, or every shop). */
async function loadOrder(q, orderId, scopeShopId, scopeShopIds = null) {
  const [r] = UUID.test(String(orderId || ''))
    ? await q(`select * from zd.orders where id = $1::uuid and ($2::text is null or shop_id = $2::uuid) and ($3::uuid[] is null or shop_id = any($3::uuid[]))`,
      [orderId, scopeShopId || null, scopeShopIds ? scopeShopIds.map(String) : null])
    : [];
  if (!r) throw new Error('Няма такава поръчка');
  return toOrder(r);
}

const notConnected = (c) => new Error(`Първо свържете ${c.name} в Интеграции → ${c.name} (товарителници)`);

async function connectedFor(q, order) {
  const c = courierOf(order.courier);
  if (!c) throw new Error('Товарителници има само за Еконт, Спиди и BOX NOW');
  const s = await courierSettings(q, order.courier, order.shopId);
  if (!s) throw notConnected(c);
  return { c, s };
}

/**
 * The office of the order, checked against our office list. Orders that came only through ConvertBuilder have no office id:
 * then the code is taken from the text our checkout widget writes ("… Офис Плевен (5803), ул. …") — never from a text the
 * customer typed ("– офис: …") — and only when such an office exists. `deliveryTo` is what the waybill window shows.
 */
async function withOffice(q, order) {
  if (!['econt_office', 'speedy_office', 'boxnow_locker'].includes(order.deliveryType)) {
    return { ...order, deliveryTo: [order.addressText, order.city].filter(Boolean).join(', ') || order.officeText };
  }
  let id = order.officeId;
  if (!id) {
    const text = String(order.officeText || '');
    const code = /–\s*(офис|автомат):/.test(text) ? null : (text.match(/\((\d{1,6})\)(?=,|\s*$)/) || [])[1];
    if (code) id = `${order.courier}:${code}`;
  }
  const [o] = id ? await q(`select id, name, city from zd.offices where id = $1`, [id]) : [];
  if (!o) return { ...order, officeId: order.officeId && order.officeId === id ? order.officeId : '', deliveryTo: order.officeText };
  return { ...order, officeId: o.id, deliveryTo: `${o.name}, ${o.city} (${o.id.split(':')[1]})` };
}

/** The couriers this shop may send with (connected), for an order that came without one. */
async function connectedCouriers(q, shopId) {
  const out = [];
  for (const key of Object.keys(COURIERS)) if (await courierSettings(q, key, shopId)) out.push({ key, name: COURIERS[key].name, address: key !== 'boxnow' });
  return out;
}

/**
 * An order a site sent without one of our couriers (delivery type `other`): the shop picks the courier and an office/locker, or a
 * city + address (Econt, Speedy), before the waybill. Written on the order itself, so everything after works as for any order.
 */
export async function assignRoute(q, { orderId, scopeShopId, scopeShopIds = null, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  if (order.shipment || order.waybillState) throw new Error('Поръчката вече има товарителница');
  const courier = String(input.courier || '');
  if (!courierOf(courier)) throw new Error('Изберете куриер');
  if (!(await courierSettings(q, courier, order.shopId))) throw notConnected(COURIERS[courier]);
  let patch;
  const officeId = String(input.officeId || '');
  if (officeId) {
    const [o] = await q(`select id, name, city, code, is_automat from zd.offices where id = $1 and courier = $2`, [officeId, courier]);
    if (!o) throw new Error('Няма такъв офис на този куриер — изберете от списъка');
    patch = { deliveryType: courier === 'boxnow' ? 'boxnow_locker' : `${courier}_office`, officeId: o.id, officeText: `${o.name}, ${o.city} (${o.code})`, city: o.city, postCode: '', addressText: '' };
  } else {
    const city = String(input.city || '').trim().slice(0, 80), addressText = String(input.addressText || '').trim().slice(0, 200);
    if (courier === 'boxnow') throw new Error('BOX NOW доставя само до автомат — изберете автомат');
    if (!city || !addressText) throw new Error('Изберете офис или въведете град и адрес');
    patch = { deliveryType: `${courier}_address`, officeId: '', officeText: `${COURIERS[courier].name} – адрес: ${addressText}, ${city}`, city, postCode: String(input.postCode || '').trim().slice(0, 12), addressText };
  }
  const rows = await q(
    `update zd.orders set courier = $2, delivery_type = $3, office_id = $4, office_text = $5, city = $6, post_code = $7, address_text = $8
     where id = $1::uuid and waybill_number = '' returning id`,
    [order.id, courier, patch.deliveryType, patch.officeId, patch.officeText, patch.city, patch.postCode, patch.addressText]);
  if (!rows.length) throw new Error('Поръчката вече има товарителница');
  return loadOrder(q, orderId, scopeShopId, scopeShopIds);
}

/** Values for the waybill window. */
export async function waybillDefaults(q, { orderId, scopeShopId, scopeShopIds = null }) {
  const order = await withOffice(q, await loadOrder(q, orderId, scopeShopId, scopeShopIds));
  if (order.deliveryType === 'other' && !order.shipment) return { connected: false, needsRoute: true, courier: 'other', courierName: '', couriers: await connectedCouriers(q, order.shopId) };
  const c = courierOf(order.courier);
  const s = c ? await courierSettings(q, order.courier, order.shopId) : null;
  if (!s) return { connected: false, courier: order.courier, courierName: c?.name || '' };
  const req = c.build(order, s.cfg, {});
  // what the customer already pays for shipping inside the order (total above the items): paid twice if the receiver also pays the courier
  const itemsSum = (order.items || []).reduce((sum, it) => sum + Number(it.price || 0) * (Number(it.qty) || 1), 0);
  const shippingInOrder = Math.max(0, Math.round((Number(order.total) - itemsSum) * 100) / 100);
  const d = c.defaults(req, s.cfg);
  const codTotal = Math.round(Number(order.total) * 100) / 100, codItems = Math.round((codTotal - shippingInOrder) * 100) / 100;
  return {
    connected: true, courier: order.courier, courierName: c.name, demo: s.creds.demo, sender: s.cfg.sender.text, shippingInOrder, codTotal, codItems,
    officeText: c.routeText ? c.routeText(order.deliveryTo, s.cfg) : order.deliveryTo,
    ...d,
    // the customer pays the courier at the office ("receiver"): cash on delivery is the items only, so shipping is never paid twice
    cod: d.payer === 'receiver' && d.cod === codTotal ? codItems : d.cod,
  };
}

export async function previewWaybill(q, { orderId, scopeShopId, scopeShopIds = null, input = {} }) {
  const order = await withOffice(q, await loadOrder(q, orderId, scopeShopId, scopeShopIds));
  const { c, s } = await connectedFor(q, order);
  return { ...(await c.preview(s.creds, c.build(order, s.cfg, input))), demo: s.creds.demo };
}

const unclear = (c) => `Не е ясно дали ${c.name} създаде товарителницата — проверете в ${c.site} и после натиснете „Освободи“ при поръчката`;
const SENDABLE = ['new', 'confirmed', 'shipped'];
const STATUS_BG = { delivered: 'доставена', returned: 'върната', cancelled: 'отказана' };

/**
 * Creates the waybill once: the order is claimed first ('creating'), so a second click cannot make a second waybill.
 * Only a clear refusal from the courier frees the order again; an unclear answer leaves it 'unknown' until a person checks the
 * courier's site and releases it. A live waybill moves new/confirmed → shipped (the earlier status is kept for a cancel); a test one changes nothing.
 */
export async function createWaybill(q, { orderId, scopeShopId, scopeShopIds = null, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  if (order.shipment) throw new Error(`Поръчката вече има товарителница № ${order.shipment.number}`);
  const c0 = courierOf(order.courier);
  if (order.waybillState === 'unknown') throw new Error(unclear(c0 || COURIERS.econt));
  if (!SENDABLE.includes(order.status)) throw new Error(`Поръчката е ${STATUS_BG[order.status]} — товарителница се прави само за поръчка за изпращане`);
  const { c, s } = await connectedFor(q, order);
  if (input.expectDemo !== undefined && Boolean(input.expectDemo) !== s.creds.demo) {
    throw new Error(`Режимът на ${c.name} (реален/тестов) е сменен — затворете прозореца и го отворете отново`);
  }
  const req = c.build(await withOffice(q, order), s.cfg, input);
  // still to be sent at this moment (the customer may have cancelled from their link just now)
  const claimed = await q(`update zd.orders set waybill_number = 'creating', waybill_created_at = now()
     where id = $1::uuid and waybill_number = '' and status = any($2::text[]) returning id`, [order.id, SENDABLE]);
  if (!claimed.length) throw new Error('Товарителницата вече се създава — обновете страницата след малко');
  let w;
  const t0 = Date.now();
  try {
    w = await c.create(s.creds, req);
    console.log('[waybills] courier answered', order.courier, `${Date.now() - t0}ms`); // how long the courier itself takes (the slow part when a shop complains)
  } catch (err) {
    if (err.rejected) { // the courier clearly refused: nothing was created
      await q(`update zd.orders set waybill_number = '' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
      throw err;
    }
    await q(`update zd.orders set waybill_number = 'unknown' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
    console.error('[waybills] unclear courier answer', order.courier, order.id, err.message);
    throw new Error(`${err.message}. ${unclear(c)}${req.orderNumber ? ` (търсете поръчка № ${req.orderNumber})` : ''}`);
  }
  const live = !s.creds.demo;
  try {
    await q(
      `update zd.orders set waybill_number = $2, waybill_courier = $8, waybill_pdf = $3, waybill_price = $4::text::numeric, waybill_currency = $5, waybill_parcels = $9,
         waybill_demo = $6, waybill_status = '', waybill_checked_at = null, waybill_created_at = now(), waybill_prev_status = status,
         waybill_status_changed_at = null, waybill_at_office_since = null, waybill_refresh_at = null,
         status_changed_at = case when $7 and status in ('new', 'confirmed') then now() else status_changed_at end,
         status = case when $7 and status in ('new', 'confirmed') then 'shipped' else status end
       where id = $1::uuid`,
      [order.id, w.number, w.pdf || '', w.price == null ? null : String(w.price), w.currency, s.creds.demo, live, order.courier, (w.parcels || []).join(',')],
    );
  } catch (err) {
    console.error('[waybills] created at the courier but not saved', order.id, w.number, err);
    // keep at least the number: the order must never look free for a second waybill
    await q(`update zd.orders set waybill_number = $2, waybill_courier = $4, waybill_demo = $3, waybill_parcels = $5 where id = $1::uuid`,
      [order.id, w.number, s.creds.demo, order.courier, (w.parcels || []).join(',')])
      .catch((e) => console.error('[waybills] number not saved either', order.id, w.number, e));
    throw new Error(`Товарителница № ${w.number} е създадена в ${c.name}, но не се записа изцяло тук — обновете страницата`);
  }
  if (live) await syncStockSafe(q, order.id);
  const extra = c.after ? await c.after(s.creds, s.cfg, w) : {};
  // remembered on the order, so it is not lost when the window is closed
  const remember = extra.pickupError ? PICKUP_NOTE : extra.statusText;
  if (remember) await q(`update zd.orders set waybill_status = $2 where id = $1::uuid and waybill_number = $3`, [order.id, remember, w.number]).catch(() => {});
  let pdf = w.pdf;
  try { pdf = (await loadOrder(q, order.id, null)).shipment?.pdf || pdf; } catch (err) { console.error('[waybills] reload after create failed', order.id, err.message); }
  return { number: w.number, pdf, price: w.price, currency: w.currency, demo: s.creds.demo, ...extra };
}

/** BOX NOW, sending from a locker: the shop dropped the parcel and tells BOX NOW (once). */
export async function confirmDrop(q, { orderId, scopeShopId, scopeShopIds = null }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  const w = order.shipment;
  if (!w || w.courier !== 'boxnow') throw new Error('Поръчката няма товарителница на BOX NOW');
  if (w.status === DROP_DONE) throw new Error('Пускането в автомата вече е потвърдено');
  const s = await courierSettings(q, 'boxnow', order.shopId);
  if (!s) throw notConnected(COURIERS.boxnow);
  if (Boolean(w.demo) !== s.creds.demo) throw new Error('Режимът на BOX NOW (реален/тестов) е сменен спрямо товарителницата');
  await boxnow.confirmAnyApm(s.creds, w.number);
  await q(`update zd.orders set waybill_status = $2 where id = $1::uuid and waybill_number = $3`, [order.id, DROP_DONE, w.number]);
  return { ok: true };
}

/** After checking the courier's site by hand: frees an order whose waybill creation was unclear (or never finished). */
export async function releaseWaybill(q, { orderId, scopeShopId, scopeShopIds = null }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  if (order.waybillState === 'creating') throw new Error('Товарителницата още се създава — изчакайте две минути');
  if (order.waybillState !== 'unknown') throw new Error('Няма какво да се освобождава');
  await q(`update zd.orders set waybill_number = '', waybill_created_at = null where id = $1::uuid and waybill_number in ('creating', 'unknown')`, [order.id]);
  return { ok: true };
}

/**
 * Cancels at the courier (only possible before it takes the parcel) and frees the order; a live waybill gives the order back the
 * status it had before. A real waybill is cancelled only in real mode; a test one is only removed here when the shop is live
 * (the live login never goes to the test server).
 */
export async function cancelWaybill(q, { orderId, scopeShopId, scopeShopIds = null }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  const w = order.shipment;
  if (!w) throw new Error('Поръчката няма товарителница');
  const c = courierOf(w.courier);
  if (!c) throw new Error('Непознат куриер');
  const s = await courierSettings(q, w.courier, order.shopId);
  if (!w.demo) {
    if (!s) throw notConnected(c);
    if (s.creds.demo) throw new Error(`Това е истинска товарителница — превключете ${c.name} в реален режим, за да я анулирате`);
    await c.cancel(s.creds, w.number);
  } else if (s?.creds.demo) {
    await c.cancel(s.creds, w.number).catch(() => {}); // a test waybill is removed here either way
  }
  const [prev] = await q(`select waybill_prev_status from zd.orders where id = $1::uuid`, [order.id]);
  const back = SENDABLE.includes(prev?.waybill_prev_status) ? prev.waybill_prev_status : 'confirmed';
  await q(
    `update zd.orders set waybill_number = '', waybill_courier = '', waybill_pdf = '', waybill_price = null, waybill_currency = '', waybill_demo = false,
       waybill_status = '', waybill_created_at = null, waybill_checked_at = null, waybill_prev_status = '', waybill_parcels = '', waybill_attempt = waybill_attempt + 1,
       waybill_status_changed_at = null, waybill_at_office_since = null, waybill_refresh_at = null,
       status_changed_at = case when $3 and status = 'shipped' and $4 <> 'shipped' then now() else status_changed_at end,
       status = case when $3 and status = 'shipped' then $4 else status end
     where id = $1::uuid and waybill_number = $2`,
    [order.id, w.number, !w.demo, back],
  );
  if (!w.demo) await syncStockSafe(q, order.id);
  return { ok: true };
}

/** A Speedy waybill / BOX NOW label as PDF (both print only through their API, with the shop's login). */
export async function waybillPdf(q, { orderId, scopeShopId, scopeShopIds = null }) {
  const order = await loadOrder(q, orderId, scopeShopId, scopeShopIds);
  const w = order.shipment;
  if (!w || !['speedy', 'boxnow'].includes(w.courier)) throw new Error('Няма товарителница за печат');
  const s = await courierSettings(q, w.courier, order.shopId);
  if (!s) throw notConnected(COURIERS[w.courier]);
  const pdf = w.courier === 'boxnow' ? await boxnow.labelPdf(s.creds, w.number) : await speedy.printWaybill(s.creds, w.number, s.cfg.paperSize, fetch, w.parcels);
  return { pdf, filename: `tovaritelnica-${w.number}.pdf` };
}

/**
 * One courier answer onto the order: its text (and when the text last changed), the first day at the receiver's office
 * (gone once it no longer waits there), and delivered/returned. Returns the new status when the order moved.
 */
async function applyCourierStatus(q, id, st) {
  await q(`update zd.orders set waybill_checked_at = now(),
     waybill_status = case when waybill_status = any($4::text[]) then waybill_status else $2 end,
     waybill_status_changed_at = case when waybill_status <> all($4::text[]) and waybill_status is distinct from $2 then now() else waybill_status_changed_at end,
     waybill_at_office_since = case when $3::text is null then null else coalesce(waybill_at_office_since, $3::timestamptz) end where id = $1::uuid`,
    [id, String(st.text || '').slice(0, 120), st.atOffice || null, SHOP_NOTES]);
  if (!st.status) return null;
  const moved = await q(`update zd.orders set status = $2, status_changed_at = now() where id = $1::uuid and status = 'shipped' returning id`, [id, st.status]);
  if (!moved.length) return null;
  await syncStockSafe(q, id);
  return st.status;
}

const REFRESH_MINUTES = 30;
const REFRESH_BUDGET_MS = 5000;
/**
 * The buyer opened the order page: ask the courier about this one parcel when the last check is older than 30 minutes.
 * Never for test waybills or unfinished numbers; slow or failing couriers leave the last known state (false).
 */
export async function refreshOrderStatus(q, orderId) {
  let o;
  try {
    // claim the slot before asking: parallel opens and failed answers still mean one courier call per 30 minutes
    [o] = await q(
      `update zd.orders set waybill_refresh_at = now() where id = $1::uuid and status = 'shipped'
         and waybill_number not in ('', 'creating', 'unknown') and not waybill_demo
         and (waybill_checked_at is null or waybill_checked_at < now() - interval '${REFRESH_MINUTES} minutes')
         and (waybill_refresh_at is null or waybill_refresh_at < now() - interval '${REFRESH_MINUTES} minutes')
       returning id, shop_id, waybill_number, waybill_courier`, [orderId]);
    if (!o) return false;
    const c = courierOf(o.waybill_courier);
    const s = c && await courierSettings(q, o.waybill_courier, o.shop_id);
    if (!s || s.creds.demo) return false;
    let timer;
    const answers = await Promise.race([
      c.statuses(s.creds, [o.waybill_number]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('courier too slow')), REFRESH_BUDGET_MS); }),
    ]).finally(() => clearTimeout(timer));
    const st = answers.find((a) => a.number === o.waybill_number);
    if (!st) return false;
    await applyCourierStatus(q, o.id, st);
    return true;
  } catch (err) {
    console.error('[tracking] refresh failed', o?.waybill_courier, err.message);
    return false;
  }
}

/** Shipped orders with a live waybill of this courier → delivered / returned. */
async function syncStatuses(q, key, shopId) {
  const c = courierOf(key);
  const s = await courierSettings(q, key, shopId);
  if (!s) throw new Error(`${c.name} не е свързан`);
  if (s.creds.demo) return { checked: 0, delivered: 0, returned: 0 }; // test waybills never change real orders
  try {
    const rows = await q(
      `select id, waybill_number from zd.orders
       where shop_id = $1::uuid and status = 'shipped' and waybill_courier = $2 and waybill_number not in ('', 'creating', 'unknown')
         and not waybill_demo and waybill_created_at > now() - interval '${SYNC_DAYS} days'
       order by waybill_created_at limit ${SYNC_MAX}`,
      [shopId, key],
    );
    const result = { checked: 0, delivered: 0, returned: 0 };
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const byNumber = new Map(part.map((r) => [r.waybill_number, r.id]));
      for (const st of await c.statuses(s.creds, [...byNumber.keys()])) {
        const id = byNumber.get(st.number);
        if (!id) continue;
        result.checked++;
        const moved = await applyCourierStatus(q, id, st);
        if (moved) result[moved]++;
      }
    }
    await saveIntegration(q, key, { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null }, shopId });
    return result;
  } catch (err) {
    await saveIntegration(q, key, { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() }, shopId });
    throw err;
  }
}

export const syncEcontStatuses = (q, shopId) => syncStatuses(q, 'econt', shopId);
export const syncSpeedyStatuses = (q, shopId) => syncStatuses(q, 'speedy', shopId);
export const syncBoxnowStatuses = (q, shopId) => syncStatuses(q, 'boxnow', shopId);

/**
 * „Обнови статусите“: every connected live courier of the shop, now; one courier failing does not stop the others.
 * No courier is started after `deadline` (ms): the function has 60 s and one courier may take ~25 s.
 */
export async function syncShopStatuses(q, shopId, { deadline = Infinity } = {}) {
  const total = { checked: 0, delivered: 0, returned: 0, errors: [], skipped: [] };
  for (const key of Object.keys(COURIERS)) {
    const s = await courierSettings(q, key, shopId);
    if (!s || s.creds.demo) continue;
    if (Date.now() > deadline) { total.skipped.push(COURIERS[key].name); continue; }
    try {
      const r = await syncStatuses(q, key, shopId);
      total.checked += r.checked; total.delivered += r.delivered; total.returned += r.returned;
    } catch (err) {
      total.errors.push(`${COURIERS[key].name}: ${humanize(err)}`);
    }
  }
  return total;
}
