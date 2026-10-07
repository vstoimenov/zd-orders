// Meta (Facebook/Instagram) ads: daily spend of one ad account via the Marketing API, with a System User token (ads_read).
import { getIntegration, getSecret, saveIntegration } from './integrations-repo.js';
import { sofiaDay } from './visits.js';
import { humanize } from './errors-bg.js';

export const GRAPH = 'https://graph.facebook.com/v26.0';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PURCHASE_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];

export function normalizeAccountId(v) {
  const id = String(v ?? '').trim().replace(/^act_/i, '');
  if (!/^\d{1,20}$/.test(id)) throw new Error('Невалиден ID на рекламния акаунт — само цифри, напр. 1234567890 (може и с act_ отпред)');
  return id;
}

/** Graph API error → what the shop owner should do, in Bulgarian. */
export function metaError(err, status) {
  const code = Number(err?.code), sub = Number(err?.error_subcode), m = String(err?.message || `HTTP ${status}`);
  if (code === 190) return new Error('Ключът (access token) е невалиден или изтекъл — създайте нов System User token');
  if (code === 100 && (sub === 33 || /does not exist|cannot be loaded/i.test(m))) return new Error('Няма такъв рекламен акаунт или ключът няма достъп до него');
  if ([10, 200, 294].includes(code) || /permission/i.test(m)) return new Error('Ключът няма право да чете рекламите — нужно е право ads_read и достъп до рекламния акаунт');
  if ([4, 17, 32, 613, 80000, 80004].includes(code)) return new Error('Meta ограничи заявките за момента — опитайте след няколко минути');
  return new Error(`Грешка от Meta: ${m}`);
}

async function graphGet(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Meta не отговори навреме — опитайте отново' : 'Няма връзка с Meta — опитайте отново');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || data?.error) throw metaError(data?.error, res.status);
  return data;
}

function graphUrl(path, params, token) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  u.searchParams.set('access_token', token);
  return u;
}

export async function testAccount({ accountId, token }, fetchImpl = fetch) {
  const a = await graphGet(graphUrl(`/act_${accountId}`, { fields: 'name,currency,account_status' }, token), fetchImpl);
  return { name: String(a.name || ''), currency: String(a.currency || 'EUR'), status: a.account_status ?? null };
}

export function parseInsight(r) {
  const pick = (list) => {
    const byType = new Map((Array.isArray(list) ? list : []).map((a) => [a.action_type, Number(a.value) || 0]));
    const t = PURCHASE_TYPES.find((x) => byType.has(x));
    return t ? byType.get(t) : 0;
  };
  return {
    day: String(r.date_start), spend: Number(r.spend) || 0, impressions: Math.trunc(Number(r.impressions) || 0),
    clicks: Math.trunc(Number(r.clicks) || 0), purchases: Math.trunc(pick(r.actions)), purchaseValue: Math.round(pick(r.action_values) * 100) / 100,
  };
}

/** Daily account totals between two YYYY-MM-DD days (account time zone), following Meta's pages. */
export async function fetchInsights({ accountId, token }, { since, until }, fetchImpl = fetch) {
  let url = graphUrl(`/act_${accountId}/insights`, {
    level: 'account', time_increment: '1', time_range: { since, until }, fields: 'spend,impressions,clicks,actions,action_values', limit: '100',
  }, token);
  const out = [];
  // only a complete answer counts: the caller deletes days Meta no longer reports, so a partial one must fail instead
  for (let page = 0; url; page++) {
    if (page >= 30) throw new Error('Периодът е твърде голям — изберете по-кратък');
    const d = await graphGet(url, fetchImpl);
    if (!Array.isArray(d?.data)) throw new Error('Meta върна непълен отговор — опитайте отново');
    out.push(...d.data.map(parseInsight));
    url = d?.paging?.next ? new URL(d.paging.next) : null;
    if (url && url.origin !== 'https://graph.facebook.com') throw new Error('Meta върна непълен отговор — опитайте отново'); // only Meta's own links
  }
  return out;
}

/** Connected Meta settings incl. the decrypted token, or null when not set up / switched off. */
export async function metaConfig(q) {
  const i = await getIntegration(q, 'meta');
  if (!i.hasSecret || !i.config.accountId || i.config.active === false) return null;
  return { ...i.config, token: await getSecret(q, 'meta') };
}

const validDay = (s) => DAY.test(String(s)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** Stores daily spend for a range (default: the last 7 days — Meta keeps refining recent results). */
export async function syncMeta(q, { from, to } = {}) {
  const until = to || sofiaDay();
  const since = from || sofiaDay(new Date(Date.parse(`${until}T12:00:00Z`) - 6 * 864e5));
  if (!validDay(since) || !validDay(until) || since > until) throw new Error('Невалидна дата');
  const cfg = await metaConfig(q);
  if (!cfg) throw new Error('Meta рекламите не са свързани');
  try {
    const rows = await fetchInsights(cfg, { since, until });
    await q(
      `insert into zd.ad_spend (platform, account_id, day, spend, impressions, clicks, purchases, purchase_value, currency, updated_at)
       select 'meta', $1, r.day::date, r.spend, r.impressions, r.clicks, r.purchases, r."purchaseValue", $2, now()
       from jsonb_to_recordset($3::text::jsonb) as r(day text, spend numeric, impressions bigint, clicks bigint, purchases int, "purchaseValue" numeric)
       on conflict (platform, account_id, day) do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
         purchases = excluded.purchases, purchase_value = excluded.purchase_value, currency = excluded.currency, updated_at = now()`,
      [cfg.accountId, cfg.currency || 'EUR', JSON.stringify(rows)],
    );
    // days Meta no longer reports (spend corrected to nothing) are removed
    await q(`delete from zd.ad_spend where platform = 'meta' and account_id = $1 and day between $2::date and $3::date and not (day = any($4::date[]))`,
      [cfg.accountId, since, until, rows.map((r) => r.day)]);
    const result = { days: rows.length };
    // the admin may have switched accounts meanwhile: then this result is not the connected account's
    if ((await getIntegration(q, 'meta')).config.accountId === cfg.accountId) {
      await saveIntegration(q, 'meta', { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null } });
    }
    return result;
  } catch (err) {
    await saveIntegration(q, 'meta', { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() } });
    throw err;
  }
}
