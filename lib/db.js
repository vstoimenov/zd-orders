import postgres from 'postgres';

let client = null;
let override = null;

/** q(text, params) → rows. Production: postgres.js over the Supabase pooler; tests inject PGlite. */
export function getQuery() {
  if (override) return override;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  client ??= postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, ssl: 'require' });
  return (text, params = []) => client.unsafe(text, params);
}

export function setQueryForTests(q) {
  override = q;
}
