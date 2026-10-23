# Собствени сайтове — design

Date: 2026-10-23. The owner: "да" to start without questions; earlier: three ways in for shops with their own (custom) site —
a one-line office picker for any form, an orders API with instructions for developers, and no-integration entry (manual orders,
CSV). Everything reuses the WooCommerce work: the shop key, `POST /api/orders`, the signed callbacks, `OrdyxPicker`.

## What the shop gets
1. **API for developers** — a public page `ordyx.eu/dev` (Bulgarian, with curl/PHP/Node examples): the shop key (Интеграции →
   WooCommerce/API), `GET /api/orders` (check), `POST /api/orders` (the order shape, `source: 'api'`, `external_id`, idempotent
   re-sends, `status: 'cancelled'`), the answer, errors, the 600/hour limit, and **webhooks**: the site sends
   `X-Ordyx-Site: {"webhookUrl": "https://<the shop's domain>/…"}`; Ordyx POSTs there (same HMAC signature as WooCommerce) on
   `shipped`, `waybill_cancelled`, `cancelled`; a failed webhook is retried nightly (3 days). The page also documents the picker.
2. **Picker in any form** — one script tag + `data-ordyx` attributes, no code:
   `<script src="https://app.ordyx.eu/checkout.js" defer></script>` and
   `<div data-ordyx-picker data-type="econt_office" data-into="#office" data-city="#city" data-zip="#zip"></div>`.
   `data-type` can be a fixed type or `select:#how` (a select whose option values are Ordyx types). The chosen point is written
   into the site's own inputs (text, city, post code; plus `data-office-id` for the id). Programmers can also call
   `OrdyxPicker.mount(...)` directly (already there).
3. **Manual order in the admin** — Поръчки → „+ Нова поръчка“: name, phone, email, delivery (the same picker: courier/office or
   address, or „друго“), items (name × qty × price), total, payment (cash on delivery / paid). Source `manual`, number
   `<domain>:m-<short id>`. Goes through the same post-insert steps (stock, НЕкоректен, push; no WhatsApp confirmation).
4. **CSV import** — Поръчки → „Импорт от CSV“: upload a file (UTF-8 or Windows-1251, `,` or `;`), columns matched by header
   (name, phone, email, city, office/address, items, total, payment; synonyms in Bulgarian/English), a preview with errors per row,
   then import. Delivery becomes `other` unless an office id/text can be matched; the shop picks the courier in the waybill window
   (already there). Source `csv`, number `<domain>:c-<file hash>-<row>` (importing the same file twice does not duplicate).

## Data / API
- `X-Ordyx-Site.webhookUrl` stored in the key status (`restUrl` stays for WooCommerce); `notifySite` posts to `webhookUrl` for
  source `api` (host must equal the shop domain); `site_notify` retry covers it.
- `POST /api/admin/orders {action: 'create', order}` (owner or client within their shop) → `{ok, id}`; `{action: 'import', csv}`
  → `{preview}` / `{action: 'import', csv, confirm: true}` → `{inserted, updated, skipped, errors}`. Max 500 rows per import.
- No migration: `source` is free text; `cb_order_id` unique.

## Decisions (mine — owner can overrule)
- `ordyx.eu/dev` is public (no secrets on it); the key is shown only in the admin.
- Manual/CSV orders never send the WhatsApp confirmation automatically (the shop already spoke to the customer).
- The CSV preview is shown before anything is written; rows with no phone or no items are skipped, not imported.
- The admin loads `/checkout.js` for the picker (same origin).

## Non-goals
Product catalogue sync, custom-site abandoned carts, a JS SDK beyond `OrdyxPicker`, XLSX import (CSV only).
