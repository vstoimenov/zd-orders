// Пътят на растежа for one shop: its facts (the advisor's daily numbers + a few of its own), the owner's answers and the
// operation it works on. Stored in zd.settings `path:<shop>` as { answers: { key: { v, at } }, op: {...}, done: [...] }.
import { walk, OPS, QUESTIONS, ANSWER_DAYS, progress, goalFor, numbers, trackPush, trend, trackMetric } from './path.js';
import { getAdvisor } from './repo.js';
import { checkoutCompletion } from '../abandoned.js';
import { sofiaDay } from '../visits.js';

const minus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const at = (p) => `($${p}::date)::timestamp at time zone 'Europe/Sofia'`;
const COUNTED = `o.status <> 'cancelled' and o.cb_check <> 'pending' and o.currency = 'EUR'`;
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const key = (shopId) => `path:${shopId}`;

async function readState(q, shopId) {
  const [r] = await q(`select value from zd.settings where key = $1`, [key(shopId)]);
  const s = r ? json(r.value) : {};
  return { answers: s.answers || {}, op: s.op || null, done: Array.isArray(s.done) ? s.done : [] };
}
async function writeState(q, shopId, s) {
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [key(shopId), JSON.stringify(s)]);
}

/** Numbers the advisor's daily pass does not keep: lifetime orders, new buyers before, buys a year, retention, price, idle stock, checkouts. */
export async function pathExtras(q, shopId, day = sofiaDay()) {
  const d30 = minus(day, 30), d120 = minus(day, 120), d365 = minus(day, 365);
  const [[life], [nb], [yr], [ret], [price], [idle], completion] = await Promise.all([
    q(`select count(*)::int as n, min(o.created_at) as first_at from zd.orders o where o.shop_id = $1::uuid and ${COUNTED}`, [shopId]),
    // new buyers (first order by phone) in the 90 days before the last 30, per 30 days
    q(`with f as (select o.phone_norm, min(o.created_at) as first_at from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> '' group by 1)
       select count(*) filter (where first_at >= ${at(3)} and first_at < ${at(2)})::int as base from f`, [shopId, d30, d120]),
    // orders per buyer over the last year (buyers by phone)
    q(`select count(*)::int as orders, count(distinct o.phone_norm)::int as buyers from zd.orders o
       where o.shop_id = $1::uuid and ${COUNTED} and o.status <> 'returned' and o.phone_norm <> '' and o.created_at >= ${at(2)} and o.created_at < ${at(3)}`, [shopId, d365, day]),
    // new buyers of 90–180 days ago: how many bought again within 90 days
    q(`with f as (select o.phone_norm, min(o.created_at) as first_at from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> '' group by 1)
       select count(*)::int as n, count(*) filter (where exists (select 1 from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm = f.phone_norm
         and o.created_at > f.first_at + interval '1 hour' and o.created_at < f.first_at + interval '90 days'))::int as again
       from f where first_at >= ${at(2)} and first_at < ${at(3)}`, [shopId, minus(day, 180), minus(day, 90)]),
    // the price of each product sold now and a year ago (per unit), weighted by today's units
    q(`with it as (select lower(btrim(i->>'name')) as k, coalesce((i->>'price')::numeric, 0) / greatest(coalesce((i->>'qty')::numeric, 1), 1) as unit,
         greatest(coalesce((i->>'qty')::numeric, 1), 1) as qty, o.created_at >= ${at(2)} as now
         from zd.orders o cross join lateral jsonb_array_elements(o.items) i
         where o.shop_id = $1::uuid and ${COUNTED} and coalesce(i->>'name', '') <> '' and coalesce((i->>'price')::numeric, 0) > 0
           and (o.created_at >= ${at(2)} or (o.created_at >= ${at(3)} and o.created_at < ${at(4)}))),
       p as (select k, avg(unit) filter (where now) as nowp, avg(unit) filter (where not now) as thenp, sum(qty) filter (where now) as units from it group by k)
       select count(*)::int as n, sum(units * nowp) / nullif(sum(units * thenp), 0) as ratio from p where nowp is not null and thenp is not null`,
      [shopId, d30, minus(day, 395), d365]),
    // money in stock that did not sell for 60 days
    q(`select coalesce(sum(pc.stock * pc.unit_cost), 0) as value, count(*)::int as n from zd.product_costs pc
       where pc.shop_id = $1::uuid and pc.stock > 0 and pc.unit_cost > 0 and not pc.digital and not exists (
         select 1 from zd.orders o cross join lateral jsonb_array_elements(o.items) i where o.shop_id = pc.shop_id and ${COUNTED}
           and o.created_at >= ${at(2)} and lower(btrim(i->>'name')) = lower(btrim(pc.name)))`, [shopId, minus(day, 60)]),
    checkoutCompletion(q, { shopId, from: d30 }),
  ]);
  const historyDays = life.first_at ? Math.floor((Date.parse(`${day}T00:00:00Z`) - new Date(life.first_at).getTime()) / 864e5) : 0;
  return {
    ordersTotal: life.n, historyDays,
    newBuyersBase: historyDays >= 120 && nb.base >= 15 ? r3(nb.base / 3) : null,
    buysPerYear: historyDays >= 180 && yr.buyers >= 50 ? r3(yr.orders / yr.buyers) : null,
    retention90: ret.n >= 30 ? r3(ret.again / ret.n) : null,
    priceRaised: historyDays >= 395 && price.n >= 3 && price.ratio != null ? Number(price.ratio) >= 1.03 : null,
    blockedValue: Math.round(Number(idle.value)), blockedItems: idle.n,
    completion: completion ? completion.rate : null,
  };
}

/** The walk's facts: the advisor's numbers of the day plus the extras. */
export async function pathFacts(q, shopId, day = sofiaDay()) {
  await getAdvisor(q, shopId, day); // runs the day's pass when it has not run yet
  const [row] = await q(`select metrics from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
  const m = json(row?.metrics);
  const x = await pathExtras(q, shopId, day);
  const kind = m.repeatProfile === 'rarely' ? 'durable' : m.repeatProfile ? 'consumable' : '';
  return {
    ...x, kind,
    ads: Boolean(m.meta) && Number(m.spend30) > 0, spend30: m.meta ? Number(m.spend30 || 0) : null,
    payback: m.payback?.value ?? null, marginPerOrder: m.marginPerOrder ?? null,
    newBuyers30: m.newBuyers?.n30 ?? null, cac: m.newBuyers?.cac ?? null, cacBase: m.newBuyers?.cacBase ?? null,
    conversion: m.conversion?.rate ?? null, channelShare: m.channel?.share ?? null, aov: m.basket?.aov ?? null, baseAov: m.basket?.baseAov ?? null,
    sleeping: m.customers?.sleeping ?? null, orders30: m.orders30 ?? null, revenue7: m.revenue7 ?? null, returnsRate: m.returns?.rate ?? null,
  };
}

const fresh = (answers, day) => Object.fromEntries(Object.entries(answers)
  .filter(([k, a]) => Object.hasOwn(QUESTIONS, k) && a && a.v != null && String(a.at || '').slice(0, 10) >= minus(day, ANSWER_DAYS))
  .map(([k, a]) => [k, a.v]));

function opView(id) {
  const o = OPS[id];
  return { key: id, name: o.name, axis: o.axis, stop: o.stop, when: o.when, how: o.how, moves: o.moves, checkText: o.check.text, days: o.check.days, measured: Boolean(o.check.metric) };
}

const NUDGE_DAYS = 3; // a move that stands this long gets a reminder
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
/** Step by step: which moves are done, the move to do now, and whether it is time to ask „Стана ли?“. */
function stepView(op, day) {
  const moves = OPS[op.key].moves;
  const ticks = moves.map((_, i) => Boolean(op.ticks?.[i]));
  const next = ticks.indexOf(false);
  const since = op.tickAt || op.at;
  return {
    ticks, next: next === -1 ? null : next, doneMoves: ticks.filter(Boolean).length,
    daysLeft: Math.max(0, daysBetween(day, op.until)), idleDays: daysBetween(since, day),
    stuck: next !== -1 && daysBetween(since, day) >= NUDGE_DAYS,
    ask: day >= op.until, // the check's day came: „Стана ли?“
  };
}

/** The path as the shop sees it: the steps, the next question or the operation, and the operation it is working on. */
export async function getPath(q, shopId, day = sofiaDay()) {
  const [f, s] = await Promise.all([pathFacts(q, shopId, day), readState(q, shopId)]);
  const w = walk(f, fresh(s.answers, day));
  if (s.op && OPS[s.op.key] && trackPush(s.op, f, day)) await writeState(q, shopId, s);
  const active = s.op && OPS[s.op.key]
    ? { ...opView(s.op.key), startedAt: s.op.at, ...progress(s.op.key, s.op, f, day), ...stepView(s.op, day), trend: trend(s.op, day) } : null;
  // the shop's numbers, worst first; the one the operation works on goes first
  const focus = active ? trackMetric(active.key) : w.op ? OPS[w.op].check.metric : null;
  const nums = numbers(f);
  const i = nums.findIndex((x) => x.metric === focus);
  if (i > 0) nums.unshift(...nums.splice(i, 1));
  return {
    day, steps: w.steps, ask: w.ask || null, op: w.op ? opView(w.op) : null, active, numbers: nums, focus: i >= 0 ? focus : null,
    // little history in Ordyx yet: the numbers firm up as orders come in
    young: f.ordersTotal < 30 || f.historyDays < 30 ? { orders: f.ordersTotal, days: f.historyDays } : null,
    done: s.done.slice(-5).map((d) => ({ name: OPS[d.key]?.name || d.key, at: d.at, met: d.met })),
  };
}

/** The owner's answer to one question of the path. */
export async function answerPath(q, shopId, { key: k, value }, day = sofiaDay()) {
  const qn = QUESTIONS[k];
  if (!qn || !qn.options.some((o) => o.value === value)) throw new Error('Невалиден отговор');
  const s = await readState(q, shopId);
  s.answers[k] = { v: value, at: day };
  await writeState(q, shopId, s);
  return getPath(q, shopId, day);
}

/** „Започвам“: the operation the path leads to now; its number today and the goal are kept. */
export async function startPath(q, shopId, day = sofiaDay()) {
  const f = await pathFacts(q, shopId, day);
  const s = await readState(q, shopId);
  const w = walk(f, fresh(s.answers, day));
  if (!w.op) throw new Error('Първо отговори на въпроса');
  const g = goalFor(w.op, f);
  s.op = { key: w.op, at: day, until: new Date(Date.parse(`${day}T12:00:00Z`) + OPS[w.op].check.days * 864e5).toISOString().slice(0, 10), ...g };
  trackPush(s.op, f, day);
  await writeState(q, shopId, s);
  return getPath(q, shopId, day);
}

/** A move of the operation done (or undone): the next one becomes the one to do now. */
export async function tickPath(q, shopId, { i, on = true }, day = sofiaDay()) {
  const s = await readState(q, shopId);
  if (!s.op || !OPS[s.op.key]) throw new Error('Няма започната операция');
  const n = OPS[s.op.key].moves.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error('Невалиден ход');
  const ticks = Array.from({ length: n }, (_, k) => Boolean(s.op.ticks?.[k]));
  ticks[i] = Boolean(on);
  s.op.ticks = ticks;
  if (on) s.op.tickAt = day;
  await writeState(q, shopId, s);
  return getPath(q, shopId, day);
}

/** The daily nudge: a push when the move to do now stands for days, and once when the check's day comes („Стана ли?“). */
export async function sendPathNudges(q, notify, day = sofiaDay()) {
  const rows = await q(`select st.key, st.value, s.id as shop_id, s.name from zd.settings st join zd.shops s on st.key = 'path:' || s.id::text
     where st.value ? 'op' and jsonb_typeof(st.value->'op') = 'object'`);
  let sent = 0;
  for (const r of rows) {
    const s = json(r.value);
    if (!s.op || !OPS[s.op.key]) continue;
    const v = stepView(s.op, day), o = OPS[s.op.key], who = r.name || 'Магазинът', url = `/admin/?shop=${r.shop_id}#dash`;
    let msg = null;
    const week = daysBetween(s.op.at, day);
    if (!v.ask && week >= 7 && week % 7 === 0 && s.op.trendAt !== day) {
      // once a week: is it working — the operation's number since the start
      const f = await pathFacts(q, r.shop_id, day).catch(() => null);
      if (f) trackPush(s.op, f, day);
      const t = trend(s.op, day);
      s.op.trendAt = day;
      if (t && t.state !== 'early') msg = { title: `🧭 ${who}: ${t.state === 'up' ? 'действа' : t.state === 'down' ? 'влошава се' : 'не помръдва'}`, body: `${t.text} („${o.name}“)`, url };
      else await writeState(q, r.shop_id, s);
    }
    if (!msg && v.ask && s.op.askedAt !== s.op.until) {
      msg = { title: `🧭 ${who}: стана ли?`, body: `Днес е проверката на „${o.name}“: ${o.check.text}. Отвори и кажи как е.`, url };
      s.op.askedAt = s.op.until;
    } else if (!msg && !v.ask && v.stuck && (!s.op.nudgedAt || daysBetween(s.op.nudgedAt, day) >= NUDGE_DAYS)) {
      msg = { title: `🧭 ${who}: следващият ход`, body: `${o.moves[v.next]} (ход ${v.next + 1} от ${o.moves.length} на „${o.name}“)`, url };
      s.op.nudgedAt = day;
    }
    if (!msg) continue;
    await notify(q, r.shop_id, msg);
    await writeState(q, r.shop_id, s);
    sent++;
  }
  return { sent };
}

/** The operation ends: done (the check is met, or the owner says so) or stopped; the answers are asked again for a fresh walk. */
export async function endPath(q, shopId, { met = false } = {}, day = sofiaDay()) {
  const s = await readState(q, shopId);
  if (s.op) s.done.push({ key: s.op.key, at: day, met: Boolean(met) });
  s.op = null;
  s.answers = {}; // the numbers changed: the map is walked again from the start
  await writeState(q, shopId, s);
  return getPath(q, shopId, day);
}

/** „Отговори наново“: forget the owner's answers (the operation in progress stays). */
export async function resetPathAnswers(q, shopId, day = sofiaDay()) {
  const s = await readState(q, shopId);
  s.answers = {};
  await writeState(q, shopId, s);
  return getPath(q, shopId, day);
}
