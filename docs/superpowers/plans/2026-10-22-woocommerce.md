# Ordyx for WooCommerce + orders API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a WordPress plugin that puts the Ordyx courier picker into WooCommerce checkout (or only forwards orders), sends every order to Ordyx with a per-shop key, and gets the waybill number, tracking link and status back.

**Architecture:** Ordyx side — a keyed path in the existing `api/orders.js` (no new Vercel function), shop keys sealed in
`zd.integrations` (provider `woocommerce`), two new delivery types (`econt_address`, `other`), signed callbacks to the plugin
after waybill/cancel, an Интеграции card, and a mount API in `public/checkout.js` the plugin reuses. WordPress side — a
dependency-free PHP plugin under `integrations/woocommerce/ordyx/`, zipped into `public/integrations/`.

**Tech Stack:** Node 22 ESM, Postgres (`zd`), node:test + PGlite; ES5 widget; PHP 7.4+/WordPress 6.4+/WooCommerce 8+ (HPOS,
classic + block checkout, plain JS on `wp.element`, no build); Docker for a local WordPress (`DOCKER_CONFIG=/tmp/dockercfg`).

**Spec:** `docs/superpowers/specs/2026-10-22-woocommerce-design.md`

## Global Constraints
- Key format `ordyx_live_<keyId 10 chars base62>_<secret 32 chars base64url>`; stored sealed (`lib/secretbox.js` `seal/open`);
  lookup by `config.keyId`, compare with `timingSafeEqual`. Shown once when made.
- Callback signature: header `X-Ordyx-Timestamp` (unix s) + `X-Ordyx-Signature` = hex HMAC-SHA256(key, `${timestamp}.${rawBody}`);
  plugin rejects when |now − timestamp| > 300 s. Callbacks only to a URL whose host (www stripped) equals the shop's domain.
- Woo orders: `cb_order_id = '<domain>:wc-<wcId>'`, `source = 'woocommerce'`; `payment_method` `cod` | `card`.
- Keyed requests: no Origin/ORDER_TOKEN check, no per-IP limit; 600 requests/hour per key (per instance).
- Delivery types: add `econt_address`, `other` (migration 024). `other` skips office/address checks.
- No new Vercel functions (10/12). Bulgarian UI; English code; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- A broken Ordyx connection never blocks a WooCommerce checkout (queue + retry 24 h).

## Review Focus
1. A leaked/renewed key: the old key is refused at once; a key of shop A can never write into shop B.
2. Re-sends and parallel retries never create two orders; a re-send never overwrites an order that has a waybill.
3. A card order is never sent before payment; a card-paid order's waybill has COD 0.
4. Callbacks: wrong host refused; a slow WordPress (5 s) never fails the waybill creation in Ordyx.
5. The ConvertBuilder widget keeps working byte-for-byte in behaviour after the mount-API change (harness + checkout-core tests).

---

### Task 1: shop keys + keyed orders API
**Files:** create `lib/shop-keys.js`, `db/migrations/024_woocommerce.sql`; modify `lib/order.js` (econt_address, other, `paid`→`card`), `api/orders.js` (Bearer path), `lib/orders-repo.js` (`upsertExternalOrder`), tests `test/orders-keyed.test.js`, `test/order.test.js`.
**Interfaces — Produces:**
- `makeShopKey(q, shopId) → { key }` (replaces the old one), `shopByKey(q, key) → { shopId, domain, approved } | null`, `keyStatus(q, shopId) → { hasKey, keyId, createdAt, lastOrderAt, lastError, mode, pluginVersion, restUrl }`, `noteKeyUse(q, shopId, patch)`.
- `upsertExternalOrder(q, order) → { id, inserted, updated, locked }` — insert, or update name/phone/email/address/office/items/total/payment while `waybill_number = ''`; `locked: true` when it has a waybill.
- Migration 024: delivery_type check + `econt_address`; `alter table zd.orders add column if not exists external_status text not null default ''`.
- [ ] Tests: `GET /api/orders` with the key (the plugin's „Провери връзката“) → `{ ok: true, shop: { name, domain } }` and records `site: { restUrl, mode, version }` sent in the `X-Ordyx-Site` header (JSON) into `keyStatus`; orders record it too. Key made → order with `Authorization: Bearer <key>` lands in that shop with `cb_order_id 'a-shop.bg:wc-17'`, `source 'woocommerce'`; renewed key → old one 401; key of shop A with body for anything → shop A only; unapproved shop → 403 „чака одобрение“; same wc id twice → one order, second updates items; after a waybill → `locked`, nothing changes; `paid: true` → `payment_method 'card'`; `status: 'cancelled'` with no waybill → order cancelled (stock back), with a waybill → `external_status 'cancelled'` and the owner's push „отказана в WooCommerce“; `econt_address` needs city + address; `other` needs neither; 601st request in an hour → 429; the ConvertBuilder path (token + Origin) unchanged (existing api tests green).
- [ ] RED → implement → GREEN; commit `feat(api): per-shop keys and keyed orders for WooCommerce and custom sites`.

### Task 2: Econt to an address
**Files:** `lib/econt-api.js` (`buildLabel` with `receiverAddress` for `econt_address`), `lib/waybills.js` (defaults/preview/create accept it), `public/admin/index.html` (waybill window shows the address), tests `test/econt-api.test.js`, `test/waybills.test.js`.
- [ ] Tests: `buildLabel` for `econt_address` → no `receiverOfficeCode`, `receiverAddress: { city: { country: { code3: 'BGR' }, name: 'Варна', postCode: '9000' }, other: 'ул. Тайна 5' }`; office order unchanged.
- [ ] Verify once with `mode: 'calculate'` against demo.econt.com (public test account iasp-dev) that the address label is accepted; adjust the address shape to what Econt accepts and pin it in the test.
- [ ] RED → implement → GREEN; commit `feat(econt): waybills to an address`.

### Task 3: orders with an unknown courier (`other`)
**Files:** `lib/waybills.js` (`createWaybill`/`previewWaybill` accept `input.courier` + `input.officeId` or address when the order's type is `other`, and store them on the order first), `public/admin/index.html` (waybill window: courier select + office search for `other`), tests `test/waybills.test.js`.
- [ ] Tests: an `other` order + `{ courier: 'econt', officeId: 'econt:1107' }` → the order becomes `econt_office` with that office, then the label is built; without a courier → „Изберете куриер и офис“.
- [ ] RED → implement → GREEN; commit `feat(waybills): pick the courier and office for orders that came without one`.

### Task 4: callbacks to WooCommerce
**Files:** create `lib/woo-callback.js` (`notifySite(q, orderId, event)`), call it from `createWaybill` (live), `cancelWaybill`, admin PATCH to `cancelled`; tests `test/woo-callback.test.js`.
**Interfaces — Consumes:** `keyStatus().restUrl`, sealed key. **Produces:** POST `<restUrl>/ordyx/v1/order` body `{ api: 1, event: 'shipped'|'cancelled', wcId, number, courier, trackUrl, trackingPage }`.
- [ ] Tests: shipped → one signed POST (signature verifies with the key), body has `trackingPage 'https://app.ordyx.eu/p/<token>'`; host ≠ shop domain → no call, `lastError` set; WordPress hanging → returns within 5 s, waybill still created; non-Woo orders → no call.
- [ ] RED → implement → GREEN; commit `feat(woocommerce): tell the shop's site about waybills and cancellations`.

### Task 5: picker mount API in the widget
**Files:** `public/checkout.js` (`window.OrdyxPicker.mount(el, { api, host, courier, type, onChange })` → `{ value(), destroy() }`; the ConvertBuilder mount untouched), `dev/harness.html` (a standalone mount demo), `test/checkout-core.test.js`.
- [ ] Tests: core exports unchanged; in the harness the standalone picker searches, „Намери ме“, map, hours, and `onChange` gets `{ type, officeId, officeText, city, postCode }`; the ConvertBuilder harness behaves as before.
- [ ] Commit `feat(checkout): a mount API so other platforms reuse the picker`.

### Task 6: Интеграции → WooCommerce card
**Files:** `lib/admin/integrations.js` (actions `woo_key` (make/renew → key once), status block `woocommerce`), `public/admin/index.html` (card + modal: steps, key shown once with copy, download, last order, mode, errors), tests `test/integrations.test.js`.
- [ ] Tests: `woo_key` returns a key once, status never shows it; a client only for their own shop.
- [ ] Commit `feat(admin): WooCommerce card — shop key, plugin download, status`.

### Task 7: the WordPress plugin
**Files:** `integrations/woocommerce/ordyx/` — `ordyx.php` (header, HPOS + blocks compatibility declared), `includes/class-settings.php` (key, mode, test connection, shipped→Completed switch), `includes/class-shipping.php` (shipping methods per courier type in zones), `includes/class-checkout-classic.php` + `assets/checkout-classic.js` (picker via `OrdyxPicker.mount`, hidden fields, server-side check against cached offices, fail-open), `includes/class-checkout-blocks.php` + `assets/checkout-blocks.js` (Blocks integration, Store API extension data), `includes/class-sender.php` (hooks: `woocommerce_checkout_order_processed`/`woocommerce_store_api_checkout_order_processed` for COD, `woocommerce_payment_complete` for card, `woocommerce_order_status_cancelled|refunded`; queue in order meta + WP cron retry 24 h; „Изпрати пак“), `includes/class-rest.php` (`ordyx/v1/order` with signature check → note + meta + status), `includes/class-updater.php` (self-update from `woocommerce.json`), `readme.txt`; `dev/woo-env/docker-compose.yml` (wordpress + mariadb + wp-cli), `dev/woo-zip.mjs`.
- [ ] Local check in Docker against `dev/admin-local.mjs` (host.docker.internal:8766): classic and block checkout place a COD order with an Econt office → it appears in Ordyx with the office; a card order (WooCommerce's test „cheque“ marked paid) arrives only after payment; a waybill in Ordyx → note, tracking link and Completed in WooCommerce; Ordyx stopped → checkout still works, the order is sent on the next cron run; „Само поръчките“ with a flat-rate method → `other` order.
- [ ] Commit `feat(woocommerce): the Ordyx plugin`.

### Task 8: zip + release
**Files:** `public/integrations/ordyx-woocommerce.zip`, `public/integrations/woocommerce.json`, `vercel.json` (no-cache header for the json).
- [ ] `node dev/woo-zip.mjs`; apply migration 024; full suite; deploy; download the zip from production, install it on the local WordPress, connect to production with a test shop key, place one test order and delete it afterwards.
