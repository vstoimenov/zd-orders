import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../db/migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

export async function makeTestQuery() {
  const db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
  return (text, params = []) => db.query(text, params).then((r) => r.rows);
}
