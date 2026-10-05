// nekorekten.com — registry of customers who refuse cash-on-delivery parcels. API: GET /api/v1/reports?phone=…, header Api-Key; free plan 5 req/min, 30 searches/day.
const REPORTS = 'https://api.nekorekten.com/api/v1/reports';

/** Search response → { count, reportIds } (response: { items: [{ id, … }], count, currentPage, itemsPerPage, message }). */
export function summarize(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const count = Number.isFinite(Number(data?.count)) && data?.count != null ? Number(data.count) : items.length;
  return { count, reportIds: items.map((it) => String(it?.id ?? '')).filter(Boolean).slice(0, 10) };
}

export const reportUrl = (id) => `https://nekorekten.com/reports/${encodeURIComponent(id)}`;

export async function lookupPhone(phoneNorm, apiKey, fetchImpl = fetch) {
  const digits = String(phoneNorm ?? '').replace(/\D/g, '');
  if (!digits) throw new Error('Nekorekten: no phone');
  const res = await fetchImpl(`${REPORTS}?phone=${digits}`, {
    headers: { 'Api-Key': apiKey, Accept: 'application/json', 'X-Site-Host': 'kurier.profitbrand.online' },
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`Nekorekten: HTTP ${res.status}${data?.message ? `: ${data.message}` : ''}`);
  // an HTML/quota page with status 200 must not become a false "clean"
  if (!Array.isArray(data?.items)) throw new Error('Nekorekten: unexpected response');
  return summarize(data);
}

/** Plan and usage of the key (plan name, API requests/min, searches/day) — also a cheap way to test a key. */
export async function getUsage(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.nekorekten.com/api/v1/api-keys/current/usage', {
    headers: { 'Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !data?.items) throw new Error(`Nekorekten: HTTP ${res.status}${data?.message ? `: ${data.message}` : ''}`);
  return data.items;
}
