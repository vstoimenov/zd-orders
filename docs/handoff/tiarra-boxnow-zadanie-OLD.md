# Задача: BOX NOW (доставка до автомат) в чекаута на tiarracosmetics.com

Добави BOX NOW като трети куриер до Еконт и Спиди. BOX NOW доставя **само до автомат** (няма офис, няма адрес).
Автоматите идват от Ordyx, а поръчката се праща към Ordyx като досега. Не чупи Еконт и Спиди.

## Данни от Ordyx
- Списък с автомати: `GET https://app.ordyx.eu/api/offices?courier=boxnow&host=tiarracosmetics.com`
  - `host` е ЗАДЪЛЖИТЕЛЕН — без него (или ако BOX NOW не е включен за магазина в Ordyx) отговорът е `{"offices":[],"enabled":false}`.
  - При включен: `{"offices":[{ "id":"boxnow:1840", "code":"1840", "name":"Лидл Тракия", "city":"Пловдив", "postCode":"4000", "address":"бул. Освобождение 52", "isAutomat":true, "lat":42.1, "lng":24.7, "hours":"24/7" }], "enabled":true}`
  - Празен списък / `enabled:false` → картата на BOX NOW НЕ се показва (не е грешка).
- Поръчката към `POST https://app.ordyx.eu/api/orders` (същият ключ `ORDYX_API_KEY`) за BOX NOW:
  - `delivery_type: "boxnow_locker"` (НЕ `boxnow_office`)
  - `office_id: "boxnow:<code>"` — точно `id` от списъка
  - `office_text: "BOX NOW – автомат <name>, <address>"`, `city`, `post_code` от автомата, `address_text: ""`

## Промени в кода
1. **Миграция** (нов файл в `supabase/migrations/`):
   - `store.orders.courier` check → `('econt','speedy','boxnow')`.
   - `store.commerce_settings`: `boxnow_enabled boolean not null default false`, `boxnow_price numeric(10,2) not null default 2.99 check (boxnow_price >= 0)`; check-а `econt_enabled or speedy_enabled` → `econt_enabled or speedy_enabled or boxnow_enabled`.
   - Функциите за поръчка (`create_order` / `create_order_with_promo` / `create_order_with_settings_and_promo` — последните им версии, вкл. `20261109170000_promo_brands.sql`): `p_courier` да приема `boxnow`; за `boxnow` `p_delivery_type` трябва да е `automat` (иначе грешка); `COURIER_DISABLED`, ако `boxnow_enabled` е false; цена = `boxnow_price` (безплатна доставка над прага важи и тук).
2. **`lib/commerce-settings-schema.ts` и `lib/commerce-settings.ts`**: `boxnowEnabled`, `boxnowPrice`; `courierPrice()` за `boxnow` → `boxnowPrice`; refine „поне един куриер“ да включва BOX NOW.
3. **`lib/ordyx-offices.ts`**: `getCourierOffices(courier: 'econt'|'speedy'|'boxnow')`; за `boxnow` URL-ът е с `&host=tiarracosmetics.com` (по-добре от env `SITE_HOST`). Zod схемата може да остане (допълнителните полета се изрязват); `enabled:false` → празен масив.
4. **`app/api/shipping/offices/route.ts`**: приема `courier=boxnow`.
5. **`lib/office-token.ts`**: `courier` enum + `boxnow`; за `boxnow` типът е винаги `automat`.
6. **`components/cart/CourierPicker.tsx`**:
   - Трета карта „До автомат на **BOX NOW**“, лого `/site/boxnow.png` (вземи от https://app.ordyx.eu/logos/boxnow.svg или официалното лого на BOX NOW), цена `boxnowPrice`, срок `deliveryEstimate`.
   - Показва се само ако `settings.boxnowEnabled` И Ordyx върне поне един автомат.
   - При BOX NOW: без табовете „До офис / До автомат / До адрес“ — направо търсене на населено място + автомат; `deliveryType` = `automat`. Етикетът „Автомат за пратки“.
   - `Courier` типът и `onDeliveryChange` да включват `boxnow`.
7. **`components/cart/CheckoutForm.tsx`, `app/api/orders/route.ts`, `app/api/orders/quote/route.ts`**: `courier` enum + `boxnow`; ако `courier==='boxnow'` и `deliveryType!=='automat'` → 400; проверка за изключен BOX NOW → 422 „Избраният куриер временно не е достъпен.“
8. **`lib/ordyx-sync.ts`**: `courier` + `boxnow`; `delivery_type` = `boxnow` → `"boxnow_locker"`, иначе както досега; за BOX NOW `office_text` = `BOX NOW – автомат ${office.name}, ${office.address}`; търсенето на автомата по `office_id` да ползва `getCourierOffices('boxnow')` (с host).
9. **Админ**: `components/admin/SettingsAdmin.tsx` + `app/api/admin/settings/route.ts` — превключвател „BOX NOW“ и цена; `lib/admin/orders.ts`, `components/admin/OrdersAdmin.tsx`, `lib/order-email.ts`, `components/cart/OrderThankYou.tsx` — показвай „BOX NOW“ като име на куриера.

## Тестове / проверка
- Unit: `courierPrice` за boxnow; `verifyOffice` за boxnow+automat (и отказ за boxnow+office); `ordyx-sync` праща `boxnow_locker` и `office_id` `boxnow:…`.
- Ръчно: с изключен BOX NOW картата я няма; с включен — избор на автомат → поръчка → в Ordyx поръчката е „до автомат на BOX NOW“ с избрания автомат.
- `pnpm lint`, `pnpm test`, `pnpm build` да минават. Миграцията да се пусне в Supabase преди деплой.
