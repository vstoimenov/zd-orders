-- one row per visitor per day (reloads and floods add nothing) + a daily-salted address hash to cap visitors per address
delete from zd.visits v using zd.visits w where v.day = w.day and v.site = w.site and v.visitor = w.visitor and v.id > w.id;
alter table zd.visits add column if not exists ip_hash text not null default '';
create unique index if not exists visits_day_site_visitor_uidx on zd.visits (day, site, visitor);
create index if not exists visits_day_site_ip_idx on zd.visits (day, site, ip_hash);
