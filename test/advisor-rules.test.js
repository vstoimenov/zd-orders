import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, candidates, rank, opportunity, judge, cardFor, paybackLevel, rateWorse, missingData, resultText, MIN_ORDERS } from '../lib/advisor/rules.js';

/** A healthy shop: enough orders, Meta, costs and courier statuses; nothing fires. */
const base = (over = {}) => ({
  day: '2026-11-10', orders30: 120, revenue30: 4800, aov: 40, contribution30: 1440, marginPerOrder: 12, marginKnown: true,
  meta: true, spend30: 900, spend7: 210, revenue7: 1200, roas7: 5.71, breakEvenRoas: 3.33,
  payback: { value: 1.3, newBuyers: 60, spend: 900, margin: 1170, byDelivery: true },
  statusTracked: true, shipped30: 110, returnCost: 6,
  returns: { rate: 0.1, base: 0.1, shipped: 100, baseShipped: 300 },
  risky: { count: 0, returnRate: 0.3 }, stock: [], carts: { open: 2 }, customers: { sleeping: 100, active365: 400 },
  repeatProfile: '', ...over,
});

test('a healthy shop: no rule fires, the card is the biggest +10% chance', () => {
  assert.deepEqual(candidates(base()), []);
  const o = opportunity(base());
  assert.equal(o.kind, 'chance');
  assert.equal(o.rule, 'chance_aov'); // 4800 × 10% × 30% = 144 € — the same as 120 × 10% × 12 €: the first listed wins
  assert.equal(o.euros, 144);
});

test('payback levels: 0,9 / 1,1 / 1,6', () => {
  assert.equal(paybackLevel(0.85).key, 'loses');
  assert.equal(paybackLevel(0.95).key, 'edge');
  assert.equal(paybackLevel(1.2).key, 'pays');
  assert.equal(paybackLevel(1.7).key, 'scale');
  assert.equal(paybackLevel(null), null);
});

test('ads losing money: first always, its cost is what the new buyers did not pay back', () => {
  const m = base({ payback: { value: 0.6, newBuyers: 50, spend: 1000, margin: 600 }, returns: { rate: 0.3, base: 0.1, shipped: 100, baseShipped: 300 } });
  const list = rank(candidates(m));
  assert.equal(list[0].rule, 'ads_loss');
  assert.equal(list[0].euros, 400);
  assert.match(list[0].problem, /20 €.*12 €.*0,60/);
  assert.equal(list[1].rule, 'returns_up');
});

test('ROAS under break-even with at least 20 € spent in 7 days', () => {
  const m = base({ roas7: 2, revenue7: 420, spend7: 210 }); // 420 / 3.33 = 126 € margin for 210 € spent
  const c = candidates(m).find((x) => x.rule === 'roas_below');
  assert.ok(c);
  assert.ok(Math.abs(c.euros - (210 - 420 / 3.33) * 30 / 7) < 0.01);
  assert.equal(candidates({ ...m, spend7: 10 }).find((x) => x.rule === 'roas_below'), undefined);
  assert.equal(candidates({ ...m, meta: false }).find((x) => x.rule === 'roas_below'), undefined, 'unknown is not zero');
});

test('returns: 20% relative and 2 points worse, enough parcels, couriers connected', () => {
  assert.equal(rateWorse(0.13, 0.1), true);
  assert.equal(rateWorse(0.115, 0.1), false, 'under 2 points');
  assert.equal(rateWorse(0.33, 0.3), false, '3 points but only 10% relative');
  const m = base({ returns: { rate: 0.18, base: 0.11, shipped: 80, baseShipped: 250 } });
  const c = candidates(m).find((x) => x.rule === 'returns_up');
  assert.ok(c);
  assert.equal(c.euros, Math.round((0.18 - 0.11) * 110 * 6 * 100) / 100);
  assert.equal(candidates({ ...m, statusTracked: false }).find((x) => x.rule === 'returns_up'), undefined);
  assert.equal(candidates({ ...m, returns: { ...m.returns, shipped: 12 } }).find((x) => x.rule === 'returns_up'), undefined);
});

test('few orders: only the money rules speak', () => {
  const m = base({ orders30: MIN_ORDERS - 1, payback: { value: 0.5, newBuyers: 10, spend: 200, margin: 100 }, carts: { open: 40 } });
  assert.deepEqual(candidates(m).map((c) => c.rule), ['ads_loss']);
  assert.equal(opportunity(m), null);
});

test('stock running out of a top product; sleeping customers only when they come back at all', () => {
  const m = base({ stock: [{ name: 'Крем', stock: 6, daysLeft: 3, revenueShare: 0.4, marginPerDay: 20 }], customers: { sleeping: 250, active365: 400 } });
  const list = candidates(m);
  const s = list.find((c) => c.rule === 'stock_out');
  assert.equal(s.subject, 'Крем');
  assert.equal(s.euros, 220);
  assert.match(s.problem, /свършва след около 3 дни/);
  assert.ok(list.find((c) => c.rule === 'sleeping'));
  assert.equal(candidates({ ...m, repeatProfile: 'rarely' }).find((c) => c.rule === 'sleeping'), undefined);
});

test('rules being checked or dismissed are skipped; within 10% of euros the earlier step wins', () => {
  const m = base({ returns: { rate: 0.2, base: 0.1, shipped: 100, baseShipped: 300 }, carts: { open: 60 } });
  assert.equal(candidates(m, new Set(['returns_up'])).find((c) => c.rule === 'returns_up'), undefined);
  const list = rank([{ rule: 'b', step: 4, euros: 100 }, { rule: 'a', step: 2, euros: 95 }, { rule: 'c', step: 3, euros: 300 }]);
  assert.deepEqual(list.map((c) => c.rule), ['c', 'a', 'b']);
});

test('the card: numbers frozen, check date, euros a month', () => {
  const c = candidates(base({ returns: { rate: 0.18, base: 0.11, shipped: 80, baseShipped: 250 } }))[0];
  const card = cardFor(c, '2026-11-10');
  assert.equal(card.checkUntil, '2026-12-10');
  assert.match(card.texts.check, /10\.12\.2026/);
  assert.match(card.texts.cost, /около 46 € на месец/);
  assert.equal(card.texts.action.view, 'orders');
});

test('judge: success, partial, none — with the euros it brought', () => {
  const card = { rule: 'returns_up', valueAtStart: 0.18, target: 0.11 };
  const ok = judge(card, base({ returns: { rate: 0.1, base: 0.12, shipped: 90, baseShipped: 300 } }));
  assert.equal(ok.result, 'success');
  assert.equal(ok.euros, Math.round((0.18 - 0.1) * 110 * 6 * 100) / 100);
  assert.match(resultText(card, ok), /Стана: от 18% на 10% — около 53 € на месец/);
  assert.equal(judge(card, base({ returns: { rate: 0.15, base: 0.12, shipped: 90, baseShipped: 300 } })).result, 'partial');
  const none = judge(card, base({ returns: { rate: 0.2, base: 0.12, shipped: 90, baseShipped: 300 } }));
  assert.equal(none.result, 'none');
  assert.equal(none.euros, 0);
  assert.equal(judge(card, base({ returns: null })).result, 'none', 'no data on the day: not a success');
  assert.equal(judge({ rule: 'ads_loss', valueAtStart: 0.6, target: 1 }, base({ payback: { value: 1.05 } })).result, 'success');
});

test('missing data is named, never counted as zero', () => {
  assert.deepEqual(missingData(base()), []);
  assert.deepEqual(missingData(base({ meta: false, marginKnown: false, statusTracked: false })).map((x) => x.key), ['meta', 'costs', 'statuses']);
  for (const r of Object.values(RULES)) assert.ok(['step', 'metric', 'test', 'gain'].every((k) => k in r));
});

/* ---- stage 2 ---- */
test('refusals at confirmation: over 20% with no history, or worse than the shop’s own base', () => {
  const m = base({ refusals: { rate: 0.25, base: null, answered: 40, refused: 10 } });
  const c = candidates(m).find((x) => x.rule === 'refusals_up');
  assert.equal(c.euros, Math.round((0.25 - 0.1) * 40 * 12 * 100) / 100);
  assert.match(c.problem, /25% от клиентите отказват/);
  assert.equal(candidates(base({ refusals: { rate: 0.17, base: 0.15, answered: 40 } })).find((x) => x.rule === 'refusals_up'), undefined);
  assert.ok(candidates(base({ refusals: { rate: 0.2, base: 0.1, answered: 40 } })).find((x) => x.rule === 'refusals_up'));
});

test('slow shipping only when it is slower than usual and slow parcels do come back more', () => {
  const ship = { median: 52, base: 20, n: 40, baseN: 90, slow30: 25, slowReturnRate: 0.2, fastReturnRate: 0.1 };
  const c = candidates(base({ ship })).find((x) => x.rule === 'ship_slow');
  assert.equal(c.euros, Math.round(0.1 * 25 * 6 * 100) / 100);
  assert.match(c.problem, /52 ч\..*20 ч\./);
  assert.equal(candidates(base({ ship: { ...ship, slowReturnRate: 0.08 } })).find((x) => x.rule === 'ship_slow'), undefined, 'no proof it costs');
  assert.equal(candidates(base({ ship: { ...ship, median: 28 } })).find((x) => x.rule === 'ship_slow'), undefined, 'under 12 hours slower');
  const j = judge({ rule: 'ship_slow', valueAtStart: 52, target: 20, euros: 15 }, base({ ship: { ...ship, median: 36 } }));
  assert.equal(j.result, 'partial');
  assert.equal(j.euros, 7.5, 'half the way back: half the euros');
});

test('a new buyer got dearer while the site sells as before; conversion down while visits hold', () => {
  const m = base({ newBuyers: { n30: 40, cac: 18, cacBase: 12 }, conversion: { rate: 0.02, base: 0.021, visits30: 3000, visitsPerDay: 100, baseVisitsPerDay: 95 } });
  const c = candidates(m).find((x) => x.rule === 'cac_up');
  assert.equal(c.euros, 240);
  assert.equal(candidates({ ...m, conversion: { ...m.conversion, rate: 0.012 } }).find((x) => x.rule === 'cac_up'), undefined, 'the site is the problem then');
  const conv = candidates({ ...m, conversion: { rate: 0.012, base: 0.02, visits30: 3000, visitsPerDay: 100, baseVisitsPerDay: 95 } }).find((x) => x.rule === 'conversion_down');
  assert.equal(conv.euros, Math.round(0.008 * 3000 * 12 * 100) / 100);
  assert.equal(candidates({ ...m, conversion: { rate: 0.012, base: 0.02, visits30: 3000, visitsPerDay: 60, baseVisitsPerDay: 95 } }).find((x) => x.rule === 'conversion_down'), undefined, 'fewer visits, not a weaker site');
});

test('second orders within 60 days dropped (not for shops whose buyers come back rarely); time to scale', () => {
  const m = base({ repeat60: { rate: 0.1, base: 0.18, n: 60, baseN: 150 }, newBuyers: { n30: 50 } });
  const r = candidates(m).find((x) => x.rule === 'repeat_down');
  assert.equal(r.euros, Math.round(0.08 * 50 * 12 * 100) / 100);
  assert.equal(r.days, 60);
  assert.equal(candidates({ ...m, repeatProfile: 'rarely' }).find((x) => x.rule === 'repeat_down'), undefined);
  const up = base({ payback: { value: 1.9, newBuyers: 40, spend: 900, margin: 1710 }, paybackMonthAgo: 1.7 });
  const s = candidates(up).find((x) => x.rule === 'scale_up');
  assert.equal(s.euros, Math.round(0.2 * 900 * 0.9 * 100) / 100);
  assert.match(cardFor(s, '2026-11-10').texts.cost, /^Можеш да спечелиш още около/);
  assert.equal(candidates({ ...up, paybackMonthAgo: 1.2 }).find((x) => x.rule === 'scale_up'), undefined, 'one good month is not enough');
});

test('no product costs: growth cards still speak, on an estimated 30% margin they name', () => {
  const m = base({ marginPerOrder: null, marginKnown: false, aov: 40, carts: { open: 20 } });
  const c = candidates(m).find((x) => x.rule === 'carts_open');
  assert.equal(c.euros, 20 * 0.1 * 12);
  assert.match(cardFor(c, '2026-11-10').texts.cost, /30% марж/);
});
