// Integrations configured from the admin. One row per provider; the API key is sealed (lib/secretbox.js) and never returned.
import { seal, open } from './secretbox.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});

export async function getIntegration(q, provider) {
  const [row] = await q(`select config, secret_enc from zd.integrations where provider = $1`, [provider]);
  return { provider, config: row ? parse(row.config) : {}, hasSecret: Boolean(row?.secret_enc) };
}

/** Merges `config` into the stored one (in SQL, so concurrent writers keep each other's fields); `secret` replaces the key only when given. */
export async function saveIntegration(q, provider, { config = {}, secret } = {}) {
  const [row] = await q(
    `insert into zd.integrations (provider, config, secret_enc, updated_at) values ($1, $2::text::jsonb, $3, now())
     on conflict (provider) do update set config = zd.integrations.config || excluded.config,
       secret_enc = coalesce(excluded.secret_enc, zd.integrations.secret_enc), updated_at = now()
     returning config`,
    [provider, JSON.stringify(config), secret ? seal(secret) : null],
  );
  return parse(row.config);
}

export async function getSecret(q, provider) {
  const [row] = await q(`select secret_enc from zd.integrations where provider = $1`, [provider]);
  return row?.secret_enc ? open(row.secret_enc) : null;
}

export const CURRENCIES = ['EUR', 'BGN', 'USD'];
const SHOP_DEFAULTS = { name: '', url: '', email: '', phone: '', currency: 'EUR' };

/** Store data shown in the admin (zd.settings 'shop'): name for the sidebar, public URL, email, phone, currency. */
export async function getShop(q) {
  const [row] = await q(`select value from zd.settings where key = 'shop'`);
  const v = parse(row?.value);
  return Object.fromEntries(Object.entries(SHOP_DEFAULTS).map(([k, d]) => [k, typeof v[k] === 'string' && v[k] ? v[k] : d]));
}

/** Validates every field first (Bulgarian messages for the admin), then replaces the store data. */
export async function saveShop(q, input = {}) {
  const t = (v) => String(v ?? '').trim();
  const shop = { name: t(input.name), url: t(input.url), email: t(input.email), phone: t(input.phone), currency: t(input.currency) || 'EUR' };
  if (shop.name.length > 60) throw new Error('Името на магазина е до 60 знака');
  if (shop.url && (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(shop.url) || shop.url.length > 200)) throw new Error('Невалиден адрес — напр. https://adhdbg.eu');
  if (shop.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shop.email) || shop.email.length > 160)) throw new Error('Невалиден имейл');
  if (shop.phone.length > 30) throw new Error('Телефонът е до 30 знака');
  if (!CURRENCIES.includes(shop.currency)) throw new Error('Невалидна валута');
  await q(
    `insert into zd.settings (key, value) values ('shop', $1::text::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(shop)],
  );
  return shop;
}
