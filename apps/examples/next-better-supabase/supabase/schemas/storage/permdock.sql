-- Supabase Storage policies from rls.storage: static create policy statements on storage.objects.
create policy "permdock_storage_quote_files_select"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes(json_populate_record(null::"public"."quotes", json_build_object('id', (storage.foldername(name))[1]::uuid, 'organization_id', (storage.foldername(name))[1]::uuid)), 'quotes.read'::text));

create policy "permdock_storage_quote_files_insert"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
  with check (bucket_id = 'quote-files'
    and "permdock".can_quotes(json_populate_record(null::"public"."quotes", json_build_object('id', (storage.foldername(name))[1]::uuid, 'organization_id', (storage.foldername(name))[1]::uuid)), 'quotes.update'::text));

create policy "permdock_storage_quote_files_update"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes(json_populate_record(null::"public"."quotes", json_build_object('id', (storage.foldername(name))[1]::uuid, 'organization_id', (storage.foldername(name))[1]::uuid)), 'quotes.update'::text))
  with check (bucket_id = 'quote-files'
    and "permdock".can_quotes(json_populate_record(null::"public"."quotes", json_build_object('id', (storage.foldername(name))[1]::uuid, 'organization_id', (storage.foldername(name))[1]::uuid)), 'quotes.update'::text));

create policy "permdock_storage_quote_files_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
  using (bucket_id = 'quote-files'
    and "permdock".can_quotes(json_populate_record(null::"public"."quotes", json_build_object('id', (storage.foldername(name))[1]::uuid, 'organization_id', (storage.foldername(name))[1]::uuid)), 'quotes.update'::text));

create policy "storage_objects_insert_read_only_actors"
  on "storage"."objects"
  as restrictive
  for insert
  to authenticated
  with check ((select "permdock".permdock_actor_may_write()));

create policy "storage_objects_update_read_only_actors"
  on "storage"."objects"
  as restrictive
  for update
  to authenticated
  using ((select "permdock".permdock_actor_may_write()))
  with check ((select "permdock".permdock_actor_may_write()));

create policy "storage_objects_delete_read_only_actors"
  on "storage"."objects"
  as restrictive
  for delete
  to authenticated
  using ((select "permdock".permdock_actor_may_write()));
