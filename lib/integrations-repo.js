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

/** nekorekten.com key: the one saved in the admin, else the NEKOREKTEN_API_KEY env (first setup). */
export async function nekorektenKey(q) {
  try { return (await getSecret(q, 'nekorekten')) || process.env.NEKOREKTEN_API_KEY || null; }
  catch { return process.env.NEKOREKTEN_API_KEY || null; }
}
