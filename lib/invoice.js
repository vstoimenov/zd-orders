// Invoice details a buyer gives for an order (company, ЕИК, ДДС номер, МОЛ, address of registration). From a checkout or a
// site they are kept as typed (an order is never refused for them; wrong ones are marked invalid for the shop to check);
// from the order page they are checked strictly.
// control characters (NUL etc.) never reach the database — Postgres jsonb refuses \u0000
const str = (v, max) => String(v ?? '').replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const EIK = /^\d{9}(\d{4})?$/;
const VAT = /^BG\d{9,10}$/;

/** → {ok, invoice} | {ok:false, error}. Empty input = {} (no invoice). */
export function cleanInvoice(input, { strict = false } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const inv = {
    company: str(i.company, 160), eik: str(i.eik, 20).replace(/\s/g, ''), vat: str(i.vat, 20).replace(/\s/g, '').toUpperCase(),
    mol: str(i.mol, 120), address: str(i.address, 200),
  };
  for (const k of Object.keys(inv)) if (!inv[k]) delete inv[k];
  if (!Object.keys(inv).length) return { ok: true, invoice: {} };
  const problem = !inv.company ? 'Въведете името на фирмата' : !EIK.test(inv.eik || '') ? 'ЕИК трябва да е 9 или 13 цифри'
    : inv.vat && !VAT.test(inv.vat) ? 'ДДС номерът е BG и 9 или 10 цифри' : '';
  if (problem && strict) return { ok: false, error: problem };
  return { ok: true, invoice: problem ? { ...inv, invalid: true } : inv };
}

/** Stores the order's invoice details. strict: refused with a Bulgarian error when wrong (the order page). Empty input changes nothing. */
export async function saveInvoice(q, orderId, input, { strict = false, onlyIfEmpty = false } = {}) {
  const c = cleanInvoice(input, { strict });
  if (!c.ok) throw new Error(c.error);
  if (!Object.keys(c.invoice).length) return {};
  // a re-sent order never replaces details the buyer already gave or corrected
  await q(`update zd.orders set invoice = $2::text::jsonb where id = $1::uuid${onlyIfEmpty ? ` and invoice = '{}'::jsonb` : ''}`, [orderId, JSON.stringify(c.invoice)]);
  return c.invoice;
}
