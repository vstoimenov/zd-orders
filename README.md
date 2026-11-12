# Ordyx (zd-orders)

Платформа за онлайн магазини с наложен платеж: избор на офис / автомат / адрес на Еконт, Спиди и BOX NOW в чекаута,
копие на всяка поръчка в Supabase (схема `zd`), товарителници, проследяване, финанси, наличности, купувачи, кампании
и „Съветник“ в „Табло“.

## Адреси
- Сайт: https://ordyx.eu · Админ: https://app.ordyx.eu/admin/ · За програмисти: https://ordyx.eu/dev
- Чекаут скрипт: `<script src="https://app.ordyx.eu/checkout.js" defer></script>`
  (ConvertBuilder → Настройки → Собствен Body код; собствен сайт — виж `/dev`; WooCommerce — плъгинът в Интеграции)
- Демо: https://zd-orders.vercel.app/demo/ (без парола, примерни данни)

## Деплой
- Vercel проект `zd-orders`, свързан с GitHub `vstoimenov/zd-orders`. **Production клонът е `feat/zd-orders`**:
  всеки пуш или сливане в него отива на живо сам. Другите клонове правят Preview.
- Миграциите (`db/migrations/*.sql`) се пускат ръчно в Supabase (проект agency-crm, схема `zd`), с правата за `zd_app`,
  описани в края на всеки файл.

## Нощни задачи (Vercel Cron)
- 03:00 UTC `/api/cron/refresh`: офиси и автомати, рекламен разход от Meta, товарителници от Еконт, правени извън Ordyx,
  и статусите на пратките (Еконт, Спиди, BOX NOW).
- 03:30 UTC `/api/cron/nekorekten`: проверки в НЕкоректен и месечното резюме на Съветника (push на 1-во число).

## Разработка
- Тестове: `npm test`
- Локален админ с тестова база: `node dev/admin-local.mjs` → http://localhost:8766/admin/ (парола `local-test`)
- Локален фалшив чекаут: статичен сървър в корена → http://localhost:8765/dev/harness.html
  (`harness-cards.html` — картите на собствен сайт; `harness-form.html` — избор в собствена форма)
- Спецификации и планове: `docs/superpowers/`

## Env (Vercel)
Задължителни: `DATABASE_URL`, `ADMIN_PASSWORD`, `ADMIN_SECRET`, `INTEGRATIONS_SECRET`, `CRON_SECRET`, `ALLOWED_ORIGINS`, `ORDER_TOKEN`.
По избор: `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`, `NEKOREKTEN_API_KEY`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`
(известия), `META_APP_ID` / `META_APP_SECRET` / `META_CONFIG_ID` / `META_PUBLIC` (Meta реклами), `WHATSAPP_CONFIG_ID` /
`WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_PUBLIC`, `VOICE_CALL_URL` / `VOICE_CALL_SECRET` / `VOICE_TICK_SECRET` / `VOICE_PUBLIC`.
