import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(readFileSync(new URL('../public/admin/roas.js', import.meta.url), 'utf8'), { window });
const { breakEven } = window.zdRoas;
const r2 = (v) => (v == null ? v : Math.round(v * 100) / 100);

test('break-even ROAS and CPA from the per-order numbers', () => {
  const x = breakEven({ aov: 30, productCost: 6, shipping: 3.5, codPct: 2, returnPct: 10, returnCost: 4, targetMarginPct: 10 });
  // kept 90 %: revenue 27 − product 5.40 − shipping 3.50 − COD 0.54 − returns 0.40 = 17.16 per order before ads
  assert.equal(r2(x.profit), 17.16);
  assert.equal(r2(x.beRoas), 1.75, 'ROAS counts the order value, like Meta: 30 / 17.16');
  assert.equal(r2(x.beCpa), 17.16);
  assert.equal(r2(x.targetCpa), 14.16, 'leave 10 % of 30 € as profit');
  assert.equal(r2(x.targetRoas), 2.12);
});

test('no profit before ads means no ROAS can break even', () => {
  const x = breakEven({ aov: 10, productCost: 9, shipping: 3 });
  assert.ok(x.profit < 0);
  assert.equal(x.beRoas, null);
  assert.equal(x.targetRoas, null);
});

test('empty or odd inputs are treated as 0, returns are capped below 100 %', () => {
  const x = breakEven({ aov: '25', productCost: '', shipping: undefined, returnPct: 250 });
  assert.ok(Number.isFinite(x.profit));
  assert.ok(x.profit > 0);
});
