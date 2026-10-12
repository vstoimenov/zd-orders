// Web Push: a notification on the owner's phone (admin added to the home screen) for every new order.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (Vercel env). Without them nothing is sent and nothing fails.
import webpush from 'web-push';

const SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:admin@profitbrand.online';
export const pushConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';
// only the browsers' own push services: our server never posts to an address someone typed in
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/i;
const MAX_WAIT_MS = 2000; // a slow push service must not hold up an order (the checkout waits for it)
const ADMIN = () => process.env.PUSH_ADMIN_PATH || '/admin/'; // the public demo opens /demo/
const MAX_FAILURES = 5; // a device that keeps failing (e.g. subscribed with an old key) is dropped
const FRESH_HOURS = 6;

let sender = null;
/** Tests replace the push service. */
export function setPushSenderForTests(fn) { sender = fn; }

function send(row, payload, waitMs) {
  const s = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  if (sender) return sender(s, payload);
  return webpush.sendNotification(s, payload, {
    TTL: 24 * 3600, urgency: 'high', timeout: waitMs,
    vapidDetails: { subject: SUBJECT(), publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY },
  });
}

function validEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint || ''));
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && u.href.length <= 1000;
  } catch { return false; }
}

/** userId: a client's device (its "all shops" = only that client's shops); null = the owner's. */
export async function saveSubscription(q, { subscription, shopId = null, userAgent = '', userId = null }) {
  const s = subscription || {};
  if (!validEndpoint(s.endpoint)) throw new Error('Непозната услуга за известия — отворете админа в Chrome или Safari');
  const p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
  if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100) throw new Error('Липсва ключ на известията — опитайте отново');
  await q(
    `insert into zd.push_subscriptions (endpoint, p256dh, auth, shop_id, user_agent, user_id) values ($1, $2, $3, $4::uuid, $5, $6::uuid)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, shop_id = excluded.shop_id,
       user_agent = excluded.user_agent, user_id = excluded.user_id, failures = 0`,
    [s.endpoint, p256dh, auth, shopId, String(userAgent).slice(0, 300), userId],
  );
}

// ownerOf: a client only ever touches their own devices (null = the owner, any device)
const MINE = `($2::uuid is null or user_id = $2::uuid)`;

export async function removeSubscription(q, endpoint, ownerOf = null) {
  await q(`delete from zd.push_subscriptions where endpoint = $1 and ${MINE}`, [String(endpoint || ''), ownerOf]);
}

export async function subscriptionStatus(q, endpoint, ownerOf = null) {
  const [r] = await q(`select shop_id from zd.push_subscriptions where endpoint = $1 and ${MINE}`, [String(endpoint || ''), ownerOf]);
  return r ? { subscribed: true, shopId: r.shop_id } : { subscribed: false, shopId: null };
}

/**
 * Sends to these devices (payload may depend on the device); returns how many arrived. A device the push service no longer
 * knows (404/410), or one that failed MAX_FAILURES times in a row, is removed. Never throws, never waits longer than waitMs.
 */
async function deliver(q, rows, payloadFor, { waitMs = MAX_WAIT_MS } = {}) {
  const results = await Promise.all(rows.map(async (row) => {
    let timer;
    try {
      const timeout = new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), waitMs); });
      await Promise.race([send(row, JSON.stringify(payloadFor(row)), waitMs), timeout]);
      await q(`update zd.push_subscriptions set last_sent_at = now(), failures = 0 where id = $1`, [row.id]).catch(() => {});
      return true;
    } catch (err) {
      if ([404, 410].includes(err?.statusCode)) {
        await q(`delete from zd.push_subscriptions where id = $1`, [row.id]).catch(() => {});
      } else {
        console.error('[push] send failed', err?.statusCode || err?.message);
        await q(`update zd.push_subscriptions set failures = failures + 1 where id = $1`, [row.id]).catch(() => {});
        await q(`delete from zd.push_subscriptions where id = $1 and failures >= ${MAX_FAILURES}`, [row.id]).catch(() => {});
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }));
  return results.filter(Boolean).length;
}

const money = (v, currency) => `${Number(v).toFixed(2).replace('.', ',')} ${currency === 'EUR' ? '€' : currency}`;
const shortPlace = (t) => String(t || '').split(',')[0].trim().slice(0, 80);

/** "🛒 Нова поръчка" on every device of the order's shop (and the "all shops" devices). Never throws, never waits long. */
export async function notifyNewOrder(q, orderId, { maxWaitMs = MAX_WAIT_MS } = {}) {
  if (!pushConfigured() || !orderId) return;
  try {
    const [o] = await q(
      `select o.id, o.name, o.total, o.currency, o.office_text, o.shop_id, s.name as shop_name
       from zd.orders o join zd.shops s on s.id = o.shop_id
       where o.id = $1::uuid and o.created_at > now() - interval '${FRESH_HOURS} hours'`, [orderId]); // a sync of old orders stays quiet
    if (!o) return;
    // the owner's devices (no user); a client's devices only while that client is active and still has this shop
    const rows = await q(
      `select p.id, p.endpoint, p.p256dh, p.auth, p.shop_id from zd.push_subscriptions p
       where (p.shop_id is null or p.shop_id = $1::uuid)
         and (p.user_id is null or exists (select 1 from zd.users u join zd.user_shops us on us.user_id = u.id
                                            where u.id = p.user_id and u.active and us.shop_id = $1::uuid))`, [o.shop_id]);
    if (!rows.length) return;
    const base = {
      title: `🛒 Нова поръчка${o.shop_name ? ` · ${o.shop_name}` : ''}`,
      body: [o.name || 'Клиент', money(o.total, o.currency), shortPlace(o.office_text)].filter(Boolean).join(' · '),
      tag: o.id,
    };
    // an "all shops" device opens the orders as they are; a shop's device opens that shop
    await deliver(q, rows, (row) => ({ ...base, url: row.shop_id ? `${ADMIN()}?shop=${o.shop_id}#orders` : `${ADMIN()}#orders` }), { waitMs: maxWaitMs });
  } catch (err) {
    console.error('[push] new order notification failed', err?.message);
  }
}

/** A message for every device that follows this shop (the owner's and the shop's clients'). Never throws. */
export async function notifyShop(q, shopId, { title, body, url }) {
  if (!pushConfigured() || !shopId) return;
  try {
    const rows = await q(
      `select p.id, p.endpoint, p.p256dh, p.auth, p.shop_id from zd.push_subscriptions p
       where (p.shop_id is null or p.shop_id = $1::uuid)
         and (p.user_id is null or exists (select 1 from zd.users u join zd.user_shops us on us.user_id = u.id
                                            where u.id = p.user_id and u.active and us.shop_id = $1::uuid))`, [shopId]);
    if (rows.length) await deliver(q, rows, (row) => ({ title, body, tag: `shop-${Date.now()}`, url: url || (row.shop_id ? `${ADMIN()}?shop=${shopId}#orders` : `${ADMIN()}#orders`) }));
  } catch (err) {
    console.error('[push] shop notification failed', err?.message);
  }
}

const ALERT_HOURS = 6;
/** "A customer reached the checkout but there is no shipping method for the cart" — at most once every few hours per shop. */
export async function alertNoShipping(q, shopId, site) {
  if (!shopId) return;
  try {
    const key = `alert_noship:${shopId}`;
    const fresh = await q(
      `insert into zd.settings (key, value) values ($1, jsonb_build_object('at', now()))
       on conflict (key) do update set value = excluded.value
       where (zd.settings.value->>'at')::timestamptz < now() - interval '${ALERT_HOURS} hours' returning key`, [key]);
    if (!fresh.length) return; // alerted recently
    await notifyShop(q, shopId, {
      title: '⚠️ Няма метод за доставка в чекаута',
      body: `Клиент стигна до чекаута на ${site}, но ConvertBuilder не предлага доставка за количката му — проверете цените за доставка (напр. над определена сума).`,
    });
  } catch (err) {
    console.error('[push] no-shipping alert failed', err?.message);
  }
}

/** Something happened to an order (e.g. the customer confirmed it): the same devices as for a new order, without the freshness rule. */
export async function notifyOrderEvent(q, orderId, title) {
  if (!pushConfigured() || !orderId) return;
  try {
    const [o] = await q(`select id, name, total, currency, shop_id from zd.orders where id = $1::uuid`, [orderId]);
    if (!o) return;
    const rows = await q(
      `select p.id, p.endpoint, p.p256dh, p.auth, p.shop_id from zd.push_subscriptions p
       where (p.shop_id is null or p.shop_id = $1::uuid)
         and (p.user_id is null or exists (select 1 from zd.users u join zd.user_shops us on us.user_id = u.id
                                            where u.id = p.user_id and u.active and us.shop_id = $1::uuid))`, [o.shop_id]);
    if (rows.length) {
      await deliver(q, rows, (row) => ({ title, body: `${o.name || 'Клиент'} · ${money(o.total, o.currency)}`, tag: `${o.id}-event`,
        url: row.shop_id ? `${ADMIN()}?shop=${o.shop_id}#orders` : `${ADMIN()}#orders` }));
    }
  } catch (err) {
    console.error('[push] order event failed', err?.message);
  }
}

/** A message for the owner's own devices (e.g. a new registration). Never throws. */
export async function notifyOwner(q, { title, body, url }) {
  if (!pushConfigured()) return;
  try {
    const rows = await q(`select id, endpoint, p256dh, auth from zd.push_subscriptions where user_id is null`);
    if (rows.length) await deliver(q, rows, () => ({ title, body, url: url || `${ADMIN()}#orders`, tag: `owner-${Date.now()}` }));
  } catch (err) {
    console.error('[push] owner notification failed', err?.message);
  }
}

/** A test notification to one device. */
export async function testPush(q, endpoint, ownerOf = null) {
  const rows = await q(`select id, endpoint, p256dh, auth from zd.push_subscriptions where endpoint = $1 and ${MINE}`, [String(endpoint || ''), ownerOf]);
  if (!rows.length) throw new Error('Това устройство не е включено за известия');
  const ok = await deliver(q, rows, () => ({ title: '🔔 Пробно известие', body: 'Известията работят — така ще идват новите поръчки.', url: `${ADMIN()}#orders`, tag: 'test' }), { waitMs: 8000 });
  if (!ok) throw new Error('Известието не стигна до устройството — изключете и включете известията отново');
}
