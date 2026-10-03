-- Data, not schema, so pg-delta does not diff it: the tables the bs_audit
-- triggers record, minus updated_at, which every update changes.
insert into better_supabase.audited_tables (target, ignore) values
  ('public.organizations', '{updated_at}'),
  ('public.customers', '{updated_at}'),
  ('public.contacts', '{updated_at}'),
  ('public.staff', '{updated_at}'),
  ('public.quotes', '{updated_at}'),
  ('public.datetime_preferences', '{updated_at}')
on conflict (target) do update set ignore = excluded.ignore;
