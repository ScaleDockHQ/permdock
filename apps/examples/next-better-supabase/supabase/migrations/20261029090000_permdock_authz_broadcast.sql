-- sends every version bump on the server topic and on the user's authz:<uid>
create or replace function "permdock".permdock_broadcast_authz_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    perform realtime.send(jsonb_build_object('user_id', new.user_id, 'version', new.version), 'changed', 'better_supabase:authz', true);
    perform realtime.send(jsonb_build_object('user_id', new.user_id, 'version', new.version), 'changed', 'authz:' || new.user_id::text, true);
  end if;
  return null;
end;
$$;
revoke execute on function "permdock".permdock_broadcast_authz_version() from public, anon, authenticated;
create or replace trigger permdock_authz_version_broadcast
  after insert or update on "permdock"."permdock_authz_version"
  for each row execute function "permdock".permdock_broadcast_authz_version();

-- each user receives their own authz:<uid> topic, and no user may join the server topic
do $$
begin
  if to_regclass('realtime.messages') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'permdock_authz_version_receive'
  ) then
    create policy permdock_authz_version_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) = 'authz:' || (select auth.uid())::text
      );
  end if;
end;
$$;
