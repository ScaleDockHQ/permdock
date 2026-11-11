-- better-supabase add --adopt: the rows and settings of permissions that no data migration holds yet.

set lock_timeout = '5s';

-- permissions
insert into better_supabase.blocks (name, version, mode)
values ('permissions', 1, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
