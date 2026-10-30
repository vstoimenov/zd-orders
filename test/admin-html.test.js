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

test('admin forms shrink to a phone: form grid columns may go below an input\'s built-in width (inputs ran off the „Нова поръчка“ dialog)', () => {
  assert.match(html, /\.fgrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.fgrid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(html, /\.fgrid input,\.fgrid select\{[^}]*min-width:0/);
});

test('a waybill for a courier that is not connected says so at the top and hides the empty form (on a phone the note was below the fold)', () => {
  const branch = html.slice(html.indexOf('if (!d.connected) {'), html.indexOf('if (!d.connected) {') + 600);
  assert.match(branch, /\$\('wbFields'\)\.hidden = true/);
  assert.match(branch, /\$\('wbRoute'\)\.innerHTML = [^;]*не е свързан/);
});

test('the Meta card shows „Скоро“ and cannot be opened while the server says meta.open is false', () => {
  assert.match(html, /\$\('iMetaOpen'\)\.textContent = m\.open === false && !m\.configured \? 'Скоро'/);
  assert.match(html, /\$\('iMetaOpen'\)\.disabled = m\.open === false && !m\.configured/, 'a shop already connected keeps its settings (disconnect = data deletion)');
});

test('„Клиенти“ names the client\'s own shops and offers „Откажи“ next to „Одобри“', () => {
  assert.match(html, /\(u\.shops \|\| \[\]\)\.filter\(function \(sh\) \{ return sh\.approved; \}\)/);
  assert.match(html, /data-reject="/);
  assert.match(html, /action: 'reject_shop'/);
});

test('small first-run fixes: the home-screen icon is „Ordyx“; a 429 at login shows its reason; a remembered „all shops“ is dropped when there is no shop; a new shop from the guide stays in the guide', () => {
  assert.doesNotMatch(html, /иконка „Поръчки“/);
  assert.match(html, /r\.status === 429/);
  assert.match(html, /if \(currentShop === 'all' && !shops\.length\) currentShop = ''/);
  assert.match(html, /location\.hash = fromGuide \? '#start' : '#integrations'/);
});

test('the login screen tells a client who forgot the password whom to write to (the address of the legal pages)', () => {
  const login = html.slice(html.indexOf('<form id="login"'), html.indexOf('</form>', html.indexOf('<form id="login"')));
  assert.match(login, /Забравена парола\?/);
  assert.match(login, /mailto:stoimenov@profitbrand\.online/);
  assert.match(html, /Пишете на <a href="mailto:stoimenov@profitbrand\.online/);
});

test('the orders drawn before the role was known are drawn again once it is: the owner got no „📞 Потвърди“ until a refresh', () => {
  const boot = html.slice(html.indexOf('.then(loadMe).then(function () {'), html.indexOf('.then(loadMe).then(function () {') + 400);
  assert.match(boot, /\.then\(loadMe\)\.then\(function \(\) \{[\s\S]*?render\(\);/);
});

test('on a phone the courier country picker wraps under the heading instead of widening the page (Интеграции and its dialogs ran off the screen)', () => {
  assert.match(html, /\.isec-head\{display:flex;[^}]*flex-wrap:wrap/);
  assert.match(html, /@media \(max-width:600px\)\{[^}]*\.icountry\{margin-left:0;flex:1 1 100%\}/);
});

test('the registration form names the terms and the privacy policy it accepts (the link goes out publicly)', () => {
  const form = html.slice(html.indexOf('<form id="signupForm"'), html.indexOf('<form id="inviteForm"'));
  assert.match(form, /С регистрацията приемате <a href="https:\/\/ordyx\.eu\/terms"[^>]*>Общите условия<\/a> и <a href="https:\/\/ordyx\.eu\/privacy"[^>]*>Политиката за поверителност<\/a>/);
});
