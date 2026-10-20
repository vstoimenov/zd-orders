// Speedy offices without a client contract: their public office-locator map page embeds every office as a JS object literal.
// Unofficial — if Speedy changes the page, the parse returns [] and the cached list stays (replaceOffices never wipes on []).
const MAP_URL = 'https://services.speedy.bg/officesmap_v2/googleMaps.php?office_locator&lang=bg&src=olsl_1';
const ENTRY = /(\d+): \{oID: (\d+), officeName: '((?:[^'\\]|\\.)*)',[^}]*?Y: ([\d.\-]+), X: ([\d.\-]+), officeType: '(\w+)', dropOffAllowed: \d, pickUpAllowed: (\d)\}/g;

export async function fetchSpeedyMap(fetchImpl = fetch) {
  const res = await fetchImpl(MAP_URL);
  if (!res.ok) throw new Error(`Speedy map: HTTP ${res.status}`);
  return res.text();
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());

export function parseSpeedyOffices(html) {
  const out = [];
  const seen = new Set();
  for (const [, , id, rawName, lat, lng, type, pickUp] of String(html ?? '').matchAll(ENTRY)) {
    if (pickUp !== '1' || seen.has(id)) continue; // only offices that hand out parcels
    seen.add(id);
    const name = rawName.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
    out.push({
      id: `speedy:${id}`, courier: 'speedy', code: id, name,
      // "АЙТОС - КИРИЛ И МЕТОДИЙ" → Айтос; a bare city name is the city's main office; "ПЛОДОВИТОВО (АВТОМАТ)" → Плодовитово
      city: titleCase(name.split(/\s[-–]\s/)[0].replace(/\s*\(автомат\)\s*$/i, '')),
      cityId: null, postCode: '', address: '', isAutomat: type === 'APT', lat: Number(lat), lng: Number(lng), hours: '', // the public map has no opening hours
    });
  }
  return out;
}

const key = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Speedy's map has no post codes, but ConvertBuilder requires one: take it from the city list (Econt nomenclature).
 * "Бяла (Варна)" = city Бяла in region Варна; otherwise prefer a city with an office, then the first match.
 */
export function attachPostCodes(offices, cities, points = []) {
  const byName = new Map();
  for (const c of cities) {
    const k = key(c.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  return offices.map((o) => {
    if (o.postCode) return o;
    const m = String(o.city).match(/^(.*?)\s*\((.+)\)$/);
    const candidates = byName.get(key(m ? m[1] : o.city)) || [];
    const pick = (m && candidates.find((c) => key(c.region) === key(m[2]))) || candidates.find((c) => c.hasOffice) || candidates[0];
    if (pick) return { ...o, postCode: pick.postCode };
    const near = nearest(points, o.lat, o.lng);
    return near ? { ...o, postCode: near.postCode } : o;
  });
}

/** Closest point by equirectangular distance — plenty accurate inside Bulgaria. */
function nearest(points, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const k = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = (p.lat - lat) ** 2 + ((p.lng - lng) * k) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
