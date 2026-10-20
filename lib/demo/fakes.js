// The public demo's outside world: only Econt's own test server is real; Speedy, BOX NOW, Meta and ConvertBuilder answer with sample data;
// everything else (incl. live Econt) is refused — nothing a visitor types ever leaves the demo.
const json = (data, status = 200) => ({
  ok: status < 300, status, headers: new Map([['content-type', 'application/json']]), json: async () => data, text: async () => JSON.stringify(data),
});
const refused = (message) => json({ error: { message }, message, type: 'Demo', innerErrors: [] }, 403);

let speedyNo = 62000000000;
function fakeSpeedy(path, body) {
  if (path === 'client/contract') return json({ clients: [{ clientId: 90001, clientName: 'Демо Търговия ЕООД', objectName: 'Склад', privatePerson: false, address: { fullAddressString: 'гр. София, бул. България 1' } }] });
  if (path === 'services') return json({ services: [{ id: 505, name: 'СТАНДАРТ 24 ЧАСА', cargoType: 'PARCEL' }] });
  if (path === 'calculate') return json({ calculations: [{ serviceId: 505, price: { amount: 5.1, vat: 1.02, total: 6.12, currency: 'EUR' } }] });
  if (path === 'shipment') {
    const id = String(++speedyNo);
    const n = Math.max(1, Number(body?.content?.parcelsCount) || 1);
    return json({ id, parcels: Array.from({ length: n }, (_, i) => ({ seqNo: i + 1, id: i ? `${id}${i}` : id })), price: { total: 6.12, currency: 'EUR' } });
  }
  if (path === 'shipment/cancel') return json({});
  if (path === 'pickup') return json({ orders: [{ id: 1 }] });
  if (path === 'track') return json({ parcels: (body?.parcels || []).map((p) => ({ parcelId: p.id, operations: [{ operationCode: 12, description: 'Предадена на куриер за доставка' }] })) });
  if (path === 'print') {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 40 380 Td (DEMO - Speedy waybill) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => pdf.buffer };
  }
  return json({ error: { message: 'Демо: непозната заявка', code: 1 } });
}

let boxnowNo = 2270000000;
const DEMO_PDF = (text) => new TextEncoder().encode(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 40 380 Td (${text}) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);
function fakeBoxnow(u) {
  const p = u.pathname;
  if (p === '/api/v1/auth-sessions') return json({ access_token: 'demo', token_type: 'Bearer', expires_in: 3600 });
  if (p === '/api/v1/origins') return json({ data: u.searchParams.get('locationType') === 'any-apm' ? [{ id: 'any-apm', type: 'any-apm', name: 'Any APM' }] : [{ id: 'demo-wh', type: 'warehouse', name: 'Демо склад', addressLine1: 'бул. България 1', addressLine2: 'София' }] });
  if (p === '/api/v1/delivery-requests') return json({ id: `DEMO-${boxnowNo}`, parcels: [{ id: String(++boxnowNo) }] });
  if (p.endsWith(':cancel')) return json({});
  if (p.endsWith('/label.pdf')) { const pdf = DEMO_PDF('DEMO - BOX NOW label'); return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => pdf.buffer }; }
  if (p === '/api/v1/parcels') return json({ data: [{ id: u.searchParams.get('parcelId'), state: 'in-transit', events: [] }] });
  return json({ code: 'P400', message: 'Демо: непозната заявка' }, 400);
}

function fakeMeta(u) {
  if (u.pathname.endsWith('/me/adaccounts')) return json({ data: [{ account_id: '1234567890', name: 'Демо реклами', currency: 'EUR', account_status: 1, business: { name: 'Демо Търговия' } }] });
  if (/\/act_\d+$/.test(u.pathname)) return json({ name: 'Демо реклами', currency: 'EUR', account_status: 1 });
  if (u.pathname.endsWith('/insights')) return json({ data: [] });
  return json({});
}

function fakeConvertBuilder(u, init) {
  const path = u.pathname.replace(/^\/api\/site/, '');
  if (path.startsWith('/orders')) return json({ items: [], totalCount: 0 });
  if (path === '/webhooks' && (init?.method || 'GET') === 'POST') return json({ id: 'demo-hook' });
  if (path.startsWith('/webhooks')) return json([]);
  return json({});
}

export function demoFetch(realFetch) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'demo.econt.com') return realFetch(url, init); // Econt's public test server: real test waybills, never real shipments
    if (u.hostname.endsWith('econt.com')) return refused('В демото Еконт работи само в тестов режим (demo.econt.com)');
    if (u.hostname === 'api.speedy.bg') {
      let body = {};
      try { body = JSON.parse(init.body || '{}'); } catch { /* not JSON */ }
      return fakeSpeedy(u.pathname.replace('/v1/', ''), body);
    }
    if (u.hostname === 'api-production.boxnow.bg' || u.hostname === 'api-stage.boxnow.bg') return fakeBoxnow(u);
    if (u.hostname === 'graph.facebook.com') return fakeMeta(u);
    if (u.pathname.startsWith('/api/site')) return fakeConvertBuilder(u, init);
    return refused('В демото външните връзки са изключени');
  };
}
