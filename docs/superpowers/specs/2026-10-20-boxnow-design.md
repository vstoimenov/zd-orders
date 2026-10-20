# BOX NOW in Ordyx — design

Date: 2026-10-20. Requested by the owner ("да започни с бокс нау"). BOX NOW = parcel lockers only (961 in Bulgaria).
API facts come from BOX NOW Partner API manual v1.65/1.69 (summary kept outside the repo); the public locker list is
`https://locationapi-production.boxnow.bg/v1/apms_bg-BG.json` (no login).

## Why
Shops want to offer delivery to a BOX NOW locker next to Econt and Speedy, and create the waybill from Ordyx like
they do for Econt/Speedy. The owner is registering Ordyx with BOX NOW (integrationsupport@boxnow.bg) for test access.

## Two phases
**A — lockers in the checkout (works now, public data).** The nightly cron loads the locker list into `zd.offices`
(`courier = 'boxnow'`, id `boxnow:<id>`, all automats). The checkout widget shows a "BOX NOW" choice when the
ConvertBuilder page has a shipping method whose label mentions BOX NOW (same rule as Econt/Speedy: CB labels decide
what is offered and the price). Orders arrive with `delivery_type = 'boxnow_locker'`, `courier = 'boxnow'`.

**B — waybills (built to the manual; proven only against a fake until BOX NOW gives test access).**
Each shop enters its own BOX NOW OAuth Client ID + Secret (sealed, like Econt/Speedy passwords) and a test-mode switch
(stage host `api-stage.boxnow.bg`, live `api-production.boxnow.bg`). It chooses where parcels start:
a registered **warehouse** (BOX NOW collects) or **"I drop it in any locker"** (any-apm; then a compartment size 1/2/3 is
required). One button creates the delivery request; the parcel id is the waybill number; the label PDF is fetched through
Ordyx with the shop's login; cancel; nightly status sync (delivered / returned / waiting in the locker since …).

## Decisions (owner's)
- Start with BOX NOW; owner writes to BOX NOW for credentials.
- Shops connect with their own data, as with Econt/Speedy.

## Decisions (mine — owner can overrule)
- Delivery type name `boxnow_locker`; checkout label "BOX NOW"; CB label pattern `/box\s*now|бокс\s*нау/i`.
- Keep lockers with state `boxnow-ready` and `only-delivery` (both can receive parcels for customers).
- City = `addressLine2` trimmed; name = the locker's `name` without the leading "BOX NOW - ".
- COD: `paymentMode: 'cod'` + `amountToBeCollected` when the order is cash on delivery (BOX NOW must allow COD for the shop;
  their P411 error is shown in Bulgarian). Currency follows the shop's BOX NOW account.
- No price preview (BOX NOW has no price endpoint): the window says the price is per the shop's BOX NOW contract.
- Waybill number = first parcel id; order number sent to BOX NOW = our order id (unique; P410 forbids reuse).
- Free-shipping cost setting `freeShippingBoxnow` next to Econt/Speedy.
- Landing page is not changed until a real test waybill works.

## Non-goals
Home delivery by BOX NOW, customer returns, CSV import, webhooks (nightly polling is enough), the BOX NOW map widget
(our own search list is used, like for Econt/Speedy).

## Anti-goals
- Never break Econt/Speedy checkout or waybills.
- Never create a real BOX NOW parcel by accident: test mode must hit the stage host only, and an unclear answer blocks
  the order ("unknown") exactly like the other couriers.
