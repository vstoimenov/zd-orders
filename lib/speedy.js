// Speedy offices without a client contract: their public office-locator map page embeds every office as a JS object literal.
// Unofficial — if Speedy changes the page, the parse returns [] and the cached list stays (replaceOffices never wipes on []).
const MAP_URL = 'https://services.speedy.bg/officesmap_v2/googleMaps.php?office_locator&lang=bg&src=olsl_1';
const ENTRY = /(\d+): \{oID: (\d+), officeName: '((?:[^'\\]|\\.)*)',[^}]*?officeType: '(\w+)', dropOffAllowed: \d, pickUpAllowed: (\d)\}/g;

export async function fetchSpeedyMap(fetchImpl = fetch) {
  const res = await fetchImpl(MAP_URL);
  if (!res.ok) throw new Error(`Speedy map: HTTP ${res.status}`);
  return res.text();
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());

export function parseSpeedyOffices(html) {
  const out = [];
  const seen = new Set();
  for (const [, , id, rawName, type, pickUp] of String(html ?? '').matchAll(ENTRY)) {
    if (pickUp !== '1' || seen.has(id)) continue; // only offices that hand out parcels
    seen.add(id);
    const name = rawName.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
    out.push({
      id: `speedy:${id}`, courier: 'speedy', code: id, name,
      city: titleCase(name.split(/\s[-–]\s/)[0]), // "АЙТОС - КИРИЛ И МЕТОДИЙ" → Айтос; a bare city name is the city's main office
      cityId: null, postCode: '', address: '', isAutomat: type === 'APT',
    });
  }
  return out;
}
