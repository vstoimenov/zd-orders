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

test('after „Запази и свържи“ the dialog shows the site code to copy and where to put it (whole-site Body)', () => {
  assert.match(html, /id="iCbNext" hidden/);
  assert.match(html, /id="iCbCopy"/);
  const after = html.slice(html.indexOf("action: 'save_convertbuilder'"));
  assert.match(after.slice(0, 1500), /\$\('iCbNext'\)\.hidden = false/);
  assert.match(html.slice(html.indexOf('id="iCbNext"'), html.indexOf('id="iCbNext"') + 1200), /Код за целия сайт[\s\S]*Body/);
});
