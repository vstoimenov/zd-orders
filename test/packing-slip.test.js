import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus, setPacked } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { slipHtml, adminBase, orderLink } from '../lib/packing-slip.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); n = 0; await q(`update zd.shops set name = 'ADHD книга' where id = $1`, [SHOP]); });

async function add(patch = {}, status = 'new') {
  n++;
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${n}`, name: `Мария <script>alert(1)</script>`, phone: '0888123456', phoneNorm: `+3598881${String(n).padStart(5, '0')}`, email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1107', officeText: 'ЕКОНТ – офис София Младост (1107)', city: 'София', postCode: '1000',
    addressText: '', items: [{ name: 'Книга & тесте', qty: 2, price: 18.5 }, { name: 'Аудио', qty: 1, price: 9 }], total: 50.07, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  return r.id;
}
const get = async (url, cookie = owner) => { const res = fakeRes(); await router(fakeReq({ url, headers: cookie ? { cookie } : {} }), res); return res; };

test('the slip has what the packer needs, escaped, with a QR that opens the order in Ordyx', async () => {
  const id = await add();
  const [o] = (await q(`select * from zd.orders where id = $1::uuid`, [id]));
  const { toOrder } = await import('../lib/orders-repo.js');
  const html = await slipHtml({ name: 'ADHD книга' }, [toOrder(o)]);
  assert.equal(adminBase(), 'https://app.ordyx.eu/admin');
  process.env.ADMIN_BASE_URL = 'https://zd-orders.vercel.app/demo';
  assert.equal(orderLink('x'), 'https://zd-orders.vercel.app/demo/?order=x', 'the demo keeps its QR links on the demo');
  delete process.env.ADMIN_BASE_URL;
  assert.match(html, /Мария &lt;script&gt;/);
  assert.ok(!html.includes('<script>alert'), 'customer text is escaped');
  assert.match(html, /Книга &amp; тесте.*×\s*2/s);
  assert.match(html, /Аудио.*×\s*1/s);
  assert.match(html, /50[.,]07/);
  assert.match(html, /Наложен платеж/);
  assert.match(html, /София Младост \(1107\)/);
  assert.match(html, /<svg/);
  assert.ok(html.includes(`https://app.ordyx.eu/admin/?order=${id}`), 'the QR link is printed under the code too');
  assert.match(html, /adhdbg\.eu:1/);
  assert.match(html, /ADHD книга/);
});

test('GET ?slip=<id> is an HTML page for the logged-in admin of that shop; ?slip=all prints every order to pack', async () => {
  const a = await add(), b = await add({}, 'confirmed'), packed = await add(), shipped = await add({}, 'shipped');
  await setPacked(q, packed, true);
  assert.equal((await get(`/api/admin/orders?slip=${a}&shop=${SHOP}`, null)).statusCode, 401);
  let res = await get(`/api/admin/orders?slip=${a}&shop=${SHOP}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal((String(res.body).match(/class="slip"/g) || []).length, 1);
  res = await get(`/api/admin/orders?slip=all&shop=${SHOP}`);
  assert.equal((String(res.body).match(/class="slip"/g) || []).length, 2, 'a and b; not the packed one, not the shipped one');
  assert.ok(String(res.body).includes(`order=${a}`) && String(res.body).includes(`order=${b}`));
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  assert.equal((await get(`/api/admin/orders?slip=${a}&shop=${other}`)).statusCode, 404, 'another shop never sees it');
  assert.equal((await get(`/api/admin/orders?slip=all&shop=${other}`)).statusCode, 200);
  assert.match(String((await get(`/api/admin/orders?slip=all&shop=${other}`)).body), /Няма поръчки за пакетиране/);
  assert.equal((await get(`/api/admin/orders?slip=nope&shop=${SHOP}`)).statusCode, 404);
  assert.equal((await get(`/api/admin/orders?slip=${'-'.repeat(36)}&shop=${SHOP}`)).statusCode, 404, 'a malformed id is 404, not 500');
  void shipped;
});
