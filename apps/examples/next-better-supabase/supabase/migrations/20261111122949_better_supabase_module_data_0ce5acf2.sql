-- better-supabase add --adopt: the rows and settings of audit that no data migration holds yet.

set lock_timeout = '5s';

-- audit
insert into better_supabase.blocks (name, version, mode)
values ('audit', 13, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
