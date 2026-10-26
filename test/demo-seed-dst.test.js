import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { seedDemo } from '../lib/demo/seed.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';

test('the demo seeds 30 different days even late in the evening after the clocks went back (25.10: a 25-hour day)', async () => {
  const q = await makeTestQuery(); setQueryForTests(q);
  const realNow = Date.now;
  const shift = Date.parse('2026-10-26T21:30:00Z') - realNow(); // 23:30 in Sofia, the day after the change; the clock keeps running
  Date.now = () => realNow() + shift;
  try {
    await seedDemo(q);
  } finally { Date.now = realNow; }
  const days = await q(`select count(distinct day)::int as n, count(*)::int as rows from zd.ad_spend`);
  assert.equal(days[0].n, days[0].rows);
  assert.ok(days[0].n >= 30);
});
