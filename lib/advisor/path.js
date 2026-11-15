// Пътят на растежа: from a shop's numbers (and a few answers of its owner) to the one operation it works on now.
// The logic follows the four growth axes (new buyers × money per purchase × repeat purchases × how long they stay, on the base
// of time, people and capacity) — docs/superpowers/specs/2026-11-14-growth-path-design.md. Pure functions: facts come from
// path-repo.js. Every shop in Ordyx sells physical goods; the only type question is consumables or durable goods.

/** Thresholds for physical goods. */
export const T4 = Object.freeze({
  payback: 1.0, // margin of new buyers in 30 days ÷ ad spend for them
  conversion: 0.015, // visit → order
  completion: 0.55, // started checkout → order
  buysConsumable: 3, buysDurable: 1.2, // purchases per buyer a year
  retention90: 0.2, // consumables: share of new buyers who buy again within 90 days
  stairs: 1.3, // money per buyer after the extra offers
  silent: 200, // buyers silent for 90+ days worth waking
  channel: 0.7, // one channel's share of orders
  blocked: 300, // € of stock unsold for 60 days
});
export const ANSWER_DAYS = 90; // an owner's answer is asked again after this long

const pct = (v) => `${Math.round(v * 1000) / 10}%`.replace('.', ',');
const num = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
const eur = (v) => `${Math.round(v).toLocaleString('bg-BG')} €`;

/**
 * The operations. axis: what part of the business it grows · stop: the one sentence that says what holds the shop · when · how ·
 * moves: the first three · check: { metric, dir ('up'|'down'), goal (start value → goal), days, text } (metric null = the owner says).
 */
export const OPS = {
  hands: {
    name: 'Свободни ръце', axis: 'Основа', stop: 'Всичко минава през теб.',
    when: 'Над половината ти седмица отива в ръчна работа: опаковане, обаждания, отговори.',
    how: 'Мериш къде отиват часовете и махаш, автоматизираш или предаваш всичко, което не изисква точно теб.',
    moves: ['Една седмица записвай на всеки половин час какво правиш — веднага, не вечерта по памет.',
      'До всеки ред отбележи: изисква ли точно теб и повтаря ли се.',
      'Спри ненужното. За първото, което може да се предаде, запиши стъпките, докато го правиш. В Ordyx: автоматично потвърждение, товарителници с един клик, склад за изпълнение.'],
    check: { metric: null, days: 60, text: 'Часовете ти в ръчна работа падат с поне една трета и не се връщат два месеца' },
  },
  batch: {
    name: 'Поточна линия', axis: 'Основа', stop: 'Пълен си — повече поръчки просто не можеш да изпратиш.',
    when: 'Капацитетът за изпращане е таванът.', how: 'Изпращането става на партиди или отива при склад за изпълнение.',
    moves: ['Раздели изпращането на стъпки и запиши колко време отнема всяка и дали изисква теб.',
      'Реши кое става на партиди (напр. опаковане веднъж на ден) и кое отива при склад (Ordyx → Интеграции → склад).',
      'Пусни първата партида и сравни връщанията с досегашните.'],
    check: { metric: 'orders30', dir: 'up', goal: (s) => s * 2, days: 90, text: 'Двойно повече поръчки със същите часове' },
  },
  team: {
    name: 'Екип', axis: 'Основа', stop: 'Само още хора или второ място ще те разширят.',
    when: 'Процесът е писан, но един човек не стига.', how: 'Обучаваш човек, който изпълнява по твоя писан стандарт.',
    moves: ['Опиши човека, когото търсиш, и какво точно поема по стандарта.', 'Изпитай кандидатите със задача, не с въпроси, и вземи този, който следва процеса.',
      'Първата седмица гледа и учи, а ти изпращаш и обясняваш решенията си на глас.'],
    check: { metric: 'returnsRate', dir: 'down', goal: (s) => s * 1.15, days: 60, text: 'Връщанията не растат с над 15%, докато новият човек изпраща' },
  },
  voice: {
    name: 'Свой глас', axis: 'Нови купувачи', stop: 'Клиентите не могат да те различат от другите.',
    when: 'Купувачът не може с едно изречение да каже защо ти, а не друг.',
    how: 'Градиш това, което не се копира: свой начин, свои думи, ясен противник и доказателство.',
    moves: ['Попитай петима клиенти: „С едно изречение — защо купихте от нас, а не от друг?“',
      'Запиши отговорите дума по дума и преброй колко си приличат.',
      'Маркирай на сайта всяко изречение, което и конкурент би могъл да напише, и го смени.'],
    check: { metric: 'conversion', dir: 'up', goal: (s) => s * 1.2, days: 60, text: 'Конверсията на сайта +20%' },
  },
  promise: {
    name: 'Ново обещание', axis: 'Нови купувачи', stop: 'Разбират офертата, но тя не отговаря на нуждата им.',
    when: 'Подходящи хора идват, разбират и пак не купуват.', how: 'Питаш защо избират и защо отказват и преработваш обещанието и офертата.',
    moves: ['Уговори 20 кратки разговора — 10 с купили и 10 с отказали (Ordyx пази отказалите при потвърждение).',
      'Питай защо са избрали или отказали — не дали им харесва.', 'Фразите, които се повтарят поне при петима, стават новото обещание.'],
    check: { metric: 'conversion', dir: 'up', goal: (s) => s * 1.3, days: 60, text: 'Конверсията +30%, без спад в средната поръчка' },
  },
  path: {
    name: 'Чиста пътека', axis: 'Нови купувачи', stop: 'Влизат и си тръгват, преди да поръчат.',
    when: 'Хората стигат до продукта или чекаута и нещо по пътя ги спира.', how: 'Мериш всяка стъпка до поръчката, гледаш хората и махаш една доказана пречка.',
    moves: ['Запиши колко души минават през всяка стъпка: посещение → започнат чекаут → поръчка (Ordyx: изоставени колички).',
      'Намери стъпката с най-голяма загуба и я сравни с миналия месец.',
      'Изгледай 20 записа на хора, които не са купили (напр. безплатният Microsoft Clarity), и запиши какво ги спира.'],
    check: { metric: 'completion', dir: 'up', goal: (s) => Math.max(s * 1.2, 0.7), days: 45, text: 'Повече завършени поръчки от започнатите и страница, която се отваря на телефон под 2,5 секунди' },
  },
  patience: {
    name: 'Търпеливи напомняния', axis: 'Нови купувачи', stop: 'Подходящи са, но не са готови сега.',
    when: 'Много започнати поръчки и въпроси, които не стават покупка.', how: 'Поредица съобщения, всяко от които отговаря на едно реално възражение.',
    moves: ['Запиши дума по дума 20-те най-чести възражения на хората, които питат и не купуват.',
      'Напиши историята на един клиент: какво беше преди, какво стана и какво разбра.',
      'Срещу всяко възражение — по едно съобщение; разпредели ги в 6 седмици към всички, които не са купили (Ordyx: изоставени колички и кампании).'],
    check: { metric: null, days: 45, text: 'Над 25% отварят съобщенията, под 2% се отписват и поне 5% купуват до 30-ия ден' },
  },
  demo: {
    name: 'Демонстрация на живо', axis: 'Нови купувачи', stop: 'Разбират те, но не вярват, че при тях ще стане.',
    when: 'Продуктът иска обяснение, което страница не носи (над 100 €).', how: 'Едно живо събитие води група хора до едно решение.',
    moves: ['Определи дата, час и минутата, в която ще кажеш офертата.', 'Направи страница за записване и напомняния ден преди и час преди.',
      'Подреди показването: не е по тяхна вина · голямата идея · счупено е едно нещо · има ясен път · следващата стъпка е офертата.'],
    check: { metric: null, days: 30, text: 'Поне 10% от останалите до офертата купуват' },
  },
  window: {
    name: 'Отворен прозорец', axis: 'Нови купувачи', stop: 'Имаш списък с клиенти, но той купува на капки.',
    when: 'Имаш работеща оферта и списък, но продаваш равномерно и никога не създаваш момент.',
    how: 'Кампания с дата на отваряне и дата на затваряне.',
    moves: ['Избери дати за отваряне и затваряне и продукта, чиято врата се отваря.', 'Реши какво изчезва в края — бонус, цена или самата оферта.',
      'Прати на целия списък 6 съобщения: 2 дни преди · при отварянето · ден 1 нещо полезно · ден 2 „утре затваряме“ · ден 3 три пъти · след затварянето (Ordyx → Кампании).'],
    check: { metric: 'revenue7', dir: 'up', goal: (s) => s * 2, days: 30, text: 'Приходът в седмицата на прозореца поне двойно над обичайния' },
  },
  freshAds: {
    name: 'Свежи реклами', axis: 'Нови купувачи', stop: 'Рекламите ти са едни и същи от месеци.',
    when: 'Цената на нов купувач расте, а рекламите не се сменят.', how: 'Тестваш различни ползи, ъгли и формати и поддържаш поток от нови реклами.',
    moves: ['Изпиши рекламите, които вървят днес, и до всяка — каква полза обещава.',
      'Виж кой от четирите ъгъла липсва: проблемът, твоят начин, резултатът или провокация срещу нещо, в което пазарът вярва.',
      'За всеки липсващ направи видео, статична реклама и разговорна от клиент — и пускай нови всяка седмица.'],
    check: { metric: 'cac', dir: 'down', goal: (s) => s, days: 30, text: 'Нови реклами всяка седмица, нито една над 40% от разхода, а цената на купувач не скача с над 20%' },
  },
  channel: {
    name: 'Втори канал', axis: 'Нови купувачи', stop: 'Каналът, от който идват купувачите, е изчерпан.',
    when: 'Почти всички поръчки идват от един канал и той спря да расте.', how: 'Тест на нов канал с фиксиран бюджет и предварително записано правило за успех.',
    moves: ['Избери новия канал там, където хората ти вече са — най-близо до сегашния.',
      'Преди да започнеш, запиши бюджета, датата на решение и числото, при което казваш „да“.', 'Пусни и не пипай 3 дни; после махни само очевидно мъртвото.'],
    check: { metric: 'channelShare', dir: 'down', goal: () => T4.channel, days: 60, text: 'Вторият канал носи поръчки при цена на купувач до 130% от основния' },
  },
  adjacent: {
    name: 'Съседен пазар', axis: 'Нови купувачи', stop: 'Пазарът ти е изчерпан.',
    when: 'Сменил си реклами и публики, а цената на купувач пак расте.', how: 'Влизаш в съседен пазар с преведено обещание и свои доказателства.',
    moves: ['Избери най-близкия съседен пазар — не най-големия.', 'Запиши предварително при какви три числа спираш.', 'Проведи 10 разговора с хора от новия пазар, преди да похарчиш едно евро.'],
    check: { metric: null, days: 90, text: 'Цена на купувач, доказателства и изплащане в новия пазар — по трите числа, записани в началото' },
  },
  budget: {
    name: 'Повече бюджет', axis: 'Нови купувачи', stop: 'Рекламата се изплаща — можеш да купиш повече купувачи.',
    when: 'Парите за реклама се връщат за 30 дни и можеш да изпратиш повече.', how: 'Вдигаш бюджета на стъпала и следиш маржа от реалния разход.',
    moves: ['Провери три неща: рекламата се изплаща, можеш да изпратиш повече и парите в сметката стигат.',
      'Запиши днешния бюджет, цената на нов купувач и колко купувачи идват.', 'Качвай бюджета с 20–30% на всеки 3–4 дни и всеки ден гледай цената на купувач и изпращането.'],
    check: { metric: 'newBuyers30', dir: 'up', goal: (s) => s * 2, days: 60, text: 'Двойно повече нови купувачи, а цената на купувач качена с не повече от 20%' },
  },
  partners: {
    name: 'Партньори', axis: 'Нови купувачи', stop: 'Нямаш бюджет за реклама.',
    when: 'Офертата продава, но пари за реклама няма.', how: 'Партньорство с някого, който вече има твоите клиенти, с ясна полза и готови материали.',
    moves: ['Направи списък от 30 души или фирми, които имат твоите клиенти (или 20 разпознаваеми имена в нишата ти).',
      'Дай нещо полезно първо на най-топлите от списъка, без условие.', 'Пиши им и говори по 15 минути с всеки, който отговори.'],
    check: { metric: null, days: 60, text: 'Над 15% от новите купувачи идват от партньори, при поне петима активни' },
  },
  entry: {
    name: 'Малка първа покупка', axis: 'Нови купувачи', stop: 'Нямаш нещо малко и евтино, с което непознатите да започнат.',
    when: 'Непознатите не смеят да купят основното от теб.', how: 'Малка първа оферта с ясна следваща платена стъпка.',
    moves: ['Разпиши основния продукт на 5–8 отделни резултата.', 'Избери един, който човек получава бързо, и му сложи цена 5–15% от основния (мостра, мини разфасовка).',
      'Реши какво предлагаш веднага след като я купи — следващата стъпка към основния.'],
    check: { metric: 'payback', dir: 'up', goal: () => T4.payback, days: 60, text: 'Рекламата на малката покупка се изплаща от покупките след нея' },
  },
  extras: {
    name: 'Допълнителни оферти', axis: 'Повече пари', stop: 'Клиентът купува само едно нещо.',
    when: 'Първа работа, ако четирите допълнителни оферти не са налице.',
    how: 'Четири оферти: добавка в чекаута, по-голямото след покупка, по-малкото след отказ и свързан продукт — по реалната нужда.',
    moves: ['Избери 1–3 малки добавки, които клиентът да отметне в чекаута.', 'Реши какво по-голямо предлагаш веднага след покупката и какво по-малко — ако откаже.',
      'Избери продукт, различен от основния, но свързан с него (шампоан → балсам), и го предложи веднага след по-голямото.'],
    check: { metric: 'aov', dir: 'up', goal: (s) => s * T4.stairs, days: 45, text: 'Купувачът дава с 30% повече, без спад в конверсията' },
  },
  smaller: {
    name: 'По-малката версия', axis: 'Повече пари', stop: 'Най-често чуваш „скъпо е“.',
    when: 'Много откази заради цената.', how: 'По-малка версия на резултата, показана веднага след отказа.',
    moves: ['Попитай 20 отказали защо точно — с един въпрос (Ordyx пази отказалите при потвърждение).', 'Запиши причините дума по дума и виж дали е за парите или не виждат стойността.',
      'Направи по-малка версия на резултата и я покажи веднага след отказа.'],
    check: { metric: null, days: 45, text: 'Поне 8% от отказалите вземат по-малката версия, а продажбите на пълната не падат' },
  },
  price: {
    name: 'Нова цена', axis: 'Повече пари', stop: 'Не си вдигал цена повече от година.',
    when: 'Цената стои, а разходите растат.', how: 'Планирано вдигане с причина, предизвестие и защита на сегашните клиенти.',
    moves: ['Провери признаците, че си под цената: година без вдигане · печелиш почти всяка продажба · никой не спори за цената · по-слабите конкуренти са по-скъпи · себестойността расте · маржът е нисък.',
      'Сметни колко печелиш преди и след вдигането с твоите числа (Ordyx → Финанси).',
      'Добави нещо ново в офертата, обяви новата цена предварително и пази старата за сегашните клиенти до дата.'],
    check: { metric: 'marginPerOrder', dir: 'up', goal: (s) => s * 1.1, days: 60, text: 'Печалбата на поръчка расте, а под 5% от клиентите си тръгват' },
  },
  margin: {
    name: 'Марж', axis: 'Повече пари', stop: 'Продаваш, но не ти остава.',
    when: 'След всички разходи остава малко или продажбите губят пари.', how: 'Смяташ рекламата, доставката, таксите и труда и поправяш това, което изяжда маржа.',
    moves: ['Запиши всички разходи по реални продажби: реклама, доставка, такси, опаковка и твоя труд (Ordyx → Финанси).',
      'Сметни колко ти остава на час по всеки продукт.', 'Спри или вдигни цената на това, което ти оставя най-малко.'],
    check: { metric: 'marginPerOrder', dir: 'up', goal: (s) => (s > 0 ? s * 1.3 : 1), days: 60, text: 'Маржът на поръчка +30%, без спад в поръчките' },
  },
  wake: {
    name: 'Събуждане', axis: 'Повторни покупки', stop: 'Стотици клиенти мълчат от месеци.',
    when: 'Над 200 купувачи не са поръчвали от 3 месеца.', how: 'Кратка поредица към забравените клиенти, която пита, преди да предложи.',
    moves: ['Извади клиентите, които не са купували над 3 месеца (Ordyx → Купувачи → заспали).', 'Напиши им съобщение, което пита как са, преди да предложи нещо.',
      'Прати го и запиши кой отговори (Ordyx → Кампании).'],
    check: { metric: 'sleeping', dir: 'down', goal: (s) => s * 0.95, days: 30, text: 'Над 5% от писаните купуват и над 3 € приход на изпратено съобщение' },
  },
  subscription: {
    name: 'Абонамент', axis: 'Повторни покупки', stop: 'Всеки месец започваш от нула.',
    when: 'Същият продукт може да се доставя редовно, а клиентите поръчват отначало всеки път.', how: 'Редовна доставка и плащане по план.',
    moves: ['Отговори на три въпроса: връща ли се нуждата сама, губи ли нещо клиентът, ако спре, и купуват ли вече отново.',
      'Опиши с думите на клиентите какво им трябва всеки месец и какво ще имат на третия.', 'Предложи абонамента първо на сегашните си клиенти, с годишен план на цената на 10 месеца.'],
    check: { metric: null, days: 90, text: 'Над 25% от прихода се повтаря всеки месец' },
  },
  next: {
    name: 'Следващ продукт', axis: 'Повторни покупки', stop: 'Няма какво да купят от теб втори път.',
    when: 'Клиентът е доволен, но няма какво друго да вземе.', how: 'Следващият продукт за човека, който вече е купил.',
    moves: ['Проведи 20 разговора с доволни клиенти и питай какво са направили, след като купиха.', 'Запиши кое се повтаря — 7 от 20 значи следващ продукт.',
      'Обяви новото на клиентите си и приемай заявки, преди да го направиш.'],
    check: { metric: 'buysPerYear', dir: 'up', goal: (s, f) => (f.kind === 'durable' ? T4.buysDurable : T4.buysConsumable), days: 90, text: 'Покупките на купувач над прага и над 30% от прихода от сегашни клиенти' },
  },
  occasion: {
    name: 'Повод', axis: 'Повторни покупки', stop: 'Имаш повод в календара, а го пропускаш.',
    when: 'Идва празник или сезон, който носи покупки.', how: 'Седемдневна кампания с реален повод и реален краен срок.',
    moves: ['Избери повода и датата — причина, която се казва с едно изречение без думата „отстъпка“.', 'Реши крайния срок, офертата и какво става след него.',
      'Напиши трите вълни съобщения — обявяване, напомняне, последен ден — и ги пусни по дати (Ordyx → Кампании).'],
    check: { metric: 'revenue7', dir: 'up', goal: (s) => s * 3, days: 30, text: 'Приходът в седмицата на повода поне 3 пъти колкото нормална седмица' },
  },
  clearance: {
    name: 'Разчистване на склада', axis: 'Повторни покупки', stop: 'Пари стоят блокирани в стока, която не се продава.',
    when: 'Стока стои непродадена от два месеца.', how: 'Петдневно разчистване с честно обявена причина.',
    moves: ['Изпиши стоката, в която стоят пари: колко пари и от колко дни не се продава (Ordyx → Наличности).',
      'Подреди я по пари, умножени по дни, и избери какво влиза.', 'Обяви честната причина и пусни 5-дневно разчистване със срок до последния час.'],
    check: { metric: 'blockedValue', dir: 'down', goal: (s) => s * 0.5, days: 30, text: 'Освободени пари и над 30% нови имена сред купувачите' },
  },
  firstDays: {
    name: 'Първите дни', axis: 'Колко остават', stop: 'Купувачите си тръгват в първите 30 дни.',
    when: 'Хората купуват, но не стигат до първия полезен резултат.', how: 'Водиш всеки нов купувач до първия резултат и проверяваш кое действие предсказва връщането.',
    moves: ['Изпиши действията, които купувачът може да направи в първите дни с продукта.', 'Сравни 30 върнали се и 30 отпаднали — какво са направили първите, а вторите не.',
      'Води всеки нов купувач до това действие в първите 14 дни със съобщения ден по ден.'],
    check: { metric: 'retention90', dir: 'up', goal: (s) => Math.max(s + 0.2, T4.retention90), days: 90, text: 'Задържането 90 дни расте с поне 20 пункта или стига прага' },
  },
  quality: {
    name: 'Еднакво качество', axis: 'Колко остават', stop: 'Резултатът е различен всеки път.',
    when: 'Едни клиенти са възхитени, други недоволни от абсолютно същото.', how: 'Обещан резултат с число, контролни точки и оценка след всяка доставка.',
    moves: ['Запиши обещания резултат с число и срок.', 'Определи 3–5 контролни точки — какво се проверява и кой отговаря (поръчка, опаковка, пратка).',
      'Питай за оценка 1–10 след всяка доставка и звъни при всяка под 7.'],
    check: { metric: 'returnsRate', dir: 'down', goal: (s) => s * 0.8, days: 60, text: 'Най-лошата оценка е поне 7, а връщанията падат' },
  },
  signal: {
    name: 'Ранен сигнал', axis: 'Колко остават', stop: 'Отпадането расте.',
    when: 'Клиентите си тръгват постепенно, с ясни сигнали преди това.', how: 'Списък на клиентите в риск и контакт преди отказа, не в деня му.',
    moves: ['Запиши сигналите, че клиент е на път да си тръгне, и кой от тях е най-силният (напр. по-дълго от обичайното без поръчка).',
      'Всяка седмица преглеждай кои клиенти показват сигнала (Ordyx → Купувачи).', 'Свържи се с всеки от тях до седмица — преди да е изчезнал.'],
    check: { metric: 'retention90', dir: 'up', goal: (s) => s * 1.1, days: 60, text: 'Над 30% от клиентите в риск остават' },
  },
  referrals: {
    name: 'Препоръки', axis: 'Колко остават', stop: 'Имаш доволни клиенти и нула препоръки.',
    when: 'Доволни клиенти и никаква система за препоръки.', how: 'Конкретна молба в конкретния момент, с готов текст и награда за двете страни.',
    moves: ['Сметни колко можеш да платиш за нов купувач — печалбата от един купувач за цялото време — и дай 25–50% от това като награда за двете страни.',
      'Напиши молбата с три неща: кого, защо точно сега и какво да направи.', 'Питай в момента, в който клиентът е доволен (след доставката), и записвай кой кого е довел.'],
    check: { metric: null, days: 60, text: 'Над 15% от новите купувачи идват по препоръка' },
  },
  proofs: {
    name: 'Доказателства', axis: 'Колко остават', stop: 'Събираш отзиви случайно, когато се сетиш.',
    when: 'Доказателствата идват случайно и рядко се ползват.', how: 'Автоматично искане веднага след резултата, подредено по възражения.',
    moves: ['Избери момента, в който клиентът получава резултата — тогава питаш.', 'Направи молбата автоматична (напр. съобщение след доставка) и вземи писмено съгласие как може да я ползваш.',
      'Подреди всяко доказателство по възражението, което оборва: скъпо е · пробвах вече · при мен няма да стане · нямам време · мога и сам.'],
    check: { metric: null, days: 30, text: 'Поне 5 нови доказателства месечно, 70% от тях в рекламите или на страницата' },
  },
};

const yesNo = [{ value: 'yes', label: 'Да' }, { value: 'no', label: 'Не' }];
/** The questions Ordyx cannot answer from data. Each owner question also names the node it belongs to. */
export const QUESTIONS = {
  kind: { text: 'Какво продаваш?', options: [{ value: 'consumable', label: 'Неща, които се свършват и се купуват пак (козметика, храна, консумативи)' }, { value: 'durable', label: 'Неща за дълго (дрехи, техника, мебели, бижута)' }] },
  capacity: { text: 'Ако утре дойдат двойно повече поръчки, ще ги изпратиш ли със същото качество?', options: [{ value: 'yes', label: 'Да, без проблем' }, { value: 'some', label: 'Част от тях' }, { value: 'no', label: 'Не, вече съм на макс' }] },
  standard: { text: 'Имаш ли писано как се приема, опакова и изпраща една поръчка — така че друг да го направи без теб?', options: yesNo },
  batchable: { text: 'Може ли изпращането да стане на партиди или да го поеме склад за изпълнение?', options: yesNo },
  marginOk: { text: 'След рекламата, доставката, таксите и стоката печелиш ли от една поръчка?', options: yesNo },
  growing: { text: 'Растат ли новите купувачи месец за месец, без цената на купувач да скача?', options: yesNo },
  breaks: { text: 'Къде губиш най-много хора?', options: [{ value: 'few', label: 'Малко хора влизат изобщо' }, { value: 'checkout', label: 'Започват поръчка и не я завършват' }, { value: 'refuse', label: 'Разглеждат и не купуват' }, { value: 'cac', label: 'Купуват, но купувачът ми струва все повече' }] },
  fewWhy: { text: 'Защо мислиш, че влизат малко хора?', options: [{ value: 'budget', label: 'Нямам бюджет за реклама' }, { value: 'entry', label: 'Нямам евтин продукт за начало' }, { value: 'market', label: 'Сменях реклами и публики, а купувачът пак поскъпва' }, { value: 'list', label: 'Имам списък с клиенти, но купуват на капки' }] },
  different: { text: 'Може ли твой клиент да каже с едно изречение с какво си различен от конкурента?', options: [{ value: 'no', label: 'Не, или не съм питал' }, { value: 'yes', label: 'Да' }, { value: 'disbelief', label: 'Различен съм, но не вярват, че при тях ще стане' }] },
  cacWhy: { text: 'Купувачът поскъпва. Какво е най-вярно?', options: [{ value: 'old', label: 'Рекламите са стари и честотата расте' }, { value: 'tried', label: 'Пуснах нови реклами и пак не падна' }, { value: 'copied', label: 'Конкурент ме копира дословно' }] },
  lastLook: { text: 'Какво гледа човек последно, преди да се откаже?', options: [{ value: 'page', label: 'Страницата на продукта, после си тръгва' }, { value: 'ads', label: 'Не стига до страницата — рекламата не води' }, { value: 'unknown', label: 'Не знам' }] },
  extras: { text: 'Имаш ли и четирите: добавка в чекаута, по-голямото след покупка, по-малкото след отказ и свързан продукт?', options: [{ value: 'no', label: 'Не всички' }, { value: 'yes', label: 'Да, и четирите' }] },
  extrasWork: { text: 'Дава ли купувачът поне 30% повече, откакто ги имаш?', options: [{ value: 'no', label: 'Не' }, { value: 'price', label: 'Много отказват заради цената' }, { value: 'yes', label: 'Да' }] },
  raised: { text: 'Вдигал ли си цени през последните 12 месеца?', options: yesNo },
  second: { text: 'Има ли какво да купи същият клиент втори път?', options: [{ value: 'yes', label: 'Да' }, { value: 'periodic', label: 'Не, но същото може да се доставя редовно' }, { value: 'once', label: 'Не, по природа се купува веднъж' }] },
  occasion: { text: 'Има ли естествен повод за покупка в следващите 90 дни (празник, сезон)?', options: yesNo },
  leave: { text: 'Кога и как си тръгват клиентите?', options: [{ value: 'early', label: 'В първите 30 дни' }, { value: 'gradual', label: 'Постепенно, с ясни сигнали преди това' }, { value: 'random', label: 'Без правило — зависи кой е изпратил поръчката' }] },
  missing: { text: 'Задържането е добро. Какво липсва?', options: [{ value: 'proofs', label: 'Малко отзиви и доказателства, които мога да ползвам' }, { value: 'referrals', label: 'Малко клиенти по препоръка' }, { value: 'none', label: 'И двете са наред' }] },
  manual: { text: 'Над половината ти седмица минава ли в ръчна работа по поръчките?', options: yesNo },
};

/**
 * The walk. `f` = facts (null = unknown), `a` = the owner's fresh answers { key: value }. Each node reads data first and asks the owner only
 * when data is missing. Returns { steps: [{ text, answer, by: 'data'|'owner' }], ask?: { key, text, options }, op?: key }.
 */
export function walk(f, a = {}) {
  const steps = [];
  const kind = f.kind || a.kind || '';
  const data = (text, answer) => { steps.push({ text, answer, by: 'data' }); };
  const owner = (key) => {
    const v = a[key];
    if (v == null) return { ask: { key, ...QUESTIONS[key] } };
    const opt = QUESTIONS[key].options.find((o) => o.value === v);
    steps.push({ text: QUESTIONS[key].text, answer: opt ? opt.label : v, by: 'owner' });
    return { v };
  };
  const done = (op) => ({ steps, op });
  const ask = (r) => ({ steps, ask: r.ask });

  // every shop in Ordyx already sells: a short history in Ordyx is not a new business, so the walk starts from what it sells
  if (!kind) { const r = owner('kind'); if (r.ask) return ask(r); } else data('Какво продаваш?', kind === 'durable' ? 'Неща за дълго' : 'Консумативи');
  const k = kind || a.kind;

  // 4–7 — capacity: can the shop take more orders at all
  const cap = owner('capacity'); if (cap.ask) return ask(cap);
  if (cap.v === 'no') {
    const st = owner('standard'); if (st.ask) return ask(st);
    if (st.v === 'no') return done('hands');
    const b = owner('batchable'); if (b.ask) return ask(b);
    return done(b.v === 'yes' ? 'batch' : 'team');
  }

  // 8 — does the money for ads come back within 30 days
  let paysBack;
  if (f.payback != null) { paysBack = f.payback >= T4.payback; data('Връща ли се рекламата за 30 дни?', `${paysBack ? 'Да' : 'Не'} — ${num(f.payback)} (прагът е ${num(T4.payback)})`); }
  else if (!f.ads) { paysBack = true; data('Връща ли се рекламата за 30 дни?', 'Няма платена реклама в Ordyx — продължаваме'); }
  else { paysBack = true; data('Връща ли се рекламата за 30 дни?', 'Още няма достатъчно данни — продължаваме'); }
  if (!paysBack) return stairs();

  // 9 — margin after every cost
  if (f.marginPerOrder != null) {
    data('Печелиш ли от поръчка след всички разходи?', f.marginPerOrder > 0 ? `Да — ${eur(f.marginPerOrder)} на поръчка` : `Не — ${eur(f.marginPerOrder)} на поръчка`);
    if (f.marginPerOrder <= 0) return done('margin');
  } else { const r = owner('marginOk'); if (r.ask) return ask(r); if (r.v === 'no') return done('margin'); }

  // 10 — new buyers growing month over month with a steady price of a buyer
  let grows;
  if (f.newBuyers30 != null && f.newBuyersBase != null) {
    const cacSteady = f.cac == null || f.cacBase == null || Math.abs(f.cac / f.cacBase - 1) <= 0.2;
    grows = f.newBuyers30 > f.newBuyersBase && cacSteady;
    data('Растат ли новите купувачи при стабилна цена на купувач?', `${grows ? 'Да' : 'Не'} — ${f.newBuyers30} за 30 дни срещу ${Math.round(f.newBuyersBase)} средно преди`);
  } else { const r = owner('growing'); if (r.ask) return ask(r); grows = r.v === 'yes'; }
  if (grows) return repeat();
  return breaks();

  // 11 — where exactly it breaks
  function breaks() {
    let where = null;
    if (f.cac != null && f.cacBase != null && f.cac >= f.cacBase * 1.2) where = 'cac';
    else if (f.completion != null && f.completion < T4.completion) where = 'checkout';
    else if (f.conversion != null && f.conversion < T4.conversion) where = 'refuse';
    else if (f.conversion != null) where = 'few';
    if (where) {
      const text = { cac: `купувачът поскъпва — ${eur(f.cac)} срещу ${eur(f.cacBase)}`, checkout: `завършват ${pct(f.completion)} от започнатите поръчки (под ${pct(T4.completion)})`,
        refuse: `купуват ${pct(f.conversion)} от посетителите (под ${pct(T4.conversion)})`, few: `купуват ${pct(f.conversion)} от посетителите — над прага, значи влизат малко` }[where];
      data('Къде се къса?', text);
    } else { const r = owner('breaks'); if (r.ask) return ask(r); where = r.v; }
    if (where === 'checkout') return done('path');
    if (where === 'refuse') return refuse();
    if (where === 'cac') return cacUp();
    return few();
  }
  // 12 — few people come at all
  function few() {
    if (f.ads === false || f.spend30 === 0) { data('Защо влизат малко?', 'Няма платена реклама'); return done('partners'); }
    if (f.channelShare != null && f.channelShare > T4.channel) { data('Защо влизат малко?', `${pct(f.channelShare)} от поръчките идват от един канал`); return done('channel'); }
    if (f.payback != null && f.payback >= 1.5) { data('Защо влизат малко?', `Рекламата се изплаща силно (${num(f.payback)}) — има място за още`); return done('budget'); }
    const r = owner('fewWhy'); if (r.ask) return ask(r);
    return done({ budget: 'partners', entry: 'entry', market: 'adjacent', list: 'window' }[r.v] || 'entry');
  }
  // 14 — they see the offer and say no
  function refuse() {
    const r = owner('different'); if (r.ask) return ask(r);
    if (r.v === 'no') return done('voice');
    if (r.v === 'yes') return done('promise');
    if (f.aov != null && f.aov >= 100) { data('Колко струва основната ти оферта?', `${eur(f.aov)} средна поръчка — над 100 €`); return done('demo'); }
    if (f.aov != null) data('Колко струва основната ти оферта?', `${eur(f.aov)} средна поръчка — под 100 €`);
    const l = owner('lastLook'); if (l.ask) return ask(l);
    return done(l.v === 'ads' ? 'freshAds' : 'path');
  }
  // 15 — a buyer costs more
  function cacUp() {
    const r = owner('cacWhy'); if (r.ask) return ask(r);
    if (r.v === 'old') return done('freshAds');
    if (r.v === 'copied') return done('voice');
    return refuse();
  }
  // 20–23 — more money per buyer
  function stairs() {
    const r = owner('extras'); if (r.ask) return ask(r);
    if (r.v === 'no') return done('extras');
    let w;
    if (f.aov != null && f.baseAov != null) {
      w = f.aov >= f.baseAov * T4.stairs ? 'yes' : 'no';
      data('Дава ли купувачът 30% повече?', `${w === 'yes' ? 'Да' : 'Не'} — средна поръчка ${eur(f.aov)} срещу ${eur(f.baseAov)} преди`);
      if (w === 'no') { const p = owner('extrasWork'); if (p.ask) return ask(p); w = p.v; }
    } else { const p = owner('extrasWork'); if (p.ask) return ask(p); w = p.v; }
    if (w === 'no') return done('extras');
    if (w === 'price') return done('smaller');
    // 23 — conversion above the threshold?
    if (f.conversion != null) {
      data('Над прага ли е конверсията?', `${f.conversion >= T4.conversion ? 'Да' : 'Не'} — ${pct(f.conversion)} (прагът е ${pct(T4.conversion)})`);
      if (f.conversion < T4.conversion) return breaks();
    }
    // 22 — price raised in the last 12 months
    if (f.priceRaised != null) { data('Вдигал ли си цени за 12 месеца?', f.priceRaised ? 'Да' : 'Не'); return done(f.priceRaised ? 'margin' : 'price'); }
    const p = owner('raised'); if (p.ask) return ask(p);
    return done(p.v === 'yes' ? 'margin' : 'price');
  }
  // 30–40 — repeat purchases and how long buyers stay
  function repeat() {
    const goal = k === 'durable' ? T4.buysDurable : T4.buysConsumable;
    if (f.buysPerYear != null) {
      const ok = f.buysPerYear >= goal;
      data('Покупки на купувач за година над прага?', `${ok ? 'Да' : 'Не'} — ${num(f.buysPerYear)} (прагът е ${num(goal)})`);
      if (ok) return stay();
    }
    const r = owner('second'); if (r.ask) return ask(r);
    if (r.v === 'periodic') return done('subscription');
    if (r.v === 'once') return done('next');
    if (f.sleeping != null && f.sleeping >= T4.silent) { data('Мълчат ли 200+ купувачи над 90 дни?', `Да — ${f.sleeping}`); return done('wake'); }
    if (f.sleeping != null) data('Мълчат ли 200+ купувачи над 90 дни?', `Не — ${f.sleeping}`);
    if (f.blockedValue != null && f.blockedValue >= T4.blocked) { data('Има ли пари, блокирани в стока?', `Да — ${eur(f.blockedValue)} стока без продажба 60 дни`); return done('clearance'); }
    const o = owner('occasion'); if (o.ask) return ask(o);
    return done(o.v === 'yes' ? 'occasion' : 'next');
  }
  function stay() {
    if (k !== 'durable') {
      if (f.retention90 != null) {
        const ok = f.retention90 >= T4.retention90;
        data('Задържане 90 дни над прага?', `${ok ? 'Да' : 'Не'} — ${pct(f.retention90)} (прагът е ${pct(T4.retention90)})`);
        if (!ok) { const r = owner('leave'); if (r.ask) return ask(r); return done({ early: 'firstDays', gradual: 'signal', random: 'quality' }[r.v]); }
      }
      const m = owner('missing'); if (m.ask) return ask(m);
      if (m.v === 'proofs') return done('proofs');
      if (m.v === 'referrals') return done('referrals');
    } else data('Задържане 90 дни', 'Прескача се — неща за дълго');
    const h = owner('manual'); if (h.ask) return ask(h);
    if (h.v === 'yes') return done('hands');
    if (f.channelShare != null && f.channelShare > T4.channel) { data('Един канал над 70% от поръчките?', `Да — ${pct(f.channelShare)}`); return done('channel'); }
    data('Всичко работи', cap.v === 'yes' ? 'Има място за още поръчки' : 'Капацитетът е ограничен');
    return done(cap.v === 'yes' ? 'budget' : 'batch');
  }
}

/** The value of a check's metric in the facts (null = Ordyx cannot measure it now). */
export function metricOf(f, metric) {
  if (!metric) return null;
  const v = f[metric];
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

/** How a started operation stands: its number now against the goal, and whether the check is met. */
export function progress(op, started, f, today) {
  const def = OPS[op];
  if (!def) return null;
  const now = metricOf(f, def.check.metric);
  const goal = started.goal;
  const met = now != null && goal != null && (def.check.dir === 'down' ? now <= goal : now >= goal);
  return { now, start: started.start ?? null, goal: goal ?? null, until: started.until, met, overdue: !met && today > started.until, metric: def.check.metric, dir: def.check.dir || null };
}

/** The goal of an operation started with these facts (null when Ordyx cannot measure it). */
export function goalFor(op, f) {
  const c = OPS[op]?.check;
  const start = metricOf(f, c?.metric);
  if (start == null) return { start: null, goal: null };
  return { start, goal: Math.round(c.goal(start, f) * 1000) / 1000 };
}

/* ---- what the numbers say: each number against its norm, with the shop's own figures and one thing to do ---- */
const rel = (now, base) => (base ? (now - base) / Math.abs(base) : 0);
/**
 * The shop's numbers, worst first. Each: { metric, label, now, norm, bad, gap, tip } — `now`/`norm` already worded,
 * `gap` how far from the norm (0 = at it), `tip` one concrete thing from these very numbers. Numbers Ordyx does not have are left out.
 */
export function numbers(f) {
  const out = [];
  const add = (metric, label, now, norm, bad, gap, tip) => out.push({ metric, label, now, norm, bad, gap: Math.round(Math.abs(gap) * 100) / 100, tip });
  if (f.conversion != null) {
    const c = f.conversion, bad = c < T4.conversion;
    add('conversion', 'Посещение → поръчка', pct(c), pct(T4.conversion), bad, rel(c, T4.conversion), bad
      ? `От 1 000 посещения поръчват ${Math.round(c * 1000)}, нормата е ${Math.round(T4.conversion * 1000)}. Виж какво гледа човек последно, преди да излезе — обикновено страницата на продукта не казва ясно цената, доставката и защо при теб.`
      : `${Math.round(c * 1000)} поръчки на 1 000 посещения — над нормата. Тук не пипай, растежът е в повече хора или по-голяма поръчка.`);
  }
  if (f.completion != null) {
    const c = f.completion, bad = c < T4.completion;
    add('completion', 'Започнат чекаут → поръчка', pct(c), pct(T4.completion), bad, rel(c, T4.completion), bad
      ? `${pct(1 - c)} от хората, които започват поръчка, не я завършват. Покажи цената на доставката още на продукта, махни незадължителните полета и пробвай поръчката сам от телефона.`
      : `Завършват ${pct(c)} от започнатите поръчки — чекаутът не е проблемът.`);
  }
  if (f.payback != null && f.ads) {
    const p = f.payback, bad = p < T4.payback;
    add('payback', 'Изплащане на рекламата (30 дни)', `${num(p)} €`, `${num(T4.payback)} €`, bad, rel(p, T4.payback), bad
      ? `За всеки 1 € реклама се връщат ${num(p)} € марж от новите купувачи — губиш на всяка поръчка от реклама. Не вдигай бюджета; първо по-голяма поръчка (добавка в чекаута) или по-евтин купувач (нови реклами).`
      : `Всеки 1 € реклама връща ${num(p)} € марж — рекламата се изплаща. Тук има място за повече бюджет, на стъпки по 20%.`);
  }
  if (f.cac != null && f.cacBase != null && f.cacBase > 0) {
    const r = rel(f.cac, f.cacBase), bad = r > 0.2;
    add('cac', 'Цена на нов купувач', eur(f.cac), eur(f.cacBase), bad, r, bad
      ? `Нов купувач ти струва ${eur(f.cac)}, а обичайно ${eur(f.cacBase)} (+${Math.round(r * 100)}%). Най-честата причина са уморени реклами — смени картинката и първото изречение, не публиката.`
      : `Нов купувач струва ${eur(f.cac)} — колкото обикновено.`);
  }
  if (f.aov != null && f.baseAov != null && f.baseAov > 0) {
    const r = rel(f.aov, f.baseAov), bad = r < -0.1;
    add('aov', 'Средна поръчка', eur(f.aov), eur(f.baseAov), bad, r, bad
      ? `Средната поръчка падна от ${eur(f.baseAov)} на ${eur(f.aov)}. Сложи една добавка в чекаута за 20–30% от цената на основния продукт.`
      : `Средната поръчка е ${eur(f.aov)} (обичайно ${eur(f.baseAov)}). Следващата стъпка нагоре е по-голямото след покупка.`);
  }
  if (f.newBuyers30 != null && f.newBuyersBase != null && f.newBuyersBase > 0) {
    const r = rel(f.newBuyers30, f.newBuyersBase), bad = r < -0.2;
    add('newBuyers30', 'Нови купувачи за 30 дни', String(f.newBuyers30), String(Math.round(f.newBuyersBase)), bad, r, bad
      ? `Новите купувачи паднаха до ${f.newBuyers30} от обичайните ${Math.round(f.newBuyersBase)} на месец. Провери дали рекламата върви и дали нещо не е счупено на сайта.`
      : `${f.newBuyers30} нови купувачи за 30 дни (обичайно ${Math.round(f.newBuyersBase)}).`);
  }
  if (f.retention90 != null && f.kind === 'consumable') {
    const v = f.retention90, bad = v < T4.retention90;
    add('retention90', 'Купуват пак до 90 дни', pct(v), pct(T4.retention90), bad, rel(v, T4.retention90), bad
      ? `Само ${pct(v)} от новите купувачи купуват втори път до 90 дни. Прати им напомняне точно когато продуктът се свършва и им дай причина да дойдат при теб, а не при друг.`
      : `${pct(v)} купуват пак до 90 дни — над нормата.`);
  }
  if (f.buysPerYear != null && f.kind) {
    const norm = f.kind === 'durable' ? T4.buysDurable : T4.buysConsumable, v = f.buysPerYear, bad = v < norm;
    add('buysPerYear', 'Покупки на клиент за година', num(v), num(norm), bad, rel(v, norm), bad
      ? `Клиентът купува ${num(v)} пъти в годината, нормата е ${num(norm)}. Нужен е следващ продукт или повод да се върне.`
      : `${num(v)} покупки на клиент в годината — добре.`);
  }
  if (f.sleeping != null) {
    const v = f.sleeping, bad = v >= T4.silent;
    add('sleeping', 'Мълчащи клиенти (90+ дни)', String(v), `под ${T4.silent}`, bad, rel(v, T4.silent), bad
      ? `${v} купували клиенти мълчат от 90+ дни. Едно съобщение с причина да се върнат (нов продукт, повод) е най-евтината поръчка, която ще вземеш този месец.`
      : `${v} мълчащи клиенти — още не си струва отделна кампания.`);
  }
  if (f.blockedValue != null && f.blockedValue > 0) {
    const v = f.blockedValue, bad = v >= T4.blocked;
    add('blockedValue', 'Стока без продажба 60 дни', eur(v), `под ${eur(T4.blocked)}`, bad, rel(v, T4.blocked), bad
      ? `${eur(v)} стоят в ${f.blockedItems || 'няколко'} продукта, които не са продадени от 60 дни. Пакетирай ги като подарък към бързо продаващ се продукт или ги предложи на старите клиенти.`
      : `${eur(v)} стока без продажба — малко.`);
  }
  if (f.channelShare != null) {
    const v = f.channelShare, bad = v >= T4.channel;
    add('channelShare', 'Поръчки от един канал', pct(v), `под ${pct(T4.channel)}`, bad, rel(v, T4.channel), bad
      ? `${pct(v)} от поръчките идват от един канал. Ако там нещо се счупи (акаунт, цена на реклама), спира всичко — започни втори канал с малък бюджет.`
      : `Поръчките идват от повече от един канал (${pct(v)} от най-големия).`);
  }
  if (f.returnsRate != null && f.returnsRate > 0) {
    const v = f.returnsRate, bad = v > 0.15;
    add('returnsRate', 'Върнати пратки', pct(v), 'под 15%', bad, rel(v, 0.15), bad
      ? `${pct(v)} от пратките се връщат. Потвърждавай поръчките по телефон или WhatsApp преди изпращане — Ordyx го прави сам.`
      : `${pct(v)} върнати пратки — нормално.`);
  }
  return out.sort((a, b) => (b.bad - a.bad) || (b.gap - a.gap));
}

/* ---- is it working: the operation's number since it started ---- */
const TRACK_PROXY = 'orders30'; // an operation the owner checks is followed by its orders
/** The number an operation is followed by (its own check, or orders when the owner checks it). */
export const trackMetric = (op) => OPS[op]?.check.metric || TRACK_PROXY;
/** Adds today's value to the operation's track (once a day, the last 120 kept). Returns true when it changed. */
export function trackPush(started, f, day) {
  const v = metricOf(f, trackMetric(started.key));
  if (v == null) return false;
  const t = Array.isArray(started.track) ? started.track : [];
  if (t.length && t[t.length - 1].d === day) { if (t[t.length - 1].v === v) return false; t[t.length - 1].v = v; }
  else t.push({ d: day, v });
  started.track = t.slice(-120);
  return true;
}
/**
 * Is it working: { state: 'early'|'up'|'flat'|'down', text, metric, first, now, weekAgo } from the track.
 * 'up'/'down' at 5% in the operation's direction; 'flat' after two weeks without a move; 'early' before a week.
 */
export function trend(started, day) {
  const def = OPS[started.key];
  const t = Array.isArray(started.track) ? started.track : [];
  const metric = trackMetric(started.key), dir = def?.check.metric ? def.check.dir || 'up' : 'up';
  if (!t.length) return null;
  const first = t[0], last = t[t.length - 1];
  const days = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${started.at}T12:00:00Z`)) / 864e5);
  const back = t.filter((x) => x.d <= new Date(Date.parse(`${last.d}T12:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10)).pop() || null;
  const fmt = (v) => (['conversion', 'completion', 'retention90', 'channelShare', 'returnsRate'].includes(metric) ? pct(v)
    : ['aov', 'marginPerOrder', 'revenue7', 'cac', 'blockedValue'].includes(metric) ? eur(v) : num(v));
  const r = rel(last.v, first.v) * (dir === 'down' ? -1 : 1);
  const label = METRIC_LABEL[metric] || metric;
  const base = { metric, label, first: first.v, now: last.v, weekAgo: back ? back.v : null, days };
  const since = `${label}: ${fmt(first.v)} → ${fmt(last.v)} за ${days} ${days === 1 ? 'ден' : 'дни'}`;
  if (days < 7) return { ...base, state: 'early', text: `${since}. Още е рано — числото се мери след първата седмица.` };
  if (r >= 0.05) return { ...base, state: 'up', text: `${since}. Действа — продължи със същото, не сменяй нищо друго едновременно.` };
  if (r <= -0.05) return { ...base, state: 'down', text: `${since}. Влошава се. Върни последната промяна и виж кой ход я предизвика.` };
  if (days >= 14) return { ...base, state: 'flat', text: `${since}. Не помръдва от 2 седмици — ходът, по който си, не стига. Мини на следващия или го направи по-силно.` };
  return { ...base, state: 'early', text: `${since}. Почти без промяна — дай му още седмица.` };
}
const METRIC_LABEL = {
  conversion: 'Посещение → поръчка', completion: 'Завършени поръчки', payback: 'Изплащане на рекламата', cac: 'Цена на нов купувач', aov: 'Средна поръчка',
  newBuyers30: 'Нови купувачи', retention90: 'Купуват пак', buysPerYear: 'Покупки на клиент', sleeping: 'Мълчащи клиенти', blockedValue: 'Стока без продажба',
  channelShare: 'Поръчки от един канал', returnsRate: 'Върнати пратки', orders30: 'Поръчки за 30 дни', ordersTotal: 'Продажби', marginPerOrder: 'Марж на поръчка', revenue7: 'Оборот за 7 дни',
};
