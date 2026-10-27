import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// One stray quote in the admin's inline script left the whole admin blank (27.10): the HTML tests only matched text, nothing
// compiled the code. Every inline script and shared script on the served pages must at least parse.
const PAGES = ['admin/index.html', 'landing/index.html', 'landing/oferta.html', 'confirm/index.html'];
const SHARED = ['couriers-eu.js', 'checkout.js', 'admin/roas.js'];
const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

for (const page of PAGES) {
  test(`every inline script on ${page} parses`, () => {
    const scripts = [...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, 'precondition: the page has inline code');
    scripts.forEach((src, i) => assert.doesNotThrow(() => new vm.Script(src, { filename: `${page}#${i}` }), `${page} script ${i}`));
  });
}

test('the shared scripts parse', () => {
  for (const f of SHARED) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
});
