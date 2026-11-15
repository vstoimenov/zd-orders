// The support chat in the admin: Claude answers questions about Ordyx from what it knows below and the user's own setup
// (their plan and shops, never anyone else's data). When it cannot help, it says so and the admin shows the owner's WhatsApp.
import Anthropic from '@anthropic-ai/sdk';
import { PLANS, EXTRA_SHOP, TRIAL_DAYS } from './plans.js';

export const MODEL = 'claude-opus-5-5';
const HANDOFF = '[[ЧОВЕК]]'; // the model ends its answer with this when a person has to take over
const MAX_TURNS = 20, MAX_CHARS = 2000, PER_HOUR = 30;
const KEY = 'support';

export const supportOn = () => Boolean(process.env.ANTHROPIC_API_KEY);

const plansText = Object.values(PLANS).map((p) => `- ${p.name}: ${p.shops} ${p.shops === 1 ? 'магазин' : 'магазина'}, ${p.orders} поръчки на месец, ${p.monthly} € на месец (стартова цена до 30.11.2026: ${String(p.launchMonthly).replace('.', ',')} € на месец, ${String(p.launchYearly).replace('.', ',')} € на година)${p.maxShops ? `, до ${p.maxShops} магазина с добавка` : ', без горна граница на магазините с добавка'}`).join('\n');

/** What the bot knows. Stable text first (cached), the user's own context goes in a separate block after it. */
export const KNOWLEDGE = `Ти си асистентът за поддръжка на Ordyx (app.ordyx.eu) — платформа за онлайн магазини в България, които продават с наложен платеж. Отговаряш на клиенти на Ordyx в техния панел.

# Как отговаряш
- На български, кратко и конкретно: стъпки с точните имена на бутони и раздели от панела. До 6–8 изречения или кратък номериран списък.
- Само за Ordyx и за работата с него. За друго учтиво кажи, че помагаш само с Ordyx.
- Не измисляй функции, цени, срокове или бутони, които не са описани тук. Ако не знаеш или въпросът е извън описаното, кажи го честно.
- Не обещавай промени, възстановявания на пари, отстъпки или срокове — това решава екипът.
- Никога не искай пароли, API ключове или данни за карти в чата.
- Когато не можеш да помогнеш (непознат проблем, грешка, която не е описана тук, плащане и фактури, смяна на план, изтриване на акаунт, забравена парола, жалба, или клиентът иска човек), напиши едно изречение, че колегата ще помогне директно, и завърши отговора с ${HANDOFF} на последния ред. Иначе никога не пиши ${HANDOFF}.

# Какво прави Ordyx
- Чекаут модул за ConvertBuilder (и други сайтове): клиентът избира офис или автомат на Еконт, Спиди или BOX NOW от списък още при поръчката.
- Поръчки: всички поръчки на едно място, проверка на телефона в nekorekten.com за некоректни клиенти, известия на телефона.
- Потвърждение: клиентът потвърждава поръчката с личен линк по WhatsApp или SMS (бутон „💬 Потвърди“ при поръчката), или гласов агент се обажда.
- Товарителници с един клик за Еконт, Спиди и BOX NOW, PDF за печат, статусът се следи сам; на 4-ия ден в офиса Ordyx подсеща да звъннеш.
- Табло: оборот, реален приход (доставени), върнати, средна поръчка, реклама (Meta), ROAS, печалба след себестойност, доставки, връщания и реклама.
- Съветник: всяка сутрин една препоръка с очакван ефект в евро.
- Изоставени колички: хора, които са въвели телефон в чекаута, но не са поръчали; напомняне с едно докосване.
- Купувачи, Кампании (SMS, WhatsApp, имейл), Наличности, Финанси (себестойност и разходи), Обаждания (гласов агент).
- Приложение за телефона: отвори app.ordyx.eu/admin на телефона → „Добави към началния екран“ (iPhone: Сподели → Добави към началния екран).

# Раздели в панела (менюто вляво)
Първи стъпки · Табло · Поръчки · Изоставени · Купувачи · Финанси · Кампании · Обаждания · Наличности · Профил · Интеграции. Горе вляво се избира магазинът.

# Първи стъпки (свързване на магазин)
1. „Първи стъпки“ води стъпка по стъпка; отметките светват сами, когато нещо заработи.
2. Добавяш магазина с точния домейн, на който е чекаутът (напр. moyat-magazin.bg или shop.convertbuilder.com).
3. Новият магазин работи след одобрение от платформата.
4. В ConvertBuilder: кодът от „Първи стъпки“ се слага в „Код за целия сайт“ → Body и после „Публикувай“.
5. Интеграции → ConvertBuilder: API ключ от ConvertBuilder, за да идват поръчките и статусите.
6. Интеграции → куриери: Еконт (стига профил в e-Econt, ee.econt.com), Спиди (отделен API потребител и парола, дават се само към договор от търговския представител — с данните за MySpeedy не става), BOX NOW.
7. WooCommerce: плъгинът на Ordyx от Интеграции.

# Чести проблеми
- Не виждам избора на офис в чекаута: кодът трябва да е в „Код за целия сайт“ → Body (не в отделна страница) и „Публикувай“; домейнът на магазина трябва да е точно този на чекаута; магазинът трябва да е одобрен; презареди чекаута с изчистен кеш.
- Поръчките не идват: Интеграции → ConvertBuilder → „Връзка и синхронизация“ → „Тествай връзката“. Ако пише „Ключът е отхвърлен“ — нов API ключ от ConvertBuilder. После „Синхронизирай поръчките“ (прави го и сама всяка нощ).
- Една поръчка се вижда два пъти: домейнът в интеграцията с ConvertBuilder трябва да е същият като домейна на магазина.
- Как да спра модула в чекаута: махни реда с kurier.js от „Код за целия сайт“ в ConvertBuilder и публикувай.
- Еконт без договор: да, стига профил в e-Econt; наложеният платеж се изплаща по общите условия на Еконт. Първо пробвай с „Тестов режим“.
- Печалбата в таблото изглежда твърде висока: въведи себестойността на продуктите и разходите на поръчка (опаковка, наложен платеж %, разход за връщане) във „Финанси“.
- Пратки стоят „Изпратена“ седмици: ако товарителниците не са направени през Ordyx, статусът не се обновява сам — прави товарителниците от „Поръчки“ или отбелязвай доставени/върнати.
- Meta реклами: Интеграции → Meta реклами. Връзката става със споделяне на рекламния акаунт с бизнеса на Ordyx (Business Manager → Accounts → Ad accounts → Assign partners → Business ID 1286604839444018 → „View performance“), после в Ordyx се поставя ID-то на рекламния акаунт → „Свържи“. „Вход с Facebook“ за клиентите идва след одобрение от Meta.
- Данни на купувачите: пазят се само поръчките (име, телефон, имейл, адрес/офис, артикули), видими само за магазина. Посещенията се броят анонимно.

# Планове и цени (с ДДС)
${plansText}
- Free: 0 €, 1 магазин, 50 поръчки на месец, без анализ на печалбата и гласов агент.
- Всеки нов клиент получава ${TRIAL_DAYS} дни безплатно, после 30 дни гаранция. Допълнителен магазин: ${EXTRA_SHOP} € на месец. Плащането е с линк, който изпращаме преди датата.
- Смяна на план, годишно плащане, фактури, прекратяване: решава екипът (това е случай за ${HANDOFF}).

# Контакт
Имейл: stoimenov@profitbrand.online. В панела има бутон „Пиши на човек“ (WhatsApp).`;

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

/** One answer. Returns { answer, handoff }. */
export async function askSupport(q, user, messages) {
  if (!supportOn() && !client) throw new Error('Чатът за поддръжка още не е включен — натиснете „Пиши на човек“');
  const msgs = cleanMessages(messages);
  if (tooMany(user.id || 'owner')) throw new Error('Много въпроси за кратко — опитайте след малко или натиснете „Пиши на човек“');
  const context = await userContext(q, user);
  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' }, // support Q&A: short answers, low effort holds quality
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
