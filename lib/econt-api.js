// Econt e-Econt API with the shop's own profile (username/password, no contract needed): profile, waybills, statuses.
export const ECONT_HOSTS = { live: 'https://ee.econt.com/services', demo: 'https://demo.econt.com/ee/services' };
export const trackUrl = (number) => `https://www.econt.com/services/track-shipment/${encodeURIComponent(number)}`;

const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const RETURNED = ['return', 'is_returning_to_sender', 'returned_to_sender'];

/** Econt's nested error {message, innerErrors[]} → one readable line. */
function errorText(e) {
  if (!e || typeof e !== 'object') return '';
  const inner = (Array.isArray(e.innerErrors) ? e.innerErrors : []).map(errorText).filter(Boolean).join('; ');
  return clean([clean(e.message), inner].filter(Boolean).join(' '));
}

/** rejected = Econt clearly said no (nothing was done); false = unknown (timeout, lost connection, odd answer). */
const fail = (message, rejected) => Object.assign(new Error(message), { rejected });
const ECONT_PDF = /^https?:\/\/([a-z0-9-]+\.)*econt\.com\//i;

export async function econtCall({ username, password, demo }, path, body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${demo ? ECONT_HOSTS.demo : ECONT_HOSTS.live}/${path}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    throw fail(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Еконт не отговори навреме — опитайте отново' : 'Няма връзка с Еконт — опитайте отново', false);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const text = errorText(data);
    throw fail(`Еконт: ${text || `HTTP ${res.status}`}`, Boolean(text) && (res.status < 500 || res.status === 517)); // 517 = Econt's refusal; other 5xx may have done it
  }
  if (data == null) throw fail('Еконт върна неочакван отговор', false);
  return data;
}

const addressText = (a) => [
  [clean(a.city?.name), clean(a.city?.postCode)].filter(Boolean).join(' '), clean(a.quarter),
  [clean(a.street), clean(a.num)].filter(Boolean).join(' '), clean(a.other),
].filter(Boolean).join(', ');

/** The profile's client (sender name/phones) and its addresses, ready to send back as senderAddress. */
export async function getProfile(creds, fetchImpl = fetch) {
  const d = await econtCall(creds, 'Profile/ProfileService.getClientProfiles', {}, fetchImpl);
  const p = Array.isArray(d?.profiles) ? d.profiles[0] : null;
  if (!p?.client) throw new Error('Еконт не върна данни за профила');
  return {
    name: clean(p.client.name),
    company: Boolean(p.client.juridicalEntity), // a company must name the person who hands over parcels (senderAgent)
    phones: (Array.isArray(p.client.phones) ? p.client.phones : []).map(clean).filter(Boolean),
    addresses: (Array.isArray(p.addresses) ? p.addresses : []).filter((a) => a?.city?.name).map((a) => ({
      id: String(a.id),
      text: addressText(a),
      address: {
        city: { country: { code3: 'BGR' }, name: clean(a.city.name), postCode: clean(a.city.postCode) },
        quarter: clean(a.quarter), street: clean(a.street), num: clean(a.num), other: clean(a.other),
      },
    })),
  };
}

const num = (v) => (v === '' || v == null ? NaN : Number(String(v).replace(',', '.')));

/** Order + shop settings (+ values typed in the waybill window) → Econt label. Throws Bulgarian messages for the admin. */
export function buildLabel(order, settings, input = {}) {
  const office = String(order.officeId || '').startsWith('econt:') ? order.officeId.slice(6) : '';
  if (order.courier !== 'econt' || !office) throw new Error('Поръчката не е до офис на Еконт');
  const s = settings || {};
  if (!s.sender || (s.sender.type === 'office' ? !s.sender.officeCode : !s.sender.address)) throw new Error('В настройките на Еконт изберете откъде изпращате (офис или адрес)');
  const senderName = clean(s.senderName) || clean(s.profileName);
  const senderPhone = clean(s.senderPhone);
  if (!senderPhone) throw new Error('В настройките на Еконт въведете телефон на подателя');
  const agent = clean(s.senderAgent);
  if (s.profileCompany && !agent) throw new Error('Профилът в Еконт е на фирма — в настройките на Еконт въведете упълномощено лице (човекът, който предава пратките)');
  if (!clean(order.phone)) throw new Error('Поръчката няма телефон на получателя');

  const weight = num(input.weight ?? s.weight ?? 1);
  if (!(weight > 0 && weight <= 50)) throw new Error('Тегло: от 0,01 до 50 кг');
  const packCount = input.packCount == null || input.packCount === '' ? 1 : Number(input.packCount);
  if (!Number.isInteger(packCount) || packCount < 1 || packCount > 10) throw new Error('Брой пакети: от 1 до 10');
  const cod = input.cod == null || input.cod === '' ? (['cod', ''].includes(order.paymentMethod || '') ? Number(order.total) : 0) : num(input.cod);
  if (!(cod >= 0 && cod <= 10000)) throw new Error('Наложен платеж: сума от 0 до 10 000');
  const items = (order.items || []).map((it) => `${it.qty} × ${clean(it.name)}`).join(', ');
  const description = (clean(input.description) || clean(s.description) || items || 'стоки').slice(0, 100);

  const label = {
    senderClient: { name: senderName, phones: [senderPhone] },
    ...(agent ? { senderAgent: { name: agent, phones: [senderPhone] } } : {}),
    ...(s.sender.type === 'office' ? { senderOfficeCode: String(s.sender.officeCode) } : { senderAddress: s.sender.address }),
    receiverClient: { name: clean(order.name), phones: [clean(order.phone)] },
    receiverOfficeCode: office,
    packCount, shipmentType: 'PACK', weight,
    shipmentDescription: description,
  };
  const services = {};
  if (cod > 0) Object.assign(services, { cdAmount: Math.round(cod * 100) / 100, cdType: 'get', cdCurrency: order.currency || 'EUR' });
  if (input.review ?? s.review) services.payAfterAccept = true;
  if (Object.keys(services).length) label.services = services;
  if ((input.payer || s.payer || 'receiver') === 'receiver') label.paymentReceiverMethod = 'cash';
  return label;
}

/** mode 'calculate' (price only) or 'create' (a real waybill on a live profile). */
export async function createLabel(creds, label, mode, fetchImpl = fetch) {
  if (!['calculate', 'create'].includes(mode)) throw new Error('invalid mode');
  const d = await econtCall(creds, 'Shipments/LabelService.createLabel', { label, mode }, fetchImpl);
  const l = d?.label;
  if (!l || (mode === 'create' && !l.shipmentNumber)) throw fail('Еконт не върна номер на товарителница', false);
  return {
    number: l.shipmentNumber ? String(l.shipmentNumber) : null, price: Number(l.totalPrice) || 0, currency: clean(l.currency) || 'EUR',
    receiverDue: Number(l.receiverDueAmount) || 0, senderDue: Number(l.senderDueAmount) || 0, pdf: ECONT_PDF.test(String(l.pdfURL || '')) ? String(l.pdfURL) : null, // only Econt's own links go into the admin
  };
}

export async function deleteLabels(creds, numbers, fetchImpl = fetch) {
  const d = await econtCall(creds, 'Shipments/LabelService.deleteLabels', { shipmentNumbers: numbers }, fetchImpl);
  const failed = (Array.isArray(d?.results) ? d.results : []).find((r) => r?.error);
  if (failed) throw new Error(`Еконт: ${errorText(failed.error) || 'товарителницата не може да се анулира'}`);
}

/** Econt status → 'delivered' | 'returned' | null (still on its way). Return receipts (обратна разписка) do not count. */
export function statusFromEcont(s) {
  const types = (Array.isArray(s?.trackingEvents) ? s.trackingEvents : []).filter((e) => !e?.isReceipt).map((e) => e?.destinationType);
  if (types.some((t) => RETURNED.includes(t))) return 'returned';
  if (s?.deliveryTime || types.includes('client')) return 'delivered';
  return null;
}

export async function shipmentStatuses(creds, numbers, fetchImpl = fetch) {
  const d = await econtCall(creds, 'Shipments/ShipmentService.getShipmentStatuses', { shipmentNumbers: numbers }, fetchImpl);
  return (Array.isArray(d?.shipmentStatuses) ? d.shipmentStatuses : []).filter((x) => x?.status?.shipmentNumber).map((x) => ({
    number: String(x.status.shipmentNumber), status: statusFromEcont(x.status), text: clean(x.status.shortDeliveryStatus),
  }));
}
