// Web Push: a notification on the owner's phone (admin added to the home screen) for every new order.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (Vercel env). Without them nothing is sent and nothing fails.
import webpush from 'web-push';

const SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:admin@profitbrand.online';
export const pushConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';
// only the browsers' own push services: our server never posts to an address someone typed in
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/i;
const MAX_WAIT_MS = 4000; // a slow push service must not hold up an order
const FRESH_HOURS = 6;

let sender = null;
/** Tests replace the push service. */
export function setPushSenderForTests(fn) { sender = fn; }

function send(row, payload) {
  const s = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  if (sender) return sender(s, payload);
  return webpush.sendNotification(s, payload, {
    TTL: 24 * 3600, urgency: 'high', timeout: MAX_WAIT_MS,
    vapidDetails: { subject: SUBJECT(), publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY },
  });
}

function validEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint || ''));
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && u.href.length <= 1000;
  } catch { return false; }
}

export async function saveSubscription(q, { subscription, shopId = null, userAgent = '' }) {
  const s = subscription || {};
  if (!validEndpoint(s.endpoint)) throw new Error('Непозната услуга за известия — отворете админа в Chrome или Safari');
  const p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
  if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100) throw new Error('Липсва ключ на известията — опитайте отново');
  await q(
    `insert into zd.push_subscriptions (endpoint, p256dh, auth, shop_id, user_agent) values ($1, $2, $3, $4::uuid, $5)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, shop_id = excluded.shop_id,
       user_agent = excluded.user_agent, failures = 0`,
    [s.endpoint, p256dh, auth, shopId, String(userAgent).slice(0, 300)],
  );
}

export async function removeSubscription(q, endpoint) {
  await q(`delete from zd.push_subscriptions where endpoint = $1`, [String(endpoint || '')]);
}

export async function subscriptionStatus(q, endpoint) {
  const [r] = await q(`select shop_id from zd.push_subscriptions where endpoint = $1`, [String(endpoint || '')]);
  return r ? { subscribed: true, shopId: r.shop_id } : { subscribed: false, shopId: null };
}

/** Sends to these devices; a device the push service no longer knows (404/410) is removed. Never throws. */
async function deliver(q, rows, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async (row) => {
    try {
      await Promise.race([send(row, body), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), MAX_WAIT_MS))]);
      await q(`update zd.push_subscriptions set last_sent_at = now(), failures = 0 where id = $1`, [row.id]);
    } catch (err) {
      if ([404, 410].includes(err?.statusCode)) {
        await q(`delete from zd.push_subscriptions where id = $1`, [row.id]).catch(() => {});
      } else {
        console.error('[push] send failed', err?.statusCode || err?.message);
        await q(`update zd.push_subscriptions set failures = failures + 1 where id = $1`, [row.id]).catch(() => {});
      }
    }
  }));
}

const money = (v, currency) => `${Number(v).toFixed(2).replace('.', ',')} ${currency === 'EUR' ? '€' : currency}`;
const shortPlace = (t) => String(t || '').split(',')[0].trim().slice(0, 80);

/** "🛒 Нова поръчка" on every device of the order's shop (and the "all shops" devices). Never throws, never waits long. */
export async function notifyNewOrder(q, orderId) {
  if (!pushConfigured() || !orderId) return;
  try {
    const [o] = await q(
      `select o.id, o.name, o.total, o.currency, o.office_text, o.shop_id, s.name as shop_name
       from zd.orders o join zd.shops s on s.id = o.shop_id
       where o.id = $1::uuid and o.created_at > now() - interval '${FRESH_HOURS} hours'`, [orderId]); // a sync of old orders stays quiet
    if (!o) return;
    const rows = await q(`select id, endpoint, p256dh, auth from zd.push_subscriptions where shop_id is null or shop_id = $1::uuid`, [o.shop_id]);
    if (!rows.length) return;
    await deliver(q, rows, {
      title: `🛒 Нова поръчка${o.shop_name ? ` · ${o.shop_name}` : ''}`,
      body: [o.name || 'Клиент', money(o.total, o.currency), shortPlace(o.office_text)].filter(Boolean).join(' · '),
      url: `/admin/?shop=${o.shop_id}#orders`, tag: o.id,
    });
  } catch (err) {
    console.error('[push] new order notification failed', err?.message);
  }
}

/** A test notification to one device. */
export async function testPush(q, endpoint) {
  const rows = await q(`select id, endpoint, p256dh, auth from zd.push_subscriptions where endpoint = $1`, [String(endpoint || '')]);
  if (!rows.length) throw new Error('Това устройство не е включено за известия');
  await deliver(q, rows, { title: '🔔 Пробно известие', body: 'Известията работят — така ще идват новите поръчки.', url: '/admin/#orders', tag: 'test' });
}
