// Voting for the next country on ordyx.eu: counts per country, one vote per browser, a changed mind moves the vote.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const call = async (method, body, cookie = '') => { const res = fakeRes(); await router({ method, url: '/api/admin/euvote', headers: { cookie, host: 'ordyx.eu' }, body: body && JSON.stringify(body), socket: {} }, res); return res; };

test('no login needed: nothing at first, then every vote counts and a browser can move its vote but not double it', async () => {
  assert.deepEqual(json(await call('GET')), { votes: {} });
  let res = await call('POST', { country: 'ro' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).votes, { RO: 1 });
  assert.match(res.headers['set-cookie'], /^zd_euvote=RO; Path=\/; Max-Age=31536000/);
  await call('POST', { country: 'RO' }); // another browser
  assert.deepEqual(json(await call('GET')).votes, { RO: 2 });
  res = await call('POST', { country: 'RO' }, 'zd_euvote=RO'); // the same browser again: still 2
  assert.deepEqual(json(res).votes, { RO: 2 });
  res = await call('POST', { country: 'GR' }, 'zd_euvote=RO'); // changed its mind: the vote moves
  assert.deepEqual(json(res).votes, { RO: 1, GR: 1 });
  assert.equal((await call('POST', { country: 'Romania' })).statusCode, 400);
  assert.equal((await call('POST', {})).statusCode, 400);
  assert.equal((await call('DELETE')).statusCode, 405);
});
