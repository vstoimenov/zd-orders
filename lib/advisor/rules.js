// Ordyx Съветник: from one day's numbers of a shop to the one card it sees (docs/superpowers/specs/2026-11-10-advisor-design.md).
// Pure functions: the numbers come from metrics.js, the cards are stored by repo.js.

const round = (v) => Math.round(Number(v) || 0);
export const eur = (v) => `${round(v).toLocaleString('bg-BG')} €`;
export const pct = (v) => `${Math.round((Number(v) || 0) * 1000) / 10}%`.replace('.', ',');
const ratio = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',');
const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dateBg = (day) => { const [y, m, d] = day.split('-'); return `${Number(d)}.${m}.${y}`; };

/** The metrics the shop can switch off (all on by default), in the order the filter shows them. */
export const RULE_NAMES = {
  ads_loss: 'Изплащане на рекламата', roas_below: 'ROAS спрямо прага на печалба', returns_up: 'Върнати пратки',
  risky_unconfirmed: 'Рискови клиенти без потвърждение', stock_out: 'Свършваща стока', carts_open: 'Изоставени колички', sleeping: 'Заспали клиенти',
  refusals_up: 'Откази при потвърждение', ship_slow: 'Скорост на изпращане', cac_up: 'Цена за нов купувач', conversion_down: 'Конверсия на сайта',
  repeat_down: 'Втора поръчка до 60 дни', scale_up: 'Кога да вдигнеш бюджета',
  small_orders: 'Средна поръчка', single_item: 'Поръчки с един продукт', one_channel: 'Зависимост от един канал',
};

const SOURCE = { facebook: 'Facebook', instagram: 'Instagram', google: 'Google', tiktok: 'TikTok', youtube: 'YouTube', direct: 'директни посещения', email: 'имейли', sms: 'SMS' };
const sourceName = (s) => SOURCE[s] || s;
const round5 = (v) => Math.max(5, Math.round(v / 5) * 5); // a threshold people remember: 35 €, 40 €, 45 €
// what to do, not where to click: the shop's own builder decides the menus
const GUIDE_BUNDLE = 'Добави на продукта вариант „2 броя“ с цена малко под двойната (например −15%) и го покажи в чекаута като избор с надпис „Най-изгодно“. ' +
  'Ако предпочиташ праг за безплатна доставка — сложи го малко над сегашната средна поръчка и го напиши ясно до цената.';
const GUIDE_BUMP = 'Добави в чекаута допълнителна оферта с отметка (bump): малък свързан продукт, до една трета от цената на основния, с едно изречение защо върви с него. ' +
  'Сложи я точно над бутона за поръчка.';

const ESTIMATED_MARGIN = 0.3; // when the shop has not entered product costs, growth cards count 30% of the average order (and say so)
/** The margin of one order: the real one, or an estimate the card names (unknown costs must not hide growth cards). */
export function unitMargin(m) {
  if (m.marginPerOrder) return { value: m.marginPerOrder, estimated: false };
  return m.aov ? { value: Math.round(m.aov * ESTIMATED_MARGIN * 100) / 100, estimated: true } : { value: 0, estimated: false };
}
const hours = (v) => `${Math.round(v)} ч.`;

export const MIN_ORDERS = 30; // fewer orders in 30 days: only the money rules speak

/**
 * The thresholds the platform owner may tune without a deploy (zd.settings 'advisor:limits'): how much worse than the
 * shop's base a number must be, the orders needed for growth cards, the payback levels. Set once per pass by repo.js.
 */
export const DEFAULT_LIMITS = Object.freeze({ worse: 0.2, minOrders: MIN_ORDERS, loses: 0.9, edge: 1.1, scale: 1.6 });
export const LIMITS = { ...DEFAULT_LIMITS };
const LIMIT_RANGE = { worse: [0.05, 0.6], minOrders: [5, 500], loses: [0.3, 1.5], edge: [0.5, 2], scale: [1, 5] };
/** Valid limits from stored or typed values (anything missing or out of range keeps the default); throws on a bad order of levels. */
export function cleanLimits(v = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGE)) {
    const n = Number(v?.[k]);
    if (v?.[k] !== undefined && v?.[k] !== '' && Number.isFinite(n) && n >= lo && n <= hi) out[k] = k === 'minOrders' ? Math.round(n) : Math.round(n * 100) / 100;
  }
  if (!(out.loses < out.edge && out.edge < out.scale)) throw new Error('Нивата на изплащане трябва да растат: „губи“ < „на ръба“ < „мащабирай“');
  return out;
}
export function setLimits(v) { Object.assign(LIMITS, v ? cleanLimits(v) : DEFAULT_LIMITS); }
const MONTH_PER_WEEK = 30 / 7;

/** Payback of ads (margin of new buyers in their first 30 days ÷ what was spent to get them) → one of four levels. */
export function paybackLevel(v) {
  if (v == null) return null;
  if (v < LIMITS.loses) return { key: 'loses', label: 'Губи', text: 'Всеки нов купувач ти струва повече, отколкото носи за месец. Не вдигай бюджета.' };
  if (v < LIMITS.edge) return { key: 'edge', label: 'На ръба', text: 'Рекламата горе-долу се изплаща. Вдигни маржа, преди да вдигнеш бюджета.' };
  if (v <= LIMITS.scale) return { key: 'pays', label: 'Изплаща се', text: 'Рекламата носи пари. Пази това, което работи.' };
  return { key: 'scale', label: 'Мащабирай', text: 'Можеш да вдигнеш бюджета с 20% и да провериш след 14 дни.' };
}

/** A rate is worse than the shop's own base: at least 20% relative and at least 2 percentage points. */
export const rateWorse = (now, base) => base != null && now != null && now - base >= 0.02 && now >= base * (1 + LIMITS.worse);

/**
 * The rules of stage 1. Each: step (1 money · 2 leaks · 3 fulfilment · 4 growth), metric + whether higher is better,
 * test(m) → null or the card's numbers, gain(start, end, m) → euros a month the change brought.
 */
export const RULES = {
  ads_loss: {
    step: 1, metric: 'payback', higherBetter: true, days: 30,
    test(m) {
      const p = m.payback;
      if (!p || p.value == null || p.value >= LIMITS.loses) return null;
      return {
        value: p.value, target: 1, euros: Math.max(0, p.spend - p.margin),
        problem: `Всеки нов купувач ти струва ${eur(p.spend / p.newBuyers)}, а за първия си месец ти оставя ${eur(p.margin / p.newBuyers)}. Рекламата се изплаща ${ratio(p.value)} пъти.`,
        move: 'Не вдигай бюджета. Първо вдигни средната поръчка или спри най-скъпата кампания.',
        action: { label: 'Отвори калкулатора', view: 'dash', anchor: 'beAov' },
        check: 'Изплащане поне 1,00',
      };
    },
    gain: (s, e, m) => Math.max(0, (e - s) * (m.spend30 || 0)),
  },
  roas_below: {
    step: 1, metric: 'roas7', higherBetter: true, days: 14,
    test(m) {
      if (!m.meta || m.breakEvenRoas == null || m.roas7 == null || m.spend7 < 20 || m.roas7 >= m.breakEvenRoas) return null;
      const weekly = m.spend7 - m.revenue7 / m.breakEvenRoas;
      if (weekly <= 0) return null;
      return {
        value: m.roas7, target: m.breakEvenRoas, euros: weekly * MONTH_PER_WEEK,
        problem: `За последните 7 дни рекламата върна ${ratio(m.roas7)} € на всеки 1 €, а при твоя марж трябват поне ${ratio(m.breakEvenRoas)}. Губиш около ${eur(weekly)} на седмица.`,
        move: 'Спри най-слабата кампания или прегледай цената на продукта.',
        action: { label: 'Виж източниците на трафик', view: 'dash', anchor: 'dSources' },
        check: `ROAS поне ${ratio(m.breakEvenRoas)}`,
      };
    },
    gain: (s, e, m) => (m.breakEvenRoas ? Math.max(0, ((e - s) / m.breakEvenRoas) * (m.spend30 || 0)) : 0),
  },
  returns_up: {
    step: 2, metric: 'returns', higherBetter: false, days: 30,
    test(m) {
      const r = m.returns;
      if (!m.statusTracked || !r || r.shipped < 20 || r.baseShipped < 20 || !rateWorse(r.rate, r.base)) return null;
      return {
        value: r.rate, target: r.base, euros: (r.rate - r.base) * m.shipped30 * m.returnCost,
        problem: `Върнатите пратки са ${pct(r.rate)}, а обичайно при теб са ${pct(r.base)}.`,
        move: 'Потвърждавай всяка поръчка, преди да я изпратиш — с WhatsApp, SMS или обаждане.',
        action: { label: 'Към поръчките за потвърждение', view: 'orders' },
        check: `Върнати под ${pct(r.base)}`,
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * (m.shipped30 || 0) * (m.returnCost || 0)),
  },
  risky_unconfirmed: {
    step: 2, metric: 'risky', higherBetter: false, days: 30,
    test(m) {
      const r = m.risky;
      if (!r || r.count < 3) return null;
      return {
        value: r.count, target: 0, euros: r.count * r.returnRate * m.returnCost,
        problem: `${r.count} пратки към клиенти със сигнали в НЕкоректен тръгнаха без потвърждение. При тях връщането е най-вероятно (${pct(r.returnRate)}).`,
        move: 'Потвърждавай винаги поръчките с червен флаг, преди да ги изпратиш.',
        action: { label: 'Виж рисковите купувачи', view: 'buyers', segment: 'risky' },
        check: '0 рискови пратки без потвърждение',
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * (m.risky?.returnRate || 0) * (m.returnCost || 0)),
  },
  stock_out: {
    step: 3, metric: 'stockDays', higherBetter: true, days: 14,
    test(m) {
      const p = (m.stock || []).filter((x) => x.daysLeft != null && x.daysLeft < 10).sort((a, b) => a.daysLeft - b.daysLeft)[0];
      if (!p) return null;
      const days = Math.max(0, Math.floor(p.daysLeft));
      return {
        value: p.daysLeft, target: 14, euros: Math.max(0, 14 - p.daysLeft) * p.marginPerDay, subject: p.name,
        problem: `„${p.name}“ носи ${pct(p.revenueShare)} от оборота и ${days ? `свършва след около ${days} ${days === 1 ? 'ден' : 'дни'}` : 'вече е свършил'}.`,
        move: 'Поръчай нова доставка сега, за да не спре продажбата.',
        action: { label: 'Към наличностите', view: 'inventory' },
        check: 'Наличност за поне 14 дни',
      };
    },
    gain: (s, e, m, card) => {
      const p = (m.stock || []).find((x) => x.name === card?.subject);
      return p && e >= 14 ? Math.max(0, 14 - s) * p.marginPerDay : 0;
    },
  },
  carts_open: {
    step: 4, metric: 'cartsOpen', higherBetter: false, days: 30,
    test(m) {
      const c = m.carts;
      const u = unitMargin(m);
      if (!c || c.open < 10 || !u.value) return null;
      return {
        value: c.open, target: Math.floor(c.open / 2), euros: c.open * 0.1 * u.value, estimated: u.estimated,
        problem: `${c.open} души стигнаха до поръчката, оставиха телефон и спряха — и още никой не им е писал.`,
        move: 'Напомни им с едно съобщение от „Изоставени“. Обикновено поне 1 от 10 се връща.',
        action: { label: 'Към изоставените колички', view: 'abandoned' },
        check: `Под ${Math.floor(c.open / 2)} колички без напомняне`,
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * 0.1 * unitMargin(m).value),
  },
  sleeping: {
    step: 4, metric: 'sleeping', higherBetter: false, days: 30,
    test(m) {
      const c = m.customers;
      const u = unitMargin(m);
      if (!c || m.repeatProfile === 'rarely' || c.sleeping < 20 || c.active365 < 50 || c.sleeping / c.active365 <= 0.4 || !u.value) return null;
      return {
        value: c.sleeping, target: Math.round(c.sleeping * 0.95), euros: c.sleeping * 0.05 * u.value, estimated: u.estimated,
        problem: `${c.sleeping} клиенти (${pct(c.sleeping / c.active365)} от купувачите за годината) не са поръчвали от поне 3 месеца.`,
        move: 'Върни ги с лично съобщение и оферта със срок, например −10% до неделя.',
        action: { label: 'Направи кампания към заспалите', view: 'buyers', segment: 'sleeping' },
        check: 'Поне 5% от тях поръчват отново',
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * unitMargin(m).value),
  },

  /* ---- stage 2 ---- */
  refusals_up: {
    step: 2, metric: 'refusals', higherBetter: false, days: 30,
    test(m) {
      const r = m.refusals, u = unitMargin(m);
      if (!r || !u.value) return null;
      const base = r.base ?? 0.1;
      if (!(r.base == null ? r.rate > 0.2 : rateWorse(r.rate, r.base))) return null;
      return {
        value: r.rate, target: base, euros: Math.max(0, r.rate - base) * r.answered * u.value, estimated: u.estimated,
        problem: `${pct(r.rate)} от клиентите отказват при потвърждението${r.base != null ? `, а обичайно при теб са ${pct(r.base)}` : ''}.`,
        move: 'Провери дали цената, доставката и срокът са ясни още в чекаута — и прочети отговорите на отказалите.',
        action: { label: 'Към поръчките', view: 'orders' },
        check: `Откази под ${pct(base)}`,
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * (m.refusals?.answered || 0) * unitMargin(m).value),
  },
  ship_slow: {
    step: 3, metric: 'shipHours', higherBetter: false, days: 14,
    test(m) {
      const x = m.ship;
      if (!x || x.median - x.base < 12 || x.median < x.base * (1 + LIMITS.worse)) return null;
      if (x.slowReturnRate == null || x.fastReturnRate == null || x.slowReturnRate <= x.fastReturnRate) return null; // no proof it costs
      const diff = x.slowReturnRate - x.fastReturnRate;
      return {
        value: x.median, target: x.base, euros: diff * x.slow30 * m.returnCost,
        problem: `Пратките тръгват средно ${hours(x.median)} след поръчката, а обичайно при теб — след ${hours(x.base)}. Пратките, тръгнали след 48 ч., се връщат в ${pct(x.slowReturnRate)} от случаите, бързите — в ${pct(x.fastReturnRate)}.`,
        move: 'Изпращай в деня на поръчката: пакетирай сутрин и прави товарителниците наведнъж.',
        action: { label: 'Към неизпратените поръчки', view: 'orders' },
        check: `Изпращане до ${hours(x.base)}`,
      };
    },
    gain: (s, e, m, card) => proportional(s, e, card),
  },
  cac_up: {
    step: 4, metric: 'cac', higherBetter: false, days: 14,
    test(m) {
      const b = m.newBuyers;
      if (!m.meta || !b || b.cac == null || b.cacBase == null || b.cac - b.cacBase < 2 || b.cac < b.cacBase * (1 + LIMITS.worse)) return null;
      if (m.conversion && m.conversion.rate <= m.conversion.base * (1 - LIMITS.worse)) return null; // the site sells worse: conversion_down speaks
      return {
        value: b.cac, target: b.cacBase, euros: (b.cac - b.cacBase) * b.n30,
        problem: `Новият купувач поскъпна от ${eur(b.cacBase)} на ${eur(b.cac)}, а сайтът продава както преди.`,
        move: 'Смени рекламите (нова снимка, видео или заглавие) или аудиторията. Остави старата да върви, докато новата докаже, че е по-евтина.',
        action: { label: 'Виж източниците на трафик', view: 'dash', anchor: 'dSources' },
        check: `Нов купувач под ${eur(b.cacBase)}`,
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * (m.newBuyers?.n30 || 0)),
  },
  conversion_down: {
    step: 4, metric: 'conversion', higherBetter: true, days: 14,
    test(m) {
      const c = m.conversion, u = unitMargin(m);
      if (!c || !u.value || c.base == null || c.rate > c.base * (1 - LIMITS.worse) || c.base - c.rate < 0.003) return null;
      if (c.visitsPerDay < c.baseVisitsPerDay * 0.8) return null; // fewer visits, not a weaker site
      return {
        value: c.rate, target: c.base, euros: (c.base - c.rate) * c.visits30 * u.value, estimated: u.estimated,
        problem: `Хората идват както преди, но купуват по-рядко: ${pct(c.rate)} от посещенията стават поръчка, обичайно при теб — ${pct(c.base)}.`,
        move: 'Провери страницата като клиент: цената, наличността, скоростта на телефон, отзивите и дали чекаутът работи.',
        action: { label: 'Виж посещенията', view: 'dash', anchor: 'dSources' },
        check: `Конверсия поне ${pct(c.base)}`,
      };
    },
    gain: (s, e, m) => Math.max(0, (e - s) * (m.conversion?.visits30 || 0) * unitMargin(m).value),
  },
  repeat_down: {
    step: 4, metric: 'repeat60', higherBetter: true, days: 60,
    test(m) {
      const r = m.repeat60, u = unitMargin(m);
      if (!r || m.repeatProfile === 'rarely' || !u.value || r.base == null || !(r.base - r.rate >= 0.02 && r.rate <= r.base * (1 - LIMITS.worse))) return null;
      const monthly = m.newBuyers?.n30 || r.n; // new buyers a month (the cohort is 30 days too)
      return {
        value: r.rate, target: r.base, euros: (r.base - r.rate) * monthly * u.value, estimated: u.estimated,
        problem: `Само ${pct(r.rate)} от новите купувачи поръчват втори път до 60 дни, обичайно при теб — ${pct(r.base)}.`,
        move: 'Прати SMS на купилите преди 30–60 дни с продукт, който върви с първата им покупка.',
        action: { label: 'Нова кампания', view: 'campaigns' },
        check: `Втора поръчка при поне ${pct(r.base)}`,
      };
    },
    gain: (s, e, m) => Math.max(0, (e - s) * (m.newBuyers?.n30 || 0) * unitMargin(m).value),
  },
  scale_up: {
    step: 4, metric: 'payback', higherBetter: true, days: 14, kind: 'gain',
    test(m) {
      const p = m.payback;
      if (!p || p.value <= LIMITS.scale || !m.spend30) return null;
      if (m.paybackMonthAgo == null ? p.newBuyers < 20 : m.paybackMonthAgo <= LIMITS.scale) return null; // two months in a row, or a big sample
      return {
        value: p.value, target: LIMITS.edge, euros: 0.2 * m.spend30 * (p.value - 1),
        problem: `Рекламата ти се изплаща ${ratio(p.value)} пъти още през първия месец на новия купувач.`,
        move: 'Вдигни бюджета с 20% и не пипай рекламите 14 дни. Ако изплащането остане високо — вдигни пак.',
        action: { label: 'Виж изплащането', view: 'dash', anchor: 'beAov' },
        check: `Изплащане над ${ratio(LIMITS.edge)} при по-високия бюджет`,
      };
    },
    gain: (s, e, m, card) => (e >= Number(card?.target ?? LIMITS.edge) ? Number(card?.euros) || 0 : 0),
  },
};

Object.assign(RULES, {
  small_orders: {
    step: 4, metric: 'aov', higherBetter: true, days: 30,
    test(m) {
      const b = m.basket, u = unitMargin(m), f = m.freeShipping;
      if (!b || b.n < 30 || !u.value) return null;
      const dropped = b.baseAov != null && b.baseAov - b.aov >= 2 && b.aov <= b.baseAov * 0.9;
      const farBelow = f && b.aov < f.threshold * 0.7;
      if (!dropped && !farBelow) return null;
      const marginRate = u.estimated ? ESTIMATED_MARGIN : (m.contribution30 / m.revenue30) || ESTIMATED_MARGIN;
      const next = round5(b.aov * 1.2);
      return {
        value: b.aov, target: Math.round(b.aov * 1.1 * 100) / 100, euros: 0.1 * b.n * b.aov * marginRate, estimated: u.estimated,
        problem: dropped
          ? `Средната поръчка падна от ${eur(b.baseAov)} на ${eur(b.aov)}.`
          : `Средната поръчка е ${eur(b.aov)}, а безплатна доставка има от ${eur(f.threshold)} — стигат я само ${pct(f.share)} от поръчките.`,
        move: farBelow ? `Свали прага за безплатна доставка до около ${eur(next)} или добави пакет „2 броя с отстъпка“.` : `Сложи безплатна доставка над около ${eur(next)} или пакет „2 броя с отстъпка“.`,
        action: { label: 'Как се прави', guide: GUIDE_BUNDLE },
        check: `Средна поръчка над ${eur(b.aov * 1.1)}`,
      };
    },
    gain: (s, e, m) => {
      const u = unitMargin(m), rate = u.estimated ? ESTIMATED_MARGIN : (m.contribution30 / m.revenue30) || ESTIMATED_MARGIN;
      return Math.max(0, (e - s) * (m.basket?.n || 0) * rate);
    },
  },
  single_item: {
    step: 4, metric: 'single', higherBetter: false, days: 30,
    test(m) {
      const b = m.basket, u = unitMargin(m);
      if (!b || b.n < 30 || b.single <= 0.8 || !u.value) return null;
      // one in seven orders taking a small add-on at a third of the average order
      const euros = (1 / 7) * b.n * (b.aov / 3) * (u.estimated ? ESTIMATED_MARGIN : u.value / b.aov);
      return {
        value: b.single, target: 0.7, euros, estimated: u.estimated,
        problem: `${pct(b.single)} от поръчките са само с един продукт.`,
        move: 'Добави в чекаута малък свързан продукт, който се добавя с едно цъкване.',
        action: { label: 'Как се прави', guide: GUIDE_BUMP },
        check: 'Под 70% поръчки с един продукт',
      };
    },
    gain: (s, e, m, card) => proportional(s, e, card),
  },
  one_channel: {
    step: 4, metric: 'channelShare', higherBetter: false, days: 60, kind: 'risk',
    test(m) {
      const c = m.channel;
      if (!c || c.share <= 0.85 || c.source === 'direct') return null;
      return {
        value: c.share, target: 0.85, euros: 0, subject: c.source,
        problem: `${pct(c.share)} от поръчките за последните 60 дни идват от ${sourceName(c.source)}.`,
        move: 'Пробвай втори канал с 10% от бюджета — друга мрежа, имейл или SMS към старите клиенти.',
        action: { label: 'Нова кампания към старите клиенти', view: 'campaigns' },
        check: `Под 85% от ${sourceName(c.source)}`,
      };
    },
    gain: () => 0,
  },
});

/** The part of the card's euros that came true: how far the number moved from the start toward the target. */
function proportional(s, e, card) {
  const t = Number(card?.target), all = Number(card?.euros) || 0;
  if (!(s !== t) || !all) return 0;
  return Math.max(0, Math.min(1, (s - e) / (s - t))) * all;
}

/** What the shop is missing for a fuller picture (unknown is not zero). */
export function missingData(m) {
  const out = [];
  if (!m.meta) out.push({ key: 'meta', text: 'Свържи Meta рекламите — без тях не виждам дали рекламата се изплаща.', view: 'integrations' });
  if (!m.marginKnown) out.push({ key: 'costs', text: 'Въведи себестойността на продуктите във „Финанси“ — без нея не знам маржа.', view: 'costs' });
  if (!m.statusTracked && m.orders30 >= 10) {
    const c = m.couriers || {};
    const open = (c.shipped || 0) - (c.final || 0);
    out.push(c.connected
      // the courier is connected, but these parcels left without an Ordyx waybill: their end never reaches Ordyx
      ? { key: 'statuses', view: 'orders', text: `Куриерът е свързан, но ${open} от ${c.shipped} пратки отпреди 1–4 месеца още са „изпратени“ — тръгнали са без товарителница от Ordyx и не виждам дали са доставени или върнати. Прави товарителниците от „Поръчки“ или отбелязвай доставените и върнатите.` }
      : { key: 'statuses', view: 'integrations', text: 'Свържи куриерите в „Интеграции“, за да виждам доставените и върнатите пратки.' });
  }
  if (m.history?.cb && m.history.days < 90) out.push({ key: 'history', text: 'Изтегли поръчките от последните 90 дни от ConvertBuilder — така имам с какво да сравнявам още от днес.', sync: true });
  return out;
}

/** Every rule that fires today, with its card; rules in `skip` (being checked, dismissed) are left out. */
export function candidates(m, skip = new Set()) {
  const ready = m.orders30 >= LIMITS.minOrders;
  const out = [];
  for (const [rule, r] of Object.entries(RULES)) {
    if (skip.has(rule) || (!ready && r.step !== 1)) continue;
    const c = r.test(m);
    if (c) out.push({ rule, step: r.step, metric: r.metric, days: r.days, kind: r.kind || 'cost', ...c, euros: Math.round(Math.max(0, c.euros) * 100) / 100 });
  }
  return out;
}

/** Money rules first; then the most euros, a lower step winning when the euros are within 10%. */
export function rank(list) {
  const money = list.filter((c) => c.step === 1).sort((a, b) => b.euros - a.euros);
  const rest = list.filter((c) => c.step !== 1).sort((a, b) => {
    const hi = Math.max(a.euros, b.euros);
    if (hi > 0 && Math.abs(a.euros - b.euros) <= hi * 0.1 && a.step !== b.step) return a.step - b.step;
    return b.euros - a.euros;
  });
  return [...money, ...rest];
}

/** No problem: the lever where +10% brings the most euros a month. */
export function opportunity(m) {
  const u = unitMargin(m);
  if (m.orders30 < LIMITS.minOrders || !u.value || !m.revenue30) return null;
  const marginRate = u.estimated ? ESTIMATED_MARGIN : m.contribution30 / m.revenue30;
  const options = [
    { key: 'aov', euros: m.revenue30 * 0.1 * marginRate, problem: `Средната поръчка е ${eur(m.aov)}. Ако я вдигнеш с 10%, печелиш още около ${eur(m.revenue30 * 0.1 * marginRate)} на месец.`, move: 'Добави пакет „2 броя с отстъпка“ или малък продукт към поръчката с едно цъкване.' },
    { key: 'orders', euros: m.orders30 * 0.1 * u.value, problem: `С 10% повече поръчки (още около ${Math.round(m.orders30 * 0.1)} на месец) печелиш около ${eur(m.orders30 * 0.1 * u.value)}.`, move: 'Напомняй на изоставените колички и пробвай нова реклама с 10% от бюджета.' },
  ];
  if (m.returns?.rate && m.shipped30) {
    const e = m.returns.rate * 0.1 * m.shipped30 * m.returnCost;
    options.push({ key: 'returns', euros: e, problem: `Ако върнатите пратки паднат с една десета (от ${pct(m.returns.rate)} на ${pct(m.returns.rate * 0.9)}), спестяваш около ${eur(e)} на месец.`, move: 'Потвърждавай поръчките преди изпращане и изпращай в деня на поръчката.' });
  }
  const best = options.sort((a, b) => b.euros - a.euros)[0];
  return best.euros >= 5 ? { rule: `chance_${best.key}`, kind: 'chance', euros: Math.round(best.euros * 100) / 100, problem: best.problem, move: best.move } : null;
}

/** The current value of a card's number in today's metrics (null = cannot tell today). */
export function metricValue(m, metric, card = {}) {
  switch (metric) {
    case 'payback': return m.payback?.value ?? null;
    case 'roas7': return m.roas7 ?? null;
    case 'returns': return m.returns && m.returns.shipped >= 10 ? m.returns.rate : null;
    case 'risky': return m.risky ? m.risky.count : null; // shipped in the last 30 days: by the check's day, all after the card
    case 'stockDays': return (m.stock || []).find((x) => x.name === card.subject)?.daysLeft ?? null;
    case 'cartsOpen': return m.carts ? m.carts.open : null;
    case 'sleeping': return m.customers ? m.customers.sleeping : null;
    case 'refusals': return m.refusals ? m.refusals.rate : null;
    case 'shipHours': return m.ship ? m.ship.median : null;
    case 'cac': return m.newBuyers?.cac ?? null;
    case 'conversion': return m.conversion ? m.conversion.rate : null;
    case 'repeat60': return m.repeat60 ? m.repeat60.rate : null;
    case 'aov': return m.basket ? m.basket.aov : null;
    case 'single': return m.basket ? m.basket.single : null;
    case 'channelShare': return m.channel ? m.channel.share : null;
    default: return null;
  }
}

/** A check that reached its day: success (target met) · partial (better, not there) · none. */
export function judge(card, m) {
  const r = RULES[card.rule];
  if (!r) return { result: 'none', end: null, euros: 0 };
  const end = metricValue(m, r.metric, card);
  if (end == null) return { result: 'none', end: null, euros: 0 };
  const s = Number(card.valueAtStart), t = Number(card.target);
  const better = r.higherBetter ? end > s : end < s;
  const reached = r.higherBetter ? end >= t : end <= t;
  const result = reached ? 'success' : better ? 'partial' : 'none';
  return { result, end, euros: result === 'none' ? 0 : Math.round(r.gain(s, end, m, card) * 100) / 100 };
}

/** The result in words, for the card that closed. */
export function resultText(card, j) {
  const r = RULES[card.rule];
  const fmt = (v) => (['returns', 'refusals', 'conversion', 'repeat60', 'single', 'channelShare'].includes(r?.metric) ? pct(v) : r?.metric === 'aov' ? eur(v) : ['payback', 'roas7'].includes(r?.metric) ? ratio(v)
    : r?.metric === 'shipHours' ? hours(v) : r?.metric === 'cac' ? eur(v) : String(Math.round(v)));
  if (j.result === 'none') return `Няма промяна: ${fmt(card.valueAtStart)} тогава, ${j.end == null ? 'няма данни' : fmt(j.end)} сега. Ще пробваме друго.`;
  const head = j.result === 'success' ? 'Стана' : 'Има подобрение';
  return `${head}: от ${fmt(card.valueAtStart)} на ${fmt(j.end)}${j.euros > 0 ? ` — около ${eur(j.euros)} на месец` : ''}.`;
}

/** A fired rule → the card stored and shown (numbers frozen at the day). */
export function cardFor(c, day) {
  return {
    rule: c.rule, metric: c.metric, valueAtStart: c.value, target: c.target, euros: c.euros, subject: c.subject || '',
    checkUntil: plusDays(day, c.days),
    texts: {
      problem: c.problem, move: c.move, action: c.action,
      cost: (c.kind === 'gain' ? `Можеш да спечелиш още около ${eur(c.euros)} на месец.` : c.kind === 'risk' ? 'Това е риск: ако там нещо спре, спират и продажбите.' : `Това ти струва около ${eur(c.euros)} на месец.`)
        + (c.estimated ? ' (сметнато при около 30% марж — въведи себестойността във „Финанси“ за точна сума)' : ''),
      check: `${c.check} до ${dateBg(plusDays(day, c.days))}. Ще ти кажа резултата.`,
    },
  };
}
