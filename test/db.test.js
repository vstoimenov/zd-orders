import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitConcurrency } from '../lib/db.js';

test('never more queries in flight than connections (the Supabase pooler hangs on pipelined queries)', async () => {
  let inFlight = 0, peak = 0;
  const slow = async (i) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return i; };
  const run = limitConcurrency(3);
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => run(() => slow(i))));
  assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => i), 'every query answers, in its own order');
  assert.equal(peak, 3);
  await assert.rejects(run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await run(() => slow(99)), 99, 'a failed query frees its slot');
});
