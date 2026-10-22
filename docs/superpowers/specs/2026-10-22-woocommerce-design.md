# Ordyx за WooCommerce + API за поръчки — design

Date: 2026-10-22. Owner: WooCommerce is where most potential clients are; ours must be the better choice than the free courier
plugins they already use. Both ways in: our checkout (recommended) and „само поръчките“ for shops not ready to switch — „ще им
трябва, нашия е по-добър“ (switch them later).

## Why ours wins
Free BG plugins (Drusoft Econt/Speedy, AV Solutions, Bulgarisation, BG Couriers, ShipBG) do one courier or the office picker plus
a waybill; several do not work with the block checkout (WooCommerce's default). Ours: Econt, Speedy and BOX NOW in one picker with
„Намери ме“, map and hours, then everything after the order — waybills, НЕкоректен, tracking page, packing + QR, profit, abandoned
carts, many shops for agencies.

## What the shop gets
1. **A WordPress plugin „Ordyx за WooCommerce“** (zip download from Ordyx admin → Интеграции → WooCommerce; WordPress.org later).
2. **Connection**: in the plugin settings the shop pastes its **Ordyx shop key** (made in Ordyx, one per shop, can be renewed —
   the old one stops at once). Test button „Провери връзката“.
3. **Mode „Ordyx в чекаута“ (default)**: our courier/office/locker picker in WooCommerce checkout — classic shortcode checkout and
   the block checkout. The couriers appear as WooCommerce shipping methods (Еконт офис/автомат, Еконт адрес, Спиди офис/автомат,
   Спиди адрес, BOX NOW автомат), switched on and priced in WooCommerce's own shipping zones (flat price, free over an amount —
   standard WooCommerce UX). The picker is the same widget as in ConvertBuilder (search, „Намери ме“, map, hours); the chosen point
   is stored on the order (office id + readable text) and checked server-side before the order is placed.
4. **Mode „Само поръчките“**: the plugin leaves the checkout alone; orders still go to Ordyx with whatever address/shipping method
   the existing plugin wrote. The shop picks the office in the Ordyx waybill window when it is not known. A banner in the plugin
   settings explains what they miss and offers the switch.
5. **Orders into Ordyx at once**: when WooCommerce creates an order (any payment: COD and card), the plugin sends it to Ordyx
   server-to-server with the shop key; a failed send is retried (WP cron, up to 24 h) and visible in the plugin settings. Paid by
   card orders carry „платена“ so the waybill has no cash on delivery.
6. **Back into WooCommerce**: when Ordyx creates a waybill, WooCommerce gets the number + tracking link (order note + order
   meta, shown in the customer's „My account“ order view and in the „completed“ email), and the status changes: shipped →
   „Completed“ (default, can be switched to keep the status), cancelled in Ordyx → „Cancelled“. Ordyx calls the plugin's REST
   endpoint, signed with the shop key (HMAC).
7. **Ordyx admin → Интеграции → WooCommerce card**: make/renew the shop key, download the plugin, status (last order received,
   errors), the mode the plugin reports.

## API for orders (also for custom sites later)
- `POST /api/orders` keeps serving the ConvertBuilder widget; it also accepts `Authorization: Bearer <shop key>` (no Origin check,
  no ORDER_TOKEN) for server-to-server senders. The key identifies the shop; the body is the same order shape plus
  `source: 'woocommerce'`, `external_id` (the WooCommerce order id), `paid: true|false`.
- Idempotent by (shop, source, external_id): re-sends update, never duplicate.
- Keys are stored hashed; shown once when made. No new Vercel function (10/12 used).

## How it works in detail (builder's questions, settled)
1. **Keys and signing**: one key per Ordyx shop, `ordyx_live_<random>`; Ordyx keeps it **sealed** (lib/secretbox.js, like courier
   passwords — not hashed), so it can both check incoming orders and sign its calls back (HMAC-SHA256 over the raw body, header
   `X-Ordyx-Signature`, plus a timestamp; ±5 min). Renewing replaces it at once. The plugin reports its REST URL
   (`<home_url>/wp-json/ordyx/v1/…`) with every order and on „Провери връзката“; Ordyx calls back only if that host equals the
   shop's domain (www ignored). Staging = its own Ordyx shop with its own domain and key. A shop not approved yet (client-made) gets
   403 „чака одобрение“.
2. **Delivery types**: new `econt_address` (Econt to an address, with its waybill — WooCommerce shops ship to addresses a lot) and
   `other` (courier/office unknown — „Само поръчките“ with flat rate, pickup or another courier's method). `other` skips the
   office/address checks; the waybill window then asks for the courier and office. The method title the other plugin wrote is kept
   in the office text so the shop sees it.
3. **When orders are sent**: cash on delivery — when WooCommerce creates the order (processing/on-hold); card/bank — on
   `payment_complete` only; pending/failed are never sent. Key = (shop, `woocommerce`, WC order id), `cb_order_id` =
   `<domain>:wc-<id>`. Re-sends update name/phone/address/items/total only while Ordyx has no waybill. Cancelled or refunded in
   WooCommerce → sent as cancelled; Ordyx cancels it if there is no waybill, otherwise keeps it and tells the shop (push +
   badge „отказана в WooCommerce“).
4. **Checking the chosen point**: the plugin keeps the shop's office lists cached from `/api/offices` (same as the widget) and checks
   the office id against them on „Place order“; if the cache is empty and Ordyx is unreachable it **accepts** and the order arrives in
   Ordyx marked „провери офиса“. BOX NOW is offered only when the shop switched it on (existing `courier=shop` info).
5. **Money**: items at the prices the customer paid (tax included, coupons spread over the lines), shipping as its own field,
   `total` = the WooCommerce order total, `payment_method` `cod` or `card`. A card-paid order gets COD 0 on the waybill. The order's
   currency is stored as WooCommerce sent it.
6. **The picker**: the existing widget gets a small mount API; the plugin loads it from Ordyx for the classic checkout and for the
   block checkout (a Blocks integration written in plain JS on `wp.element` — no build step, like the rest of Ordyx). The shop is
   found by the site's host, as today.
7. **Agencies**: each shop has its own key; one Ordyx login may hold many shops (already so).
8. **After the order**: the same steps as ConvertBuilder orders (stock, НЕкоректен, push to the shop, duplicate flag); WhatsApp
   confirmation only for cash on delivery. The per-IP limit does not apply to keyed requests (a limit per key instead: 600/hour).
   Product name = title + variation („Тениска — M, черна“); SKU sent too.
9. **The zip**: built by `node dev/woo-zip.mjs` into `public/integrations/ordyx-woocommerce.zip` (committed), with
   `public/integrations/woocommerce.json` (`version`, `api: 1`, download URL); the plugin uses it for WordPress's own
   „update available“ (self-update), until it is on WordPress.org.

## Constraints
- PHP plugin: WordPress 6.4+, WooCommerce 8.x+, PHP 7.4+; HPOS compatible; no external PHP libraries; Bulgarian UI strings.
- Plugin code lives in this repo under `integrations/woocommerce/ordyx/`; the zip is built by a dev script and served from Ordyx.
- Local testing: WordPress + WooCommerce in Docker on this machine (no real shop needed); a real client's staging later.
- Never store the shop key in plain text in Ordyx; in WordPress it sits in wp_options like other gateway keys.

## Decisions (mine — owner can overrule)
- Shipping prices are set in WooCommerce (not in Ordyx) — shops already know that screen.
- Shipped → Completed by default (common in BG shops), switchable.
- Retry window 24 h, then the order shows as „не е изпратена в Ordyx“ in the plugin with a „Изпрати пак“ button.
- „Само поръчките“ does not parse other plugins' private meta (formats differ and change); office text comes from the shipping
  address lines.
- WordPress.org listing later (review takes weeks); first the zip.

## Non-goals (this round)
Payments/card gateway (later, as an option), product/stock sync from Ordyx to WooCommerce, abandoned carts on WooCommerce,
Shopify, custom-site embed (next project reuses the API).

## Anti-goals
- A broken Ordyx connection must never block a WooCommerce checkout: orders are queued and sent later.
- No duplicate orders in Ordyx when WooCommerce re-saves or the plugin retries.
