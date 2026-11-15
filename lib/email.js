// E-mail out of Ordyx through Resend: one platform key (RESEND_API_KEY), every shop writes under its own name from the platform's
// address, replies go to the shop. The unsubscribe link carries a signed token; Resend's webhook is checked with its signing secret.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.resend.com';
export const BATCH = 100; // Resend's batch endpoint takes up to 100 messages
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);
export const fromAddress = (shopName) => `${String(shopName || 'Ordyx').replace(/[",<>\r\n]/g, '').trim().slice(0, 60) || 'Ordyx'} <${process.env.EMAIL_FROM || 'no-reply@ordyx.eu'}>`;
const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const EMAIL_RE = /^[^\s@"<>]+@[^\s@"<>]+\.[a-z]{2,}$/i;
export const validEmail = (v) => EMAIL_RE.test(String(v || '').trim()) && String(v).length <= 254;
export const normEmail = (v) => String(v || '').trim().toLowerCase();

/** Sends up to 100 messages in one call. Each { from, to, subject, html, text, reply_to, headers, tags }. Returns their provider ids in order. */
export async function sendBatch(messages) {
  if (!emailConfigured()) throw new Error('Изпращането на имейли още не е включено в платформата');
  if (!messages.length) return [];
  const r = await fetch(`${API}/emails/batch`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(messages), signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message ? `Resend: ${body.message}` : `Resend отговори с ${r.status}`);
  const ids = (body.data || []).map((x) => x.id || '');
  return messages.map((_, i) => ids[i] || '');
}

/* ---- the unsubscribe link: <shop>.<email, base64url>.<hmac>, so nobody can unsubscribe anyone else ---- */
const secret = () => { const s = process.env.INTEGRATIONS_SECRET || process.env.ADMIN_SECRET; if (!s) throw new Error('INTEGRATIONS_SECRET missing'); return s; };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (shopId, email) => createHmac('sha256', secret()).update(`unsub|${shopId}|${email}`).digest('base64url').slice(0, 32);
export function unsubToken(shopId, email) { const e = normEmail(email); return `${shopId}.${b64(e)}.${sign(shopId, e)}`; }
export function unsubUrl(shopId, email, campaignId = '') { return `${base()}/api/admin/email?u=${encodeURIComponent(unsubToken(shopId, email))}${campaignId ? `&c=${encodeURIComponent(campaignId)}` : ''}`; }
/** The shop and address of a token, or null when it was not signed by us. */
export function readUnsub(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !/^[0-9a-f-]{36}$/.test(parts[0])) return null;
  let email;
  try { email = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch { return null; }
  if (!validEmail(email)) return null;
  const want = Buffer.from(sign(parts[0], email)), got = Buffer.from(parts[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? { shopId: parts[0], email } : null;
}

/* ---- Resend's webhook (Svix): v1 signatures over "<id>.<timestamp>.<body>" with the whsec_ secret, at most 5 minutes old ---- */
export function webhookOk(raw, headers, whsec = process.env.RESEND_WEBHOOK_SECRET, now = Date.now()) {
  if (!whsec || raw == null) return false;
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = String(headers['svix-signature'] || '');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(String(whsec).replace(/^whsec_/, ''), 'base64');
  const want = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return sigs.split(' ').some((s) => {
    const [v, sig] = s.split(',');
    if (v !== 'v1' || !sig) return false;
    const a = Buffer.from(sig), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
