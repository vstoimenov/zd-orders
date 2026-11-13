// Plans and the launch offer: the price by the day the plan was chosen, kept 12 months from the first payment; Founders 20.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { quote, chooseSubscription, markPaid, cancelSubscription, foundersLeft, subscriptionView, SUB_COLS } from '../lib/plans.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); });
const BEFORE = new Date('2026-11-30T21:59:00Z'); // 23:59 in Sofia on 30.11
const AFTER = new Date('2026-11-30T22:00:01Z'); // 00:00:01 on 1.12 in Sofia
let n = 0;
const user = async () => (await q(`insert into zd.users (email, name) values ($1, 'К') returning id`, [`u${++n}@x.bg`]))[0].id;
const row = async (id) => (await q(`select ${SUB_COLS} from zd.users where id = $1::uuid`, [id]))[0];

test('launch prices until 30.11.2026 23:59 in Sofia, regular after; with VAT', () => {
  assert.deepEqual(quote('starter', 'monthly', BEFORE), { plan: 'starter', billing: 'monthly', launch: true, price: 40.2, regular: 67 });
  assert.deepEqual(quote('growth', 'yearly', BEFORE), { plan: 'growth', billing: 'yearly', launch: true, price: 465.6, regular: 1164 });
  assert.equal(quote('business', 'yearly', BEFORE).price, 705.6);
  assert.deepEqual(quote('growth', 'monthly', AFTER), { plan: 'growth', billing: 'monthly', launch: false, price: 97, regular: 97 });
  assert.throws(() => quote('pro', 'monthly'), /план/);
  assert.throws(() => quote('growth', 'weekly'), /месечно или годишно/);
});

test('the plan picked at registration: 14 days free; a change keeps the launch price of the first choice', async () => {
  const id = await user();
  let s = await chooseSubscription(q, id, { plan: 'growth', billing: 'monthly' }, BEFORE);
  assert.equal(s.price, 58.2); assert.equal(s.trialUntil, '2026-12-14T21:59:00.000Z'); assert.equal(s.launchActive, true);
  s = await chooseSubscription(q, id, { plan: 'business', billing: 'yearly' }, AFTER);
  assert.deepEqual([s.planName, s.billing, s.price, s.regular, s.launch], ['Business', 'yearly', 705.6, 1764, true]);
  assert.equal(s.trialUntil, '2026-12-14T21:59:00.000Z', 'the free period is not restarted');
  const late = await user();
  assert.equal((await chooseSubscription(q, late, { plan: 'growth', billing: 'monthly' }, AFTER)).price, 97);
});

test('paid monthly: the launch price for 12 months from the first payment, then the regular one', async () => {
  const id = await user();
  await chooseSubscription(q, id, { plan: 'starter', billing: 'monthly' }, BEFORE);
  const s = await markPaid(q, id, { paidAt: '2026-12-10T10:00:00Z' }, new Date('2026-12-10T10:00:00Z'));
  assert.deepEqual([s.price, s.lockedUntil, s.founder], [40.2, '2027-12-10T10:00:00.000Z', false]);
  assert.equal(subscriptionView(await row(id), new Date('2027-12-09T10:00:00Z')).price, 40.2);
  assert.equal(subscriptionView(await row(id), new Date('2027-12-11T10:00:00Z')).price, 67);
  assert.equal((await markPaid(q, id, { paidAt: '2027-01-10T10:00:00Z' })).paidAt, '2026-12-10T10:00:00.000Z', 'the first payment stays');
});

test('Founders 20: the first 20 yearly payers keep the launch price for good; the 21st for 12 months; monthly never', async () => {
  const ids = [];
  for (let i = 0; i < 21; i++) { const id = await user(); ids.push(id); await chooseSubscription(q, id, { plan: 'growth', billing: 'yearly' }, BEFORE); }
  const monthly = await user(); await chooseSubscription(q, monthly, { plan: 'growth', billing: 'monthly' }, BEFORE);
  assert.equal((await markPaid(q, monthly)).founder, false);
  assert.equal(await foundersLeft(q), 20);
  for (const id of ids.slice(0, 20)) assert.equal((await markPaid(q, id)).founder, true);
  assert.equal((await row(ids[19])).sub_founder_no ?? (await q(`select sub_founder_no from zd.users where id = $1::uuid`, [ids[19]]))[0].sub_founder_no, 20);
  assert.equal(await foundersLeft(q), 0);
  const late = await markPaid(q, ids[20]);
  assert.equal(late.founder, false);
  const far = new Date(Date.now() + 3 * 365 * 864e5);
  assert.equal(subscriptionView(await row(ids[0]), far).price, 465.6, 'a founder keeps it');
  assert.equal(subscriptionView(await row(ids[20]), far).price, 1164);
  await assert.rejects(chooseSubscription(q, ids[0], { plan: 'business', billing: 'yearly' }), /Founders/);
});

test('a plan chosen after the launch is never a founder; cancelling ends the launch price', async () => {
  const late = await user(); await chooseSubscription(q, late, { plan: 'starter', billing: 'yearly' }, AFTER);
  assert.equal((await markPaid(q, late)).founder, false);
  const id = await user(); await chooseSubscription(q, id, { plan: 'growth', billing: 'yearly' }, BEFORE);
  assert.equal((await markPaid(q, id)).founder, true);
  await cancelSubscription(q, id);
  const s = subscriptionView(await row(id));
  assert.deepEqual([s.price, s.founder, s.launch], [1164, false, false]);
  assert.equal(await foundersLeft(q), 19, 'the place of one of the first 20 who paid is not given again');
});
