# Meta App Review за „Вход с Facebook“ (ads_read) — какво да подадеш

Целта: клиентите да виждат „Вход с Facebook“ като собственика. Meta го пуска за хора извън приложението само след
**App Review за `ads_read` (Advanced Access)**. Токените на системния потребител вече работят — те са за „споделяне“
и не заместват това одобрение.

## Къде
developers.facebook.com → My Apps → приложението на Ordyx → **App Review → Permissions and Features** →
`ads_read` → **Request advanced access**. (Ако иска и `business_management` — същото.)

Преди това провери в **App settings → Basic**: Privacy Policy URL `https://ordyx.eu/privacy`, Terms `https://ordyx.eu/terms`,
User data deletion: `https://ordyx.eu/privacy` (там е описано изтриването), App icon, Category „Business and Pages“,
App mode: **Live**.

## Текстове за формата (на английски, Meta ги чете така)

**How will your app use ads_read?**
> Ordyx is an order-management platform for e-commerce shops in Bulgaria. A shop owner logs in with Facebook (Facebook Login
> for Business) and selects their own ad account. Ordyx reads daily ad spend, impressions, clicks and purchase conversions for
> that account (Insights API, read-only) and shows them next to the shop's orders: ad spend per day, ROAS, cost per order and
> profit after advertising. Ordyx never creates, edits or pauses ads and never reads accounts the user did not select.
> The user can disconnect at any time in Ordyx → Integrations → Meta ads; the token is deleted immediately.

**Step-by-step for the reviewer**
> 1. Open https://app.ordyx.eu/admin and log in with the test account below.
> 2. Go to Integrations → Meta ads → „+ Свържи“ (Connect) → „Вход с Facebook“ (Continue with Facebook).
> 3. Log in with Facebook, choose the business and the ad account, and allow access.
> 4. Back in Ordyx, pick the ad account from the list → „Свържи избрания акаунт“ (Connect the selected account).
> 5. Open „Табло“ (Dashboard): the ad spend, ROAS and cost per order for the last 30 days appear from the Insights API.

Тестов профил за Meta: направи клиент в Ordyx (Клиенти → Покани) с имейл, който ще дадеш на Meta, и му дай достъп до
тестов магазин. Сложи имейла и паролата в полето „Test credentials“.

## Записът на екрана (screencast), 1–2 минути
1. Вход в app.ordyx.eu/admin.
2. Интеграции → Meta реклами → „Вход с Facebook“ → прозорецът на Facebook → избор на бизнес и рекламен акаунт → разрешаване.
3. Връщане в Ordyx → избор на акаунта от списъка → „Свържи“.
4. Табло: рекламният разход, ROAS и цената на поръчка.
5. Интеграции → Meta → „Прекъсни връзката“ (показва, че потребителят контролира достъпа).
Говор не трябва; ако има надписи — на английски.

## След одобрението
Ordyx → Интеграции → Meta реклами → отметни **„Вход с Facebook“ и за клиентите**. Без промяна по кода.
