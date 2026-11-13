// Partners: every client has a link (ordyx.eu/?ref=CODE); whoever registers through it is referred by that client, and 50% of each
// subscription payment of a referred client is the partner's commission, for as long as the client pays. The owner pays it out
// (bank transfer) and records the payout; the partner sees link, clients, earned, paid and the balance in „Профил“.
import { randomBytes } from 'node:crypto';

export const COMMISSION = 0.5;
const CODE = /^[a-z0-9]{6,16}$/;
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const site = () => (process.env.LANDING_BASE_URL || 'https://ordyx.eu').replace(/\/$/, '');
export const refLink = (code) => `${site()}/?ref=${code}`;

/** The client's partner code, made the first time it is asked for. */
export async function ensureRefCode(q, userId) {
  const [u] = await q(`select ref_code from zd.users where id = $1::uuid`, [userId]);
  if (!u) throw new Error('Клиентът не е намерен');
  if (u.ref_code) return u.ref_code;
  for (let i = 0; i < 5; i++) {
    const code = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, '0');
    const [r] = await q(`update zd.users set ref_code = $2 where id = $1::uuid and ref_code is null and not exists (select 1 from zd.users where ref_code = $2) returning ref_code`, [userId, code]);
    if (r) return r.ref_code;
    const [again] = await q(`select ref_code from zd.users where id = $1::uuid`, [userId]);
    if (again?.ref_code) return again.ref_code;
  }
  throw new Error('Линкът не се създаде — опитайте пак');
}

/** A new account registered through a partner's link: referred by that partner (never by itself, set once). */
export async function attachReferrer(q, userId, code) {
  const c = String(code || '').toLowerCase().trim();
  if (!CODE.test(c)) return null;
  const [r] = await q(
    `update zd.users u set referred_by = p.id from zd.users p
     where u.id = $1::uuid and p.ref_code = $2 and p.id <> u.id and u.referred_by is null returning p.id`, [userId, c]);
  return r ? r.id : null;
}

/** What the partner sees: the link, the clients it brought, every commission, what was paid out and the balance. */
export async function affiliateSummary(q, userId) {
  const code = await ensureRefCode(q, userId);
  const [clients, commissions, payouts] = await Promise.all([
    q(`select u.name, u.created_at, u.sub_plan, (select count(*)::int from zd.payments p where p.user_id = u.id) as payments
       from zd.users u where u.referred_by = $1::uuid order by u.created_at desc`, [userId]),
    q(`select to_char(p.paid_at, 'YYYY-MM-DD') as paid_at, p.amount, u.name from zd.payments p join zd.users u on u.id = p.user_id
       where u.referred_by = $1::uuid order by p.paid_at desc, p.created_at desc limit 200`, [userId]),
    q(`select to_char(paid_at, 'YYYY-MM-DD') as paid_at, amount, note from zd.payouts where user_id = $1::uuid order by paid_at desc, created_at desc`, [userId]),
  ]);
  const earned = r2(commissions.reduce((s, c) => s + Number(c.amount) * COMMISSION, 0));
  const paidOut = r2(payouts.reduce((s, p) => s + Number(p.amount), 0));
  return {
    code, link: refLink(code), rate: COMMISSION,
    // a first name only: the partner learns who came, not the client's account
    clients: clients.map((c) => ({ name: String(c.name || '').split(' ')[0] || 'Клиент', joinedAt: new Date(c.created_at).toISOString(), plan: c.sub_plan || '', paying: c.payments > 0 })),
    commissions: commissions.map((c) => ({ paidAt: c.paid_at, name: String(c.name || '').split(' ')[0] || 'Клиент', payment: Number(c.amount), commission: r2(Number(c.amount) * COMMISSION) })),
    payouts: payouts.map((p) => ({ paidAt: p.paid_at, amount: Number(p.amount), note: p.note })),
    earned, paidOut, balance: r2(earned - paidOut),
  };
}

/** The owner's view: every partner who brought someone, with what is owed. */
export async function listPartners(q) {
  const rows = await q(
    `select p.id, p.name, p.email, p.ref_code,
       (select count(*)::int from zd.users u where u.referred_by = p.id) as clients,
       (select coalesce(sum(x.amount), 0) from zd.payments x join zd.users u on u.id = x.user_id where u.referred_by = p.id) as paid_by_clients,
       (select coalesce(sum(o.amount), 0) from zd.payouts o where o.user_id = p.id) as paid_out
     from zd.users p where exists (select 1 from zd.users u where u.referred_by = p.id) order by p.name`);
  return rows.map((r) => {
    const earned = r2(Number(r.paid_by_clients) * COMMISSION), paidOut = r2(r.paid_out);
    return { id: r.id, name: r.name, email: r.email, code: r.ref_code, clients: r.clients, earned, paidOut, balance: r2(earned - paidOut) };
  });
}

/** The owner paid a partner (bank transfer). */
export async function addPayout(q, userId, { amount, paidAt, note = '' } = {}) {
  const sum = Number(String(amount ?? '').replace(',', '.'));
  if (!Number.isFinite(sum) || sum <= 0) throw new Error('Невалидна сума');
  const day = paidAt && /^\d{4}-\d{2}-\d{2}$/.test(String(paidAt)) ? String(paidAt) : new Date().toLocaleDateString('sv', { timeZone: 'Europe/Sofia' });
  await q(`insert into zd.payouts (user_id, paid_at, amount, note) values ($1::uuid, $2::date, $3, $4)`, [userId, day, r2(sum), String(note || '').trim().slice(0, 200)]);
}
