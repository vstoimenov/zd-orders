// Hidden event offer (ordyx.eu/oferta, printed on business cards): registration without a code, 3 months free on the unlimited plan.
// One shared link for every event; the owner switches it on/off. No settings row = on.
export const OFFER_MONTHS = 3;
export const OFFER_LINK = 'https://ordyx.eu/oferta';
export const OFFER_OFF = 'Офертата вече не е активна — разгледайте Ordyx на ordyx.eu';

export async function offerActive(q) {
  const [r] = await q(`select value from zd.settings where key = 'offer'`);
  const v = r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : null;
  return v?.active !== false;
}

export async function setOfferActive(q, on) {
  await q(`insert into zd.settings (key, value) values ('offer', jsonb_build_object('active', $1::boolean, 'at', now()))
           on conflict (key) do update set value = excluded.value`, [Boolean(on)]);
}
