// Пътят на растежа: the walk from numbers and answers to one operation; the goal and its check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, OPS, QUESTIONS, T4, progress, goalFor } from '../lib/advisor/path.js';

const base = {
  ordersTotal: 500, kind: 'consumable', ads: true, spend30: 1000, payback: 1.2, marginPerOrder: 8,
  newBuyers30: 120, newBuyersBase: 100, cac: 10, cacBase: 10, conversion: 0.02, completion: 0.7, channelShare: 0.5,
  aov: 40, baseAov: 38, sleeping: 50, buysPerYear: 3.5, retention90: 0.3, priceRaised: true, blockedValue: 0,
  orders30: 300, revenue7: 2800, returnsRate: 0.08,
};
const go = (patch = {}, answers = {}) => walk({ ...base, ...patch }, { capacity: 'yes', ...answers });

test('under 20 sales the only operation is proving the offer', () => {
  const w = walk({ ...base, ordersTotal: 7 });
  assert.equal(w.op, 'first20');
  assert.match(w.steps[0].answer, /Не — 7/);
});

test('the owner is asked only what the data cannot say, one question at a time', () => {
  let w = walk({ ...base, kind: '' });
  assert.equal(w.ask.key, 'kind');
  w = walk({ ...base, kind: '' }, { kind: 'durable' });
  assert.equal(w.ask.key, 'capacity');
  assert.ok(QUESTIONS.capacity.options.length === 3);
});

test('full capacity: no written process → free hands; batchable → a production line; else a team', () => {
  assert.equal(walk(base, { capacity: 'no', standard: 'no' }).op, 'hands');
  assert.equal(walk(base, { capacity: 'no', standard: 'yes', batchable: 'yes' }).op, 'batch');
  assert.equal(walk(base, { capacity: 'no', standard: 'yes', batchable: 'no' }).op, 'team');
});

test('ads that do not pay back lead to more money per buyer: the extra offers first', () => {
  let w = go({ payback: 0.7 });
  assert.equal(w.ask.key, 'extras');
  assert.equal(go({ payback: 0.7 }, { extras: 'no' }).op, 'extras');
  // all four offers, but the order is not 30% bigger → the owner says why
  w = go({ payback: 0.7, aov: 40, baseAov: 38 }, { extras: 'yes' });
  assert.equal(w.ask.key, 'extrasWork');
  assert.equal(go({ payback: 0.7 }, { extras: 'yes', extrasWork: 'price' }).op, 'smaller');
  // bigger orders and conversion above the threshold: the price was not raised → a new price, raised → the margin
  assert.equal(go({ payback: 0.7, aov: 55, baseAov: 40, priceRaised: false }, { extras: 'yes' }).op, 'price');
  assert.equal(go({ payback: 0.7, aov: 55, baseAov: 40, priceRaised: true }, { extras: 'yes' }).op, 'margin');
  // conversion under the threshold sends it back to where it breaks
  assert.equal(go({ payback: 0.7, aov: 55, baseAov: 40, conversion: 0.01, completion: 0.4 }, { extras: 'yes' }).op, 'path');
});

test('no paid ads is not a failed payback; a loss on every order is the margin', () => {
  assert.equal(go({ payback: null, ads: false, marginPerOrder: -2 }).op, 'margin');
  assert.equal(go({ marginPerOrder: null }).ask.key, 'marginOk');
});

test('not growing: the data says where it breaks', () => {
  const flat = { newBuyers30: 80, newBuyersBase: 100 };
  assert.equal(go({ ...flat, completion: 0.4 }).op, 'path');
  assert.equal(go({ ...flat, conversion: 0.01 }).ask.key, 'different');
  assert.equal(go({ ...flat, conversion: 0.01 }, { different: 'no' }).op, 'voice');
  assert.equal(go({ ...flat, conversion: 0.01 }, { different: 'yes' }).op, 'promise');
  assert.equal(go({ ...flat, conversion: 0.01, aov: 150 }, { different: 'disbelief' }).op, 'demo');
  assert.equal(go({ ...flat, conversion: 0.01, aov: 40 }, { different: 'disbelief', lastLook: 'ads' }).op, 'freshAds');
  assert.equal(go({ ...flat, cac: 15, cacBase: 10 }, { cacWhy: 'old' }).op, 'freshAds');
  // enough conversion, few visitors: no ads → partners · one channel → a second one · strong payback → more budget
  assert.equal(go({ ...flat, ads: false, spend30: 0 }).op, 'partners');
  assert.equal(go({ ...flat, channelShare: 0.85 }).op, 'channel');
  assert.equal(go({ ...flat, payback: 1.8 }).op, 'budget');
  assert.equal(go(flat, { fewWhy: 'list' }).op, 'window');
  // no visit data: the owner says where
  assert.equal(go({ ...flat, conversion: null, completion: null }).ask.key, 'breaks');
});

test('growing: repeat purchases and how long buyers stay', () => {
  assert.equal(go({ buysPerYear: 1.5 }, { second: 'periodic' }).op, 'subscription');
  assert.equal(go({ buysPerYear: 1.5 }, { second: 'once' }).op, 'next');
  assert.equal(go({ buysPerYear: 1.5, sleeping: 340 }, { second: 'yes' }).op, 'wake');
  assert.equal(go({ buysPerYear: 1.5, blockedValue: 900 }, { second: 'yes' }).op, 'clearance');
  assert.equal(go({ buysPerYear: 1.5 }, { second: 'yes', occasion: 'yes' }).op, 'occasion');
  assert.equal(go({ retention90: 0.1 }, { leave: 'early' }).op, 'firstDays');
  assert.equal(go({ retention90: 0.1 }, { leave: 'random' }).op, 'quality');
  assert.equal(go({}, { missing: 'referrals' }).op, 'referrals');
  // durable goods skip retention; one channel over 70% → a second channel; else more budget while there is room
  assert.equal(go({ kind: 'durable', buysPerYear: 1.3, channelShare: 0.8 }, { manual: 'no' }).op, 'channel');
  assert.equal(go({ kind: 'durable', buysPerYear: 1.3 }, { manual: 'no' }).op, 'budget');
  assert.equal(go({}, { missing: 'none', manual: 'yes' }).op, 'hands');
});

test('every operation the walk can reach exists, with three moves and a check', () => {
  for (const [k, o] of Object.entries(OPS)) {
    assert.equal(o.moves.length, 3, k);
    assert.ok(o.name && o.stop && o.check.text && o.check.days, k);
  }
});

test('the goal is fixed at the start; the check is met when the number gets there', () => {
  const f = { ...base, completion: 0.4 };
  const g = goalFor('path', f);
  assert.deepEqual(g, { start: 0.4, goal: 0.7 });
  const started = { ...g, until: '2026-12-31' };
  assert.equal(progress('path', started, { ...f, completion: 0.5 }, '2026-12-01').met, false);
  assert.equal(progress('path', started, { ...f, completion: 0.72 }, '2026-12-01').met, true);
  assert.equal(progress('path', started, { ...f, completion: 0.5 }, '2027-01-02').overdue, true);
  assert.deepEqual(goalFor('hands', f), { start: null, goal: null }, 'the owner says when it is done');
  assert.equal(goalFor('wake', { ...base, sleeping: 400 }).goal, 380);
  assert.equal(T4.payback, 1);
});
