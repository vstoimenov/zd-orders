# Custom sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** custom sites join through the orders API (with webhooks and a developer page), the picker drops into any form, and shops without any integration enter orders by hand or from CSV.

**Architecture:** webhooks extend `lib/woo-callback.js` (source `api` → `webhookUrl`); the picker gets a declarative mount in
`public/checkout.js`; manual + CSV orders are new actions in `lib/admin/orders.js` backed by `lib/manual-orders.js` (validation
reuses `lib/order.js`, insert reuses `upsertExternalOrder`); the developer page is static under `public/landing/dev.html`.

**Spec:** `docs/superpowers/specs/2026-10-23-custom-sites-design.md`

## Global Constraints
- Numbers: manual `<domain>:m-<8 hex>`, csv `<domain>:c-<8 hex of file>-<row>`; sources `manual`, `csv`, `api`.
- CSV: UTF-8 (with/without BOM) or Windows-1251 (detect by invalid UTF-8), delimiter `,` or `;` (count in the header), ≤ 500 rows, ≤ 1 MB.
- Webhook: same signature/timestamp as WooCommerce; host must equal the shop domain; 5 s; retried by `retryCallbacks`.
- No new Vercel functions; ES5 widget; Bulgarian UI; commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus
1. CSV with Windows-1251, `;`, quoted fields with commas/new lines, and a BOM parses right; a 2nd import of the same file changes nothing.
2. A client admin can create/import only into their own shops; `shop=all` is refused for writes.
3. Manual orders go through stock/НЕкоректен/push but never the automatic WhatsApp message.
4. Webhook to a host other than the shop domain is refused; a site answering 3xx/5xx is retried nightly.
5. The declarative picker never breaks a page without the attributes, and writes nothing when the user picks nothing.

---

### Task 1: webhooks for API senders
**Files:** `lib/shop-keys.js` (`siteInfo` accepts `webhookUrl`), `lib/woo-callback.js` (source `api` → `webhookUrl`, `retryCallbacks` includes `api`), tests `test/woo-callback.test.js`.
- [ ] Tests: an `api` order with a stored `webhookUrl` on the shop domain gets the signed POST; another host refused; `retryCallbacks` retries `api` orders.
- [ ] RED → implement → GREEN; commit `feat(api): webhooks for custom sites`.

### Task 2: manual orders + CSV import (backend)
**Files:** create `lib/manual-orders.js` (`createManualOrder(q, {shopId, domain, order}) → {id}`, `parseCsv(text|buffer) → {rows, delimiter, encoding}`, `previewImport(q, {shopId, domain, csv}) → {rows:[{row, ok, error, order}], summary}`, `importCsv(...)` → counts), `lib/admin/orders.js` (POST actions `create`, `import`), tests `test/manual-orders.test.js`.
- [ ] Tests: create → order with source `manual`, number `<domain>:m-…`, stock/push run, no WhatsApp; CSV samples (UTF-8 BOM `;`, Windows-1251 `,`, quoted commas, missing phone → skipped, office text matched to `econt:<code>` when it holds a code in brackets); second import → `updated`/`skipped`, no duplicate; a client cannot import into another shop.
- [ ] RED → implement → GREEN; commit `feat(orders): manual orders and CSV import`.

### Task 3: admin UI
**Files:** `public/admin/index.html` („+ Нова поръчка“ modal with `OrdyxPicker` for office types + address fields + items table; „Импорт от CSV“ modal: file → preview table → import; loads `/checkout.js`).
- [ ] Browser check in the local admin (both modals, a client account); commit `feat(admin): new order and CSV import`.

### Task 4: declarative picker + developer page
**Files:** `public/checkout.js` (`[data-ordyx-picker]` auto-mount with `data-type`, `data-into`, `data-city`, `data-zip`, `data-office-id`), `dev/harness-form.html`, `public/landing/dev.html` + `vercel.json` rewrite `/dev` on ordyx.eu, a link from Интеграции → WooCommerce card („API и собствени сайтове“).
- [ ] Browser check of the harness form; commit `feat(dev): the picker in any form and the developer page`.

### Task 5: release
- [ ] Suite green, deploy, open ordyx.eu/dev, create one manual order in the demo.
