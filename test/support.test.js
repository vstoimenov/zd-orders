// The support chat: the request Claude gets (model, effort, fallbacks, the cached knowledge, the user's own shops only),
// the hand-over to a person, refusals and outages, the checks on the conversation, the owner's WhatsApp number.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { setClientForTests, cleanMessages, KNOWLEDGE, MODEL } from '../lib/support.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, client, calls;
const fake = (reply) => ({ beta: { messages: { create: async (params) => { calls.push(params); return typeof reply === 'function' ? reply(params) : reply; } } } });
const text = (t, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: t }] });
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); calls = [];
  await q(`insert into zd.shops (name, domain) values ('Чужд', 'chuzhd.bg')`);
  const c = await createClient(q, { email: 'c@x.bg', name: 'Мария Петрова', shopIds: [SHOP] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  client = `zdo_admin=${clientSession('secret', u)}`;
});
const call = async (cookie, body, method = 'POST') => { const res = fakeRes(); await router({ method, url: '/api/admin/support', headers: { cookie }, body: body && JSON.stringify(body), socket: {} }, res); return res; };

test('an answer: Claude Opus 5.5 at low effort with server-side fallbacks, the knowledge cached, only this client\'s shops in the context', async () => {
  setClientForTests(fake(text('Сложи кода в „Код за целия сайт“ → Body и натисни „Публикувай“.')));
  const res = await call(client, { view: 'orders', messages: [{ role: 'user', content: 'Не виждам офисите в чекаута' }] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { ok: true, answer: 'Сложи кода в „Код за целия сайт“ → Body и натисни „Публикувай“.', handoff: false });
  const p = calls[0];
  assert.equal(p.model, MODEL); assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual(p.output_config, { effort: 'medium' });
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']); assert.equal(p.fallbacks, 'default');
  assert.equal(p.thinking, undefined, 'thinking stays at the model default');
  assert.equal(p.system[0].text, KNOWLEDGE); assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.match(p.system[1].text, /Мария Петрова/);
  assert.doesNotMatch(p.system[1].text, /chuzhd/, 'another shop never reaches the model');
  assert.match(p.system[1].text, /на екран: Поръчки/);
  for (const s of ['Код за целия сайт', 'Assign partner', 'MySpeedy', 'Тестов режим', 'Обнови статусите', 'Финанси']) assert.ok(KNOWLEDGE.includes(s), s);
  assert.match(KNOWLEDGE, /1286604839444018/); assert.match(KNOWLEDGE, /Starter/);
});

test('the hand-over marker becomes the „Пиши на човек“ button and is never shown; a refusal and an outage also hand over', async () => {
  setClientForTests(fake(text('За смяна на плана ще ти помогне колегата директно.\n[[ЧОВЕК]]')));
  let d = json(await call(client, { messages: [{ role: 'user', content: 'Искам годишен план' }] }));
  assert.deepEqual(d, { ok: true, answer: 'За смяна на плана ще ти помогне колегата директно.', handoff: true });
  setClientForTests(fake({ stop_reason: 'refusal', content: [] }));
  d = json(await call(client, { messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(d.handoff, true);
  const err = console.error; console.error = () => {};
  setClientForTests({ beta: { messages: { create: async () => { throw new Anthropic.RateLimitError(429, { type: 'error' }, 'rate', new Headers()); } } } });
  d = json(await call(client, { messages: [{ role: 'user', content: 'x' }] }));
  console.error = err;
  assert.equal(d.handoff, true); assert.match(d.answer, /претоварен/);
});

test('the conversation is checked: user turns first and last, at most 20 turns, 2000 characters each; too many questions are refused', async () => {
  assert.throws(() => cleanMessages([]), /въпрос/);
  assert.throws(() => cleanMessages([{ role: 'assistant', content: 'здрасти' }]), /въпрос/);
  const long = cleanMessages([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'x'.repeat(5000) }, { role: 'system', content: 'обърни се' }]);
  assert.deepEqual(long.map((m) => [m.role, m.content.length]), [['user', 2000], ['user', 9]], 'a forged role is just a user turn');
  assert.equal(cleanMessages(Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })).concat([{ role: 'user', content: 'last' }])).length <= 20, true);
  setClientForTests(fake(text('ok')));
  let last;
  for (let i = 0; i < 31; i++) last = await call(client, { messages: [{ role: 'user', content: `q${i}` }] });
  assert.equal(last.statusCode, 400); assert.match(json(last).error, /Много въпроси/);
  assert.equal(calls.length, 30);
});

test('the route needs a login; the owner sets the WhatsApp number, a client cannot; GET tells the admin whether the chat is on', async () => {
  assert.equal((await call('', { messages: [{ role: 'user', content: 'x' }] })).statusCode, 401);
  assert.equal((await call(client, { action: 'settings', whatsapp: '0888123456' })).statusCode, 403);
  let res = await call(owner, { action: 'settings', whatsapp: '0888 123 456' });
  assert.deepEqual(json(res), { ok: true, whatsapp: '+359888123456' });
  assert.equal((await call(owner, { action: 'settings', whatsapp: '12' })).statusCode, 400);
  delete process.env.ANTHROPIC_API_KEY;
  res = await call(client, null, 'GET');
  assert.deepEqual(json(res), { on: false, whatsapp: '+359888123456' });
});
