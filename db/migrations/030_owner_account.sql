-- 👑 An email account that is the platform owner (the owner's phone logs in with an email). Set in the database only — no admin screen writes it.
alter table zd.users add column if not exists is_owner boolean not null default false;
