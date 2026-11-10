-- Ordyx Съветник (docs/superpowers/specs/2026-11-10-advisor-design.md): the shop's numbers once a day and the cards it was shown.
create table if not exists zd.advisor_daily (
  shop_id uuid not null references zd.shops(id) on delete cascade,
  day date not null,
  metrics jsonb not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, day)
);

create table if not exists zd.advisor_cards (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references zd.shops(id) on delete cascade,
  rule text not null,
  created_at timestamptz not null default now(),
  -- shown → checking (the shop acted, or the number is being watched) → done; dismissed hides the rule for a while
  state text not null default 'shown' check (state in ('shown', 'checking', 'done', 'dismissed')),
  acted boolean not null default false,
  metric text not null default '',
  value_at_start numeric,
  target numeric,
  check_until date,
  result text check (result in ('success', 'partial', 'none')),
  value_at_end numeric,
  euros numeric not null default 0, -- the problem's cost a month when shown; the gain when done
  card jsonb not null default '{}'::jsonb, -- texts as shown (numbers frozen at that day)
  dismiss_reason text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists advisor_cards_shop_idx on zd.advisor_cards (shop_id, created_at desc);
-- production (Supabase): grant select, insert, update, delete on zd.advisor_daily, zd.advisor_cards to zd_app
