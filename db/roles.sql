-- Least-privilege role for the zd-orders Vercel functions. Run once in Supabase, never in tests.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'zd_app') then
    create role zd_app login noinherit;
  end if;
end $$;
grant usage on schema zd to zd_app;
grant select, insert, update, delete on all tables in schema zd to zd_app;
alter default privileges in schema zd grant select, insert, update, delete on tables to zd_app;
revoke all on schema zd from anon, authenticated;
