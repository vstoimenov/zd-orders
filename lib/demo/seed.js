// Sample data of the public demo: two invented shops with a month of orders, products, costs, visits, ad spend and connected
// integrations (Econt on its public test server; Speedy, Meta and ConvertBuilder answered by lib/demo/fakes.js).
import { insertOrder, saveNekorekten } from '../orders-repo.js';
import { saveIntegration } from '../integrations-repo.js';
import { saveProduct, syncStockSafe } from '../stock.js';
import { saveCosts, addExpense } from '../costs.js';
import { DEFAULT_SHOP, createShop, updateShop } from '../shops.js';
import { sofiaDay } from '../visits.js';

const WOMEN = ['Мария', 'Елена', 'Десислава', 'Николета', 'Гергана', 'Ралица', 'Цветелина', 'Виктория', 'Яна', 'Теодора'];
const MEN = ['Иван', 'Георги', 'Петър', 'Стефан', 'Димитър', 'Христо', 'Мартин', 'Калоян', 'Николай', 'Борис'];
const SURNAMES = ['Иванов', 'Петров', 'Стоянов', 'Димитров', 'Николов', 'Георгиев', 'Колев', 'Тодоров', 'Маринов', 'Василев', 'Ангелов', 'Христов'];
/** "Мария Иванова" / "Иван Иванов" — the surname follows the first name. */
const fullName = (r) => (r() < 0.65 ? `${WOMEN[Math.floor(r() * WOMEN.length)]} ${SURNAMES[Math.floor(r() * SURNAMES.length)]}а` : `${MEN[Math.floor(r() * MEN.length)]} ${SURNAMES[Math.floor(r() * SURNAMES.length)]}`);
// the shop sends from Econt 1107; customers pick up at 1127 (offices Econt's test server knows)
const ECONT = [{ id: 'econt:1127', text: 'ЕКОНТ – офис София Лозенец (1127), ул. Златовръх 1', city: 'София', post: '1164' }];
const SPEEDY = [
  { id: 'speedy:66', text: 'СПИДИ – офис ПЛЕВЕН - ЦЕНТЪР (66)', city: 'Плевен', post: '5800' },
  { id: 'speedy:12', text: 'СПИДИ – офис СОФИЯ - ЦЕНТЪР (12)', city: 'София', post: '1000' },
];
const STREETS = ['ул. Роза 5', 'бул. Христо Ботев 18, ет. 3', 'ул. Шипка 12', 'ж.к. Тракия бл. 105, вх. Б'];
const CITIES = [['Варна', '9000'], ['Пловдив', '4000'], ['Бургас', '8000'], ['Русе', '7000']];

/** Same "random" data on every start: a small seeded generator. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function seedShop(q, shopId, { site, products, orders: count, seed, adAccount }) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  for (const p of products) await saveProduct(q, { name: p.name, sku: p.sku, unitCost: p.cost, stock: p.stock, lowStock: p.low }, { create: true, shopId });
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(r() * 30);
    const kind = r();
    const where = kind < 0.6 ? { courier: 'econt', type: 'econt_office', ...pick(ECONT) }
      : kind < 0.85 ? { courier: 'speedy', type: 'speedy_office', ...pick(SPEEDY) }
        : (() => { const [city, post] = pick(CITIES); const street = pick(STREETS); return { courier: 'speedy', type: 'speedy_address', id: '', text: `СПИДИ – адрес: ${street}`, city, post, street }; })();
    const items = [];
    const main = pick(products);
    items.push({ name: main.name, qty: r() < 0.2 ? 2 : 1, price: main.price });
    if (r() < 0.3) { const extra = pick(products); if (extra !== main) items.push({ name: extra.name, qty: 1, price: extra.price }); }
    for (const it of items) it.price = Math.round(it.price * it.qty * 100) / 100;
    const goods = items.reduce((s, it) => s + it.price, 0);
    const total = Math.round((goods + (goods >= 30 ? 0 : 4.5)) * 100) / 100;
    const name = fullName(r);
    const phone = `0888100${String(100 + i).slice(-3)}`;
    const o = await insertOrder(q, {
      cbOrderId: `${site}:${1000 + i}`, name, phone, phoneNorm: `+359${phone.slice(1)}`, email: '',
      deliveryType: where.type, courier: where.courier, officeId: where.id, officeText: where.text, city: where.city, postCode: where.post,
      addressText: where.street || '', items, total, currency: 'EUR', paymentMethod: 'cod', pageUrl: `https://${site}/checkout`,
      ip: '', userAgent: '', trafficSource: pick(['facebook', 'facebook', 'instagram', 'google', 'direct', 'tiktok']), shopId,
    });
    await syncStockSafe(q, o.id);
    // older orders are mostly delivered; the last days are still being handled
    const s = r();
    const status = daysAgo <= 1 ? pick(['new', 'new', 'confirmed']) : daysAgo <= 4 ? pick(['confirmed', 'shipped', 'shipped', 'delivered'])
      : s < 0.72 ? 'delivered' : s < 0.84 ? 'returned' : s < 0.94 ? 'shipped' : 'cancelled';
    // placed daysAgo at a daytime hour (never in the future)
    await q(
      `update zd.orders set status = $5, status_changed_at = now(),
         created_at = least(now(), (((now() at time zone 'Europe/Sofia')::date - $2::int)::timestamp + make_interval(hours => $3::int, mins => $4::int)) at time zone 'Europe/Sofia')
       where id = $1::uuid`,
      [o.id, daysAgo, 8 + Math.floor(r() * 14), Math.floor(r() * 60), status],
    );
    await syncStockSafe(q, o.id);
    await saveNekorekten(q, o.id, r() < 0.08 ? { status: 'flagged', count: 1 + Math.floor(r() * 3), reportIds: [] } : { status: 'clean', count: 0 });
  }
  // anonymous visits and ad spend of the last 30 days
  for (let d = 0; d < 30; d++) {
    const day = sofiaDay(new Date(Date.now() - d * 864e5));
    const n = 25 + Math.floor(r() * 45);
    const rows = Array.from({ length: n }, (_, k) => [day, site, `v-${seed}-${d}-${k}`, '/', pick(['facebook', 'facebook', 'facebook', 'instagram', 'google', 'direct', 'tiktok']), pick(['mobile', 'mobile', 'desktop'])]);
    await q(
      `insert into zd.visits (day, site, visitor, path, source, device, shop_id, created_at)
       select (x->>0)::date, x->>1, x->>2, x->>3, x->>4, x->>5, $2::uuid, least(now(), ((x->>0)::date + time '09:00') at time zone 'Europe/Sofia')
       from jsonb_array_elements($1::text::jsonb) as x on conflict do nothing`,
      [JSON.stringify(rows), shopId],
    );
    if (adAccount) {
      const spend = Math.round((7 + r() * 8) * 100) / 100;
      await q(
        `insert into zd.ad_spend (shop_id, platform, account_id, day, spend, impressions, clicks, purchases, purchase_value, currency)
         values ($1::uuid, 'meta', $2, $3::date, $4, $5, $6, $7, $8, 'EUR')`,
        [shopId, adAccount, day, spend, 3000 + Math.floor(r() * 4000), 50 + Math.floor(r() * 90), 1 + Math.floor(r() * 3), Math.round((25 + r() * 50) * 100) / 100],
      );
    }
  }
}

export async function seedDemo(q) {
  await q(`update zd.shops set domain = 'demo-magazin.bg' where id = $1`, [DEFAULT_SHOP]);
  await updateShop(q, DEFAULT_SHOP, { name: 'Демо магазин', url: 'https://demo-magazin.bg', email: 'shop@demo-magazin.bg', phone: '0888100000', currency: 'EUR' });
  const second = await createShop(q, { name: 'Козметика Демо', domain: 'kozmetika-demo.bg' });

  await q(`insert into zd.offices (id, courier, code, name, city, address) values
    ('econt:1107', 'econt', '1107', 'Офис София Младост', 'София', 'бул. Александър Малинов 1'),
    ('econt:1127', 'econt', '1127', 'Офис София Лозенец', 'София', 'ул. Златовръх 1'),
    ('speedy:12', 'speedy', '12', 'СОФИЯ - ЦЕНТЪР', 'София', ''),
    ('speedy:66', 'speedy', '66', 'ПЛЕВЕН - ЦЕНТЪР', 'Плевен', '') on conflict (id) do nothing`);

  await seedShop(q, DEFAULT_SHOP, {
    site: 'demo-magazin.bg', seed: 7, orders: 75, adAccount: '1234567890',
    products: [
      { name: 'Книга „Спокойно дете“', sku: 'BK-01', cost: 4.2, price: 18.5, stock: 140, low: 20 },
      { name: 'Комплект карти за емоции', sku: 'CR-02', cost: 3.1, price: 12.9, stock: 75, low: 15 },
      { name: 'Подаръчна кутия', sku: 'GB-03', cost: 6.5, price: 29.9, stock: 14, low: 10 },
    ],
  });
  await saveCosts(q, { products: [], settings: { packaging: 0.6, codFeePct: 1.5, freeShippingEcont: 4.5, freeShippingSpeedy: 5, returnCost: 5 }, shopId: DEFAULT_SHOP });
  await addExpense(q, { spentOn: sofiaDay(new Date(Date.now() - 12 * 864e5)), name: 'Снимки на продуктите', amount: 120, shopId: DEFAULT_SHOP });
  await addExpense(q, { spentOn: sofiaDay(new Date(Date.now() - 3 * 864e5)), name: 'Кашони и пълнеж', amount: 46.8, shopId: DEFAULT_SHOP });

  await seedShop(q, second.id, {
    site: 'kozmetika-demo.bg', seed: 11, orders: 14, adAccount: null,
    products: [
      { name: 'Серум с витамин C', sku: 'SR-01', cost: 5.4, price: 24.9, stock: 40, low: 10 },
      { name: 'Крем за ръце', sku: 'HC-02', cost: 1.9, price: 9.9, stock: 6, low: 8 },
    ],
  });

  const now = new Date().toISOString();
  // Econt on its public test server (Econt's own published test account: real test waybills, no real shipments)
  await saveIntegration(q, 'econt', {
    config: { username: 'iasp-dev', demo: true, profileName: 'ЕТ КОНСУЛТ - ИВАН КИРЯЗОВ', profileCompany: true, senderAgent: 'Иван Кирязов', senderName: '',
      sender: { type: 'office', officeCode: '1107', addressId: '', address: null, text: 'Офис София Младост, София' },
      senderPhone: '0888100000', payer: 'receiver', weight: 1, description: '', review: false, active: true, connectedAt: now },
    secret: JSON.stringify({ username: 'iasp-dev', password: '1Asp-dev' }),
  });
  await saveIntegration(q, 'speedy', {
    config: { username: 'demo', clientId: 90001, clientName: 'Демо Търговия ЕООД', clientCompany: true, senderContact: 'Иван Петров',
      sender: { type: 'office', officeId: 12, text: 'СОФИЯ - ЦЕНТЪР' }, senderPhone: '0888100000', payer: 'receiver', weight: 1, description: '',
      review: 'OPEN', serviceId: 505, serviceName: 'СТАНДАРТ 24 ЧАСА', paperSize: 'A4', active: true, connectedAt: now },
    secret: JSON.stringify({ username: 'demo', password: 'demo' }),
  });
  await saveIntegration(q, 'meta', {
    config: { accountId: '1234567890', accountName: 'Демо реклами', currency: 'EUR', active: true, connectedAt: now, lastSyncAt: now, lastSyncResult: { days: 30 } },
    secret: 'DEMO-TOKEN',
  });
  await saveIntegration(q, 'convertbuilder', {
    config: { domain: 'demo-magazin.bg', store: 'demo-magazin.bg', active: true, currency: 'EUR', webhookId: 'demo-hook', webhookSecret: 'demo', connectedAt: now,
      lastSyncAt: now, lastSyncResult: { fetched: 75, inserted: 75, updated: 0 } },
    secret: 'DEMO-KEY',
  });
  // two shipped parcels waiting at the receiver's office: day 2 and day 5 (call the customer)
  await q(`update zd.orders set waybill_number = '10516' || lpad(n::text, 8, '0'), waybill_courier = 'econt', waybill_status = 'Пристигнала в офис',
      waybill_created_at = now() - interval '7 days', waybill_at_office_since = now() - make_interval(days => d)
    from (select id, row_number() over (order by created_at desc) as n from zd.orders where shop_id = $1::uuid and status = 'shipped' limit 2) s
    cross join lateral (select case when s.n = 1 then 1 else 4 end as d) x
    where zd.orders.id = s.id`, [DEFAULT_SHOP]);
  // abandoned carts: one to remind, one already reminded, one that came back
  await q(`insert into zd.abandoned_carts (shop_id, phone_norm, name, email, items, total, currency, delivery_text, page_url, created_at, updated_at, reminded_at, reminder_channel, reminder_count, recovered_at) values
    ($1::uuid, '+359887401122', 'Деси Колева', 'desi@example.bg', '[{"name":"Книга","qty":1,"price":12.9}]', 15.38, 'EUR', 'ЕКОНТ – офис София Младост', 'https://demo-magazin.bg/checkout',
      now() - interval '50 minutes', now() - interval '50 minutes', null, '', 0, null),
    ($1::uuid, '+359887401133', 'Пламен Георгиев', '', '[{"name":"Книга","qty":2,"price":25.8}]', 28.28, 'EUR', 'СПИДИ – офис София Център', 'https://demo-magazin.bg/checkout',
      now() - interval '5 hours', now() - interval '5 hours', now() - interval '4 hours', 'whatsapp', 1, null),
    ($1::uuid, '+359887401144', 'Нели Иванова', '', '[{"name":"Книга","qty":1,"price":12.9}]', 15.38, 'EUR', '', 'https://demo-magazin.bg/checkout',
      now() - interval '2 days', now() - interval '2 days', now() - interval '47 hours', 'viber', 1, now() - interval '40 hours')`, [DEFAULT_SHOP]);
}

/** One invented order for "Симулирай нова поръчка". */
export async function simulateOrder(q, shopId) {
  const r = rng(Date.now() % 100000);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const [p] = await q(`select name, (select domain from zd.shops where id = $1::uuid) as site from zd.product_costs where shop_id = $1::uuid order by random() limit 1`, [shopId]);
  const where = pick(ECONT);
  const name = fullName(r);
  const n = Date.now();
  const item = { name: p?.name || 'Продукт', qty: 1, price: 18.5 };
  const o = await insertOrder(q, {
    cbOrderId: `${p?.site || 'demo'}:sim-${n}`, name, phone: '0888100999', phoneNorm: '+359888100999', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: where.id, officeText: where.text, city: where.city, postCode: where.post, addressText: '',
    items: [item], total: 23, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '', userAgent: '', trafficSource: 'facebook', shopId,
  });
  await syncStockSafe(q, o.id);
  await saveNekorekten(q, o.id, { status: 'clean', count: 0 });
  return o.id;
}
