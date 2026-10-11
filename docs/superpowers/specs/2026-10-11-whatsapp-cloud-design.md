# WhatsApp Business (Cloud API) through Embedded Signup — design (approved 2026-10-11, "вариант 1")

Each shop connects its own WhatsApp Business number with one button ("Свържи WhatsApp" → Meta's Embedded Signup v4) and pays Meta
directly. The platform is a Tech Provider (our Meta app). New orders get an automatic "потвърдете поръчката" message with two
buttons; the customer's tap confirms or cancels the order (same rules as the confirmation link).

## Meta facts (developers.facebook.com, WhatsApp docs, checked 2026-10-11)
- Embedded Signup: `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } })`;
  the code lives 30 s; window `message` from *.facebook.com with `{ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH'…, data: { phone_number_id, waba_id, business_id } }`.
  v2 ends 2026-10-15 → the configuration must be v4 (Facebook Login for Business → Configurations → Embedded Signup → products).
- Tech Provider onboarding (server side): `GET /oauth/access_token?client_id&client_secret&code` → business token;
  `POST /<WABA_ID>/subscribed_apps`; `POST /<PHONE_NUMBER_ID>/register {messaging_product: 'whatsapp', pin}` (6 digits);
  the customer adds a payment method in WhatsApp Manager.
- Quick-reply taps arrive on the app webhook as `messages[].type = 'button'`, `button.payload`, `metadata.phone_number_id`.
- Pricing: per delivered template message; utility (order) templates are cheap, replies within 24 h of a customer message free.

## Pieces
- `lib/whatsapp.js`: Graph client, onboarding (exchange, check access, subscribe, register), template create/status,
  send order confirmation template (quick-reply payloads `yes:<token>` / `no:<token>`), text reply.
- Integration `provider = 'whatsapp'` per shop: WABA id, phone number id, display number, name, template name/status,
  auto-confirm on/off; secret = sealed `{ token, pin }`. Actions in Интеграции: `wa_config`, `wa_connect`, `wa_template`,
  `wa_refresh`, `wa_settings`, `wa_test`, `wa_disconnect`.
- `api/wa/webhook.js` (new function, 10/12): GET verification (`hub.verify_token` = env `WHATSAPP_VERIFY_TOKEN`), POST with
  `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`); button tap → `answerConfirm` → short reply;
  "STOP" → the shop's STOP list.
- New order (checkout widget / ConvertBuilder): if the shop has WhatsApp connected, auto-confirm on and the template approved →
  the confirmation message is sent (bounded wait, never fails the order).
- Env: `WHATSAPP_CONFIG_ID` (Embedded Signup configuration), `WHATSAPP_VERIFY_TOKEN`; `META_APP_ID` / `META_APP_SECRET` exist.

## Owner's one-time Meta setup
Business verification; add the WhatsApp product to the app; Embedded Signup v4 configuration (→ config id); webhook callback
`https://kurier.profitbrand.online/api/wa/webhook` + verify token, field `messages`; App Review for `whatsapp_business_management`
and `whatsapp_business_messaging` (advanced access) and Tech Provider onboarding. Before review it works for the app's own admins.

## Later
WhatsApp marketing campaigns sent from Кампании (each needs an approved marketing template).
