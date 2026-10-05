// nekorekten.com — registry of customers who refuse cash-on-delivery parcels. API: GET /api/v1/reports?phone=…, header Api-Key, max 10 req/min.
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
    headers: { 'Api-Key': apiKey, Accept: 'application/json', 'X-Site-Host': 'zd-orders.vercel.app' },
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`Nekorekten: HTTP ${res.status}${data?.message ? `: ${data.message}` : ''}`);
  return summarize(data);
}
