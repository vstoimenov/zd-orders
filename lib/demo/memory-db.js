// An in-memory Postgres (PGlite) with all migrations: the tests and the public demo run on it — never the real database.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../db/migrations/', import.meta.url);

export async function makeMemoryQuery() {
  const db = new PGlite();
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, DIR), 'utf8'));
  const q = (text, params = []) => db.query(text, params).then((r) => r.rows);
  q.close = () => db.close();
  return q;
}
