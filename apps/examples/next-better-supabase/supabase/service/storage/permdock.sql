-- Supabase Storage policies from rls.storage.
-- These policies sit outside the scoped declarative sync: pg-delta's shadow database has no storage.objects.
-- Apply this file with an unscoped sync only where the Storage service has created the table.
drop policy if exists "permdock_storage_quote_files_select" on "storage"."objects";
create policy "permdock_storage_quote_files_select"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes((storage.foldername(name))[1]::uuid, 'quotes.read'));

drop policy if exists "permdock_storage_quote_files_insert" on "storage"."objects";
create policy "permdock_storage_quote_files_insert"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
  with check (bucket_id = 'quote-files'
    and "permdock".can_quotes((storage.foldername(name))[1]::uuid, 'quotes.update'));

drop policy if exists "permdock_storage_quote_files_update" on "storage"."objects";
create policy "permdock_storage_quote_files_update"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes((storage.foldername(name))[1]::uuid, 'quotes.update'))
  with check (bucket_id = 'quote-files'
    and "permdock".can_quotes((storage.foldername(name))[1]::uuid, 'quotes.update'));

drop policy if exists "permdock_storage_quote_files_delete" on "storage"."objects";
create policy "permdock_storage_quote_files_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes((storage.foldername(name))[1]::uuid, 'quotes.update'));

drop policy if exists "storage_objects_insert_read_only_actors" on "storage"."objects";
create policy "storage_objects_insert_read_only_actors"
  on "storage"."objects"
  as restrictive
  for insert
  to authenticated
  with check ((select "permdock".permdock_actor_may_write()));

drop policy if exists "storage_objects_update_read_only_actors" on "storage"."objects";
create policy "storage_objects_update_read_only_actors"
  on "storage"."objects"
  as restrictive
  for update
  to authenticated
  using ((select "permdock".permdock_actor_may_write()))
  with check ((select "permdock".permdock_actor_may_write()));

drop policy if exists "storage_objects_delete_read_only_actors" on "storage"."objects";
create policy "storage_objects_delete_read_only_actors"
  on "storage"."objects"
  as restrictive
  for delete
  to authenticated
  using ((select "permdock".permdock_actor_may_write()));
