// Ad spend totals for a period in EUR (BGN at the fixed euro rate; other currencies are reported separately, not converted).
const BGN_PER_EUR = 1.95583;
const round2 = (v) => Math.round(Number(v) * 100) / 100;

/** shopId null = all shops; each shop counts only its connected Meta account. */
export async function adSpendTotals(q, { from, to, shopId = null }) {
  const rows = await q(
    `select currency, sum(spend) as spend, sum(impressions)::bigint as impressions, sum(clicks)::bigint as clicks,
       sum(purchases)::int as purchases, sum(purchase_value) as purchase_value
     from zd.ad_spend a where day between $1::date and $2::date and platform = 'meta'
       and ($3::uuid is null or a.shop_id = $3::uuid)
       and account_id = (select config->>'accountId' from zd.integrations i where i.provider = 'meta' and i.shop_id = a.shop_id) -- only the connected account
     group by currency order by currency`,
    [from, to, shopId],
  );
  const t = { spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0, unconverted: [] };
  for (const r of rows) {
    const rate = r.currency === 'EUR' ? 1 : r.currency === 'BGN' ? 1 / BGN_PER_EUR : null;
    t.impressions += Number(r.impressions); t.clicks += Number(r.clicks); t.purchases += Number(r.purchases);
    if (rate == null) { t.unconverted.push({ currency: r.currency, amount: round2(r.spend) }); continue; }
    t.spend += Number(r.spend) * rate; t.purchaseValue += Number(r.purchase_value) * rate;
  }
  return { ...t, spend: round2(t.spend), purchaseValue: round2(t.purchaseValue) };
}
