# Abandoned Carts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shop sees checkouts where a customer typed a valid phone but did not order, and reminds them by WhatsApp, SMS or Viber (plain or with a discount code) from its own phone; Табло shows abandoned / recovered.

**Architecture:** The checkout widget sends a debounced `cart` event through the existing `api/visit.js`; `lib/abandoned.js` stores one row per shop + phone + 24 h window in `zd.abandoned_carts` and derives state (open / reminded / recovered / hidden) at read time by joining `zd.orders`. A new admin route `abandoned` (inside the existing router) serves the list, reminder links and settings; `getStats` gains an `abandoned` block; the nightly cron anonymises after 30 days.

**Tech Stack:** Node 22 ESM, plain Vercel functions (no new function), Postgres (Supabase schema `zd`), node:test + PGlite, vanilla JS admin (`public/admin/index.html`) and widget (`public/checkout.js`).

**Spec:** `docs/superpowers/specs/2026-10-17-abandoned-carts-design.md`

## Global Constraints
- No new serverless function (10/12 used): capture via `api/visit.js`, admin via `api/admin/[route].js` (`ROUTES` gains `abandoned`).
- New table needs, in production: `grant select, insert, update, delete on zd.abandoned_carts to zd_app` + `create policy … for all to zd_app using (true) with check (true)` (RLS on), as migrations 011–016.
- Capture starts only with a valid phone (`normalizePhone` from `lib/phone.js`); never blocks/alters the checkout; silent failure.
- Abandoned after **30 minutes** without a matching order; recovered = matching order within **7 days**; matching order = same shop, same `phone_norm`, `created_at` > cart `created_at`, `status <> 'cancelled'`, `cb_check <> 'pending'`.
- Same phone: update the open row if `updated_at` < **24 h** ago and not reminded/hidden/recovered; else new row.
- Anonymise after **30 days** (clear name, phone_norm, email, items, page_url, delivery_text; set `anonymised_at`); delete after **400 days**.
- Opted-out numbers (`zd.campaign_optouts` for the shop) show „отписан от съобщения“ and get no reminder links.
- `{линк}` only if `https` and host = shop domain, `www.` of it or a subdomain; else `https://<shop domain>/`; drop query and fragment.
- Variables: `{име}`, `{пълно_име}`, `{продукти}`, `{сума}`, `{магазин}`, `{линк}`; discount text also `{код}`, `{отстъпка}`; saving the discount text requires `{код}`; texts ≤ 700 chars; per shop (refused for „all“).
- Default texts (exact):
  - plain: `Здравейте, {име}! Видяхме, че не завършихте поръчката си в {магазин} ({продукти}). Ако имате въпрос — пишете ни тук, ще помогнем. Можете да продължите оттук: {линк}`
  - discount: `Здравейте, {име}! Поръчката ви в {магазин} ({продукти}) още ви чака. Подарък от нас: {отстъпка} с код {код}. Продължете оттук: {линк}`
- No phone push. UI Bulgarian, code/commits English, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Customer types phone, then orders within minutes → never appears as abandoned (Task 1 test `an order within 30 minutes is not abandoned`).
2. Forged capture with a foreign `page_url` → message uses the shop's home page (Task 2 test `a link to another site falls back to the shop home`).
3. Capture from an origin that is not an approved shop → refused 403, nothing stored (Task 3 test `capture from an unknown site is refused`).
4. Oversized payload (200 items, 5 000-char names) → stored truncated (≤ 50 items, names ≤ 200, strings capped), no error (Task 1 test `oversized carts are trimmed`).
5. A client user cannot list, remind or hide another shop's carts (Task 4 test `a client sees and acts only on its own shops`).

---

### Task 1: Storage and state (`lib/abandoned.js` core)

**Files:**
- Create: `db/migrations/017_abandoned_carts.sql`, `lib/abandoned.js`
- Test: `test/abandoned.test.js`

**Interfaces:**
- Produces:
  - table `zd.abandoned_carts(id uuid pk default gen_random_uuid(), shop_id uuid not null references zd.shops(id) on delete cascade, phone_norm text not null default '', name text not null default '', email text not null default '', items jsonb not null default '[]', total numeric not null default 0, currency text not null default 'EUR', delivery_text text not null default '', page_url text not null default '', ip text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), reminded_at timestamptz, reminder_channel text not null default '', reminder_count int not null default 0, hidden_at timestamptz, anonymised_at timestamptz)` + index `(shop_id, phone_norm, updated_at desc)`; comment lines with the production grant/policy.
  - `captureCart(q, { shopId, phone, name, email, items, total, currency, deliveryText, pageUrl, ip }) → { id, created: boolean } | null` (null when the phone is invalid).
  - `listCarts(q, { shopId = null, shopIds = null, state = 'open', now = new Date() }) → rows[]` with `{ id, shopId, createdAt, updatedAt, name, phoneNorm, email, items, total, currency, deliveryText, pageUrl, state: 'open'|'reminded'|'recovered'|'hidden', remindedAt, reminderChannel, reminderCount, recoveredAt, optedOut }`; `state` filter: `'open'` (default: open + reminded, not recovered, not hidden), `'all'`, or one state. Only carts abandoned (≥ 30 min since `updated_at` with no matching order since `created_at`) or recovered appear; last 30 days; newest first; max 200.
  - `openCount(q, { shopId|shopIds }) → number` (state open, last 7 days — the badge).
  - `cartStats(q, { from, to, shopId|shopIds }) → { count, total: [{currency, amount}], recovered, afterReminder }` (period by `created_at`, Europe/Sofia days, same day rules as `lib/stats.js` `scope`).
  - `anonymiseOld(q) → { anonymised, deleted }`.

- [ ] **Step 1: Write failing tests** in `test/abandoned.test.js` (PGlite via `makeTestQuery`; shop `00000000-0000-4000-8000-000000000001`; insert orders with `insertOrder` from `lib/orders-repo.js`; move time by updating `created_at/updated_at` with SQL):
  - `a cart with an invalid phone is not stored` → `captureCart(... phone: '123')` returns `null`, table empty.
  - `the same phone within 24 h updates one row` → two captures 1 min apart (second with 2 items) → one row, items length 2, `created` false on the second.
  - `a reminded or older cart starts a new row` → after `markReminded` (Task 2) or `updated_at` 25 h ago, capture → 2 rows. (Write the 25 h case here; the reminded case in Task 2.)
  - `a fresh cart is not abandoned yet` → captured now → `listCarts` empty; set `updated_at = now() - 31 min` → one row, state `open`.
  - `an order within 30 minutes is not abandoned` → cart 31 min old, order same phone created after the cart → `listCarts` empty, `cartStats.count` 0.
  - `an order after abandonment recovers it, a cancelled or pending one does not` → order 1 h after cart: state `recovered`, `recoveredAt` set; with `status='cancelled'` or `cb_check='pending'`: state `open`; order 8 days later: `open`.
  - `oversized carts are trimmed` → 200 items with 5 000-char names → stored ≤ 50 items, each name ≤ 200; name/email ≤ 160; page_url ≤ 500; delivery_text ≤ 200.
  - `stats count abandoned, recovered and after a reminder by first capture day` → 3 abandoned carts (one recovered, one recovered after `reminded_at` set before the order) → `{ count: 3, recovered: 2, afterReminder: 1 }`, totals summed per currency.
  - `old carts are anonymised, very old deleted` → `updated_at` 31 days ago → personal fields cleared, `anonymised_at` set, still counted by `cartStats`; `created_at` 401 days → deleted.
  - `opted-out numbers are flagged` → row in `zd.campaign_optouts` for the phone → `optedOut: true`.

- [ ] **Step 2: Run** `node --test test/abandoned.test.js` — expected FAIL (module/table missing).

- [ ] **Step 3: Implement** the migration and the functions above. Matching order SQL (one `lateral` used by list and stats):
  `select o.created_at from zd.orders o where o.shop_id = c.shop_id and c.phone_norm <> '' and o.phone_norm = c.phone_norm and o.created_at > c.created_at and o.status <> 'cancelled' and o.cb_check <> 'pending' order by o.created_at limit 1` — "not abandoned" when it exists and is ≤ `updated_at + 30 min`; "recovered" when it exists, is later, and ≤ `updated_at + 7 days`. Anonymised rows keep `phone_norm = ''` but store the recovered fact: before anonymising, set a `recovered_at` column (add it to the table: `recovered_at timestamptz`) from the lateral so stats stay right.

- [ ] **Step 4: Run** `node --test test/abandoned.test.js` — PASS; `npm test` — all pass.

- [ ] **Step 5: Commit** `feat(abandoned): carts table, capture and derived state`

### Task 2: Reminder texts and links

**Files:**
- Modify: `lib/abandoned.js`
- Test: `test/abandoned.test.js`

**Interfaces:**
- Consumes: Task 1 rows; `fill` from `lib/campaigns.js`.
- Produces:
  - `DEFAULT_TEXTS = { plain, discount }` (exact strings from Global Constraints).
  - `getReminderSettings(q, shopId) → { plain, discount, code, discountText }` (zd.settings key `abandoned_msg:<shopId>`, jsonb via `jsonb_build_object`, defaults when missing).
  - `setReminderSettings(q, shopId, { plain, discount, code, discountText })` — errors (Bulgarian): no shop → `Изберете магазин`; discount text without `{код}` when a code is set → `Текстът с отстъпка трябва да съдържа {код}`; > 700 → `Съобщението е до 700 знака`; code ≤ 40 chars `[A-Za-z0-9_-]`, discountText ≤ 60.
  - `safeLink(pageUrl, shopDomain) → string`.
  - `reminderLinks(q, { id, kind: 'plain'|'discount', scopeShopId, scopeShopIds }) → { message, whatsapp, sms, viber } | null` — null when not in scope; `viber = 'viber://chat?number=%2B' + digits`; no links (all three null, message kept) when opted out; `kind:'discount'` without a code → error `Първо въведете код за отстъпка`. `{продукти}` = item names joined `, `; `{сума}` = `22,57 €` format (as `lib/confirm.js` `money`).
  - `markReminded(q, { id, channel: 'whatsapp'|'sms'|'viber', scopeShopId, scopeShopIds }) → boolean` (sets `reminded_at` only if null, `reminder_channel`, `reminder_count + 1`).
  - `hideCart(q, { id, scopeShopId, scopeShopIds }) → boolean`.

- [ ] **Step 1: Failing tests:** `default texts fill the cart`, `the shop's own texts and code are used` (`{код}` → `ЛЯТО10`, `{отстъпка}` → `10% отстъпка`), `discount text must contain {код}`, `a link to another site falls back to the shop home` (`https://evil.example/x` → `https://a-shop.bg/`; `https://www.a-shop.bg/p?utm=1#a` → `https://www.a-shop.bg/p`), `whatsapp, sms and viber links`, `opted-out carts get no links`, `reminding marks the first time and counts`, `a reminded cart starts a new row on the next capture` (from Task 1), `hidden carts leave the open list and the badge but stay in stats`.
- [ ] **Step 2:** `node --test test/abandoned.test.js` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** test file PASS, `npm test` PASS.
- [ ] **Step 5: Commit** `feat(abandoned): reminder texts, discount code and WhatsApp/SMS/Viber links`

### Task 3: Capture endpoint

**Files:**
- Modify: `api/visit.js`
- Test: `test/abandoned.test.js` (or `test/visits.test.js` if it already drives `api/visit.js`)

**Interfaces:**
- Consumes: `captureCart`.
- Produces: `POST /api/visit` body `{ e: 'cart', phone, name, email, items: [{name, qty, price}], total, currency, delivery, page }` → 204 always for allowed origins (errors logged, never surfaced); handled before `recordVisit` (not a visit), like `no_shipping`. Rate limit: > 30 captures from one `ip` in 10 min → 204 without storing.

- [ ] **Step 1: Failing tests:** `a cart event from the shop's checkout is stored, not counted as a visit`, `capture from an unknown site is refused` (403, table empty), `more than 30 captures from one address in 10 minutes are ignored`, `bots are ignored`.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS + `npm test`.
- [ ] **Step 5: Commit** `feat(abandoned): capture through the visit endpoint`

### Task 4: Admin route `abandoned`

**Files:**
- Create: `lib/admin/abandoned.js`
- Modify: `api/admin/[route].js` (import + `ROUTES.abandoned`)
- Test: `test/abandoned-admin.test.js`

**Interfaces:**
- Consumes: Tasks 1–2; `adminUser` (`lib/users.js`), `resolveShop` (`lib/shops.js`), `readJson/send/searchParams` (`lib/http.js`); pattern of `lib/admin/confirm-admin.js`.
- Produces:
  - `GET /api/admin/abandoned?shop=<id|all>&state=<open|all|recovered|hidden|reminded>` → `{ carts, openCount, settings }` (`settings` null for „all“).
  - `GET /api/admin/abandoned?shop=…&count=1` → `{ openCount }` (badge).
  - `POST` `{ action: 'remind', id, kind, channel }` → `{ ok, message, whatsapp, sms, viber }` and marks reminded; `{ action: 'hide', id }`; `{ action: 'settings', plain, discount, code, discountText }` (strict shop).
  - 401 without login; 404 `Няма такава количка` out of scope; Bulgarian errors as 400 (same catch as confirm-admin).

- [ ] **Step 1: Failing tests:** `the owner lists open carts and gets reminder links`, `a client sees and acts only on its own shops` (client of shop B: list of shop A → 403/empty per `resolveShop`, remind/hide A's cart → 404), `settings are per shop and refused for all shops`, `without login 401`.
- [ ] **Step 2–4:** run FAIL → implement → PASS + `npm test`.
- [ ] **Step 5: Commit** `feat(abandoned): admin route`

### Task 5: Табло figures

**Files:**
- Modify: `lib/stats.js` (`getStats` returns `abandoned: await cartStats(...)` with the same scope)
- Test: `test/stats.test.js`

- [ ] **Step 1: Failing test** `stats include abandoned carts for the period` → `getStats(...).abandoned` equals `{ count, total, recovered, afterReminder }` from fixtures.
- [ ] **Step 2–4:** FAIL → implement → PASS + `npm test`.
- [ ] **Step 5: Commit** `feat(abandoned): dashboard figures`

### Task 6: Nightly anonymising

**Files:**
- Modify: `api/cron/refresh.js` (call `anonymiseOld(q)` next to the visits clean-up, result in `result.abandoned`, errors caught and logged)
- Test: existing cron test file if present, else `test/abandoned.test.js` `the nightly job anonymises old carts` (drive the handler with `Authorization: Bearer cron` as `test/api.test.js` does).

- [ ] Steps: failing test → FAIL → implement → PASS + `npm test` → commit `feat(abandoned): nightly anonymising`

### Task 7: Widget capture

**Files:**
- Modify: `public/checkout.js`
- Test: `test/checkout-core.test.js`

**Interfaces:**
- Produces (exported on `core`): `cartPayload({ name, email, phone }, cart, delivery, pageUrl) → object|null` — null unless the phone normalises to a valid Bulgarian/international phone with the widget's existing phone check; `cart` = `{ items: [{title|name, quantity|qty, price}], total, currency }`, mapped to `{ e: 'cart', phone, name, email, items: [{name, qty, price}], total, currency, delivery, page }`.
- Behaviour: on `input`/`change` of `[name="name"]`, `[name="email"]`, `[name="shippingPhone"]` and on our delivery choice, debounce 1 500 ms, build the payload, send with `navigator.sendBeacon(API + '/api/visit', Blob text/plain)` falling back to `fetch(..., { keepalive: true })`; skip when identical to the last sent payload; wrapped in try/catch. Cart source: `window.WebPlatform.Store.cart` (store checkout: `items[].title`, `quantity`, `price`, `total`; `WebPlatform.Store.currency`); for the funnel checkout (adhdbg.eu) read the same object if present, else the order summary — **verify on the live adhdbg.eu checkout in the browser before choosing** and note the source in a code comment.

- [ ] **Step 1: Failing tests:** `cartPayload maps a store cart`, `cartPayload is null without a valid phone`, `cartPayload trims to 50 items`.
- [ ] **Step 2–4:** FAIL → implement → PASS + `npm test`.
- [ ] **Step 5:** Verify in `dev/harness.html` (preview `zd-harness`): typing a phone sends one `cart` beacon (the harness logs beacons); typing more updates it; no visible change to the checkout.
- [ ] **Step 6: Commit** `feat(abandoned): checkout widget sends the cart when a phone is typed`

### Task 8: Admin UI

**Files:**
- Modify: `public/admin/index.html`

**Interfaces:** consumes Task 4 route and Task 5 `abandoned` stats.

- [ ] **Step 1:** Add view `abandoned: 'Изоставени'` to `VIEWS`, a nav link (after „Поръчки“) with a count badge filled from `GET …?count=1` on load and on shop change, and `<section id="abandonedView">` with: state filter (Отворени / Всички / Върнати / Скрити), table (кога, клиент, телефон, продукти, сума, доставка, състояние), per row a „💬 Напомни“ menu (WhatsApp · SMS · Viber; and „с отстъпка“ variants when a code is set), „Скрий“; opted-out rows show „отписан от съобщения“ and no menu. Viber: open `viber` link and `navigator.clipboard.writeText(message)`, then show „Текстът е копиран — поставете го във Viber“. Settings panel: both texts, code, discount description, variable hint, save; one-line privacy note: „Добавете в политиката за поверителност, че данните, въведени в чекаута без завършена поръчка, се пазят до 30 дни, за да помогнем да я завършите.“
- [ ] **Step 2:** Табло: card `card('Изоставени', N + ' за ' + money, 'върнати ' + M + ' (' + K + ' след напомняне)', 'warn')` in the top row next to „Върнати“.
- [ ] **Step 3:** Verify with `node dev/admin-local.mjs` (preview `zd-admin-local`, password from `dev/admin-local.mjs`): seed a cart 1 h old via the local DB hook or capture endpoint, see it listed, open WhatsApp link (check href), Viber copies, hide works, badge updates, Табло card shows. Screenshot.
- [ ] **Step 4: Commit** `feat(abandoned): admin tab, reminder menu and dashboard card`

### Task 9: Demo data

**Files:**
- Modify: `lib/demo/seed.js` (3 sample carts: one open, one reminded, one recovered, timestamps relative to now)
- Test: `test/demo.test.js` `the demo shows sample abandoned carts`

- [ ] Steps: failing test → FAIL → implement → PASS + `npm test` → commit `feat(abandoned): demo carts`

### Task 10: Ship

- [ ] **Step 1:** Apply migration 017 to production (Supabase `etxbigwubhuvdmnwtsia`) **including** the grant and RLS policy for `zd_app`; check with `has_table_privilege('zd_app','zd.abandoned_carts','INSERT')`.
- [ ] **Step 2:** `npm test` — all pass (quote the counts).
- [ ] **Step 3:** Deploy `npx vercel deploy --prod --yes` (ask the owner first if the permission system blocks it).
- [ ] **Step 4:** Live check without entering personal data into a live form: the widget file served from kurier.profitbrand.online contains the cart capture; `POST /api/visit {e:'cart'}` from a foreign origin returns 403; the admin tab loads. Ask the owner to type their own phone in a checkout and confirm the row appears after 30 minutes.
- [ ] **Step 5:** Commit nothing new; report.
