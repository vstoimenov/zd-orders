# Abandoned carts — design (agreed 2026-10-17)

## Why
Ordyx sells against RevTrack and Sendica as "fewer lost orders and fewer returned parcels" for ConvertBuilder shops.
People reach the checkout, type their details and leave. The shop never learns who they were. This module shows the shop
those people and lets it bring them back with one tap — a human-sent message, not automation.

## Goals
- The shop sees every checkout where a customer typed a valid phone but did not order, within about 30 minutes.
- One tap opens a ready reminder to that customer in **WhatsApp**, **SMS** or **Viber**, sent from the shop's own phone.
- The shop chooses per reminder: a plain "you left your cart" text, or the same with a discount code the shop created.
- The shop sees how many carts were abandoned, for how much, and how many came back (and how many after a reminder).

## Non-goals (this version)
- No automatic sending of any kind (no WhatsApp API, no SMS provider, no Viber business sender). Later, when the shop's
  WhatsApp Business is set up, an automatic reminder needs its own Meta-approved **marketing** template (paid per message,
  stricter consent rules) — a separate project.
- No push notification to the phone (the owner's explicit decision: "да не излиза на телефона").
- Ordyx does not create discount codes in ConvertBuilder; the shop creates the code there and types it into Ordyx.
- No restoring the customer's cart contents server-side (ConvertBuilder keeps the cart in the browser).

## Anti-goals (a failure even if it works)
- The checkout gets slower, shows anything new, or can fail because of this module. Capturing must be invisible and fire-and-forget.
- Anything is ever sent to a customer without a person at the shop pressing a button.
- Data is captured before the customer typed a valid phone, or kept longer than needed.

## Constraints
- Vercel Hobby: 10 of 12 serverless functions are used — **no new function**. Capture goes through the existing
  anonymous endpoint `api/visit.js` (a new event kind, like `no_shipping`); admin endpoints go through the existing
  router `api/admin/[route].js` (a new route). Crons run once a day only.
- Supabase Free (schema `zd` in agency-crm, role `zd_app` needs grants + an RLS policy on any new table, as for migrations 011–016).
- The owner will not pay for Pro plans before revenue: everything must work on free plans.
- The public capture endpoint can be forged (same as orders). A forged entry may only appear in the list; nothing is ever
  sent automatically, so a fake entry costs nothing. Rate-limit per IP like orders.
- Scoping exactly like orders: a client user sees only their shops (`resolveShop` with the user), owner sees all.
- The demo (`api/demo/[route].js`, PGlite seed) should show sample abandoned carts.
- Bulgarian UI, English code/commits; tests with node:test + PGlite; TDD.

## Decided
**Capture (checkout widget, `public/checkout.js`)**
- Starts when the phone field holds a valid phone (same normalisation as orders). Sends name, phone, email, cart items
  (name, qty, line price), cart total, currency, chosen delivery type/office text if any, and the page URL.
- Re-sends (debounced) when those details change; one record per shop + phone per checkout session (later sends update it).
- Must work on both ConvertBuilder checkout kinds: funnel checkout (adhdbg.eu) and store checkout with cart
  (tiarracosmetics.com/store/checkout — there `WebPlatform.Store.cart.items` has title, quantity, price and `total`).
- Never blocks or alters the checkout; failures are silent (sendBeacon / keepalive fetch, as the visit beacon does).

**When it counts as abandoned / recovered** (computed when the admin reads, no timer)
- Abandoned: 30 minutes passed since the last update and no order with the same phone in the same shop since the cart was first captured.
- If an order with that phone arrives within 30 minutes, it is not shown as abandoned at all (it was just a normal checkout).
- Recovered: an order with the same phone in the same shop arrives after it was abandoned, within 7 days *(my call)*.
  "After a reminder" = the reminder was marked before that order.
- Orders that are `cb_check = 'pending'` (not confirmed by ConvertBuilder) do not count as recovering a cart.

**Admin**
- New tab **„Изоставени“** in the sidebar with a count badge of open (not reminded, not recovered) carts in the last 7 days.
  No phone notification.
- List: when, name, phone, products, total, delivery choice, state (нова / напомнено / върната), newest first; filter by state.
- Per row: **„💬 Напомни“** with WhatsApp, SMS and Viber; and, when the shop has a discount code set, a choice
  **„с отстъпка“**. WhatsApp = `wa.me/<number>?text=…`, SMS = `sms:<number>?&body=…` (same as the confirmation button);
  Viber cannot prefill text — it opens the chat (`viber://chat?number=%2B359…`) and copies the text to the clipboard with a
  short hint "текстът е копиран — поставете го". Opening any of them marks the row „напомнено“ (with time and channel).
- Settings (in the tab): two texts — **без отстъпка** and **с отстъпка** — with variables `{име}`, `{пълно_име}`,
  `{продукти}`, `{сума}`, `{магазин}`, `{линк}`, and for the discount text `{код}` and `{отстъпка}`; fields for the
  discount code and its description (e.g. „10% отстъпка“). Saving the discount text requires `{код}`. Per shop; refused for "all shops".
- `{линк}` = the page where the customer left *(my call: a store cart cannot be restored on another device; the page brings them back to the product/funnel)*.
- **Табло**: a card in the top summary row — „Изоставени: N за X € · върнати M (K след напомняне)“ for the selected period;
  for "all shops" the same per shop as other cards do.

**Default texts** *(my call, the shop edits them)*
- Без отстъпка: „Здравейте, {име}! Видяхме, че не завършихте поръчката си в {магазин} ({продукти}). Ако имате въпрос — пишете ни тук, ще помогнем. Можете да продължите оттук: {линк}“
- С отстъпка: „Здравейте, {име}! Поръчката ви в {магазин} ({продукти}) още ви чака. Подарък от нас: {отстъпка} с код {код}. Продължете оттук: {линк}“

**Privacy and retention**
- Records are deleted automatically 30 days after their last update (in the existing nightly cron).
- „Първи стъпки“ / the tab shows a one-line note that the shop's privacy policy must mention that checkout details
  typed but not submitted are kept up to 30 days to help finish the order (legitimate interest). Ordyx does not write the policy.
- Deleting an order or a customer does not need to cascade (records are short-lived).

## Settled after the builder check *(all my calls — the owner may override)*
- **Retention vs. long periods**: after 30 days the record is not deleted but **anonymised** (name, phone, email, items,
  page URL, delivery text cleared; dates, total, currency, state and reminder facts kept). Табло figures therefore work for
  any period without personal data. Anonymised records are deleted after 400 days, like visits.
- **Period membership**: a cart belongs to the period of its **first capture**. „Изоставени N за X €“ counts all carts that
  became abandoned (recovered ones included); „върнати M“ counts those of them later recovered; K = recovered after a reminder.
- **Which orders count** (for both "not abandoned" and "recovered"): same shop, same normalised phone, `orders.created_at`
  later than the cart's first capture, status not `cancelled`, and `cb_check <> 'pending'`. Duplicates count (they are real orders).
- **Opted-out numbers** (in `zd.campaign_optouts` of that shop): the row is shown with „отписан от съобщения“ and the
  reminder buttons are disabled. Conservative default: a reminder is a marketing-style message.
- **Dismiss**: each row has „Скрий“ (state `скрита`); hidden rows leave the badge and the default list, stay in the figures.
- **Same phone again**: a capture updates the open record of that shop + phone if it was last updated less than 24 h ago
  and is not reminded, recovered or hidden; otherwise it starts a new record. Each record keeps its first reminder time
  (used for "after a reminder"), the last channel and a reminder count.
- **`{линк}`**: kept only when its host is the shop's domain (or `www.`/a subdomain of it) and it is `https`; otherwise
  `https://<shop domain>/`. Query strings and fragments are dropped.

## Left to the builder
- Table design, indexes, how "same checkout session" is keyed, debounce timing, exact rate limits.
- How the widget reads cart items on the funnel checkout (verify against the live adhdbg.eu checkout; the store checkout path is known).
- UI layout of the tab and the reminder menu, within the admin's existing look.
- Whether the Табло card and the tab badge share one query.
