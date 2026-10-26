import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');

test('the ConvertBuilder tabs are wired to their own switcher, not the first .seg on the page (the „Изоставени“ tabs)', () => {
  assert.ok(html.indexOf('id="abTabs"') < html.indexOf('data-tab="sync"'), 'precondition: another .seg comes first');
  assert.doesNotMatch(html, /document\.querySelector\('\.seg'\)/);
  assert.doesNotMatch(html, /querySelectorAll\('\.seg button'\)/);
  assert.match(html, /<div class="seg" id="cbTabs">/);
});
