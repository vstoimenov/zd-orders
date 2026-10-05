import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, lookupPhone, reportUrl } from '../lib/nekorekten.js';

test('summarize reads count and report ids from a reports search', () => {
  assert.deepEqual(summarize({ items: [{ id: 101 }, { id: '102' }], count: 2, currentPage: 1 }), { count: 2, reportIds: ['101', '102'] });
  assert.deepEqual(summarize({ items: [], count: 0 }), { count: 0, reportIds: [] });
  assert.deepEqual(summarize({ items: [{ id: 5 }] }), { count: 1, reportIds: ['5'] });
  assert.deepEqual(summarize(null), { count: 0, reportIds: [] });
});

test('reportUrl links to a report on nekorekten.com', () => {
  assert.equal(reportUrl('101'), 'https://nekorekten.com/reports/101');
});

test('lookupPhone queries by phone digits with the Api-Key header', async () => {
  let call;
  const fetchImpl = async (url, init) => { call = { url, init }; return { ok: true, json: async () => ({ items: [{ id: 7 }], count: 1 }) }; };
  assert.deepEqual(await lookupPhone('+359888123456', 'KEY', fetchImpl), { count: 1, reportIds: ['7'] });
  assert.equal(call.url, 'https://api.nekorekten.com/api/v1/reports?phone=359888123456');
  assert.equal(call.init.headers['Api-Key'], 'KEY');
});

test('lookupPhone fails with the API message on HTTP errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ message: 'Too many requests' }) });
  await assert.rejects(lookupPhone('+359888123456', 'KEY', fetchImpl), /HTTP 429: Too many requests/);
  await assert.rejects(lookupPhone('', 'KEY', fetchImpl), /no phone/);
});
