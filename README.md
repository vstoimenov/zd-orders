# zd-orders

Избор на офис Еконт / офис Спиди / адрес Спиди в чекаута на ConvertBuilder („Да се заобичаме с думи“),
копие на всяка приета поръчка в Supabase (схема `zd`) и админ панел.

- Вграждане (ConvertBuilder → Настройки → Собствен Body код):
  `<script src="https://zd-orders.vercel.app/checkout.js" defer></script>`
- Админ: https://zd-orders.vercel.app/admin/ (парола: `ADMIN_PASSWORD` във Vercel env / локално `.env.local`)
- Офисите на Еконт се освежават всеки ден в 03:00 UTC (Vercel Cron → `/api/cron/refresh`).
- Тестове: `npm test`
- Локален фалшив чекаут: статичен сървър в корена на проекта → http://localhost:8765/dev/harness.html
- Локален админ с тестова база: `node dev/admin-local.mjs` → http://localhost:8766/admin/ (парола `local-test`)
- Деплой: `npx vercel deploy --prod --yes`
- Env: `DATABASE_URL`, `ALLOWED_ORIGINS`, `ORDER_TOKEN`, `ADMIN_PASSWORD`, `ADMIN_SECRET`, `CRON_SECRET`.
