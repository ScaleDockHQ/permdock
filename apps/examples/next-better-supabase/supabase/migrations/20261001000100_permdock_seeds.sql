-- permdock:seeds v1 schema=permdock
insert into "permdock".role_permissions (role, permission, grant_key, scope, effect) values
  ('owner', 'staff.read', 'staff.read', 'organization', 'allow'),
  ('owner', 'staff.list', 'staff.list', 'organization', 'allow'),
  ('owner', 'quotes.read', 'quotes.read', 'organization', 'allow'),
  ('owner', 'quotes.list', 'quotes.list', 'organization', 'allow'),
  ('owner', 'quotes.update', 'quotes.update', 'organization', 'allow'),
  ('member', 'staff.read', 'staff.read', 'organization', 'allow'),
  ('member', 'staff.list', 'staff.list', 'organization', 'allow'),
  ('contact', 'quotes.read', 'quotes.read', 'customer', 'allow'),
  ('contact', 'quotes.list', 'quotes.list', 'customer', 'allow')
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
delete from "permdock".role_permissions
where (role, grant_key, scope) not in (values
  ('owner', 'staff.read', 'organization'),
  ('owner', 'staff.list', 'organization'),
  ('owner', 'quotes.read', 'organization'),
  ('owner', 'quotes.list', 'organization'),
  ('owner', 'quotes.update', 'organization'),
  ('member', 'staff.read', 'organization'),
  ('member', 'staff.list', 'organization'),
  ('contact', 'quotes.read', 'customer'),
  ('contact', 'quotes.list', 'customer')
);

-- Supabase Realtime and Storage: rls.realtime and rls.storage. RLS on both tables is Supabase's. A stack without the service has no table, so each policy is skipped there.
do $permdock$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists "permdock_realtime_org_organization_quotes_select" on "realtime"."messages";
    create policy "permdock_realtime_org_organization_quotes_select"
      on "realtime"."messages"
      as permissive
      for select
      to authenticated
      using (extension in ('broadcast', 'presence')
        and (select realtime.topic()) ~ '^org:[^:]+:quotes$'
        and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids('quotes.read') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists "permdock_realtime_org_organization_quotes_insert" on "realtime"."messages";
    create policy "permdock_realtime_org_organization_quotes_insert"
      on "realtime"."messages"
      as permissive
      for insert
      to authenticated
      with check (extension in ('broadcast', 'presence')
        and (select realtime.topic()) ~ '^org:[^:]+:quotes$'
        and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids('quotes.update') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "permdock_storage_quote_files_select" on "storage"."objects";
    create policy "permdock_storage_quote_files_select"
      on "storage"."objects"
      as permissive
      for select
      to authenticated
      using (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids('quotes.read') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "permdock_storage_quote_files_insert" on "storage"."objects";
    create policy "permdock_storage_quote_files_insert"
      on "storage"."objects"
      as permissive
      for insert
      to authenticated
      with check (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids('quotes.update') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "permdock_storage_quote_files_update" on "storage"."objects";
    create policy "permdock_storage_quote_files_update"
      on "storage"."objects"
      as permissive
      for update
      to authenticated
      using (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids('quotes.update') x))
      with check (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids('quotes.update') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "permdock_storage_quote_files_delete" on "storage"."objects";
    create policy "permdock_storage_quote_files_delete"
      on "storage"."objects"
      as permissive
      for delete
      to authenticated
      using (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids('quotes.update') x));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists "realtime_messages_insert_read_only_actors" on "realtime"."messages";
    create policy "realtime_messages_insert_read_only_actors"
      on "realtime"."messages"
      as restrictive
      for insert
      to authenticated
      with check (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "storage_objects_insert_read_only_actors" on "storage"."objects";
    create policy "storage_objects_insert_read_only_actors"
      on "storage"."objects"
      as restrictive
      for insert
      to authenticated
      with check (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "storage_objects_update_read_only_actors" on "storage"."objects";
    create policy "storage_objects_update_read_only_actors"
      on "storage"."objects"
      as restrictive
      for update
      to authenticated
      using (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false))
      with check (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false));
  end if;
end
$permdock$;

do $permdock$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "storage_objects_delete_read_only_actors" on "storage"."objects";
    create policy "storage_objects_delete_read_only_actors"
      on "storage"."objects"
      as restrictive
      for delete
      to authenticated
      using (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = any(array['support', 'impersonation']::text[]) or ((((select auth.jwt()) -> 'act') ->> 'kind') is null and ((select auth.jwt()) -> 'act') ? 'session_id'), false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false));
  end if;
end
$permdock$;
