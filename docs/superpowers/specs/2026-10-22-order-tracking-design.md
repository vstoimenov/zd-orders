# Проследяване на поръчката (стъпка 1) — design

Date: 2026-10-22. Approved by the owner on the mockup („ок“). Goal: fewer „къде ми е пратката?“ calls, and the shop sees which
parcels need saving before they come back. Step 2 (automatic messages) waits for WhatsApp Business / an SMS provider.

## Buyer: „Моята поръчка“
- The personal link the shop already sends for confirmation (`/confirm/?t=…`) becomes the order page; a shorter form
  `app.ordyx.eu/p/<token>` (for SMS) opens the same page. While the order can still be confirmed, the confirm buttons stay on top.
- Shows: shop name, first name, date, total + payment, items, a big current-state box (with the courier's last status text and
  time of the last check), and a timeline of 6 steps with times: приета → потвърдена → опакована → изпратена (courier + waybill
  number) → чака в офиса/автомата → получена. Address delivery has no office step. Cancelled → „Поръчката е отказана“;
  returned → „Пратката е върната към магазина“.
- Waiting at the office: office name, address, hours, a map link („Упътване“ → Google Maps by coordinates or by address) and
  „от 23.10 · вземи я, преди да се върне“ (no exact deadline — it differs per courier).
- Buttons: „📞 Магазинът“ (the shop's phone, when set) and „Сайтът на <куриер> ↗“ (tracking URL; BOX NOW has none → hidden).
- Privacy as today: first name, items, total, office/city only — no phone, email, street.
- Fresh status: opening the page asks the courier for this one parcel when the last check is older than 30 minutes (shipped,
  real waybill, not a test waybill); at most ~5 s, any failure shows the last known state.

## Shop
- Orders: a pill „⚠️ Проблемни (N)“ = shipped with a real waybill and either at the office for 3+ days (Sofia days) or no change
  in the courier's status for 3+ days (not at the office). Rows show „в офиса N дни“ / „без движение N дни“.
- „↻ Обнови статусите“ next to the pills: checks every shipped parcel of the shop's connected couriers now (same as the night run).
- Next to a waybill: „💬 Проследяване“ opens the WhatsApp / Viber / SMS chooser (like „Потвърди“) with the text:
  „Здравейте, {име}! Поръчката Ви от {магазин} е изпратена с {куриер} ({номер}). Проследете я тук: {линк}“.

## Data
- `zd.orders.waybill_status_changed_at timestamptz` (migration 023): set when the courier's status text changes.
- „Без движение“ uses `coalesce(waybill_status_changed_at, waybill_created_at)`.

## Decisions (mine — owner can overrule)
- Fixed tracking message text for now (the confirmation text stays editable).
- 30-minute freshness, 3-day thresholds.
- The demo uses the same page (its sandbox answers).

## Non-goals
Automatic messages, e-mail, push to buyers, editing the delivery office from the page (later: „смяна на офиса“).
