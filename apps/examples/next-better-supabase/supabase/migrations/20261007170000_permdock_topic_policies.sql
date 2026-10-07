-- rls.realtime and rls.storage policies now call permitted_<scope>_ids_by_permission, so a
-- relationship grant on the same permission never reaches a topic or a folder.
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
        and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.read') x));
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
        and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x));
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
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.read') x));
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
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x));
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
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x))
      with check (bucket_id = 'quote-files'
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x));
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
        and (storage.foldername(name))[1] in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x));
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
