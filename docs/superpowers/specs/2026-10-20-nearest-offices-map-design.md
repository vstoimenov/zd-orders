# „Намери ме“, карта и работно време в чекаута — design

Date: 2026-10-20. Requested by the owner after a competitor walkthrough (docs/research/2026-10-20-competitor-checkout-video.md):
"първо 1 + 2 + 3, после Shopify".

## Why
Today the customer must type a city or office name. The competitor shows the nearest points with metres after one tap and a map
with every point. Both lift conversion and both work for every shop with no setup. Our office lists already exist; they only lack
coordinates and opening hours.

## What the customer gets
1. **„Намери ме“** in every office/locker panel (Econt, Speedy, BOX NOW). One tap → the browser asks for location → the panel lists
   the 8 nearest points of that courier with the distance ("650 m", "2,3 km"). Typing still works; results then show distance too.
   Location denied or unavailable → a short note ("Браузърът не даде местоположение — напишете град или офис."), nothing else changes.
   The location is remembered while the page is open, so switching courier needs no second tap.
2. **„Виж на картата“** in the same panel → a full-screen map (own layer, closes with ✕) with the courier's points as markers
   (office / locker icon), centred on the customer's location, else on the city typed, else on Bulgaria. Tap a marker → name, address,
   hours, "Избери" → the point is chosen and the map closes. The map library loads only when the button is tapped.
3. **Opening hours** under the address in the list and in the chosen-point card: "пн–пт 09:00–18:00 · сб 09:00–15:00" or "24/7";
   nothing when the courier does not publish them (Speedy).

## Data
- `zd.offices` gains `lat`, `lng` (double precision, null when unknown) and `hours` (text, '' when unknown). Filled by the nightly
  refresh: Econt (location + business hours, 00:00–23:59 = 24/7), Speedy (X/Y from the map page; no hours), BOX NOW (lat/lng;
  "24/7" when the note says so).
- `/api/offices` returns `lat`, `lng`, `hours` per office. No new endpoints, no new Vercel functions.

## Decisions (mine — owner can overrule)
- Distance = straight line (haversine), shown rounded: < 1 km in metres (50 m steps), else km with one decimal.
- Map: MapLibre GL (cdnjs, pinned version) + OpenFreeMap style (free, no key, no usage cap); markers limited to the points inside the
  view (max 400) to stay light on phones. No Google, no paid keys, nothing for the shop to configure.
- Geolocation is asked only on the tap ("Намери ме"), never on load (browser prompt fatigue).
- Hours as one short string built at refresh time (Sofia time), not raw timestamps.
- Landing page live demo unchanged for now.

## Non-goals
All couriers in one list sorted by distance (our flow picks the delivery method first, which maps to the ConvertBuilder method);
address autocomplete; price on the map (the price is per method, already shown on the option).

## Anti-goals
- Never block the checkout: any failure (no location, map script fails to load, no coordinates) leaves the existing search working.
- Never send the customer's location to our server: distance is computed in the browser.
