const BASE = 'https://ee.econt.com/services/Nomenclatures/NomenclaturesService';

const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

export async function fetchEcont(method, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}.${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryCode: 'BGR' }),
  });
  if (!res.ok) throw new Error(`Econt ${method}: HTTP ${res.status}`);
  return res.json();
}

/** Street part of an office address: Econt's fullAddress starts with the city, which we show separately. */
function street(address, city) {
  let full = clean(address.fullAddress);
  if (city && full.startsWith(`${city} `)) full = full.slice(city.length + 1);
  if (full === city) full = '';
  return full || [address.quarter, address.street, address.num].map(clean).filter(Boolean).join(' ');
}

const coord = (v) => (Number.isFinite(Number(v)) && Number(v) !== 0 ? Number(v) : null);
const hm = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' }) : '');
/** Econt gives opening hours as timestamps on some day: weekdays (normal) and Saturday (halfDay) → "пн–пт 09:00–18:00 · сб 09:00–15:00", "24/7". */
export function businessHours(o) {
  const week = [hm(o?.normalBusinessHoursFrom), hm(o?.normalBusinessHoursTo)];
  if (!week[0] || !week[1]) return '';
  if (week[0] === '00:00' && week[1] === '23:59') return '24/7';
  const sat = [hm(o?.halfDayBusinessHoursFrom), hm(o?.halfDayBusinessHoursTo)];
  return `пн–пт ${week[0]}–${week[1]}` + (sat[0] && sat[1] ? ` · сб ${sat[0]}–${sat[1]}` : '');
}

export function normalizeOffices(json) {
  const list = Array.isArray(json?.offices) ? json.offices : [];
  return list
    .filter((o) => clean(o?.code) && o?.address?.city?.country?.code3 === 'BGR')
    .map((o) => {
      const city = clean(o.address.city.name);
      return {
        id: `econt:${clean(o.code)}`,
        courier: 'econt',
        code: clean(o.code),
        name: clean(o.name),
        city,
        cityId: Number.isInteger(o.address.city.id) ? o.address.city.id : null,
        postCode: clean(o.address.city.postCode),
        address: street(o.address, city),
        isAutomat: Boolean(o.isAPS),
        lat: coord(o.address.location?.latitude), lng: coord(o.address.location?.longitude), hours: businessHours(o),
      };
    });
}

export function normalizeCities(json, offices = []) {
  const withOffice = new Set(offices.map((o) => o.cityId));
  const list = Array.isArray(json?.cities) ? json.cities : [];
  return list
    .filter((c) => Number.isInteger(c?.id) && clean(c.name))
    .map((c) => ({
      id: c.id,
      name: clean(c.name),
      postCode: clean(c.postCode),
      region: clean(c.regionName),
      hasOffice: withOffice.has(c.id),
    }));
}

/** Coordinates + post code of every BG office with a location (used to give Speedy offices a nearby post code). */
export function econtPoints(json) {
  const list = Array.isArray(json?.offices) ? json.offices : [];
  return list
    .filter((o) => o?.address?.city?.country?.code3 === 'BGR' && clean(o.address.city.postCode)
      && Number.isFinite(o.address.location?.latitude) && Number.isFinite(o.address.location?.longitude))
    .map((o) => ({ lat: o.address.location.latitude, lng: o.address.location.longitude, postCode: clean(o.address.city.postCode) }));
}
