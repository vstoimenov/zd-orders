import postgres from 'postgres';

const MAX_CONNECTIONS = 3;
let client = null;
let limit = null;
let override = null;

/**
 * Runs at most `max` tasks at a time; the rest wait their turn. postgres.js pipelines extra queries onto busy connections,
 * and the Supabase transaction pooler sometimes never answers pipelined queries (or answers the wrong one) — so each query
 * must have a connection to itself.
 */
export function limitConcurrency(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** q(text, params) → rows. Production: postgres.js over the Supabase pooler; tests inject PGlite. */
export function getQuery() {
  if (override) return override;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  client ??= postgres(url, { prepare: false, max: MAX_CONNECTIONS, idle_timeout: 20, connect_timeout: 10, ssl: 'require' });
  limit ??= limitConcurrency(MAX_CONNECTIONS);
  return (text, params = []) => limit(() => client.unsafe(text, params));
}

export function setQueryForTests(q) {
  override = q;
}
