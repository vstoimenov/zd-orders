// Encrypts integration secrets (API keys) at rest with AES-256-GCM; the key is derived from INTEGRATIONS_SECRET (Vercel env).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  const s = process.env.INTEGRATIONS_SECRET;
  if (!s) throw new Error('INTEGRATIONS_SECRET is not set');
  return createHash('sha256').update(s).digest();
}

/** Throws when keys cannot be sealed (INTEGRATIONS_SECRET missing) — check before side effects elsewhere. */
export function assertReady() { key(); }

export function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function open(token) {
  const [v, iv, tag, enc] = String(token ?? '').split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('invalid sealed secret');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
