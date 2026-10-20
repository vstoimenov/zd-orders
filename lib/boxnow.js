// BOX NOW lockers: BOX NOW publishes its locker list as public JSON (no login), the same ids its Partner API expects.
export const BOXNOW_LOCKERS_URL = 'https://locationapi-production.boxnow.bg/v1/apms_bg-BG.json';
const IN_SERVICE = new Set(['boxnow-ready', 'only-delivery']); // both take parcels for customers

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export async function fetchBoxnowLockers(fetchImpl = fetch) {
  const res = await fetchImpl(BOXNOW_LOCKERS_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`BOX NOW lockers: HTTP ${res.status}`);
  return parseBoxnowLockers(await res.json());
}

/** {data:[…]} → our office shape (every BOX NOW point is a locker). */
export function parseBoxnowLockers(json) {
  if (!Array.isArray(json?.data)) throw new Error('BOX NOW върна непълен списък с автомати');
  return json.data.filter((l) => l?.id != null && IN_SERVICE.has(l.state)).map((l) => ({
    id: `boxnow:${clean(l.id)}`, courier: 'boxnow', code: clean(l.id),
    name: clean(l.name).replace(/^BOX NOW\s*[-–]\s*/i, '') || clean(l.title),
    city: clean(l.addressLine2), cityId: null, postCode: clean(l.postalCode), address: clean(l.addressLine1), isAutomat: true,
    lat: Number(l.lat) || null, lng: Number(l.lng) || null, hours: /24\s*\/\s*7/.test(clean(l.note)) ? '24/7' : '', // the note says "24/7 …" for most lockers
  }));
}
