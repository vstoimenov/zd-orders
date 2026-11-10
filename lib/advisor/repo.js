// Ordyx Съветник: the day's pass for one shop (numbers, closing the checks that are due, the cards) and the shop's answers.
// The pass runs on the first look of the day (no separate nightly function: the Hobby plan allows 12), once per shop and day.
import { shopMetrics } from './metrics.js';
import { candidates, rank, opportunity, cardFor, judge, resultText, missingData, paybackLevel, RULES, RULE_NAMES, MIN_ORDERS } from './rules.js';
import { sofiaDay } from '../visits.js';

const SHOW = 3; // the card and two more behind „Следващ съвет“
const QUIET_DAYS = 30; // a rule dismissed or done is not offered again for this long
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const minus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const plus = (day, n) => minus(day, -n);
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
/** When a change happens: now on the real day; noon of `day` when a pass runs for another day (tests, a late first look). */
const stamp = (day) => (day === sofiaDay() ? new Date().toISOString() : `${day}T12:00:00Z`);
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

function rowToCard(r) {
  const c = json(r.card);
  return {
    id: r.id, rule: r.rule, state: r.state, acted: r.acted, createdAt: new Date(r.created_at).toISOString(), checkUntil: r.check_until ? dayOf(r.check_until) : null,
    euros: Number(r.euros), result: r.result || null, texts: c.texts || {}, resultText: c.resultText || '', subject: c.subject || '',
  };
}

const settingsKey = (shopId) => `advisor:${shopId}`;
async function readSettings(q, shopId) {
  const [r] = await q(`select value from zd.settings where key = $1`, [settingsKey(shopId)]);
  return r ? json(r.value) : {};
}
/** The metrics switched off by the shop (none by default: everything is watched). */
async function offRules(q, shopId) {
  const off = (await readSettings(q, shopId)).off;
  return new Set(Array.isArray(off) ? off.filter((r) => Object.hasOwn(RULE_NAMES, r)) : []);
}

/** The filter: which metrics the advisor watches. Saving starts today's pass again, so a switched-off metric's card goes at once. */
export async function setWatched(q, shopId, watched, day = sofiaDay()) {
  if (!Array.isArray(watched)) throw new Error('Невалиден избор');
  const on = new Set(watched.map(String));
  const off = Object.keys(RULE_NAMES).filter((r) => !on.has(r));
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('off', $2::text::jsonb))
     on conflict (key) do update set value = zd.settings.value || jsonb_build_object('off', $2::text::jsonb)`, [settingsKey(shopId), JSON.stringify(off)]);
  await q(`delete from zd.advisor_cards where shop_id = $1::uuid and state = 'shown'`, [shopId]);
  await q(`delete from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
  return watchedList(new Set(off));
}
const watchedList = (off) => Object.entries(RULE_NAMES).map(([rule, name]) => ({ rule, name, on: !off.has(rule) }));

/** The pass of the day: only the request that stored the day's numbers runs it (two first looks at once do it once). */
async function dailyPass(q, shopId, day) {
  const metrics = await shopMetrics(q, shopId, day);
  const stored = await q(`insert into zd.advisor_daily (shop_id, day, metrics) values ($1::uuid, $2::date, $3::text::jsonb)
     on conflict (shop_id, day) do nothing returning day`, [shopId, day, JSON.stringify(metrics)]);
  if (!stored.length) return;

  // checks that reached their day: the result in numbers and euros
  const due = await q(`select * from zd.advisor_cards where shop_id = $1::uuid and state = 'checking' and check_until <= $2::date`, [shopId, day]);
  for (const r of due) {
    const c = json(r.card);
    const card = { rule: r.rule, valueAtStart: Number(r.value_at_start), target: Number(r.target), subject: c.subject || '' };
    const j = judge(card, metrics);
    await q(`update zd.advisor_cards set state = 'done', result = $2, value_at_end = $3, euros = $4, card = card || jsonb_build_object('resultText', $5::text), updated_at = $6::timestamptz
       where id = $1::uuid`, [r.id, j.result, j.end, j.euros, resultText(card, j), stamp(day)]);
  }
  // yesterday's cards nobody acted on go; the ones that still matter come back with today's numbers
  await q(`delete from zd.advisor_cards where shop_id = $1::uuid and state = 'shown'`, [shopId]);

  const quiet = await q(`select distinct rule from zd.advisor_cards where shop_id = $1::uuid
     and (state = 'checking' or (state in ('dismissed', 'done') and updated_at >= ($2::date)::timestamp))`, [shopId, minus(day, QUIET_DAYS)]);
  const skip = new Set([...quiet.map((x) => x.rule), ...(await offRules(q, shopId))]);
  const list = rank(candidates(metrics, skip)).slice(0, SHOW);
  for (const [i, c] of list.entries()) {
    const card = cardFor(c, day);
    await q(`insert into zd.advisor_cards (shop_id, rule, metric, value_at_start, target, check_until, euros, card, created_at, updated_at)
       values ($1::uuid, $2, $3, $4, $5, $6::date, $7, $8::text::jsonb, $9::timestamptz, $9::timestamptz)`,
      [shopId, card.rule, card.metric, card.valueAtStart, card.target, card.checkUntil, card.euros, JSON.stringify({ texts: card.texts, subject: card.subject, rank: i }), stamp(day)]);
  }
}

/** What „Табло“ shows: the cards of today (in order), checks running, recent results, the payback level, what data is missing. */
export async function getAdvisor(q, shopId, day = sofiaDay()) {
  const [have] = await q(`select metrics from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
  if (!have) await dailyPass(q, shopId, day);
  const [row] = await q(`select metrics from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
  const m = json(row.metrics);
  const rows = await q(`select * from zd.advisor_cards where shop_id = $1::uuid
     and (state in ('shown', 'checking') or (state = 'done' and updated_at >= ($2::date)::timestamp)) order by created_at`, [shopId, minus(day, 14)]);
  const [won] = await q(`select coalesce(sum(euros), 0) as euros, count(*)::int as n from zd.advisor_cards where shop_id = $1::uuid and state = 'done' and result in ('success', 'partial')`, [shopId]);
  const off = await offRules(q, shopId);
  const cards = rows.filter((r) => r.state === 'shown').sort((a, b) => (json(a.card).rank ?? 0) - (json(b.card).rank ?? 0)).map(rowToCard);
  return {
    day, ready: m.orders30 >= MIN_ORDERS, orders30: m.orders30,
    // the payback level is the ads metric: hidden when the shop switched it off
    payback: m.payback && !off.has('ads_loss') ? { ...m.payback, level: paybackLevel(m.payback.value) } : null,
    cards, chance: cards.length ? null : opportunity(m),
    checking: rows.filter((r) => r.state === 'checking').map(rowToCard),
    results: rows.filter((r) => r.state === 'done' && r.result).map(rowToCard),
    watched: watchedList(off),
    missing: missingData(m).filter((x) => x.key !== 'meta' || !(off.has('ads_loss') && off.has('roas_below'))), brought: { euros: Math.round(Number(won.euros) * 100) / 100, cards: won.n },
  };
}

/** The shop's answer to a card: act („Направи това“) starts the check from today; dismiss hides the rule for 30 days. */
export async function answerCard(q, shopId, { id, action, reason = '' }, day = sofiaDay()) {
  if (!UUID.test(String(id || ''))) throw new Error('Няма такъв съвет');
  const [r] = await q(`select * from zd.advisor_cards where id = $1::uuid and shop_id = $2::uuid`, [id, shopId]);
  if (!r) throw new Error('Няма такъв съвет');
  if (action === 'act') {
    if (r.state !== 'shown') return rowToCard(r);
    const days = RULES[r.rule]?.days || 30;
    const [u] = await q(`update zd.advisor_cards set state = 'checking', acted = true, check_until = $2::date, updated_at = $3::timestamptz where id = $1::uuid returning *`, [id, plus(day, days), stamp(day)]);
    return rowToCard(u);
  }
  if (action === 'dismiss') {
    const why = ['doing', 'not_for_me'].includes(reason) ? reason : '';
    const [u] = await q(`update zd.advisor_cards set state = 'dismissed', dismiss_reason = $2, updated_at = $3::timestamptz where id = $1::uuid returning *`, [id, why, stamp(day)]);
    return rowToCard(u);
  }
  throw new Error('Непознато действие');
}
