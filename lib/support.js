// The support chat in the admin: Claude answers questions about Ordyx from what it knows below and the user's own setup
// (their plan and shops, never anyone else's data). When it cannot help, it says so and the admin shows the owner's WhatsApp.
import Anthropic from '@anthropic-ai/sdk';
import { PLANS } from './plans.js';
import { KNOWLEDGE, HANDOFF } from './support-knowledge.js';

export { KNOWLEDGE };

export const MODEL = 'claude-opus-5-5';
const MAX_TURNS = 20, MAX_CHARS = 2000, PER_HOUR = 30;
const KEY = 'support';

export const supportOn = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** The user's own setup, for answers about „my shop“: name, plan, shops and what is connected. */
async function userContext(q, user) {
  if (user.owner && !user.id) return 'Пише собственикът на платформата.';
  const shops = user.owner ? [] : await q(`select s.id, s.name, s.domain, s.approved,
      coalesce((select string_agg(i.provider, ', ' order by i.provider) from zd.integrations i where i.shop_id = s.id), '') as connected
    from zd.shops s where s.id = any($1::uuid[]) order by s.created_at`, [user.shopIds || []]);
  const [u] = user.id ? await q(`select sub_plan, sub_wants_free from zd.users where id = $1::uuid`, [user.id]) : [];
  const plan = u?.sub_wants_free ? 'Free' : u?.sub_plan ? PLANS[u.sub_plan]?.name || u.sub_plan : 'няма избран план';
  const list = shops.length ? shops.map((s) => `- ${s.name || s.domain} (${s.domain || 'без домейн'}): ${s.approved ? 'одобрен' : 'чака одобрение'}; свързани: ${s.connected || 'нищо още'}`).join('\n') : '- още няма магазини';
  return `Клиентът: ${user.name || 'без име'}. План: ${plan}.\nМагазини:\n${list}`;
}

/** The conversation as the browser sends it, checked: user/assistant turns, starting and ending with the user, short. */
export function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Напишете въпрос');
  const msgs = list.slice(-MAX_TURNS).map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '').trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.content);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('Напишете въпрос');
  return msgs;
}

const recent = new Map(); // user → times of the last questions (per server instance)
function tooMany(id, now = Date.now()) {
  const t = (recent.get(id) || []).filter((x) => now - x < 3600e3);
  recent.set(id, t);
  if (t.length >= PER_HOUR) return true;
  t.push(now);
  return false;
}

let client = null;
const getClient = () => (client ||= new Anthropic());
/** For tests: a stand-in for the Anthropic client. */
export function setClientForTests(c) { client = c; recent.clear(); }

const VIEWS = { start: 'Първи стъпки', dash: 'Табло', orders: 'Поръчки', abandoned: 'Изоставени', buyers: 'Купувачи', costs: 'Финанси', campaigns: 'Кампании',
  calls: 'Обаждания', inventory: 'Наличности', profile: 'Профил', integrations: 'Интеграции', clients: 'Клиенти' };

/** One answer. Returns { answer, handoff }. `view` = the admin screen the user is on. */
export async function askSupport(q, user, messages, { view = '' } = {}) {
  if (!supportOn() && !client) throw new Error('Чатът за поддръжка още не е включен — натиснете „Пиши на човек“');
  const msgs = cleanMessages(messages);
  if (tooMany(user.id || 'owner')) throw new Error('Много въпроси за кратко — опитайте след малко или натиснете „Пиши на човек“');
  const screen = VIEWS[String(view)] || '';
  const context = `${await userContext(q, user)}${screen ? `\nВ момента е на екран: ${screen}.` : ''}`;
  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' }, // support answers must be right: low effort gave generic replies
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // a declined request is retried on a fallback model in the same call
      system: [
        { type: 'text', text: KNOWLEDGE, cache_control: { type: 'ephemeral' } }, // stable: cached across every chat
        { type: 'text', text: `# Този клиент\n${context}` },
      ],
      messages: msgs,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      console.error('[support] Claude unavailable', err.status || '', err.message);
      return { answer: 'Чатът е претоварен в момента. Опитайте след минута или пишете директно на колегата.', handoff: true };
    }
    console.error('[support] Claude failed', err.status || '', err.message);
    throw new Error('Чатът не успя да отговори — натиснете „Пиши на човек“');
  }
  if (res.stop_reason === 'refusal') return { answer: 'По този въпрос ще ви помогне колегата директно.', handoff: true };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const handoff = text.includes(HANDOFF);
  const answer = text.split(HANDOFF).join('').trim() || 'По този въпрос ще ви помогне колегата директно.';
  return { answer, handoff: handoff || !text };
}

/* ---- the owner's WhatsApp number for „Пиши на човек“ ---- */
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
export async function supportSettings(q) {
  const [r] = await q(`select value from zd.settings where key = $1`, [KEY]);
  return { whatsapp: r ? json(r.value).whatsapp || '' : '' };
}
export async function saveSupportSettings(q, { whatsapp }) {
  const digits = String(whatsapp ?? '').replace(/[^\d+]/g, '');
  const norm = digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : digits.startsWith('0') ? `+359${digits.slice(1)}` : digits ? `+${digits}` : '';
  if (norm && !/^\+\d{8,15}$/.test(norm)) throw new Error('Невалиден телефон за WhatsApp (напр. 0888 123 456 или +359888123456)');
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [KEY, JSON.stringify({ whatsapp: norm })]);
  return { whatsapp: norm };
}
