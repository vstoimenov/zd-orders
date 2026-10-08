# Econt waybills — design (approved 2026-10-08)

Goal: create real Econt waybills (товарителници) from an order in the admin, with only an e-Econt profile (no contract).

## Verified against demo.econt.com (iasp-dev / 1Asp-dev)
- Auth: HTTP Basic with the e-Econt username/password; POST JSON. Errors: HTTP 517 `{type, message, innerErrors[]}` (Bulgarian messages, nested).
- `Profile/ProfileService.getClientProfiles` → `profiles[].client {name, phones}`, `profiles[].addresses[] {id, city{name, postCode}, quarter, street, num, other}`.
- `Shipments/LabelService.createLabel` `{label, mode: calculate|create}` → `label {shipmentNumber, totalPrice, currency, receiverDueAmount, senderDueAmount, pdfURL}`.
  - office → office (`senderOfficeCode`, `receiverOfficeCode`), address → office (`senderAddress`), COD `services {cdAmount, cdType: 'get', cdCurrency}`, review `services.payAfterAccept`.
  - receiver pays: `paymentReceiverMethod: 'cash'`; omitted → sender pays. `shipmentDescription` is required.
- `Shipments/LabelService.deleteLabels {shipmentNumbers}` → `results[] {shipmentNum, error}`.
- `Shipments/ShipmentService.getShipmentStatuses {shipmentNumbers}` → `shipmentStatuses[] {status {deliveryTime, shortDeliveryStatus, trackingEvents[] {destinationType, isReceipt}}, error}`.
  - returned: a non-receipt event `return | is_returning_to_sender | returned_to_sender`; delivered: `deliveryTime` or a `client` event.
- Tracking page: `https://www.econt.com/services/track-shipment/<number>`.

## Pieces
- `db/migrations/011_waybills.sql` — waybill columns on `zd.orders` (number, courier, pdf, price, currency, created/checked time, courier status text, demo flag).
- `lib/econt-api.js` — HTTP client, error flattening, profile, `buildLabel(order, settings, input)`, create/calculate, delete, statuses, `statusFromEcont`.
- `lib/waybills.js` — per-shop settings (`provider = 'econt'`, secret = sealed `{username, password}`), preview / create (atomic claim, no double waybills) / cancel, nightly status sync.
- `lib/admin/waybills.js` — admin route `/api/admin/waybills` (no new Vercel function): `defaults | preview | create | cancel`.
- `lib/admin/integrations.js` — `econt_profile`, `save_econt`, `sync_econt`; status `econtLabels`.
- `api/cron/refresh.js` — nightly status sync per shop.
- Admin UI — Econt card → settings modal (credentials, test mode, sender office/address, payer, weight, description, review); orders → „Товарителница“ modal (calculate → confirm → create), number with tracking link, PDF, cancel.

## Rules
- Credentials never return to the browser; the username is shown.
- Test mode uses demo.econt.com; waybills made there are marked „тест“ and are never synced as real.
- Creating moves the order new/confirmed → shipped; cancelling moves shipped → confirmed. Stock follows status (existing `syncStockSafe`).
- Nightly sync moves shipped → delivered / returned (returned gives stock back).
- Production creates real shipments charged to the profile: the UI asks for confirmation.
- Later (not now): bulk creation, Speedy.

# Speedy waybills (added 2026-10-08, approved: each shop connects its own Speedy contract)

Speedy gives Web API credentials only with a contract (MySpeedy logins do not work). No public demo server, so no test mode;
verification against the real API needs a shop's credentials (`/calculate` creates nothing).

## From the Web API docs (api.speedy.bg/web-api.html, BASE https://api.speedy.bg/v1, POST JSON, userName/password in every body)
- `/client/contract` → `clients[] {clientId, clientName, objectName, privatePerson, address}`; `/services` → `services[] {id, name, cargoType}`.
- `/calculate` `{sender, recipient{privatePerson, pickupOfficeId | addressLocation{countryId, siteName, postCode}}, service{serviceIds[]}, content{parcelsCount, totalWeight}, payment}` → `calculations[] {serviceId, price{total, currency}, error}`.
- `/shipment` `{sender{clientId, phone1{number}, contactName?, dropoffOfficeId?}, recipient{clientName (3–60), privatePerson, phone1, pickupOfficeId | address{countryId 100, siteName, postCode, addressNote}}, service{serviceId, additionalServices{cod{amount, currencyCode, processingType 'CASH'}, obpd{option 'OPEN'|'TEST', returnShipmentServiceId, returnShipmentPayer}}}, content{parcelsCount, totalWeight, contents ≤100, package ≤50}, payment{courierServicePayer 'SENDER'|'RECIPIENT'}}` → `{id, parcels[], price, error}`.
- `/shipment/cancel {shipmentId, comment}` → `{}` or `{error}` (only before pickup). `/print {paperSize A4|A6, parcels[{parcel{id}}]}` → PDF bytes (JSON on error).
- `/track {parcels[{id}] ≤10}` → `parcels[] {parcelId, operations[] {operationCode, description}}`; delivered `-14`, returned `111 | 123 | 124`.
- Errors: `{error {message, code, context, component}}` (HTTP 200 or 4xx) = clear refusal; timeouts, lost connections, 5xx, non-JSON = unclear.

## Pieces
- `lib/speedy-api.js` (client, profile, buildShipment, calculate, create, cancel, print, statuses).
- `lib/waybills.js` becomes courier-neutral (adapter per courier: econt, speedy) — same claim / unclear / release / cancel / sync rules.
- Speedy settings per shop (`provider = 'speedy'`): API user/password (sealed), sender office or contract object (pickup from address), contact person (companies), phone, payer, weight, description, review (OPEN/TEST), service, paper size.
- PDF: `GET /api/admin/waybills?pdf=<order id>&shop=<shop id>` prints through the API with the shop's credentials.
- Admin UI: Speedy card → settings window; the waybill window and order buttons work for both couriers (office and address).
