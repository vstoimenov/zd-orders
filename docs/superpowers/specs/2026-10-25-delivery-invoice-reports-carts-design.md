# Delivery change, invoice details, delivery reports, cart → order — design (approved in chat 2026-10-25)

Four small features, built in this order and released one by one: 3 → 4 → 7 → 5 (owner's numbering). Owner: „ок“ to the
plan in chat.

## 3. Change the delivery after the order
**Why**: customers pick the wrong office or move; today the shop has to call and retype it.

- One server function `changeDelivery(q, orderId, input, { by: 'customer' | 'shop', scope })` in `lib/delivery-change.js`.
  Input: `{ courier: 'econt'|'speedy'|'boxnow', officeId }` or `{ courier: 'econt'|'speedy', city, postCode, addressText }`.
  Allowed only while status is `new`/`confirmed`, `waybill_number = ''` and `fulfil_sent_at is null`; otherwise Bulgarian
  refusal „Поръчката вече е изпратена — за промяна се обадете на магазина“ (customer) / „Поръчката вече има товарителница“
  (shop) / „Поръчката е при склада“.
  Office must exist in `zd.offices` for that courier (BOX NOW only `boxnow_locker`); address needs city + address (≤80/≤200).
  BOX NOW for the customer only when the shop has BOX NOW in its checkout (integration `boxnow.config.checkout`).
  Writes `courier, delivery_type, office_id, office_text, city, post_code, address_text` (office text like assignRoute:
  `Name, City (code)`; address text `Еконт – адрес: …, City`), `delivery_changed_at = now()`, `delivery_changed_by`.
  Customer change → push „📍 Клиентът смени доставката“ + `notifySite`-like callback is NOT sent (non-goal now).
- Public: `POST /api/admin/confirm {t, action: 'delivery', ...input}` (same token page). The order page payload gets
  `canChangeDelivery` and `delivery` (current text) and `boxnow` (allowed).
- Order page: under „Доставка“ a „Смени офиса / адреса“ button opens the existing picker (`OrdyxPicker.mount`, api '',
  host = shop domain) and „Запази“. After save: „Готово — доставката е сменена“ and the page reloads its data.
- Admin: order row button „📍 Доставка“ (orders without waybill, open status) opens a modal with the same picker; saves
  via `POST /api/admin/orders {action: 'delivery', id, ...input}`. The order shows „сменена от клиента“ tag when
  `delivery_changed_by = 'customer'`.
- Migration 027: `delivery_changed_at timestamptz`, `delivery_changed_by text not null default ''`.

## 4. Invoice details
**Why**: B2B buyers need an invoice; shops now ask by phone.

- Column `invoice jsonb` (migration 027), shape `{ company, eik, vat, mol, address }` (strings, trimmed; company ≤160,
  eik 9 or 13 digits, vat optional `BG` + 9/10 digits, mol ≤120, address ≤200). Empty object = no invoice.
  Validation in `lib/invoice.js` `cleanInvoice(input) → { ok, invoice } | { ok:false, error }` (Bulgarian errors).
- Where it comes from:
  - order body field `invoice` (widget, keyed API, manual order, CSV columns „Фирма, ЕИК, ДДС номер, МОЛ, Адрес по
    регистрация“) — an invalid invoice never fails the order (ruling below).
  - the order page: „Искам фактура“ form while the order is not shipped (`POST confirm {t, action: 'invoice', ...}`).
- Widget (checkout.js, ConvertBuilder and standalone/declarative): a checkbox „Искам фактура“ under the picker; ticked →
  five fields; values go with the order (`invoice` in the /api/orders body). Off by default; nothing shown otherwise.
- Admin: „🧾 Фактура“ block in the order row when present + „Копирай“ (text block); CSV export columns; manual order
  form gets the same optional fields.
- Ruling: an invalid invoice from a checkout/API is stored as typed with `invoice.invalid = true` and the shop sees
  „⚠️ проверете ЕИК“ — an order is never refused for invoice details.

## 7. Delivery reports
**Why**: owner wants to see which courier and which kind (office / locker / address) customers pick and which returns less.

- `getStats` gains `deliveryMix`: rows by `courier` × kind (`office` = *_office, `locker` = boxnow_locker, `address` =
  *_address, `other`) with `orders, share, delivered, returned, returnRate (returned / (delivered + returned)), revenue`
  (revenue of active orders), sorted by orders. Plus `deliveryHighlights`: most used row, lowest return rate among rows
  with ≥ 10 finished parcels.
- `getStats` gains `confirmations`: by channel (`link`, `whatsapp`, `voice`, `manual`, `none`) → orders, confirmed,
  cancelled. Channel is a new column `confirm_channel text not null default ''` (migration 027) set where the answer
  happens: answerConfirm(link) 'link', WhatsApp button 'whatsapp', voice 'voice', admin PATCH to confirmed/cancelled
  'manual' (only when still empty).
- Dashboard: card „Доставки“ with the table and the two highlight lines; card „Потвърждения“; both follow the period and
  shop filters. CSV export button for the delivery table (client side).

## 5. Abandoned cart → order
**Why**: the shop calls the customer from „Изоставени“, the customer says yes; today the shop retypes it.

- „Направи поръчка“ button on open/reminded carts opens the „+ Нова поръчка“ modal prefilled: name, phone, email, items
  (name, qty, price), total, delivery text in the „other“ text field if no office can be parsed.
- On save the manual order is created with `cartId`; server marks the cart `recovered_at = now()` and `order_id`
  (migration 027: `abandoned_carts.order_id uuid`). Cart then shows „Върната → поръчка“.

## Non-goals
Site callbacks for delivery/invoice changes, invoice issuing (PDF), shipping price recalculation after a delivery change,
reports beyond the listed two.

## Constraints
Node 22 ESM, node:test + PGlite, vanilla admin, migrations applied by hand (Supabase MCP), deploy
`npx vercel deploy --prod --yes`, Bulgarian UI, no competitor names, function count unchanged (no new api/ files).
