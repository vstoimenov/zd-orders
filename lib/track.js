// Ordyx's own marketing: Meta Pixel + Conversions API, GA4 (gtag + Measurement Protocol) and Search Console for ordyx.eu.
// The owner sets the ids in „Профил → Проследяване“; the CAPI token and the GA4 API secret are sealed in zd.settings `tracking`.
// The browser tags load only after the visitor accepts cookies; the server events are sent only for a person who accepted them.
import { createHash, randomUUID } from 'node:crypto';
import { seal, open } from './secretbox.js';
import { GRAPH } from './meta.js';

const KEY = 'tracking';
const PIXEL = /^\d{8,20}$/;
const GA4 = /^G-[A-Z0-9]{4,16}$/;
const GSC = /^google[0-9a-f]{8,32}$/i; // the HTML-file method: google1234abcd.html
const sha = (v) => createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});

async function read(q) {
  const [r] = await q(`select value from zd.settings where key = $1`, [KEY]);
  return r ? json(r.value) : {};
}

/** For the owner's form: the ids, and only whether each secret is set (never the secret itself). */
export async function trackingSettings(q) {
  const s = await read(q);
  return { pixelId: s.pixelId || '', ga4Id: s.ga4Id || '', gscFile: s.gscFile || '', testCode: s.testCode || '', capiSet: Boolean(s.capi), ga4SecretSet: Boolean(s.ga4Secret) };
}

/** Saves what the owner typed: an empty secret keeps the stored one, `clear*` removes it. */
export async function saveTracking(q, b = {}) {
  const s = await read(q);
  const t = (v) => String(v ?? '').trim();
  const pixelId = t(b.pixelId), ga4Id = t(b.ga4Id).toUpperCase(), gscFile = t(b.gscFile).replace(/\.html$/i, ''), testCode = t(b.testCode).slice(0, 40);
  if (pixelId && !PIXEL.test(pixelId)) throw new Error('Meta Pixel ID е само цифри (напр. 1150537077523379)');
  if (ga4Id && !GA4.test(ga4Id)) throw new Error('GA4 Measurement ID започва с G- (напр. G-ABC123XYZ)');
  if (gscFile && !GSC.test(gscFile)) throw new Error('Файлът от Search Console изглежда като google1234abcd.html');
  const next = { ...s, pixelId, ga4Id, gscFile, testCode };
  if (t(b.capiToken)) next.capi = seal(t(b.capiToken));
  if (b.clearCapi === true) delete next.capi;
  if (t(b.ga4Secret)) next.ga4Secret = seal(t(b.ga4Secret));
  if (b.clearGa4Secret === true) delete next.ga4Secret;
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [KEY, JSON.stringify(next)]);
  return trackingSettings(q);
}

/** Public: what the browser needs (ids only). */
export async function publicTracking(q) {
  const s = await read(q);
  return { pixelId: s.pixelId || null, ga4Id: s.ga4Id || null };
}

/** Public: the Search Console verification file, when its name is the stored one. */
export async function gscFile(q, name) {
  const s = await read(q);
  const n = String(name || '').replace(/\.html$/i, '');
  return s.gscFile && n.toLowerCase() === String(s.gscFile).toLowerCase() ? `google-site-verification: ${s.gscFile}.html` : null;
}

/** The ids of a browser from its cookies (first-party on .ordyx.eu): Meta _fbp/_fbc and the GA4 client id from _ga. */
export function browserIds(cookieHeader = '') {
  const c = Object.fromEntries(String(cookieHeader).split(';').map((x) => x.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const ga = /^GA\d\.\d\.(\d+\.\d+)$/.exec(c._ga || '');
  return { fbp: /^fb\.\d\.\d+\.\d+$/.test(c._fbp || '') ? c._fbp : null, fbc: /^fb\.\d\.\d+\..+$/.test(c._fbc || '') ? c._fbc : null, ga: ga ? ga[1] : null };
}

/**
 * One conversion to Meta (CAPI) and GA4 (Measurement Protocol) from the server. `who` = { email, name, ip, ua, fbp, fbc, ga }.
 * Never throws: marketing must not break a registration or a payment. Returns what was sent where.
 */
export async function sendConversion(q, { meta, ga4, eventId = randomUUID(), who = {}, value = null, currency = 'EUR', url = 'https://ordyx.eu/' }) {
  const s = await read(q).catch(() => ({}));
  const out = { eventId, meta: false, ga4: false };
  const jobs = [];
  if (meta && s.pixelId && s.capi) {
    let token = null;
    try { token = open(s.capi); } catch { token = null; }
    if (token) {
      const first = String(who.name || '').trim().split(/\s+/)[0];
      const user = { ...(who.email ? { em: [sha(who.email)] } : {}), ...(first ? { fn: [sha(first)] } : {}), ...(who.ip ? { client_ip_address: who.ip } : {}),
        ...(who.ua ? { client_user_agent: who.ua } : {}), ...(who.fbp ? { fbp: who.fbp } : {}), ...(who.fbc ? { fbc: who.fbc } : {}), ...(who.id ? { external_id: [sha(who.id)] } : {}) };
      const event = { event_name: meta, event_time: Math.floor(Date.now() / 1000), event_id: eventId, action_source: who.ua ? 'website' : 'system_generated',
        ...(who.ua ? { event_source_url: url } : {}), user_data: user, ...(value != null ? { custom_data: { value: Math.round(value * 100) / 100, currency } } : {}) };
      jobs.push(fetch(`${GRAPH}/${s.pixelId}/events?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [event], ...(s.testCode ? { test_event_code: s.testCode } : {}) }), signal: AbortSignal.timeout(6000),
      }).then(async (r) => { out.meta = r.ok; if (!r.ok) console.error('[track] CAPI', r.status, (await r.text().catch(() => '')).slice(0, 300)); }).catch((err) => console.error('[track] CAPI', err.message)));
    }
  }
  if (ga4 && s.ga4Id && s.ga4Secret && who.ga) {
    let secret = null;
    try { secret = open(s.ga4Secret); } catch { secret = null; }
    if (secret) {
      const params = { ...(value != null ? { value: Math.round(value * 100) / 100, currency, transaction_id: eventId } : { method: 'email' }), engagement_time_msec: 1 };
      jobs.push(fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(s.ga4Id)}&api_secret=${encodeURIComponent(secret)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: who.ga, ...(who.id ? { user_id: String(who.id) } : {}), events: [{ name: ga4, params }] }), signal: AbortSignal.timeout(6000),
      }).then((r) => { out.ga4 = r.ok || r.status === 204; }).catch((err) => console.error('[track] GA4', err.message)));
    }
  }
  await Promise.all(jobs);
  return out;
}

/** After a registration with cookies accepted: keep the browser ids for the payment later, report the registration. */
export async function trackSignup(q, user, req, { consent }) {
  if (!consent) return null;
  const ids = browserIds(req.headers?.cookie);
  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ua = String(req.headers?.['user-agent'] || '').slice(0, 400);
  await q(`update zd.users set track = $2::text::jsonb where id = $1::uuid`, [user.id, JSON.stringify({ ...ids, ip, ua, at: new Date().toISOString() })]).catch(() => {});
  return sendConversion(q, { meta: 'CompleteRegistration', ga4: 'sign_up', who: { ...ids, ip, ua, email: user.email, name: user.name, id: user.id }, url: 'https://app.ordyx.eu/admin/' });
}

/** A payment the owner recorded: Purchase for a client who registered with cookies accepted. */
export async function trackPayment(q, userId, amount, paymentId) {
  const [u] = await q(`select id, email, name, track from zd.users where id = $1::uuid`, [userId]);
  const t = u?.track ? json(u.track) : null;
  if (!t || !(amount > 0)) return null;
  return sendConversion(q, { meta: 'Purchase', ga4: 'purchase', eventId: `pay-${paymentId}`, value: Number(amount), who: { email: u.email, name: u.name, id: u.id, fbp: t.fbp, fbc: t.fbc, ga: t.ga, ip: t.ip } });
}
