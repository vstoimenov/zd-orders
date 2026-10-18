// Meta (Facebook/Instagram) ads: daily spend of one ad account via the Marketing API, with a System User token (ads_read).
import { getIntegration, getSecret, saveIntegration } from './integrations-repo.js';
import { sofiaDay } from './visits.js';
import { humanize } from './errors-bg.js';
import { DEFAULT_SHOP } from './shops.js';
import { seal, open } from './secretbox.js';

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
  if ([10, 200, 294].includes(code) || /permission/i.test(m)) {
    return new Error(`Няма достъп до рекламния акаунт — при „Вход с Facebook“ изберете портфолиото и рекламния акаунт изрично (Meta: ${m.slice(0, 120)})`);
  }
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

/* ---- "Вход с Facebook": the platform's Meta app (META_APP_ID / META_APP_SECRET in Vercel) ---- */
const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
export const metaAppConfigured = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
export const metaRedirectUri = () => `${base()}/api/admin/meta`;

export function oauthDialogUrl(state) {
  const u = new URL('https://www.facebook.com/v26.0/dialog/oauth');
  u.searchParams.set('client_id', process.env.META_APP_ID);
  u.searchParams.set('redirect_uri', metaRedirectUri());
  u.searchParams.set('state', state);
  // Facebook Login for Business: a configuration (ads_read, ad accounts, token type) — Meta recommends it instead of scope
  if (process.env.META_CONFIG_ID) u.searchParams.set('config_id', process.env.META_CONFIG_ID);
  else u.searchParams.set('scope', 'ads_read');
  u.searchParams.set('response_type', 'code');
  return u.toString();
}

/**
 * Login code → token and when it expires (null = never). A user token is exchanged for a long-lived one (about 60 days);
 * a system-user token from a configuration comes back without an expiry and is kept as it is.
 */
export async function exchangeCode(code, fetchImpl = fetch) {
  const tokenUrl = (params) => {
    const u = new URL(`${GRAPH}/oauth/access_token`);
    for (const [k, v] of Object.entries({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, ...params })) u.searchParams.set(k, v);
    return u;
  };
  const first = await graphGet(tokenUrl({ redirect_uri: metaRedirectUri(), code: String(code) }), fetchImpl);
  if (!first?.access_token) throw new Error('Facebook не върна ключ — опитайте отново');
  if (!first.expires_in) return { token: first.access_token, expiresAt: null }; // system-user token: does not expire
  const at = (seconds) => new Date(Date.now() + Number(seconds) * 1000).toISOString();
  try {
    const long = await graphGet(tokenUrl({ grant_type: 'fb_exchange_token', fb_exchange_token: first.access_token }), fetchImpl);
    if (long?.access_token) return { token: long.access_token, expiresAt: long.expires_in ? at(long.expires_in) : null };
  } catch { /* keep the first token */ }
  return { token: first.access_token, expiresAt: at(first.expires_in) };
}

/** Ad accounts this token can read (for the picker). */
/** The permissions this token really has (Facebook grants ads_read only when an ad account was chosen in the login). */
export async function grantedPermissions(token, fetchImpl = fetch) {
  const d = await graphGet(graphUrl('/me/permissions', {}, token), fetchImpl);
  return new Set((Array.isArray(d?.data) ? d.data : []).filter((p) => p.status === 'granted').map((p) => p.permission));
}

export async function listAdAccounts(token, fetchImpl = fetch) {
  const get = (fields) => graphGet(graphUrl('/me/adaccounts', { fields, limit: '200' }, token), fetchImpl);
  const base = 'account_id,name,currency,account_status';
  // the portfolio name needs business_management; a login that granted only ads_read lists the accounts without it
  const d = await get(`${base},business{name}`).catch((e) => (/business_management/.test(e.message) ? get(base) : Promise.reject(e)));
  if (!Array.isArray(d?.data)) throw new Error('Meta върна непълен отговор — опитайте отново');
  return d.data.map((a) => ({
    id: String(a.account_id || '').replace(/^act_/, ''), name: String(a.name || ''), currency: String(a.currency || ''),
    active: Number(a.account_status) === 1, business: String(a.business?.name || ''),
  }));
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

/* ---- "Свържи чрез споделяне": shops share their ad account with the platform's business; one system-user token reads them all.
   Works without Meta's App Review: the app, the business and the system user are the platform's own. ---- */
const PLATFORM = 'meta_platform';
async function graphPost(path, params, token, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(GRAPH + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, access_token: token }).toString(), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Meta не отговори навреме — опитайте отново' : 'Няма връзка с Meta — опитайте отново');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || data?.error) throw Object.assign(metaError(data?.error, res.status), { metaCode: Number(data?.error?.code) || 0 });
  return data;
}
async function platform(q) {
  const [r] = await q(`select value from zd.settings where key = $1`, [PLATFORM]);
  const v = r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : null;
  return v?.token ? { token: open(v.token), systemUserId: v.systemUserId, businessId: v.businessId } : null;
}
/** The owner's one-time setup: the system user's token (checked with Meta, stored sealed) and the business shops share with. */
export async function savePlatform(q, { token, businessId } = {}, fetchImpl = fetch) {
  const t = String(token ?? '').trim(), b = String(businessId ?? '').replace(/\D/g, '');
  if (!t) throw new Error('Поставете ключа на системния потребител');
  if (!b) throw new Error('Въведете ID на бизнеса (Business Manager)');
  const me = await graphGet(graphUrl('/me', { fields: 'id,name' }, t), fetchImpl);
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('token', $2::text, 'systemUserId', $3::text, 'businessId', $4::text, 'at', now()))
     on conflict (key) do update set value = excluded.value`, [PLATFORM, seal(t), String(me.id), b]);
  return { systemUserId: String(me.id), businessId: b };
}
export async function partnerStatus(q) {
  const p = await platform(q).catch(() => null);
  return { enabled: Boolean(p), businessId: p?.businessId || '' };
}
/** A shop links an ad account it shared with the platform's business: the system user gets read access, the account belongs to this shop only. */
export async function linkPartnerAccount(q, { shopId, accountId }, fetchImpl = fetch) {
  const id = normalizeAccountId(accountId);
  const p = await platform(q);
  if (!p) throw new Error('Свързването чрез споделяне още не е включено — свържете се със собственика на Ordyx');
  const [taken] = await q(`select 1 from zd.integrations where provider = 'meta' and config->>'accountId' = $1 and coalesce(config->>'active', 'true') <> 'false'
     and shop_id <> $2::uuid`, [id, shopId]);
  if (taken) throw new Error('Този рекламен акаунт вече е свързан с друг магазин');
  try {
    await graphPost(`/act_${id}/assigned_users`, { user: p.systemUserId, tasks: JSON.stringify(['ANALYZE']) }, p.token, fetchImpl);
  } catch (err) {
    if (/^(Няма връзка|Meta не отговори|Meta ограничи)/.test(err.message)) throw err;
    throw new Error(`Рекламният акаунт ${id} още не е споделен с Ordyx. В Business Manager → Рекламни акаунти → Assign partner въведете ID ${p.businessId} с право „View performance“ и опитайте отново.`);
  }
  const a = await testAccount({ accountId: id, token: p.token }, fetchImpl);
  await saveIntegration(q, 'meta', { config: { mode: 'partner', accountId: id, accountName: a.name, currency: a.currency, active: true, oauth: false, lastError: null }, shopId });
  await q(`update zd.integrations set secret_enc = null where provider = 'meta' and shop_id = $1::uuid`, [shopId]);
  return { accountName: a.name, currency: a.currency };
}

/** A shop's connected Meta settings incl. the decrypted token (its own, or the platform's for a shared account), or null. */
export async function metaConfig(q, shopId = DEFAULT_SHOP) {
  const i = await getIntegration(q, 'meta', shopId);
  if (!i.config.accountId || i.config.active === false) return null;
  if (i.config.mode === 'partner') {
    const p = await platform(q);
    return p ? { ...i.config, shopId, token: p.token } : null;
  }
  if (!i.hasSecret) return null;
  return { ...i.config, shopId, token: await getSecret(q, 'meta', shopId) };
}

const validDay = (s) => DAY.test(String(s)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** Stores daily spend for a range (default: the last 7 days — Meta keeps refining recent results). */
export async function syncMeta(q, { from, to, shopId = DEFAULT_SHOP } = {}) {
  const until = to || sofiaDay();
  const since = from || sofiaDay(new Date(Date.parse(`${until}T12:00:00Z`) - 6 * 864e5));
  if (!validDay(since) || !validDay(until) || since > until) throw new Error('Невалидна дата');
  const cfg = await metaConfig(q, shopId);
  if (!cfg) throw new Error('Meta рекламите не са свързани');
  try {
    const rows = await fetchInsights(cfg, { since, until });
    await q(
      `insert into zd.ad_spend (shop_id, platform, account_id, day, spend, impressions, clicks, purchases, purchase_value, currency, updated_at)
       select $4::uuid, 'meta', $1, r.day::date, r.spend, r.impressions, r.clicks, r.purchases, r."purchaseValue", $2, now()
       from jsonb_to_recordset($3::text::jsonb) as r(day text, spend numeric, impressions bigint, clicks bigint, purchases int, "purchaseValue" numeric)
       on conflict (shop_id, platform, account_id, day) do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
         purchases = excluded.purchases, purchase_value = excluded.purchase_value, currency = excluded.currency, updated_at = now()`,
      [cfg.accountId, cfg.currency || 'EUR', JSON.stringify(rows), shopId],
    );
    // days Meta no longer reports (spend corrected to nothing) are removed
    await q(`delete from zd.ad_spend where shop_id = $5::uuid and platform = 'meta' and account_id = $1 and day between $2::date and $3::date and not (day = any($4::date[]))`,
      [cfg.accountId, since, until, rows.map((r) => r.day), shopId]);
    const result = { days: rows.length };
    // the admin may have switched accounts meanwhile: then this result is not the connected account's
    if ((await getIntegration(q, 'meta', shopId)).config.accountId === cfg.accountId) {
      await saveIntegration(q, 'meta', { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null }, shopId });
    }
    return result;
  } catch (err) {
    await saveIntegration(q, 'meta', { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() }, shopId });
    throw err;
  }
}
