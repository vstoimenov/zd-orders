// Ordyx Съветник: the day's pass for one shop (numbers, closing the checks that are due, the cards) and the shop's answers.
// The pass runs on the first look of the day (no separate nightly function: the Hobby plan allows 12), once per shop and day.
import { shopMetrics } from './metrics.js';
import { candidates, rank, opportunity, cardFor, judge, resultText, missingData, paybackLevel, RULES, RULE_NAMES, LIMITS, DEFAULT_LIMITS, cleanLimits, setLimits, eur } from './rules.js';
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
  await refreshDay(q, shopId, day);
  return watchedList(new Set(off));
}

/** Today's pass runs again on the next look (after the filter, the profile or newly synced history changed the picture). */
export async function refreshDay(q, shopId, day = sofiaDay()) {
  await q(`delete from zd.advisor_cards where shop_id = $1::uuid and state = 'shown'`, [shopId]);
  await q(`delete from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
}

const PROFILES = ['often', 'sometimes', 'rarely'];
/** How often the shop's buyers come back (often · sometimes · rarely); '' = not told (Ordyx may suggest from the data). */
export async function setProfile(q, shopId, value, day = sofiaDay()) {
  const v = String(value || '');
  if (v && !PROFILES.includes(v)) throw new Error('Невалиден избор');
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('repeatProfile', $2::text))
     on conflict (key) do update set value = zd.settings.value || jsonb_build_object('repeatProfile', $2::text)`, [settingsKey(shopId), v]);
  await refreshDay(q, shopId, day);
  return v;
}
const watchedList = (off) => Object.entries(RULE_NAMES).map(([rule, name]) => ({ rule, name, on: !off.has(rule) }));

/* ---- the platform's thresholds (the owner tunes them by the report, without a deploy) ---- */
const LIMITS_KEY = 'advisor:limits';
async function loadLimits(q) {
  const [r] = await q(`select value from zd.settings where key = $1`, [LIMITS_KEY]);
  try { setLimits(r ? json(r.value) : null); } catch { setLimits(null); } // a stored set that no longer validates: the defaults
  return { ...LIMITS };
}
export async function saveLimits(q, v) {
  const clean = cleanLimits(v);
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [LIMITS_KEY, JSON.stringify(clean)]);
  setLimits(clean);
  return clean;
}

/** The pass of the day: only the request that stored the day's numbers runs it (two first looks at once do it once). */
async function dailyPass(q, shopId, day) {
  await loadLimits(q);
  const metrics = await shopMetrics(q, shopId, day);
  const stored = await q(`insert into zd.advisor_daily (shop_id, day, metrics) values ($1::uuid, $2::date, $3::text::jsonb)
     on conflict (shop_id, day) do nothing returning day`, [shopId, day, JSON.stringify(metrics)]);
  if (!stored.length) return;

  // checks that reached their day: the result in numbers and euros
  const due = await q(`select * from zd.advisor_cards where shop_id = $1::uuid and state = 'checking' and check_until <= $2::date`, [shopId, day]);
  for (const r of due) {
    const c = json(r.card);
    const card = { rule: r.rule, valueAtStart: Number(r.value_at_start), target: Number(r.target), subject: c.subject || '', euros: Number(r.euros) };
    const j = judge(card, metrics);
    await q(`update zd.advisor_cards set state = 'done', result = $2, value_at_end = $3, euros = $4, card = card || jsonb_build_object('resultText', $5::text), updated_at = $6::timestamptz
       where id = $1::uuid`, [r.id, j.result, j.end, j.euros, resultText(card, j), stamp(day)]);
  }
  // yesterday's cards nobody acted on expire (kept for the report); the ones that still matter come back with today's numbers
  await q(`update zd.advisor_cards set state = 'expired', updated_at = $2::timestamptz where shop_id = $1::uuid and state = 'shown'`, [shopId, stamp(day)]);
  await q(`delete from zd.advisor_cards where shop_id = $1::uuid and state = 'expired' and created_at < now() - interval '400 days'`, [shopId]);

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
  else await loadLimits(q);
  const [row] = await q(`select metrics from zd.advisor_daily where shop_id = $1::uuid and day = $2::date`, [shopId, day]);
  const m = json(row.metrics);
  const rows = await q(`select * from zd.advisor_cards where shop_id = $1::uuid
     and (state in ('shown', 'checking') or (state = 'done' and updated_at >= ($2::date)::timestamp)) order by created_at`, [shopId, minus(day, 14)]);
  const [won] = await q(`select coalesce(sum(euros), 0) as euros, count(*)::int as n from zd.advisor_cards where shop_id = $1::uuid and state = 'done' and result in ('success', 'partial')`, [shopId]);
  const off = await offRules(q, shopId);
  const cards = rows.filter((r) => r.state === 'shown').sort((a, b) => (json(a.card).rank ?? 0) - (json(b.card).rank ?? 0)).map(rowToCard);
  return {
    day, ready: m.orders30 >= LIMITS.minOrders, orders30: m.orders30, month: await monthSummary(q, shopId, day, { unseenOnly: true }),
    // the payback level is the ads metric: hidden when the shop switched it off
    payback: m.payback && !off.has('ads_loss') ? { ...m.payback, level: paybackLevel(m.payback.value) } : null,
    cards, chance: cards.length ? null : opportunity(m),
    checking: rows.filter((r) => r.state === 'checking').map(rowToCard),
    results: rows.filter((r) => r.state === 'done' && r.result).map(rowToCard),
    watched: watchedList(off),
    funnel: m.funnel || null,
    profile: { value: m.repeatProfile || '', suggested: m.profileSuggested || '', secondOrderDays: m.secondOrderDays ?? null },
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

/* ---- the month in one line: inside Ordyx (a panel on the card) and as a push on the 1st — no e-mail ---- */
const MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const prevMonth = (day) => { const [y, mo] = day.split('-').map(Number); const p = mo === 1 ? [y - 1, 12] : [y, mo - 1]; return `${p[0]}-${String(p[1]).padStart(2, '0')}`; };

/** Last calendar month for one shop: cards shown, acted on, results and the euros they brought. null when the advisor was silent. */
export async function monthSummary(q, shopId, day = sofiaDay(), { unseenOnly = false } = {}) {
  const month = prevMonth(day), from = `${month}-01`, to = `${day.slice(0, 7)}-01`;
  if (unseenOnly && (await readSettings(q, shopId)).summarySeen === month) return null;
  const [r] = await q(`select count(*) filter (where created_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and created_at < ($3::date)::timestamp at time zone 'Europe/Sofia')::int as shown,
       count(distinct rule) filter (where created_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and created_at < ($3::date)::timestamp at time zone 'Europe/Sofia')::int as rules,
       count(*) filter (where acted and updated_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and created_at < ($3::date)::timestamp at time zone 'Europe/Sofia')::int as acted,
       count(*) filter (where state = 'done' and result in ('success', 'partial') and updated_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and updated_at < ($3::date)::timestamp at time zone 'Europe/Sofia')::int as won,
       coalesce(sum(euros) filter (where state = 'done' and result in ('success', 'partial') and updated_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and updated_at < ($3::date)::timestamp at time zone 'Europe/Sofia'), 0) as euros
     from zd.advisor_cards where shop_id = $1::uuid`, [shopId, from, to]);
  if (!r.shown && !r.acted && !r.won) return null;
  const name = MONTHS[Number(month.slice(5)) - 1];
  const euros = Math.round(Number(r.euros) * 100) / 100;
  const text = r.acted
    ? `През ${name} приложи ${r.acted} ${r.acted === 1 ? 'съвет' : 'съвета'}` + (r.won ? `, ${r.won} ${r.won === 1 ? 'даде' : 'дадоха'} резултат — около ${eur(euros)} на месец.` : '. Резултатите идват, щом изтече проверката.')
    : `През ${name} съветникът видя ${r.rules} ${r.rules === 1 ? 'проблем' : 'проблема'}, но не приложи нито един съвет. Отвори „Табло“ и започни с първия.`;
  return { month, name, shown: r.shown, acted: r.acted, won: r.won, euros, text };
}

/** The shop saw the month's summary: it is not shown again. */
export async function markSummarySeen(q, shopId, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('Невалиден месец');
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('summarySeen', $2::text))
     on conflict (key) do update set value = zd.settings.value || jsonb_build_object('summarySeen', $2::text)`, [settingsKey(shopId), month]);
}

/** On the first days of a month (nightly job): the summary as a push to the shop's followers, once per shop and month. */
export async function sendMonthlySummaries(q, notify, day = sofiaDay()) {
  if (Number(day.slice(8)) > 3) return { sent: 0 }; // the 1st; the 2nd and 3rd catch a missed night
  const month = prevMonth(day);
  const shops = await q(`select distinct c.shop_id, s.name from zd.advisor_cards c join zd.shops s on s.id = c.shop_id
     where c.created_at >= (($1 || '-01')::date)::timestamp at time zone 'Europe/Sofia'`, [month]);
  let sent = 0;
  for (const { shop_id: shopId, name } of shops) {
    if ((await readSettings(q, shopId)).summarySent === month) continue;
    const s = await monthSummary(q, shopId, day);
    if (s) { await notify(q, shopId, { title: `💡 ${name || 'Магазинът'}: съветникът за ${s.name}`, body: s.text, url: `/admin/?shop=${shopId}#dash` }); sent++; }
    await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('summarySent', $2::text))
       on conflict (key) do update set value = zd.settings.value || jsonb_build_object('summarySent', $2::text)`, [settingsKey(shopId), month]);
  }
  return { sent };
}

/* ---- the owner's report: how each metric does across all shops — the basis for tuning the thresholds ---- */
export async function advisorReport(q, { days = 90, shopIds = null } = {}) {
  const rows = await q(`select rule, count(*)::int as shown, count(*) filter (where acted)::int as acted,
       count(*) filter (where result = 'success')::int as success, count(*) filter (where result = 'partial')::int as partial,
       count(*) filter (where result = 'none')::int as none, count(*) filter (where state = 'dismissed' and dismiss_reason = 'doing')::int as doing,
       count(*) filter (where state = 'dismissed' and dismiss_reason = 'not_for_me')::int as not_for_me,
       coalesce(sum(euros) filter (where result in ('success', 'partial')), 0) as euros, count(distinct shop_id)::int as shops
     from zd.advisor_cards where created_at >= now() - make_interval(days => $1) and ($2::uuid[] is null or shop_id = any($2::uuid[]))
     group by rule`, [days, shopIds]);
  const by = Object.fromEntries(rows.map((r) => [r.rule, r]));
  await loadLimits(q);
  return {
    days, limits: { ...LIMITS }, defaults: { ...DEFAULT_LIMITS },
    rules: Object.entries(RULE_NAMES).map(([rule, name]) => {
      const r = by[rule] || { shown: 0, acted: 0, success: 0, partial: 0, none: 0, doing: 0, not_for_me: 0, euros: 0, shops: 0 };
      return { rule, name, shown: r.shown, acted: r.acted, success: r.success, partial: r.partial, none: r.none, doing: r.doing, notForMe: r.not_for_me,
        euros: Math.round(Number(r.euros) * 100) / 100, shops: r.shops };
    }),
  };
}
