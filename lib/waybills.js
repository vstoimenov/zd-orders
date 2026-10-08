// Courier waybills from the admin with the shop's own courier login: Econt (e-Econt profile) and Speedy (API user of its contract).
// Settings, price, create, cancel, print, nightly status sync — one set of rules for both couriers.
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { assertReady } from './secretbox.js';
import { getProfile, buildLabel, createLabel, deleteLabels, shipmentStatuses } from './econt-api.js';
import * as speedy from './speedy-api.js';
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

/** Admin: profile name, phones and addresses (for choosing the sender address). */
export async function econtProfile(q, shopId, b) {
  const { creds } = await credentials(q, shopId, b);
  const p = await getProfile(creds);
  return { name: p.name, company: p.company, phones: p.phones, addresses: p.addresses.map((a) => ({ id: a.id, text: a.text })) };
}

/** Saves a shop's Econt settings after checking the profile at Econt. Switching off needs no working login. */
export async function saveEcont(q, shopId, b) {
  assertReady();
  if (b.active === false) {
    await saveIntegration(q, 'econt', { config: { active: false }, shopId });
    return { active: false };
  }
  const { creds, typed } = await credentials(q, shopId, b);
  const payer = b.payer === 'sender' ? 'sender' : 'receiver';
  const weight = Number(String(b.weight ?? '1').replace(',', '.'));
  if (!(weight > 0 && weight <= 50)) throw new Error('Тегло по подразбиране: от 0,01 до 50 кг');
  const description = t(b.description);
  if (description.length > 100) throw new Error('Описанието е до 100 знака');
  const senderName = t(b.senderName).slice(0, 80);
  const senderAgent = t(b.senderAgent).slice(0, 80);

  const profile = await getProfile(creds);
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

  await saveIntegration(q, 'econt', {
    config: {
      username: creds.username, demo: creds.demo, profileName: profile.name, profileCompany: profile.company, sender, senderName, senderAgent, senderPhone, payer, weight, description,
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
    username: c.username || '', demo: Boolean(c.demo), profileName: c.profileName || '',
    sender: c.sender ? { type: c.sender.type, officeCode: c.sender.officeCode || '', addressId: c.sender.addressId || '', text: c.sender.text || '' } : null,
    senderName: c.senderName || '', senderAgent: c.senderAgent || '', profileCompany: Boolean(c.profileCompany), senderPhone: c.senderPhone || '', payer: c.payer || 'receiver', weight: c.weight ?? 1,
    description: c.description || '', review: Boolean(c.review),
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
  const payer = b.payer === 'sender' ? 'sender' : 'receiver';
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
  const senderContact = t(b.senderContact).slice(0, 60);
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

export async function speedyStatus(q, shopId) {
  const i = await getIntegration(q, 'speedy', shopId);
  const c = i.config;
  return {
    configured: i.hasSecret, connected: i.hasSecret && c.active !== false && Boolean(c.sender && c.clientId), active: c.active !== false,
    username: c.username || '', clientId: c.clientId || null, profileName: c.clientName || '', clientCompany: Boolean(c.clientCompany),
    sender: c.sender ? { type: c.sender.type, officeId: c.sender.officeId || null, text: c.sender.text || '' } : null,
    senderPhone: c.senderPhone || '', senderContact: c.senderContact || '', payer: c.payer || 'receiver', weight: c.weight ?? 1,
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
      payer: cfg.payer || 'receiver', review: Boolean(cfg.review),
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
    cancel: (creds, number) => speedy.cancelShipment(creds, number),
    statuses: (creds, numbers) => speedy.shipmentStatuses(creds, numbers),
    defaults: (shipment, cfg) => ({
      cod: shipment.service.additionalServices?.cod?.amount ?? 0, weight: shipment.content.totalWeight, packCount: shipment.content.parcelsCount,
      description: shipment.content.contents, payer: cfg.payer || 'receiver', review: Boolean(cfg.review),
    }),
  },
};
const courierOf = (key) => (Object.hasOwn(COURIERS, key) ? COURIERS[key] : null);

/** Settings + login of a shop connected to this courier, or null. */
async function courierSettings(q, key, shopId) {
  const c = courierOf(key);
  if (!c) return null;
  const i = await getIntegration(q, key, shopId);
  if (!i.hasSecret || i.config.active === false || !c.ready(i.config)) return null;
  const { username, password } = JSON.parse(await getSecret(q, key, shopId));
  return { cfg: i.config, creds: { username, password, demo: Boolean(i.config.demo) } };
}

/** The order within the admin's shop (null scope = all shops). */
async function loadOrder(q, orderId, scopeShopId) {
  const [r] = UUID.test(String(orderId || ''))
    ? await q(`select * from zd.orders where id = $1::uuid and ($2::text is null or shop_id = $2::uuid)`, [orderId, scopeShopId || null])
    : [];
  if (!r) throw new Error('Няма такава поръчка');
  return toOrder(r);
}

const notConnected = (c) => new Error(`Първо свържете ${c.name} в Интеграции → ${c.name} (товарителници)`);

async function connectedFor(q, order) {
  const c = courierOf(order.courier);
  if (!c) throw new Error('Товарителници има само за Еконт и Спиди');
  const s = await courierSettings(q, order.courier, order.shopId);
  if (!s) throw notConnected(c);
  return { c, s };
}

const deliveryText = (order) => (order.deliveryType === 'speedy_address' ? [order.addressText, order.city].filter(Boolean).join(', ') || order.officeText : order.officeText);

/** Values for the waybill window. */
export async function waybillDefaults(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  const c = courierOf(order.courier);
  const s = c ? await courierSettings(q, order.courier, order.shopId) : null;
  if (!s) return { connected: false, courier: order.courier, courierName: c?.name || '' };
  const req = c.build(order, s.cfg, {});
  return {
    connected: true, courier: order.courier, courierName: c.name, demo: s.creds.demo, officeText: deliveryText(order), sender: s.cfg.sender.text,
    ...c.defaults(req, s.cfg),
  };
}

export async function previewWaybill(q, { orderId, scopeShopId, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId);
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
export async function createWaybill(q, { orderId, scopeShopId, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  if (order.shipment) throw new Error(`Поръчката вече има товарителница № ${order.shipment.number}`);
  const c0 = courierOf(order.courier);
  if (order.waybillState === 'unknown') throw new Error(unclear(c0 || COURIERS.econt));
  if (!SENDABLE.includes(order.status)) throw new Error(`Поръчката е ${STATUS_BG[order.status]} — товарителница се прави само за поръчка за изпращане`);
  const { c, s } = await connectedFor(q, order);
  if (input.expectDemo !== undefined && Boolean(input.expectDemo) !== s.creds.demo) {
    throw new Error(`Режимът на ${c.name} (реален/тестов) е сменен — затворете прозореца и го отворете отново`);
  }
  const req = c.build(order, s.cfg, input);
  const claimed = await q(`update zd.orders set waybill_number = 'creating', waybill_created_at = now() where id = $1::uuid and waybill_number = '' returning id`, [order.id]);
  if (!claimed.length) throw new Error('Товарителницата вече се създава — обновете страницата след малко');
  let w;
  try {
    w = await c.create(s.creds, req);
  } catch (err) {
    if (err.rejected) { // the courier clearly refused: nothing was created
      await q(`update zd.orders set waybill_number = '' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
      throw err;
    }
    await q(`update zd.orders set waybill_number = 'unknown' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
    console.error('[waybills] unclear courier answer', order.courier, order.id, err.message);
    throw new Error(`${err.message}. ${unclear(c)}`);
  }
  const live = !s.creds.demo;
  try {
    await q(
      `update zd.orders set waybill_number = $2, waybill_courier = $8, waybill_pdf = $3, waybill_price = $4::text::numeric, waybill_currency = $5,
         waybill_demo = $6, waybill_status = '', waybill_checked_at = null, waybill_created_at = now(), waybill_prev_status = status,
         status_changed_at = case when $7 and status in ('new', 'confirmed') then now() else status_changed_at end,
         status = case when $7 and status in ('new', 'confirmed') then 'shipped' else status end
       where id = $1::uuid`,
      [order.id, w.number, w.pdf || '', String(w.price), w.currency, s.creds.demo, live, order.courier],
    );
  } catch (err) {
    console.error('[waybills] created at the courier but not saved', order.id, w.number, err);
    // keep at least the number: the order must never look free for a second waybill
    await q(`update zd.orders set waybill_number = $2, waybill_courier = $4, waybill_demo = $3 where id = $1::uuid`, [order.id, w.number, s.creds.demo, order.courier])
      .catch((e) => console.error('[waybills] number not saved either', order.id, w.number, e));
    throw new Error(`Товарителница № ${w.number} е създадена в ${c.name}, но не се записа изцяло тук — обновете страницата`);
  }
  if (live) await syncStockSafe(q, order.id);
  const saved = (await loadOrder(q, order.id, null)).shipment;
  return { number: w.number, pdf: saved?.pdf || w.pdf, price: w.price, currency: w.currency, demo: s.creds.demo };
}

/** After checking the courier's site by hand: frees an order whose waybill creation was unclear (or never finished). */
export async function releaseWaybill(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
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
export async function cancelWaybill(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
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
       waybill_status = '', waybill_created_at = null, waybill_checked_at = null, waybill_prev_status = '',
       status_changed_at = case when $3 and status = 'shipped' and $4 <> 'shipped' then now() else status_changed_at end,
       status = case when $3 and status = 'shipped' then $4 else status end
     where id = $1::uuid and waybill_number = $2`,
    [order.id, w.number, !w.demo, back],
  );
  if (!w.demo) await syncStockSafe(q, order.id);
  return { ok: true };
}

/** A Speedy waybill as PDF (Speedy prints only through the API, with the shop's login). */
export async function waybillPdf(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  const w = order.shipment;
  if (!w || w.courier !== 'speedy') throw new Error('Няма товарителница на Спиди за печат');
  const s = await courierSettings(q, 'speedy', order.shopId);
  if (!s) throw notConnected(COURIERS.speedy);
  return { pdf: await speedy.printWaybill(s.creds, w.number, s.cfg.paperSize), filename: `tovaritelnica-${w.number}.pdf` };
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
        await q(`update zd.orders set waybill_status = $2, waybill_checked_at = now() where id = $1::uuid`, [id, st.text.slice(0, 120)]);
        if (!st.status) continue;
        const moved = await q(`update zd.orders set status = $2, status_changed_at = now() where id = $1::uuid and status = 'shipped' returning id`, [id, st.status]);
        if (moved.length) { result[st.status]++; await syncStockSafe(q, id); }
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
