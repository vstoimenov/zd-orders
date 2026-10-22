# Скрита оферта за събития + ново лого — design

Date: 2026-10-22. Owner: going to a conference with business cards carrying a QR code; leftover cards go to later events.
Owner's words: "да се регистрира за 3 месеца безплатен период на най-високият план неограничени магазини и поръчки; смс,
обаждания и подобни се плащат отделно", "на страницата да пише колко спестява", variant B (savings calculator),
"да пише отгоре Скрита оферта за хората от това събитие", logo direction A (cut gem with light, lowercase wordmark),
"дай ми накрая готов линк".

## What gets built
1. **Logo A everywhere**: faceted gem (8 facets in yellow tones, light from the top, table with a soft gradient, thin black lines)
   + lowercase `ordyx` in Unbounded 800. A simplified mark (no thin lines) for ≤ 32 px. Replaced in the admin (login, signup,
   invite, sidebar), the landing page, the offer page, app icons (dev/icons.mjs PNGs) and `public/brand/` files.
2. **Offer page `ordyx.eu/oferta`** (noindex, not linked from anywhere): top pill „🤫 Скрита оферта за хората от това събитие“,
   „3 месеца Ordyx безплатно на най-високия план“, a slider „Колко магазина имаш?“ → savings = 3 × (29 + 12 × (shops − 1)) €
   (regular prices, without VAT; 10 = „10+“), what you get, „SMS, обаждания и подобни услуги се плащат отделно“, 3 steps,
   CTA → `https://app.ordyx.eu/admin/?offer=1`. No event name, no date. When the owner switches the offer off, the page says
   so and links to ordyx.eu instead.
3. **Registration with the offer**: `/admin/?offer=1` shows the normal signup form with an offer banner; no signup code needed
   while the offer is on. The account gets `plan = 'unlimited'`, `free_until = now() + 3 months`, `source = 'offer'`.
4. **Owner (Клиенти)**: an „Скрита оферта“ box — link, on/off, QR download; each offer client shows
   „🎟️ безплатно до 22.01.2027“ (red once expired) and the registration date (tells which event).
5. **Client**: the sidebar shows „Безплатно до …“; from 7 days before the end „остават N дни“.
6. **Print files** in `public/brand/`: QR (SVG + PNG, error correction H, gem in the middle), business card front/back
   PNG at 300 dpi, 85 × 55 mm + 3 mm bleed.

## Decisions (mine — owner can overrule)
- Unlimited shops = a safety cap of 200 for offer accounts (normal clients keep 10).
- After 3 months nothing is blocked (there is no billing yet); the owner sees who expired.
- New shops of offer clients still wait for the owner's approval (anti-fake-shop protection).
- The offer is on by default (no settings row = on); one shared link for every event.
- Rate limit and the bot trap of the normal signup apply.

## Non-goals
Billing, automatic expiry, per-event tracking codes, SMS/calls.
