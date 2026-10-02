import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const MIGRATION = readFileSync(new URL('../../db/migrations/001_zd_schema.sql', import.meta.url), 'utf8');

export async function makeTestQuery() {
  const db = new PGlite();
  await db.exec(MIGRATION);
  return (text, params = []) => db.query(text, params).then((r) => r.rows);
}
