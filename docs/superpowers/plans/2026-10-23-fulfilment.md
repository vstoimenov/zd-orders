# Fulfilment Warehouse Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop connects its fulfilment warehouse: Ordyx sends ready orders there (signed webhook), the warehouse reports the waybill and parcel progress back (keyed endpoint), and Ordyx stops making waybills for that shop.

**Architecture:** One new module `lib/fulfilment.js` (key, settings, due rule, outbound body/send/queue/retry) and one `lib/fulfilment-inbound.js` (the warehouse's reports) behind a new Vercel function `api/fulfilment.js`. Existing status-change sites call two one-line hooks (`queueFulfilment`, `queueCancel`). Waybill creation/refresh learn two new order columns (`fulfil_sent_at`, `waybill_external`). Admin gets a card + modal, the developer page a section.

**Tech Stack:** Node 22 ESM, Vercel functions, Postgres schema `zd` (PGlite in tests via `test/helpers/pglite.js` which loads `db/migrations/*.sql`), node:test, vanilla admin HTML.

**Spec:** docs/superpowers/specs/2026-10-23-fulfilment-design.md

## Global Constraints
- No new dependencies; secrets sealed with `lib/secretbox.js` (`seal`/`open`); keys never logged; timing-safe comparisons.
- Outbound: https only, `redirect: 'manual'`, 5 s timeout, HMAC-SHA256 over `${ts}.${body}` via `signBody` from `lib/woo-callback.js`, headers `X-Ordyx-Timestamp` / `X-Ordyx-Signature`. The warehouse never makes an order fail (hooks never throw).
- Inbound: `Authorization: Bearer ordyx_ful_<keyId 10 base62>_<32 base64url>`; 600/h per key (`overKeyLimit` keyed by `ful:<shopId>`); `GET` = ping; other methods 405.
- Key format regex: `/^ordyx_ful_([A-Za-z0-9]{10})_[A-Za-z0-9_-]{32}$/`.
- Integration provider string: `'fulfilment'`; config keys exactly `url, enabled, sendOn, keyId, createdAt, lastSentAt, lastReceivedAt, lastError`.
- New order columns (migration `db/migrations/026_fulfilment.sql`): `fulfil_sent_at timestamptz`, `fulfil_notify text not null default ''`, `waybill_external boolean not null default false`, `waybill_track_url text not null default ''`.
- Bulgarian user-facing texts exactly as the spec gives them; no competitor names.
- Deploy only with `npx vercel deploy --prod --yes`; migration applied by hand (Supabase MCP, project `etxbigwubhuvdmnwtsia`) before deploy. api/fulfilment.js is Vercel function 11 of 12.

## Review Focus
- A `shipped` report arriving twice, or after the order was cancelled by the buyer meanwhile: the waybill must be recorded once, the order must not flip back to shipped, the shop must be warned (Task 4 tests `shipped twice…` and `shipped for a cancelled order…`).
- A warehouse URL that redirects, hangs, or answers 500: the order stays „чака склада“, the error is readable, nothing else breaks (Task 2 `a failing warehouse…`).
- An order sent to the warehouse that the site re-sends with changed items: Ordyx must not silently drift from the warehouse's copy (Task 3 `a sent order is frozen…`).
- A shop that pauses the integration while orders are at the warehouse: no second waybill from Ordyx, the warehouse's late reports still land (Task 3 `no Ordyx waybill for a sent order…`, Task 4 `a paused integration still accepts reports`).
- A paid (card) order that never gets a confirmation request must still reach the warehouse (Task 2 `a paid order is due without confirmation`).

---

### Task 1: Migration, key and settings

**Files:**
- Create: `db/migrations/026_fulfilment.sql`
- Create: `lib/fulfilment.js`
- Test: `test/fulfilment.test.js`

**Interfaces:**
- Produces: `makeFulfilmentKey(q, shopId) → { key }`; `fulfilmentByKey(q, key) → { shopId, name, enabled } | null`;
  `fulfilmentSecret(q, shopId) → string | null`; `saveFulfilment(q, shopId, { url, sendOn }) → status` (validates: https URL ≤ 300 chars else throws `'Адресът на склада трябва да започва с https://'`; `sendOn` ∈ `'confirmed' | 'new'` else `'confirmed'`; sets `enabled: true`);
  `pauseFulfilment(q, shopId)` (`enabled: false`); `deleteFulfilment(q, shopId)` (throws `'<N> поръчки са при склада и още не са изпратени'` when orders with `fulfil_sent_at is not null and waybill_number = '' and status in ('new','confirmed')` exist; else deletes the integration row);
  `fulfilmentStatus(q, shopId) → { enabled, url, sendOn, keyId, hasKey, createdAt, lastSentAt, lastReceivedAt, lastError, due }` (`due` = `countDue`, Task 2; return 0 until then);
  `fulfilmentEnabled(q, shopId) → boolean`; `noteFulfilment(q, shopId, patch)`.

- [ ] **Step 1: Write the failing tests**

```js
// test/fulfilment.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { makeFulfilmentKey, fulfilmentByKey, fulfilmentSecret, saveFulfilment, pauseFulfilment, deleteFulfilment, fulfilmentStatus, fulfilmentEnabled } from '../lib/fulfilment.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

test('migration 026 adds the fulfilment columns', async () => {
  const [r] = await q(`select fulfil_sent_at, fulfil_notify, waybill_external, waybill_track_url from zd.orders limit 1`);
  assert.equal(r, undefined); // no orders, but the columns exist
});

test('a fulfilment key is made once, found by its id with a timing-safe compare, and replaced by a new one', async () => {
  const { key } = await makeFulfilmentKey(q, SHOP);
  assert.match(key, /^ordyx_ful_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
  assert.equal((await fulfilmentByKey(q, key)).shopId, SHOP);
  assert.equal(await fulfilmentByKey(q, key.slice(0, -1) + 'x'), null);
  assert.equal(await fulfilmentByKey(q, 'ordyx_live_abc'), null);
  assert.equal(await fulfilmentSecret(q, SHOP), key);
  const { key: key2 } = await makeFulfilmentKey(q, SHOP);
  assert.equal(await fulfilmentByKey(q, key), null);
  assert.equal((await fulfilmentByKey(q, key2)).shopId, SHOP);
});

test('settings: https only, sendOn defaults to confirmed, saving enables, pausing keeps the key', async () => {
  await assert.rejects(saveFulfilment(q, SHOP, { url: 'http://sklad.bg/hook' }), /https/);
  const st = await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook', sendOn: 'weird' });
  assert.equal(st.enabled, true); assert.equal(st.sendOn, 'confirmed'); assert.equal(st.url, 'https://sklad.bg/hook');
  assert.equal(await fulfilmentEnabled(q, SHOP), true);
  const { key } = await makeFulfilmentKey(q, SHOP);
  await pauseFulfilment(q, SHOP);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
  assert.equal((await fulfilmentByKey(q, key)).enabled, false);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, true);
});

test('deleting is refused while a sent order is still unshipped', async () => {
  await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' });
  await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text, city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, shop_id, status, fulfil_sent_at)
    values ('t:1', 'Иван', '0888', '+359888', '', 'econt_office', 'econt', 'econt:1', 'x', 'София', '', '', '[]', 10, 'EUR', 'cod', '', '', '', $1::uuid, 'confirmed', now())`, [SHOP]);
  await assert.rejects(deleteFulfilment(q, SHOP), /1 поръчки са при склада/);
  await q(`update zd.orders set waybill_number = '123', status = 'shipped'`);
  await deleteFulfilment(q, SHOP);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, false);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/fulfilment.test.js`
Expected: FAIL — `Cannot find module '../lib/fulfilment.js'`.

- [ ] **Step 3: Write the migration**

`db/migrations/026_fulfilment.sql`: a two-line comment in the style of 025, then four `alter table zd.orders add column if not exists …` lines with the exact types from Global Constraints.

- [ ] **Step 4: Implement `lib/fulfilment.js` (settings and key part)**

Follow `lib/shop-keys.js` for `makeFulfilmentKey` / `fulfilmentByKey` (provider `'fulfilment'`, prefix `ordyx_ful_`, `config->>'keyId'` lookup joined to `zd.shops` for `name`, `enabled` read from `config->>'enabled'`), `getIntegration`/`saveIntegration`/`getSecret` from `lib/integrations-repo.js`, `open` from `lib/secretbox.js`. `deleteFulfilment`: `delete from zd.integrations where provider = 'fulfilment' and shop_id = $1::uuid` after the in-flight check. Leave `countDue` as a stub returning 0 (Task 2 fills it).

- [ ] **Step 5: Run the tests**

Run: `node --test test/fulfilment.test.js`
Expected: PASS 4/4.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/026_fulfilment.sql lib/fulfilment.js test/fulfilment.test.js
git commit -m "feat(fulfilment): migration, warehouse key and settings"
```

---

### Task 2: Orders → warehouse (due rule, body, send, queue, retry)

**Files:**
- Modify: `lib/fulfilment.js`
- Test: `test/fulfilment.test.js`

**Interfaces:**
- Consumes: Task 1; `signBody(key, body)` from `lib/woo-callback.js`; `ensureConfirmToken(q, id)` from `lib/orders-repo.js`.
- Produces: `DUE_SQL` (a SQL fragment over alias `o` and integration config `c`, used by `countDue`, `retryDue`, Task 3 status),
  `isDue(o, cfg) → boolean` (pure, for one loaded row), `buildOrderBody(q, row) → object` (the spec's `order` body; SKU filled from `zd.product_costs` by `name` + `shop_id` when the item has none; `duplicate: true` when `is_duplicate`),
  `sendEvent(q, orderId, event, { fetchImpl = fetch } = {}) → boolean`, `queueFulfilment(q, orderId, opts) → void`, `queueCancel(q, orderId, opts) → void`,
  `retryDue(q, { shopId = null, budgetMs = 15000, max = Infinity, fetchImpl } = {}) → { retried, sent }`, `countDue(q, shopId) → number`.

- [ ] **Step 1: Write the failing tests** (append to `test/fulfilment.test.js`; add imports `isDue, buildOrderBody, sendEvent, queueFulfilment, queueCancel, retryDue, countDue` and `insertOrder, upsertExternalOrder` from `../lib/orders-repo.js`, `createHmac` from `node:crypto`)

```js
const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 2, price: 10 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  pageUrl: '', userAgent: '', ip: '', trafficSource: '', cbCheck: '' };
const order = async (patch = {}, n = Math.random().toString(36).slice(2)) => (await insertOrder(q, { ...base, cbOrderId: `t-${n}`, shopId: SHOP, ...patch })).id;
const setStatus = (id, status) => q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
function warehouse({ status = 200, hang = false } = {}) {
  const calls = [];
  const impl = (url, init) => { calls.push({ url: String(url), init }); if (hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    return Promise.resolve({ ok: status < 300, status, json: async () => ({}) }); };
  return { calls, impl };
}
const connect = async () => { await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' }); return (await makeFulfilmentKey(q, SHOP)).key; };

test('isDue: confirmed orders, or new ones when sendOn is new or the order is paid; never sent, cancelled or pending ones', () => {
  const cfg = { enabled: true, sendOn: 'confirmed' };
  const o = { status: 'confirmed', fulfil_sent_at: null, waybill_number: '', payment_method: 'cod', cb_check: '' };
  assert.equal(isDue(o, cfg), true);
  assert.equal(isDue({ ...o, status: 'new' }, cfg), false);
  assert.equal(isDue({ ...o, status: 'new' }, { ...cfg, sendOn: 'new' }), true);
  assert.equal(isDue({ ...o, status: 'new', payment_method: 'card' }, cfg), true);
  assert.equal(isDue({ ...o, fulfil_sent_at: new Date() }, cfg), false);
  assert.equal(isDue({ ...o, waybill_number: '123' }, cfg), false);
  assert.equal(isDue({ ...o, status: 'cancelled' }, cfg), false);
  assert.equal(isDue({ ...o, cb_check: 'pending' }, cfg), false);
  assert.equal(isDue(o, { ...cfg, enabled: false }), false);
});

test('the order body carries customer, office, items with SKU from the inventory, total, payment and the tracking page', async () => {
  await q(`insert into zd.product_costs (name, shop_id, sku) values ('Книга', $1::uuid, 'BK-1')`, [SHOP]);
  const id = await order({ isDuplicate: true });
  await q(`update zd.orders set is_duplicate = true where id = $1::uuid`, [id]);
  const [row] = await q(`select * from zd.orders where id = $1::uuid`, [id]);
  const b = await buildOrderBody(q, row);
  assert.equal(b.api, 1); assert.equal(b.event, 'order'); assert.equal(b.duplicate, true);
  assert.equal(b.order.id, id); assert.equal(b.order.number, row.cb_order_id);
  assert.deepEqual(b.order.customer, { name: 'Мария Иванова', phone: '+359888123456', email: 'm@x.bg' });
  assert.deepEqual(b.order.delivery, { type: 'econt_office', courier: 'econt', office: { id: 'econt:1127', code: '1127', text: 'Плевен Център, Плевен (1127)' }, address: null });
  assert.deepEqual(b.order.items, [{ sku: 'BK-1', name: 'Книга', qty: 2, price: 10 }]);
  assert.equal(b.order.total, 22.57); assert.equal(b.order.currency, 'EUR');
  assert.deepEqual(b.order.payment, { method: 'cod', cod_amount: 22.57 });
  assert.match(b.order.tracking_page, /^https:\/\/app\.ordyx\.eu\/p\/[A-Za-z0-9_-]+$/);
});

test('an address order and an "other" order describe the delivery accordingly', async () => {
  const a = await order({ deliveryType: 'speedy_address', courier: 'speedy', officeId: '', officeText: 'Спиди – адрес: ул. Х 1, Варна', city: 'Варна', postCode: '9000', addressText: 'ул. Х 1', paymentMethod: 'card' });
  const [ra] = await q(`select * from zd.orders where id = $1::uuid`, [a]);
  const ba = await buildOrderBody(q, ra);
  assert.deepEqual(ba.order.delivery, { type: 'speedy_address', courier: 'speedy', office: null, address: { city: 'Варна', post_code: '9000', street: 'ул. Х 1' } });
  assert.deepEqual(ba.order.payment, { method: 'card', cod_amount: 0 });
  const o = await order({ deliveryType: 'other', courier: 'other', officeId: '', officeText: 'Лично предаване' });
  const [ro] = await q(`select * from zd.orders where id = $1::uuid`, [o]);
  assert.deepEqual((await buildOrderBody(q, ro)).order.delivery, { type: 'other', courier: 'other', office: null, address: null, text: 'Лично предаване' });
});

test('sendEvent posts a signed body to the warehouse and marks the order sent', async () => {
  const key = await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  const w = warehouse();
  assert.equal(await sendEvent(q, id, 'order', { fetchImpl: w.impl }), true);
  assert.equal(w.calls[0].url, 'https://sklad.bg/hook');
  const { headers, body, redirect } = w.calls[0].init;
  assert.equal(redirect, 'manual');
  assert.equal(headers['X-Ordyx-Signature'], createHmac('sha256', key).update(`${headers['X-Ordyx-Timestamp']}.${body}`).digest('hex'));
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.ok(r.fulfil_sent_at); assert.equal(r.fulfil_notify, '');
  assert.ok((await fulfilmentStatus(q, SHOP)).lastSentAt);
});

test('a failing warehouse (500, redirect, hang) leaves the order waiting with a readable error', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  for (const [w, msg] of [[warehouse({ status: 500 }), /складът отговори 500/], [warehouse({ status: 302 }), /пренасочва/], [warehouse({ hang: true }), /не отговаря/]]) {
    assert.equal(await sendEvent(q, id, 'order', { fetchImpl: w.impl }), false);
    assert.match((await fulfilmentStatus(q, SHOP)).lastError, msg);
  }
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.equal(r.fulfil_sent_at, null); assert.equal(r.fulfil_notify, 'order');
});

test('queueFulfilment sends a due order at once and ignores one that is not due; a paid order is due without confirmation', async () => {
  await connect();
  const w = warehouse();
  const fresh = await order();
  await queueFulfilment(q, fresh, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 0);
  await setStatus(fresh, 'confirmed');
  await queueFulfilment(q, fresh, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 1);
  const paid = await order({ paymentMethod: 'card' });
  await queueFulfilment(q, paid, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
  await queueFulfilment(q, paid, { fetchImpl: w.impl }); // already sent
  assert.equal(w.calls.length, 2);
});

test('queueCancel tells the warehouse about a sent order and clears the sent mark; a never-sent order is just forgotten', async () => {
  await connect();
  const w = warehouse();
  const id = await order(); await setStatus(id, 'confirmed');
  await queueFulfilment(q, id, { fetchImpl: w.impl });
  await setStatus(id, 'cancelled');
  await queueCancel(q, id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
  assert.deepEqual(JSON.parse(w.calls[1].init.body), { api: 1, event: 'cancelled', order: { id, number: (await q(`select cb_order_id from zd.orders where id = $1::uuid`, [id]))[0].cb_order_id } });
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.equal(r.fulfil_sent_at, null); assert.equal(r.fulfil_notify, '');
  const never = await order(); await setStatus(never, 'cancelled');
  await queueCancel(q, never, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
});

test('retryDue sends due and waiting orders oldest first within its budget, skips a shop after one failure, and countDue agrees', async () => {
  await connect();
  const a = await order(); await setStatus(a, 'confirmed');
  const b = await order(); await setStatus(b, 'confirmed');
  await q(`update zd.orders set fulfil_notify = 'order', created_at = now() - interval '1 day' where id = $1::uuid`, [a]);
  assert.equal(await countDue(q, SHOP), 2);
  const bad = warehouse({ status: 500 });
  assert.deepEqual(await retryDue(q, { fetchImpl: bad.impl }), { retried: 1, sent: 0 });
  const good = warehouse();
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl }), { retried: 2, sent: 2 });
  assert.equal(JSON.parse(good.calls[0].init.body).order.id, a);
  assert.equal(await countDue(q, SHOP), 0);
  const c = await order(); await setStatus(c, 'confirmed');
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl, budgetMs: -1 }), { retried: 0, sent: 0 });
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl, max: 1 }), { retried: 1, sent: 1 });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/fulfilment.test.js`
Expected: FAIL — `isDue`/`buildOrderBody`/… are not exported.

- [ ] **Step 3: Implement the outbound part in `lib/fulfilment.js`**

- `DUE_SQL`: `o.fulfil_sent_at is null and o.waybill_number = '' and o.cb_check <> 'pending' and (o.status = 'confirmed' or (o.status = 'new' and (c.config->>'sendOn' = 'new' or o.payment_method <> 'cod')))`; the integration row joined as `c` with `c.provider = 'fulfilment' and c.config->>'enabled' = 'true'`. `isDue` is the same rule in JS.
- `buildOrderBody`: office when `delivery_type` ends in `_office`/`_locker` (code = the part after `:` in `office_id`), address when it ends in `_address`, `text` only for `other`; SKU lookup `select name, sku from zd.product_costs where shop_id = $1 and name = any($2)`; `total` as `Number`; `tracking_page` from `ensureConfirmToken`.
- `sendEvent`: loads order + integration (`url`, secret); refuses silently (false) when not enabled or no key/url — except event `'cancelled'`, which is sent even when paused; `fetchImpl(url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(5000), headers })`; 3xx → `'складът пренасочва (<status>)'`, non-ok → `'складът отговори <status>'`, throw/abort → `'складът не отговаря'`. Success: `'order'` → `fulfil_sent_at = now(), fulfil_notify = ''`; `'cancelled'` → `fulfil_sent_at = null, fulfil_notify = ''`; `noteFulfilment({ lastSentAt, lastError: null })`. Failure: `fulfil_notify = event`, `noteFulfilment({ lastError })`, `console.error('[fulfilment] …')`. Never throws.
- `queueFulfilment(q, id, { fetchImpl })`: select the order with its integration config; if `isDue` → `fulfil_notify = 'order'` then `sendEvent`. `queueCancel`: if `fulfil_sent_at is not null` → `fulfil_notify = 'cancelled'` then `sendEvent`; else `fulfil_notify = ''`. Both wrapped in try/catch.
- `retryDue`: `select o.id, o.shop_id from zd.orders o join zd.integrations c on c.shop_id = o.shop_id and c.provider = 'fulfilment' and c.config->>'enabled' = 'true' where o.created_at > now() - interval '30 days' and (o.fulfil_notify <> '' or (${DUE_SQL})) and ($1::uuid is null or o.shop_id = $1::uuid) order by o.created_at limit 500`; event = `fulfil_notify || 'order'`; budget/skip logic as `retryCallbacks`; `max` caps attempts. `countDue` = the same `where` with `count(*)` for one shop.

- [ ] **Step 4: Run the tests**

Run: `node --test test/fulfilment.test.js`
Expected: PASS 13/13.

- [ ] **Step 5: Commit**

```bash
git add lib/fulfilment.js test/fulfilment.test.js
git commit -m "feat(fulfilment): orders go to the warehouse — due rule, signed body, queue and retry"
```

---

### Task 3: Hooks into the order lifecycle, frozen orders, no Ordyx waybills

**Files:**
- Modify: `lib/confirm.js` (answerConfirm), `lib/voice-call.js` (voiceResult yes), `lib/admin/orders.js` (PATCH), `lib/cb-sync.js` (startOrder), `lib/external-orders.js` (cancelExternal), `lib/orders-repo.js` (upsert freeze, `shipmentOf`, `toOrder`), `lib/waybills.js` (refusals, refresh/sync skip), `lib/woo-callback.js` (`trackUrl`), `api/cron/refresh.js`
- Test: `test/fulfilment-hooks.test.js`

**Interfaces:**
- Consumes: Task 2 `queueFulfilment`, `queueCancel`, `retryDue`, `fulfilmentEnabled`.
- Produces: `toOrder` gains `fulfilment: { sentAt: iso|null, pending: boolean }`; `shipmentOf` gains `external: boolean` and `trackUrl` = `waybill_track_url || courier url || null`; `retryDue` result under cron `result.fulfilment`.

- [ ] **Step 1: Write the failing tests**

```js
// test/fulfilment-hooks.test.js — same header/helpers as test/fulfilment.test.js (copy `base`, `order`, `setStatus`, `warehouse`, `connect`)
import { answerConfirm, confirmLink } from '../lib/confirm.js';
import { voiceResult } from '../lib/voice-call.js';
import { upsertExternalOrder, toOrder } from '../lib/orders-repo.js';
import { createWaybill, assignRoute, cancelWaybill, saveEcont, refreshOrderStatus } from '../lib/waybills.js';
import { createHmac } from 'node:crypto';

test('the buyer confirming from the link sends the order to the warehouse; refusing a sent order tells the warehouse', async () => {
  await connect();
  const w = warehouse();
  const id = await order();
  const { token } = await confirmLink(q, { orderId: id });
  await withFetch(w.impl, () => answerConfirm(q, token, 'yes'));
  assert.equal(w.calls.length, 1);
  assert.equal(JSON.parse(w.calls[0].init.body).event, 'order');
  await q(`update zd.orders set confirm_answer = '' where id = $1::uuid`, [id]);
  await withFetch(w.impl, () => answerConfirm(q, token, 'no'));
  assert.equal(JSON.parse(w.calls[1].init.body).event, 'cancelled');
});

test('a "yes" from the voice agent sends the order', async () => {
  await connect(); process.env.VOICE_CALL_SECRET = 's';
  const w = warehouse();
  const id = await order();
  const ts = String(Math.floor(Date.now() / 1000)), body = JSON.stringify({ order_id: id, answer: 'yes' });
  const sig = createHmac('sha256', 's').update(`${ts}.${body}`).digest('hex');
  await withFetch(w.impl, () => voiceResult(q, body, { 'x-ordyx-time': ts, 'x-ordyx-signature': sig }));
  assert.equal(w.calls.length, 1);
});

test('a paid order from a site goes to the warehouse on arrival; a cancel from the site reaches the warehouse', async () => {
  // via lib/external-orders.js keyedOrders: build req/res fakes like test/orders-keyed.test.js, POST a paid order, then status cancelled
});

test('a sent order is frozen: a site re-send with new items is locked out and does not change the order', async () => {
  await connect();
  const w = warehouse();
  const first = await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-7', source: 'api', shopId: SHOP, paymentMethod: 'card' });
  await queueFulfilment(q, first.id, { fetchImpl: w.impl });
  const again = await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-7', source: 'api', shopId: SHOP, paymentMethod: 'card', items: [{ name: 'Друго', qty: 1, price: 5 }] });
  assert.equal(again.locked, true);
  assert.equal((await q(`select items from zd.orders where id = $1::uuid`, [first.id]))[0].items[0].name, 'Книга');
});

test('no Ordyx waybill for a shop with the warehouse on, nor for a sent order after the integration is paused', async () => {
  await connect();
  await saveEcont(q, SHOP, { username: 'u', password: 'p', demo: true, sender: { name: 'Магазин', phone: '0888', officeCode: '1127' } });
  const id = await order(); await setStatus(id, 'confirmed');
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP }), /правят от склада/);
  await assert.rejects(assignRoute(q, { orderId: id, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:1127' } }), /правят от склада/);
  await q(`update zd.orders set fulfil_sent_at = now() where id = $1::uuid`, [id]);
  await pauseFulfilment(q, SHOP);
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP }), /при склада/);
  const free = await order(); await setStatus(free, 'confirmed');
  await assert.doesNotReject(assignRoute(q, { orderId: free, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:1127' } }));
});

test('an external waybill cannot be cancelled here, is not refreshed with the courier, and shows its own track link', async () => {
  const id = await order();
  await q(`update zd.orders set status = 'shipped', waybill_number = 'W-1', waybill_courier = 'other', waybill_external = true, waybill_track_url = 'https://track.bg/W-1', waybill_created_at = now() where id = $1::uuid`, [id]);
  await assert.rejects(cancelWaybill(q, { orderId: id, scopeShopId: SHOP }), /от склада/);
  assert.equal(await refreshOrderStatus(q, id), false);
  const [r] = await q(`select * from zd.orders where id = $1::uuid`, [id]);
  const o = toOrder(r);
  assert.equal(o.shipment.external, true); assert.equal(o.shipment.trackUrl, 'https://track.bg/W-1');
  assert.deepEqual(o.fulfilment, { sentAt: null, pending: false });
});
```
(Fill the keyed-orders test with the req/res helper from `test/orders-keyed.test.js`; it asserts one `order` call for a `paid: true` order and one `cancelled` call after `status: 'cancelled'`.) Add `withFetch` from `test/woo-callback.test.js` to the helpers.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/fulfilment-hooks.test.js`
Expected: FAIL — no calls reach the warehouse (`w.calls.length` 0), waybills are created, `locked` false.

- [ ] **Step 3: Add the hooks**

- `lib/confirm.js` answerConfirm: after `syncStockSafe`, `answer === 'yes' ? await queueFulfilment(q, o.id) : await queueCancel(q, o.id)`.
- `lib/voice-call.js` voiceResult yes branch: `await queueFulfilment(q, b.order_id)` after `syncStockSafe`.
- `lib/admin/orders.js` PATCH: after `syncStockSafe` — `confirmed` → `queueFulfilment`, `cancelled` → `queueCancel`.
- `lib/cb-sync.js` startOrder: after the Promise.all, `await queueFulfilment(q, id)` (covers widget, keyed, manual, CSV, ConvertBuilder orders; it is a no-op unless due).
- `lib/external-orders.js` cancelExternal: `await queueCancel(q, o.id)` where it cancels (`done`).
- `lib/orders-repo.js`: in `upsertExternalOrder` and `upsertCbOrder` add `and zd.orders.fulfil_sent_at is null` next to the `waybill_number = ''` condition (upsertCbOrder: freeze `items`/`total` with a `case when zd.orders.fulfil_sent_at is null then excluded.items else zd.orders.items end`). `shipmentOf`: `external: Boolean(r.waybill_external)`, `trackUrl: r.waybill_track_url || (courier url) || null`. `toOrder`: `fulfilment: { sentAt: iso(fulfil_sent_at), pending: r.fulfil_notify !== '' }`.
- `lib/waybills.js`: a helper `assertOrdyxWaybills(q, order)` that throws `'Товарителниците за този магазин се правят от склада'` when `fulfilmentEnabled(q, order.shopId)` and `'Поръчката е при склада'` when `order.fulfilment.sentAt`; called at the top of `previewWaybill`, `createWaybill`, `assignRoute`, `waybillDefaults`. `cancelWaybill`, `waybillPdf`, `releaseWaybill`, `confirmDrop`: throw `'Тази товарителница е от склада — отменете я при него'` when `order.shipment?.external`. `refreshOrderStatus` claim query and `syncStatuses` select: add `and not waybill_external`.
- `lib/woo-callback.js`: `trackUrl` in the callback body = `o.waybill_track_url || trackUrlOf(...)` (select the column).
- `api/cron/refresh.js`: after `siteCallbacks`, `result.fulfilment = await retryDue(q)` in its own try/catch.

- [ ] **Step 4: Run the hooks tests, then the whole suite**

Run: `node --test test/fulfilment-hooks.test.js && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: hooks PASS 6/6; suite `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib test/fulfilment-hooks.test.js api/cron/refresh.js
git commit -m "feat(fulfilment): hooks on confirm/cancel, frozen sent orders, no Ordyx waybills for warehouse shops"
```

---

### Task 4: Warehouse → Ordyx (reports)

**Files:**
- Create: `lib/fulfilment-inbound.js`, `api/fulfilment.js`
- Modify: `lib/shop-keys.js` (export `overKeyLimit` already; reuse with id `ful:<shopId>`)
- Test: `test/fulfilment-inbound.test.js`

**Interfaces:**
- Consumes: Task 1 `fulfilmentByKey`, `noteFulfilment`; `notifySite` (lib/woo-callback.js), `notifyOrderEvent` (lib/push.js), `syncStockSafe` (lib/stock.js).
- Produces: `inboundHandler(req, res)` (default export of `lib/fulfilment-inbound.js`, used by `api/fulfilment.js`); `applyReport(q, shopId, body) → { status: number, body: object }` (pure of HTTP, what the tests call).

- [ ] **Step 1: Write the failing tests**

```js
// test/fulfilment-inbound.test.js — header/helpers as before; import { applyReport } from '../lib/fulfilment-inbound.js'
test('shipped records the warehouse waybill, moves the order to shipped and tells the shop site', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  const r = await applyReport(q, SHOP, { order_id: id, event: 'shipped', waybill: { courier: 'speedy', number: '5900', track_url: 'https://speedy.bg/t/5900' } });
  assert.deepEqual(r, { status: 200, body: { ok: true, status: 'shipped' } });
  const [o] = await q(`select status, waybill_number, waybill_courier, waybill_external, waybill_track_url, waybill_status, waybill_demo from zd.orders where id = $1::uuid`, [id]);
  assert.deepEqual(o, { status: 'shipped', waybill_number: '5900', waybill_courier: 'speedy', waybill_external: true, waybill_track_url: 'https://speedy.bg/t/5900', waybill_status: 'Изпратена от склада', waybill_demo: false });
  assert.ok((await fulfilmentStatus(q, SHOP)).lastReceivedAt);
});
test('shipped twice updates the number without a second status change; a bad number, courier or http url is refused', async () => { /* 400 cases: number '', 41 chars, courier 'dhl'; track_url http → stored '' */ });
test('shipped for a cancelled order is recorded and flagged, the order stays cancelled', async () => {
  // expect status 200, body.warning present, external_status 'shipped_after_cancel', order status 'cancelled', waybill_number set
});
test('delivered and returned only move a shipped order', async () => { /* applied:false on confirmed; then shipped → delivered sets status + waybill_status 'Доставена' */ });
test('cancelled from the warehouse cancels an unsent/sent open order and clears the waiting mark; not a shipped one', async () => {});
test('an order of another shop or an unknown event is refused', async () => { /* 404 'Няма такава поръчка', 400 unknown event */ });
test('the handler: bad key 401, GET ping, paused integration still accepts reports, rate limit', async () => {
  // fake req/res as in test/orders-keyed.test.js: Authorization 'Bearer <key>'; after pauseFulfilment a shipped report still lands
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/fulfilment-inbound.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/fulfilment-inbound.js` and `api/fulfilment.js`**

`applyReport` per the spec's „Warehouse → Ordyx“ section (statuses, Bulgarian errors, `notifySite(q, id, 'shipped' | 'cancelled')`, pushes „📦 Складът изпрати поръчката“ / „⚠️ Складът изпрати отказана поръчка“ / „❌ Складът отказа поръчката“, `syncStockSafe`). `inboundHandler`: Bearer → `fulfilmentByKey` (401 `'Невалиден ключ — направете нов в Ordyx → Интеграции → Fulfilment'`), `overKeyLimit('ful:' + shopId)` → 429, GET → `{ ok: true, shop }`, POST → `readJson` → `applyReport` → `send`. `api/fulfilment.js`: `export { default } from '../lib/fulfilment-inbound.js'` style wrapper calling `getQuery()`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/fulfilment-inbound.test.js`
Expected: PASS 7/7.

- [ ] **Step 5: Commit**

```bash
git add lib/fulfilment-inbound.js api/fulfilment.js test/fulfilment-inbound.test.js
git commit -m "feat(fulfilment): the warehouse reports waybills and parcel progress"
```

---

### Task 5: Admin actions, status, retry on open, demo

**Files:**
- Modify: `lib/admin/integrations.js` (status `fulfilment`, actions `ful_save`, `ful_key`, `ful_pause`, `ful_disconnect`, `ful_resend`, `ful_test`), `lib/admin/orders.js` (GET list: `retryDue(q, { shopId, budgetMs: 3000, max: 5 })` before listing when the shop's integration is enabled and `countDue > 0`), `api/demo/[route].js` (`ful_test`/`ful_resend` in the demo answer `{ ok: true, demo: true }` without network)
- Test: `test/integrations.test.js` (append), `test/api.test.js` (cron result has `fulfilment`)

- [ ] **Step 1: Write the failing tests** — in `test/integrations.test.js` (use its existing req/res + login helpers): `ful_save` returns `status.fulfilment.enabled true`; `ful_key` returns a `ordyx_ful_` key once; `ful_test` posts `{api:1,event:'ping'}` signed (fake fetch) and returns `{ ok: true }`; `ful_pause` → `enabled false`; `ful_disconnect` with an in-flight order → 400 with the count; GET status carries `fulfilment.due`. In `test/api.test.js`: the cron result includes `fulfilment: { retried, sent }`.

- [ ] **Step 2: Run to see them fail** — `node --test test/integrations.test.js test/api.test.js` → FAIL on unknown actions / missing key.

- [ ] **Step 3: Implement** — actions as one-line `case`s calling Task 1 functions; `ful_test` uses `sendEvent`-style signing but a plain `{ api: 1, event: 'ping' }` body (a helper `pingWarehouse(q, shopId, { fetchImpl })` in `lib/fulfilment.js` returning `{ ok, error }`). Orders GET: the retry runs only for a single-shop scope.

- [ ] **Step 4: Run** — `node --test test/integrations.test.js test/api.test.js` → PASS; then `npm test` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/admin/integrations.js lib/admin/orders.js lib/fulfilment.js api/demo test/integrations.test.js test/api.test.js
git commit -m "feat(admin): fulfilment actions, status and retry when the shop opens its orders"
```

---

### Task 6: Admin UI, developer page, landing

**Files:**
- Modify: `public/admin/index.html`, `public/landing/dev.html`, `public/landing/index.html`

- [ ] **Step 1: Admin card and modal** — next to the WooCommerce card: `icard` „Fulfilment склад“ (tile text `FUL`, chip `iFulChip`, line `iFulLine`, button `iFulOpen`). Modal `fulModal` with: URL input `fulUrl`, radio/select `fulSendOn` (`confirmed` „при потвърждение от клиента (препоръчано)“ / `new` „веднага при постъпване“) + the hint from the spec, „Запази“ (`ful_save`), key box like `wooKeyBox` (`fulKey`, `fulKeyNew` → `ful_key`), „Тествай връзката“ (`ful_test`), „Изпрати неизпратените (N)“ shown when `due > 0` (`ful_resend`), „Спри изпращането“ (`ful_pause`) / „Изтрий връзката“ (`ful_disconnect`, confirm dialog), status lines (последно изпратена / последно получена / грешка). `renderFul(st.fulfilment)` called from `loadIntegrations`. Also link to `https://ordyx.eu/dev#fulfilment`.
- [ ] **Step 2: Orders list** — `shipmentCell`: when `w.external` show „от склада“ tag, use `w.trackUrl`, no „Анулирай“/PDF/drop links. The „Създай товарителница“ button and route chooser are hidden when the current shop's integrations status has `fulfilment.enabled` (keep a `fulOn` flag set by `loadIntegrations`/shop status — fetch the integrations status once when the shop changes if not already loaded) or when `o.fulfilment.sentAt`. Chips: `o.fulfilment.pending` → `<span class="dup">чака склада</span>`; `o.fulfilment.sentAt` → `<span class="tag">склад</span>`.
- [ ] **Step 3: Developer page** — section `<h2 id="fulfilment">6. Fulfilment склад</h2>` after „5. Грешки и лимити“ is renumbered as needed; both bodies from the spec, the signature note, the events table, the „пишете ни“ line with the mailto used on the page.
- [ ] **Step 4: Landing** — in the „Работи ли с моя магазин?“ answer or the integrations strip add „Fulfilment склад — поръчките отиват при склада ви, той връща товарителницата. Работите с конкретен център? Пишете ни.“
- [ ] **Step 5: Verify in the browser** — `node dev/admin-local.mjs` (port 8766): open Интеграции → Fulfilment → save URL `https://example.com/hook`, make a key, see the chip „свързан“; Поръчки: the waybill button is gone, a confirmed order shows „чака склада“; `/dev#fulfilment` renders. No console errors.
- [ ] **Step 6: Commit**

```bash
git add public/admin/index.html public/landing/dev.html public/landing/index.html
git commit -m "feat(admin): Fulfilment склад card, warehouse waybills in the list, developer docs"
```

---

### Task 7: Release

- [ ] **Step 1:** `npm test` → `# fail 0`.
- [ ] **Step 2:** Apply `db/migrations/026_fulfilment.sql` to production via Supabase MCP `apply_migration` (project `etxbigwubhuvdmnwtsia`, name `026_fulfilment`).
- [ ] **Step 3:** `npx vercel deploy --prod --yes`; then `curl -s -o /dev/null -w '%{http_code}' https://app.ordyx.eu/api/fulfilment` → 401; `https://ordyx.eu/dev` → 200 containing `id="fulfilment"`; admin loads.
- [ ] **Step 4:** Commit nothing new; report.
