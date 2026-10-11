# SMS / WhatsApp campaigns — first version without sending (approved 2026-10-11)

A shop (owner or client) picks customers from its own orders, writes a message with variables, sees how many people it reaches,
how many SMS parts it takes and what it would cost, and saves the campaign. Sending is switched on later with a provider
(SMS provider not chosen yet; WhatsApp needs Meta approval); until then the personalised list is exported as CSV for any bulk tool.

## Data (migration 015)
- `zd.campaigns`: shop, name, channel (sms | whatsapp), message, segment (jsonb), consent flag, status (draft | ready), recipients count, times.
- `zd.campaign_optouts (shop_id, phone_norm)`: numbers that never get a campaign (STOP list).

## Segment (from the shop's orders, one person = one phone number)
statuses (default delivered), date from/to, product name, minimum orders, exclude customers flagged in НЕкоректен (default on);
opted-out numbers are always excluded. The latest order gives the name and the product.

## Message
Variables {име} (first name), {пълно_име}, {продукт} (latest product), {магазин}, {линк} (shop URL). SMS parts: GSM-7 160/153,
Cyrillic (UCS-2) 70/67. Cost = parts × recipients × price per SMS (shop setting, default 0,05 €). WhatsApp: cost depends on Meta.
Optional STOP footer. Saving as "ready" or exporting needs the consent checkbox (marketing messages need the customers' consent).

## Route `campaigns` (inside api/admin/[route].js, scoped like every admin route; one shop, never "all")
GET → campaigns, opt-out count, SMS price · POST preview | save | delete | optout_add | optout_remove | optouts | price ·
GET ?export=<id> → CSV (phone, name, message).

## UI
Menu "Кампании": list + editor (channel, filters, ready-made texts, variable buttons, live preview with count/parts/cost, consent,
Запази / Експорт CSV / Изпрати — disabled until a provider is connected), STOP list. Integrations: "SMS доставчик" and
"WhatsApp Business" cards marked "скоро".
