import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { getIntegration } from '../lib/integrations-repo.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import { syncMeta } from '../lib/meta.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, calls, shared, pushed;

const ok = (d) => ({ ok: true, status: 200, json: async () => d });
const bad = (code, message) => ({ ok: false, status: 400, json: async () => ({ error: { code, message } }) });
/** fake Graph: the platform's system user; only accounts in `shared` were shared with the platform's business */
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  const token = u.searchParams.get('access_token') || body.access_token;
  calls.push({ method: init.method || 'GET', path: u.pathname.replace(/^\/v\d+\.\d+/, ''), token, body });
  const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
  if (token !== 'PLATFORM') return bad(190, 'Invalid OAuth access token');
  if (path === '/me') return ok({ id: 'SU1', name: 'Ordyx' });
  const m = path.match(/^\/act_(\d+)(\/.*)?$/);
  if (m) {
    if (!shared.has(m[1])) return bad(200, '(#200) Missing Permissions');
    if (m[2] === '/assigned_users' && init.method === 'POST') { assert.equal(body.user, 'SU1'); return ok({ success: true }); }
    if (m[2] === '/insights') return ok({ data: [{ date_start: '2026-10-17', spend: '12.5', impressions: '1000', clicks: '20', actions: [] }] });
    if (!m[2]) return ok({ id: `act_${m[1]}`, name: `Акаунт ${m[1]}`, currency: 'EUR', account_status: 1 });
  }
  return bad(100, `unexpected ${path}`);
};

const call = async ({ method = 'POST', url = `/api/admin/integrations?shop=${SHOP}`, cookie = owner, body }) => {
  const res = fakeRes();
  await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};
const enable = () => call({ body: { action: 'meta_platform', token: 'PLATFORM', businessId: '1286604839444018' } });

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  calls = []; shared = new Set(['123']); pushed = [];
  setPushSenderForTests(async (s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

test('the owner turns on sharing with the platform token; the status shows the business to share with', async () => {
  assert.equal(json(await call({ method: 'GET' })).meta.partner.enabled, false);
  const res = await enable();
  assert.equal(res.statusCode, 200);
  const st = json(await call({ method: 'GET' })).meta.partner;
  assert.deepEqual(st, { enabled: true, businessId: '1286604839444018' });
  assert.ok(!JSON.stringify(json(await call({ method: 'GET' }))).includes('PLATFORM'), 'the token never leaves the server');
  assert.equal((await call({ body: { action: 'meta_platform', token: 'WRONG', businessId: '1286604839444018' } })).statusCode, 400);
});

test('a shop connects an ad account it shared: access is assigned, the account is linked and the owner is told', async () => {
  await enable();
  const res = await call({ body: { action: 'meta_partner', accountId: 'act_123' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(json(res), { ok: true, accountName: 'Акаунт 123', currency: 'EUR' });
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/act_123/assigned_users'));
  const i = await getIntegration(q, 'meta', SHOP);
  assert.deepEqual([i.config.mode, i.config.accountId, i.config.active], ['partner', '123', true]);
  const st = json(await call({ method: 'GET' })).meta;
  assert.deepEqual([st.connected, st.accountId, st.mode], [true, '123', 'partner']);
  assert.match(pushed.at(-1).body, /Акаунт 123/);
});

test('an account not shared with the platform is refused with the steps to share it', async () => {
  await enable();
  const res = await call({ body: { action: 'meta_partner', accountId: '999' } });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /спод/i);
  assert.equal((await getIntegration(q, 'meta', SHOP)).config.accountId, undefined);
});

test('one ad account belongs to one shop only', async () => {
  await enable();
  await call({ body: { action: 'meta_partner', accountId: '123' } });
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  const res = await call({ url: `/api/admin/integrations?shop=${other}`, body: { action: 'meta_partner', accountId: '123' } });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /друг магазин/);
});

test('before the owner turns sharing on, a shop gets a clear message; a client cannot set the platform token', async () => {
  const res = await call({ body: { action: 'meta_partner', accountId: '123' } });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /още не е включено/);
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  const r = await call({ url: `/api/admin/integrations?shop=${other}`, cookie: c, body: { action: 'meta_platform', token: 'PLATFORM', businessId: '1' } });
  assert.equal(r.statusCode, 403);
});

test('a client links its own shop the same way (once Meta is open to clients: META_PUBLIC=1)', async (t) => {
  process.env.META_PUBLIC = '1';
  t.after(() => { delete process.env.META_PUBLIC; });
  await enable();
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  const r = await call({ url: `/api/admin/integrations?shop=${other}`, cookie: c, body: { action: 'meta_partner', accountId: '123' } });
  assert.equal(r.statusCode, 200, r.body);
});

test('the nightly sync of a shared account reads with the platform token', async () => {
  await enable();
  await call({ body: { action: 'meta_partner', accountId: '123' } });
  calls = [];
  const r = await syncMeta(q, { from: '2026-10-17', to: '2026-10-17', shopId: SHOP });
  assert.equal(r.days, 1);
  assert.ok(calls.some((c) => c.path === '/act_123/insights' && c.token === 'PLATFORM'));
  const [row] = await q(`select spend from zd.ad_spend where shop_id = $1::uuid`, [SHOP]);
  assert.equal(Number(row.spend), 12.5);
});

test('disconnecting a shared account unlinks it so another shop could link it', async () => {
  await enable();
  await call({ body: { action: 'meta_partner', accountId: '123' } });
  await call({ body: { action: 'meta_disconnect' } });
  assert.equal(json(await call({ method: 'GET' })).meta.connected, false);
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  assert.equal((await call({ url: `/api/admin/integrations?shop=${other}`, body: { action: 'meta_partner', accountId: '123' } })).statusCode, 200);
});
