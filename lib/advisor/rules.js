// Ordyx Съветник: from one day's numbers of a shop to the one card it sees (docs/superpowers/specs/2026-11-10-advisor-design.md).
// Pure functions: the numbers come from metrics.js, the cards are stored by repo.js.

const round = (v) => Math.round(Number(v) || 0);
export const eur = (v) => `${round(v).toLocaleString('bg-BG')} €`;
export const pct = (v) => `${Math.round((Number(v) || 0) * 1000) / 10}%`.replace('.', ',');
const ratio = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',');
const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dateBg = (day) => { const [y, m, d] = day.split('-'); return `${Number(d)}.${m}.${y}`; };

export const MIN_ORDERS = 30; // fewer orders in 30 days: only the money rules speak
const MONTH_PER_WEEK = 30 / 7;

/** Payback of ads (margin of new buyers in their first 30 days ÷ what was spent to get them) → one of four levels. */
export function paybackLevel(v) {
  if (v == null) return null;
  if (v < 0.9) return { key: 'loses', label: 'Губи', text: 'Всеки нов купувач ти струва повече, отколкото носи за месец. Не вдигай бюджета.' };
  if (v < 1.1) return { key: 'edge', label: 'На ръба', text: 'Рекламата горе-долу се изплаща. Вдигни маржа, преди да вдигнеш бюджета.' };
  if (v <= 1.6) return { key: 'pays', label: 'Изплаща се', text: 'Рекламата носи пари. Пази това, което работи.' };
  return { key: 'scale', label: 'Мащабирай', text: 'Можеш да вдигнеш бюджета с 20% и да провериш след 14 дни.' };
}

/** A rate is worse than the shop's own base: at least 20% relative and at least 2 percentage points. */
export const rateWorse = (now, base) => base != null && now != null && now - base >= 0.02 && now >= base * 1.2;

/**
 * The rules of stage 1. Each: step (1 money · 2 leaks · 3 fulfilment · 4 growth), metric + whether higher is better,
 * test(m) → null or the card's numbers, gain(start, end, m) → euros a month the change brought.
 */
export const RULES = {
  ads_loss: {
    step: 1, metric: 'payback', higherBetter: true, days: 30,
    test(m) {
      const p = m.payback;
      if (!p || p.value == null || p.value >= 0.9) return null;
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
      if (!c || c.open < 10 || !m.marginPerOrder) return null;
      return {
        value: c.open, target: Math.floor(c.open / 2), euros: c.open * 0.1 * m.marginPerOrder,
        problem: `${c.open} души стигнаха до поръчката, оставиха телефон и спряха — и още никой не им е писал.`,
        move: 'Напомни им с едно съобщение от „Изоставени“. Обикновено поне 1 от 10 се връща.',
        action: { label: 'Към изоставените колички', view: 'abandoned' },
        check: `Под ${Math.floor(c.open / 2)} колички без напомняне`,
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * 0.1 * (m.marginPerOrder || 0)),
  },
  sleeping: {
    step: 4, metric: 'sleeping', higherBetter: false, days: 30,
    test(m) {
      const c = m.customers;
      if (!c || m.repeatProfile === 'rarely' || c.sleeping < 20 || c.active365 < 50 || c.sleeping / c.active365 <= 0.4 || !m.marginPerOrder) return null;
      return {
        value: c.sleeping, target: Math.round(c.sleeping * 0.95), euros: c.sleeping * 0.05 * m.marginPerOrder,
        problem: `${c.sleeping} клиенти (${pct(c.sleeping / c.active365)} от купувачите за годината) не са поръчвали от поне 3 месеца.`,
        move: 'Върни ги с лично съобщение и оферта със срок, например −10% до неделя.',
        action: { label: 'Направи кампания към заспалите', view: 'buyers', segment: 'sleeping' },
        check: 'Поне 5% от тях поръчват отново',
      };
    },
    gain: (s, e, m) => Math.max(0, (s - e) * (m.marginPerOrder || 0)),
  },
};

/** What the shop is missing for a fuller picture (unknown is not zero). */
export function missingData(m) {
  const out = [];
  if (!m.meta) out.push({ key: 'meta', text: 'Свържи Meta рекламите — без тях не виждам дали рекламата се изплаща.', view: 'integrations' });
  if (!m.marginKnown) out.push({ key: 'costs', text: 'Въведи себестойността на продуктите във „Финанси“ — без нея не знам маржа.', view: 'costs' });
  if (!m.statusTracked && m.orders30 >= 10) out.push({ key: 'statuses', text: 'Свържи куриерите в „Интеграции“, за да виждам доставените и върнатите пратки.', view: 'integrations' });
  return out;
}

/** Every rule that fires today, with its card; rules in `skip` (being checked, dismissed) are left out. */
export function candidates(m, skip = new Set()) {
  const ready = m.orders30 >= MIN_ORDERS;
  const out = [];
  for (const [rule, r] of Object.entries(RULES)) {
    if (skip.has(rule) || (!ready && r.step !== 1)) continue;
    const c = r.test(m);
    if (c) out.push({ rule, step: r.step, metric: r.metric, days: r.days, ...c, euros: Math.round(Math.max(0, c.euros) * 100) / 100 });
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
  if (m.orders30 < MIN_ORDERS || !m.marginPerOrder || !m.revenue30) return null;
  const marginRate = m.contribution30 / m.revenue30;
  const options = [
    { key: 'aov', euros: m.revenue30 * 0.1 * marginRate, problem: `Средната поръчка е ${eur(m.aov)}. Ако я вдигнеш с 10%, печелиш още около ${eur(m.revenue30 * 0.1 * marginRate)} на месец.`, move: 'Добави пакет „2 броя с отстъпка“ или малък продукт към поръчката с едно цъкване.' },
    { key: 'orders', euros: m.orders30 * 0.1 * m.marginPerOrder, problem: `С 10% повече поръчки (още около ${Math.round(m.orders30 * 0.1)} на месец) печелиш около ${eur(m.orders30 * 0.1 * m.marginPerOrder)}.`, move: 'Напомняй на изоставените колички и пробвай нова реклама с 10% от бюджета.' },
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
  const fmt = (v) => (['returns'].includes(r?.metric) ? pct(v) : ['payback', 'roas7'].includes(r?.metric) ? ratio(v) : String(Math.round(v)));
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
      problem: c.problem, cost: `Това ти струва около ${eur(c.euros)} на месец.`, move: c.move, action: c.action,
      check: `${c.check} до ${dateBg(plusDays(day, c.days))}. Ще ти кажа резултата.`,
    },
  };
}
