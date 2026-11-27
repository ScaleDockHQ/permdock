-- better-supabase add --adopt: the rows and settings of approvals that no data migration holds yet.

set lock_timeout = '5s';

-- approvals
insert into better_supabase.blocks (name, version, mode)
values ('approvals', 8, 'managed')
on conflict (name) do update
  set version = excluded.version, mode = excluded.mode, updated_at = now();
