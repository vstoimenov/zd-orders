# zd-orders — офиси Еконт/Спиди в чекаута на ConvertBuilder + собствена система за поръчки

Дата: 2026-10-02 · Статус: одобрен дизайн

## Цел

Собствено решение (без Middleware.bg), което:

1. Добавя в чекаута на ConvertBuilder избор на доставка: **Офис Еконт / Офис Спиди / Адрес Спиди**.
2. Записва копие на всяка **приета** поръчка в собствена база.
3. Дава прост админ панел за обработка.

ConvertBuilder продължава да приема поръчките нормално. Нашата система е паралелна.

## Ограничения и решения

- **Няма договори с куриери** (няма активна фирма). Еконт номенклатурите са публични (проверено: `getOffices` → 634 офиса/автомата, `getCities` → 1093 града, без креденшъли). Спиди API изисква логин; сайтът speedy.bg е зад Cloudflare → **никакво скрейпване**.
  - Офис Еконт: пълен избор от списък.
  - Офис Спиди: **официалната публична карта на Спиди** (`https://services.speedy.bg/office_locator_widget_v3/office_locator.php`, iframe в прозорец; при „Избери“ праща офиса с `postMessage` — същият механизъм работи в memopic). Без договор. Ако картата не се зареди → текстово поле „име или адрес на офиса“.
  - Адрес Спиди: град (търсене) + улица/номер (свободен текст).
  - (Ревизия 2026-10-02: първоначално Спиди офис беше свободен текст; сменено на картата по решение на собственика.)
- **Без известия** за нова поръчка (по решение на собственика). Не се строи.
- Без код/скриптове на Middleware.bg. Никакви тайни във фронтенда или в git.
- Живата страница се пипа само след тест на копие.

## Разузнаване на чекаута (2026-10-02)

URL: `https://dasezaobichame.convertbuilder.com/checkout` (+ чекаутите на blagoslovii.com: `/d-scheri-i-sinove/chekout`, `/chekout-sinove`, `/chekout-komplekt`). 1-step layout, без `<form>`. Сега е зареден `co.middleware.bg/cb/co/….js` — на тестовото копие и при пускане се маха.

| Поле | Селектор |
|---|---|
| Име | `input[name="name"]` |
| Имейл | `input[name="email"]` |
| Телефон | `input[name="shippingPhone"]` (скрит; видим е `#shippingPhone_*_dummy`, intl-tel-input) |
| Адрес / град | `input[name="shippingAddress"]`, `input[name="shippingCity"]` (в `[data-role="address-part"]`) |
| Пощ. код / област | `input[name="shippingZipCode"]`, `input[name="shippingState"]` (hidden) |
| Метод доставка | `input[name="shippingOption"]` — текстът на `.tick-wrapper`: „До офис ECONT 4.07€“, „До офис speedy 4.07€“, „До адрес speedy 4.04€“ |
| Плащане | `input[name="paymentOption"][value="cod"]` |
| Ъпсели | `.bump-wrapper input[name^="bump"]` |
| Обща сума | `.grand-total` |
| Бутон | `a[data-role="continue"]` „ПОРЪЧАЙ СЕГА“ |

Поток на платформата (`platform.client.min.js`):

1. Клик на `a[data-role="continue"]` → ако `WebPlatform.checkoutInterceptor.beforeComplete(ok, fail)` съществува, вика се преди изпращането; `ok()` продължава, `fail(msg)` спира. Сега е `null` (Middleware не го ползва).
2. AJAX `completeOrder` (POST); сървърът на CB валидира полетата.
3. При успех: `WebPlatform.Store.reportPurchase(…, order)` → излъчва `platform.events.order_completed` (CustomEvent с цялата поръчка; `order.items[] = {productId, title, quantity, price}`) и Meta Pixel `Purchase`, после след 80 ms → страница за благодарност (освен ако има `checkoutInterceptor.onCompleted` — **не го ползваме**, защото заменя пренасочването).

## Архитектура

Проект `cloude-c/zd-orders` → Vercel проект `zd-orders` (деплой с `vercel` CLI). Node serverless функции, без фреймуърк.

```
zd-orders/
  api/
    cities.js        GET                    → всички градове [{id, name, postCode, region, hasOffice}] (CDN кеш 1 ч)
    offices.js       GET  ?courier=econt    → всички офиси [{id, code, name, city, postCode, address, isAutomat}] (CDN кеш 1 ч)
    orders.js        POST (beacon от чекаута)
    admin/login.js   POST парола → подписана бисквитка
    admin/orders.js  GET списък/филтри/CSV · PATCH статус
    cron/refresh.js  GET (Vercel Cron, веднъж дневно, CRON_SECRET)
  lib/              чисти функции (нормализация, форматиране, валидация, auth) + db
  public/
    checkout.js      джаджата (вгражда се в CB)
    admin/index.html админ панел (статичен HTML + JS към /api/admin/*)
  db/migrations/    SQL за схема zd
  test/             node:test (+ PGlite за SQL)
```

### База — схема `zd` в Supabase agency-crm (`etxbigwubhuvdmnwtsia`)

Достъп: отделна Postgres роля `zd_app` (права само върху `zd`) през pooler, `DATABASE_URL` в Vercel env (моделът на memopic). Без PostgREST/anon достъп.

- `zd.cities` — `id int` PK (ID на града в Еконт), `name`, `post_code`, `region`, `has_office bool`. В autocomplete се показва „Име (област)“, защото имената се повтарят; градовете с офис на Еконт са първи.
- `zd.offices` — `id text` (напр. `econt:7538`), `courier` (`econt`), `code`, `name`, `city`, `post_code`, `address`, `is_automat bool`, `updated_at`. Refresh = upsert + изтриване на изчезналите за същия куриер (само ако новият списък не е празен).
- `zd.orders` — `id uuid`, `created_at`, `cb_order_id text unique`, `name`, `phone`, `phone_norm`, `email`, `delivery_type` (`econt_office|speedy_office|speedy_address`), `courier`, `office_id`, `office_text`, `city`, `post_code`, `address_text`, `items jsonb`, `total numeric`, `currency`, `payment_method`, `page_url`, `user_agent`, `ip`, `status` (`new|confirmed|shipped|delivered|returned|cancelled`, default `new`), `is_duplicate bool`, `status_changed_at`.

### Джаджа `public/checkout.js`

Вграждане: един ред в общия „Собствен Body код“ на сайта: `<script src="https://zd-orders.vercel.app/checkout.js" defer></script>`.

- Изчаква `WebPlatform.onReady`; работи само ако на страницата има `a[data-role="continue"]` и `input[name="shippingAddress"]`.
- Вмъква над `[data-role="address-part"]` блок с три радио опции + полета:
  - Офис Еконт: едно поле „Напишете град или име на офис“ — целият списък (~634 записа, ~20 KB gzip) се зарежда веднъж и се филтрира в браузъра мигновено (всички думи трябва да се срещат в град/име/адрес); резултатите са групирани като „Град – офис, адрес“.
  - Офис Спиди: бутон „Избери офис от картата“ → прозорец с картата на Спиди; след избор се показва избраният офис с „Смени“.
  - Адрес Спиди: град (autocomplete) + текст „улица, номер, блок, вход, ет., ап.“.
  - Ако градът липсва в списъка (малко село) — позволява се свободно въведен град.
- При всяка промяна попълва `shippingAddress` (напр. `ЕКОНТ – офис Айдемир (7538), кв. Деленките ул. София №7`; `СПИДИ – офис: <текст>`; `СПИДИ – адрес: <текст>`), `shippingCity`, `shippingZipCode`, и праща `input` + `change`.
- Избира съответния `shippingOption` по текста на етикета (ECONT / офис speedy / адрес speedy) с истински `click`, за да преизчисли CB доставката. Ако няма съвпадение — не пипа и логва в конзолата.
- Скрива родните `shippingAddress`/`shippingCity` и списъка с `shippingOption` (CSS), не ги маха от DOM.
- Задава `WebPlatform.checkoutInterceptor = { beforeComplete(ok, fail) }`: ако изборът е непълен → `fail("Моля, изберете офис на Еконт.")` и т.н. + скрол до блока; иначе `ok()`. Ако вече има чужд interceptor — обвива го (нашата проверка първо, после неговата).
- Слуша официалното събитие на платформата `document.addEventListener('platform.events.order_completed', e => …)` (CustomEvent, `e.detail = {id, total, currency, items, customerName, customerEmail, order}`; излъчва се от `reportPurchase` преди пренасочването). Нищо от платформата не се обвива → пикселът не се пипа. В `try/catch` праща `navigator.sendBeacon('/api/orders', Blob(text/plain))` с: `cb_order_id`, име/имейл/телефон (от order обекта, fallback от полетата), избора за доставка, `items` (име, количество, цена от order обекта), `total`, `currency`, `payment_method`, `page_url`, `token`. Грешка в нашия код никога не прекъсва потока на CB.
- Стил: namespace `.zdo-…`, без глобални селектори, розово/бяло в тон с формата, мобилен; целево тегло < 10 KB minified. Всичко на български.

### `POST /api/orders`

- CORS/Origin: само домейните от `ALLOWED_ORIGINS` (env, напр. `https://dasezaobichame.convertbuilder.com,https://blagoslovii.com`). Beacon е `text/plain` → без preflight; сървърът проверява `Origin`.
- Shared token (`ORDER_TOKEN`, публичен в checkout.js — само срещу случаен спам).
- Валидация: име, телефон (BG формат, нормализиран до `+359…`), `delivery_type` от позволените, офис/текст според типа, `items` масив, `total` число ≥ 0; ограничение на дължини.
- Rate limit: ≤ 5 записа от едно IP за 10 мин (заявка към `zd.orders`) → 429.
- Идемпотентност: `on conflict (cb_order_id) do nothing`.
- Дубликат: ако има поръчка със същия `phone_norm` за последните 24 ч → `is_duplicate = true` (и на новата).

### Админ `/admin`

- Вход с `ADMIN_PASSWORD`; сървърът връща HttpOnly бисквитка с HMAC-подпис (`ADMIN_SECRET`) и срок 7 дни. Всички `/api/admin/*` я проверяват.
- Таблица: дата, име, телефон, доставка, офис/адрес, артикули, сума, статус, флаг дубликат. Филтри: статус, от/до дата; търсене по телефон/име. Пагинация по 50.
- Смяна на статус: нова → потвърдена → изпратена → доставена / върната / отказана (всеки статус може да се избере ръчно).
- „Копирай за товарителница“ → в клипборда: име, телефон, куриер, офис/адрес, град, сума за наложен платеж, съдържание.
- CSV експорт на текущия филтър (UTF-8 с BOM за Excel).

### Cron

Vercel Cron `0 3 * * *` → `/api/cron/refresh` (проверка `CRON_SECRET`): Еконт `getCities` + `getOffices` (`countryCode: "BGR"`) → нормализация → upsert. (Спиди няма нужда — ползва се картата им.)

## Env (Vercel)

`DATABASE_URL`, `ALLOWED_ORIGINS`, `ORDER_TOKEN`, `ADMIN_PASSWORD`, `ADMIN_SECRET`, `CRON_SECRET`.

## Обработка на грешки

- API за офиси недостъпно → джаджата показва „Неуспешно зареждане, опитайте пак“ и позволява ръчно въвеждане на офис в текстово поле (поръчката не се губи).
- Beacon неуспешен → поръчката остава в ConvertBuilder (източникът на истина); загубата е само в нашето копие.
- Cron неуспешен → старият кеш остава; празен отговор никога не изтрива офиси.

## Тестове

- `node:test` unit тестове (test-first) за: нормализация на офиси/градове на Еконт, форматиране на `shippingAddress`, нормализация/валидация на телефон, валидация на поръчка, подпис/проверка на бисквитка, CSV, текст за товарителница.
- PGlite тестове за SQL: идемпотентност по `cb_order_id`, флаг дубликат, rate limit, refresh без изтриване при празен списък.
- Локален тест на джаджата върху запазено HTML копие на чекаута (без изпращане).
- Тест на **копие** на чекаута в CB (собственикът създава тестова страница без Middleware скрипта).
- Финален тест: реална тестова поръчка → има я в CB, в `zd.orders`, Pixel `Purchase` гърми.

## Пускане

1. Тестово копие ✅ → 2. махане на Middleware скрипта и placeholder скрипта от Head кода на живата страница + добавяне на нашия ред → 3. контролна поръчка.

## Извън обхвата (етап 2)

Създаване на товарителница през API на куриерите (иска договори); известия.
