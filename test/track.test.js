// Ordyx's own marketing: the owner's settings (secrets sealed, never sent back), the public ids, the Search Console file,
// the registration and the payment to Meta CAPI and GA4 — only with consent, never breaking either.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession, newSignupLink } from '../lib/users.js';
import { saveTracking, trackingSettings, browserIds, sendConversion } from '../lib/track.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const owner = `zdo_admin=${signSession('secret')}`;
const sha = (v) => createHash('sha256').update(v).digest('hex');
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error; globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const call = async ({ method = 'GET', url, cookie = '', body, headers = {} }) => {
  const res = fakeRes(); await router({ method, url, headers: { cookie, ...headers }, body: body && JSON.stringify(body), socket: {} }, res); return res;
};
const recorder = () => { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '' }; }; f.calls = calls; return f; };

test('the owner saves the ids; the secrets are sealed in the database and never sent back; bad ids are refused', async () => {
  await assert.rejects(saveTracking(q, { pixelId: 'abc' }), /цифри/);
  await assert.rejects(saveTracking(q, { ga4Id: 'UA-1' }), /G-/);
  await assert.rejects(saveTracking(q, { gscFile: 'evil.html' }), /google/);
  const t = await saveTracking(q, { pixelId: '1150537077523379', capiToken: 'EAA-SECRET', ga4Id: 'g-abc123', ga4Secret: 'mp-secret', gscFile: 'google1a2b3c4d5e6f.html' });
  assert.deepEqual(t, { pixelId: '1150537077523379', ga4Id: 'G-ABC123', gscFile: 'google1a2b3c4d5e6f', testCode: '', capiSet: true, ga4SecretSet: true });
  const [r] = await q(`select value::text as v from zd.settings where key = 'tracking'`);
  assert.doesNotMatch(r.v, /EAA-SECRET|mp-secret/);
  // an empty secret keeps the stored one; clear removes it
  assert.equal((await saveTracking(q, { pixelId: '1150537077523379', capiToken: '' })).capiSet, true);
  assert.equal((await saveTracking(q, { pixelId: '1150537077523379', clearCapi: true })).capiSet, false);
});

test('the route: public ids and the Search Console file for anyone, the settings for the platform owner only', async () => {
  await saveTracking(q, { pixelId: '1150537077523379', ga4Id: 'G-ABC123', capiToken: 'EAA-SECRET', gscFile: 'google1a2b3c4d5e6f' });
  let res = await call({ url: '/api/admin/track' });
  assert.deepEqual(json(res), { pixelId: '1150537077523379', ga4Id: 'G-ABC123' });
  res = await call({ url: '/api/admin/track?gsc=google1a2b3c4d5e6f.html' });
  assert.equal(res.statusCode, 200); assert.equal(res.body, 'google-site-verification: google1a2b3c4d5e6f.html');
  assert.equal((await call({ url: '/api/admin/track?gsc=google0000.html' })).statusCode, 404);
  assert.equal((await call({ url: '/api/admin/track?settings=1' })).statusCode, 401);
  const c = await createClient(q, { email: 'c@x.bg', name: 'К', shopIds: [] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  assert.equal((await call({ url: '/api/admin/track?settings=1', cookie: `zdo_admin=${clientSession('secret', u)}` })).statusCode, 403);
  res = await call({ url: '/api/admin/track?settings=1', cookie: owner });
  assert.equal(json(res).capiSet, true); assert.equal(JSON.stringify(json(res)).includes('EAA'), false);
  res = await call({ method: 'POST', url: '/api/admin/track', cookie: owner, body: { pixelId: '123' } });
  assert.equal(res.statusCode, 400);
});

test('browser ids come from the first-party cookies; junk is ignored', () => {
  assert.deepEqual(browserIds('a=1; _fbp=fb.1.1700000000000.123456789; _fbc=fb.1.1700000000000.AbCd; _ga=GA1.1.987654321.1700000000'),
    { fbp: 'fb.1.1700000000000.123456789', fbc: 'fb.1.1700000000000.AbCd', ga: '987654321.1700000000' });
  assert.deepEqual(browserIds('_fbp=<script>; _ga=x'), { fbp: null, fbc: null, ga: null });
  assert.deepEqual(browserIds(''), { fbp: null, fbc: null, ga: null });
});

test('a conversion goes to Meta CAPI (hashed e-mail and name, the event id) and GA4; nothing without the settings; a failure never throws', async () => {
  const f = recorder();
  let out = await withFetch(f, () => sendConversion(q, { meta: 'CompleteRegistration', ga4: 'sign_up', who: { email: 'A@X.bg', ga: '1.2' } }));
  assert.deepEqual([out.meta, out.ga4, f.calls.length], [false, false, 0], 'not set up: nothing is sent');
  await saveTracking(q, { pixelId: '1150537077523379', capiToken: 'EAA-SECRET', testCode: 'TEST1', ga4Id: 'G-ABC123', ga4Secret: 'mp-secret' });
  out = await withFetch(f, () => sendConversion(q, { meta: 'Purchase', ga4: 'purchase', eventId: 'pay-1', value: 40.2, who: { email: ' A@X.bg', name: 'Мария Иванова', ip: '1.2.3.4', fbp: 'fb.1.1.2', ga: '111.222', id: 'u1' } }));
  assert.deepEqual([out.meta, out.ga4], [true, true]);
  const meta = f.calls.find((c) => c.url.includes('graph.facebook.com'));
  assert.match(meta.url, /\/1150537077523379\/events\?access_token=EAA-SECRET$/);
  const e = meta.body.data[0];
  assert.equal(meta.body.test_event_code, 'TEST1');
  assert.deepEqual([e.event_name, e.event_id, e.action_source], ['Purchase', 'pay-1', 'system_generated']);
  assert.deepEqual(e.user_data.em, [sha('a@x.bg')]); assert.deepEqual(e.user_data.fn, [sha('мария')]);
  assert.equal(e.user_data.fbp, 'fb.1.1.2'); assert.deepEqual(e.custom_data, { value: 40.2, currency: 'EUR' });
  const ga = f.calls.find((c) => c.url.includes('google-analytics.com'));
  assert.match(ga.url, /measurement_id=G-ABC123&api_secret=mp-secret/);
  assert.deepEqual([ga.body.client_id, ga.body.events[0].name, ga.body.events[0].params.value, ga.body.events[0].params.transaction_id], ['111.222', 'purchase', 40.2, 'pay-1']);
  out = await withFetch(async () => { throw new Error('offline'); }, () => sendConversion(q, { meta: 'Lead', ga4: 'generate_lead', who: { email: 'a@x.bg', ga: '1.2' } }));
  assert.deepEqual([out.meta, out.ga4], [false, false]);
});

test('registration: with cookies accepted the browser ids are kept and CompleteRegistration is sent; without consent nothing; a later payment is a Purchase', async () => {
  await saveTracking(q, { pixelId: '1150537077523379', capiToken: 'EAA-SECRET', ga4Id: 'G-ABC123', ga4Secret: 'mp-secret' });
  const { code } = await newSignupLink(q);
  const f = recorder();
  const headers = { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '9.9.9.9' };
  let res = await withFetch(f, () => call({ method: 'POST', url: '/api/admin/signup', cookie: '_fbp=fb.1.1700000000000.42; _ga=GA1.1.555.666', headers,
    body: { code, name: 'Иван Петров', email: 'ivan@x.bg', password: 'parola-123', plan: 'starter', billing: 'monthly', consent: true } }));
  assert.equal(res.statusCode, 200);
  assert.ok(json(res).eventId, 'the browser half gets the same id');
  const meta = f.calls.find((c) => c.url.includes('graph.facebook.com')).body.data[0];
  assert.deepEqual([meta.event_name, meta.event_id, meta.action_source, meta.user_data.client_ip_address, meta.user_data.fbp], ['CompleteRegistration', json(res).eventId, 'website', '9.9.9.9', 'fb.1.1700000000000.42']);
  assert.equal(f.calls.find((c) => c.url.includes('google-analytics.com')).body.events[0].name, 'sign_up');
  const [u] = await q(`select id, track from zd.users where email = 'ivan@x.bg'`);
  assert.equal(u.track.ga, '555.666');
  // without consent: nothing sent, nothing kept
  const g = recorder();
  res = await withFetch(g, () => call({ method: 'POST', url: '/api/admin/signup', cookie: '_fbp=fb.1.1.1', headers: { ...headers, 'x-forwarded-for': '8.8.8.8' },
    body: { code, name: 'Анна', email: 'anna@x.bg', password: 'parola-123', plan: 'starter', billing: 'monthly' } }));
  assert.equal(res.statusCode, 200); assert.equal(json(res).eventId, undefined); assert.equal(g.calls.length, 0);
  assert.equal((await q(`select track from zd.users where email = 'anna@x.bg'`))[0].track, null);
  // the owner records Ivan's payment: Purchase with the amount, from the server
  const h = recorder();
  res = await withFetch(h, () => call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'sub_paid', id: u.id, amount: '40,20' } }));
  assert.equal(res.statusCode, 200);
  const p = h.calls.find((c) => c.url.includes('graph.facebook.com')).body.data[0];
  assert.deepEqual([p.event_name, p.custom_data.value, p.event_id.startsWith('pay-')], ['Purchase', 40.2, true]);
});
