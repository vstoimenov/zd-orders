// Integrations configured from the admin. One row per shop and provider; the API key is sealed (lib/secretbox.js) and never returned.
import { seal, open } from './secretbox.js';
import { DEFAULT_SHOP } from './shops.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});

export async function getIntegration(q, provider, shopId = DEFAULT_SHOP) {
  const [row] = await q(`select config, secret_enc from zd.integrations where shop_id = $1::uuid and provider = $2`, [shopId, provider]);
  return { provider, config: row ? parse(row.config) : {}, hasSecret: Boolean(row?.secret_enc) };
}

/** Merges `config` into the stored one (in SQL, so concurrent writers keep each other's fields); `secret` replaces the key only when given. */
export async function saveIntegration(q, provider, { config = {}, secret, shopId = DEFAULT_SHOP } = {}) {
  const [row] = await q(
    `insert into zd.integrations (shop_id, provider, config, secret_enc, updated_at) values ($1::uuid, $2, $3::text::jsonb, $4, now())
     on conflict (shop_id, provider) do update set config = zd.integrations.config || excluded.config,
       secret_enc = coalesce(excluded.secret_enc, zd.integrations.secret_enc), updated_at = now()
     returning config`,
    [shopId, provider, JSON.stringify(config), secret ? seal(secret) : null],
  );
  return parse(row.config);
}

export async function getSecret(q, provider, shopId = DEFAULT_SHOP) {
  const [row] = await q(`select secret_enc from zd.integrations where shop_id = $1::uuid and provider = $2`, [shopId, provider]);
  return row?.secret_enc ? open(row.secret_enc) : null;
}

/** Shops that have this provider set up (for the nightly jobs). */
export async function shopsWith(q, provider) {
  const rows = await q(`select shop_id from zd.integrations where provider = $1 and secret_enc is not null order by shop_id`, [provider]);
  return rows.map((r) => r.shop_id);
}
