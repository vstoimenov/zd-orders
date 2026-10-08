// Econt waybills from the admin with the shop's own e-Econt profile: settings, price, create, cancel, nightly status sync.
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { assertReady } from './secretbox.js';
import { getProfile, buildLabel, createLabel, deleteLabels, shipmentStatuses } from './econt-api.js';
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

/** Settings + login of a connected shop, or null. */
async function econtSettings(q, shopId) {
  const i = await getIntegration(q, 'econt', shopId);
  if (!i.hasSecret || i.config.active === false || !i.config.sender) return null;
  const { username, password } = JSON.parse(await getSecret(q, 'econt', shopId));
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

async function connectedFor(q, order) {
  const s = await econtSettings(q, order.shopId);
  if (!s) throw new Error('Първо свържете Еконт в Интеграции → Еконт (товарителници)');
  return s;
}

/** Values for the waybill window. */
export async function waybillDefaults(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  const s = await econtSettings(q, order.shopId);
  if (!s) return { connected: false };
  const label = buildLabel(order, s.cfg, {});
  return {
    connected: true, demo: s.creds.demo, officeText: order.officeText, sender: s.cfg.sender.text,
    cod: label.services?.cdAmount ?? 0, weight: label.weight, packCount: label.packCount, description: label.shipmentDescription,
    payer: s.cfg.payer || 'receiver', review: Boolean(s.cfg.review),
  };
}

export async function previewWaybill(q, { orderId, scopeShopId, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  const s = await connectedFor(q, order);
  const p = await createLabel(s.creds, buildLabel(order, s.cfg, input), 'calculate');
  return { price: p.price, currency: p.currency, receiverDue: p.receiverDue, senderDue: p.senderDue, demo: s.creds.demo };
}

const UNCLEAR = 'Не е ясно дали Еконт създаде товарителницата — проверете в e-Econt и после натиснете „Освободи“ при поръчката';
const SENDABLE = ['new', 'confirmed', 'shipped'];
const STATUS_BG = { delivered: 'доставена', returned: 'върната', cancelled: 'отказана' };

/**
 * Creates the Econt waybill once: the order is claimed first ('creating'), so a second click cannot make a second waybill.
 * Only a clear refusal from Econt frees the order again; an unclear answer leaves it 'unknown' until a person checks e-Econt
 * and releases it. A live waybill moves new/confirmed → shipped (the earlier status is kept for a cancel); a test one changes nothing.
 */
export async function createWaybill(q, { orderId, scopeShopId, input = {} }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  if (order.shipment) throw new Error(`Поръчката вече има товарителница № ${order.shipment.number}`);
  if (order.waybillState === 'unknown') throw new Error(UNCLEAR);
  if (!SENDABLE.includes(order.status)) throw new Error(`Поръчката е ${STATUS_BG[order.status]} — товарителница се прави само за поръчка за изпращане`);
  const s = await connectedFor(q, order);
  if (input.expectDemo !== undefined && Boolean(input.expectDemo) !== s.creds.demo) {
    throw new Error('Режимът на Еконт (реален/тестов) е сменен — затворете прозореца и го отворете отново');
  }
  const label = buildLabel(order, s.cfg, input);
  const claimed = await q(`update zd.orders set waybill_number = 'creating', waybill_created_at = now() where id = $1::uuid and waybill_number = '' returning id`, [order.id]);
  if (!claimed.length) throw new Error('Товарителницата вече се създава — обновете страницата след малко');
  let w;
  try {
    w = await createLabel(s.creds, label, 'create');
  } catch (err) {
    if (err.rejected) { // Econt clearly refused: nothing was created
      await q(`update zd.orders set waybill_number = '' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
      throw err;
    }
    await q(`update zd.orders set waybill_number = 'unknown' where id = $1::uuid and waybill_number = 'creating'`, [order.id]);
    console.error('[waybills] unclear Econt answer', order.id, err.message);
    throw new Error(`${err.message}. ${UNCLEAR}`);
  }
  const live = !s.creds.demo;
  try {
    await q(
      `update zd.orders set waybill_number = $2, waybill_courier = 'econt', waybill_pdf = $3, waybill_price = $4::text::numeric, waybill_currency = $5,
         waybill_demo = $6, waybill_status = '', waybill_checked_at = null, waybill_created_at = now(), waybill_prev_status = status,
         status_changed_at = case when $7 and status in ('new', 'confirmed') then now() else status_changed_at end,
         status = case when $7 and status in ('new', 'confirmed') then 'shipped' else status end
       where id = $1::uuid`,
      [order.id, w.number, w.pdf || '', String(w.price), w.currency, s.creds.demo, live],
    );
  } catch (err) {
    console.error('[waybills] created at Econt but not saved', order.id, w.number, err);
    // keep at least the number: the order must never look free for a second waybill
    await q(`update zd.orders set waybill_number = $2, waybill_courier = 'econt', waybill_demo = $3 where id = $1::uuid`, [order.id, w.number, s.creds.demo])
      .catch((e) => console.error('[waybills] number not saved either', order.id, w.number, e));
    throw new Error(`Товарителница № ${w.number} е създадена в Еконт, но не се записа изцяло тук — обновете страницата`);
  }
  if (live) await syncStockSafe(q, order.id);
  return { number: w.number, pdf: w.pdf, price: w.price, currency: w.currency, demo: s.creds.demo };
}

/** After checking e-Econt by hand: frees an order whose waybill creation was unclear (or never finished). */
export async function releaseWaybill(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  if (order.waybillState === 'creating') throw new Error('Товарителницата още се създава — изчакайте две минути');
  if (order.waybillState !== 'unknown') throw new Error('Няма какво да се освобождава');
  await q(`update zd.orders set waybill_number = '', waybill_created_at = null where id = $1::uuid and waybill_number in ('creating', 'unknown')`, [order.id]);
  return { ok: true };
}

/**
 * Cancels at Econt (only possible before the courier takes it) and frees the order; a live waybill gives the order back the
 * status it had before. A real waybill is cancelled only in real mode; a test one is only removed here when the shop is live
 * (the live login never goes to the test server).
 */
export async function cancelWaybill(q, { orderId, scopeShopId }) {
  const order = await loadOrder(q, orderId, scopeShopId);
  const w = order.shipment;
  if (!w) throw new Error('Поръчката няма товарителница');
  const s = await econtSettings(q, order.shopId);
  if (!w.demo) {
    if (!s) throw new Error('Първо свържете Еконт в Интеграции → Еконт (товарителници)');
    if (s.creds.demo) throw new Error('Това е истинска товарителница — превключете Еконт в реален режим, за да я анулирате');
    await deleteLabels(s.creds, [w.number]);
  } else if (s?.creds.demo) {
    await deleteLabels(s.creds, [w.number]).catch(() => {}); // a test waybill is removed here either way
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

/** Shipped orders with an Econt waybill (same mode as the shop: live or test) → delivered / returned. */
export async function syncEcontStatuses(q, shopId) {
  const s = await econtSettings(q, shopId);
  if (!s) throw new Error('Еконт не е свързан');
  if (s.creds.demo) return { checked: 0, delivered: 0, returned: 0 }; // test waybills never change real orders
  try {
    const rows = await q(
      `select id, waybill_number from zd.orders
       where shop_id = $1::uuid and status = 'shipped' and waybill_courier = 'econt' and waybill_number not in ('', 'creating')
         and not waybill_demo and waybill_created_at > now() - interval '${SYNC_DAYS} days'
       order by waybill_created_at limit ${SYNC_MAX}`,
      [shopId],
    );
    const result = { checked: 0, delivered: 0, returned: 0 };
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const byNumber = new Map(part.map((r) => [r.waybill_number, r.id]));
      for (const st of await shipmentStatuses(s.creds, [...byNumber.keys()])) {
        const id = byNumber.get(st.number);
        if (!id) continue;
        result.checked++;
        await q(`update zd.orders set waybill_status = $2, waybill_checked_at = now() where id = $1::uuid`, [id, st.text.slice(0, 120)]);
        if (!st.status) continue;
        const moved = await q(`update zd.orders set status = $2, status_changed_at = now() where id = $1::uuid and status = 'shipped' returning id`, [id, st.status]);
        if (moved.length) { result[st.status]++; await syncStockSafe(q, id); }
      }
    }
    await saveIntegration(q, 'econt', { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null }, shopId });
    return result;
  } catch (err) {
    await saveIntegration(q, 'econt', { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() }, shopId });
    throw err;
  }
}
