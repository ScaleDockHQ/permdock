-- Supabase Realtime policies from rls.realtime.
-- These policies sit outside the scoped declarative sync: pg-delta's shadow database has no realtime.messages.
-- Apply this file with an unscoped sync only where the Realtime service has created the table.
drop policy if exists "permdock_realtime_org_organization_quotes_select" on "realtime"."messages";
create policy "permdock_realtime_org_organization_quotes_select"
  on "realtime"."messages"
  as permissive
  for select
  to authenticated
  using (extension in ('broadcast', 'presence')
    and (select realtime.topic()) ~ '^org:[^:]+:quotes$'
    and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.read') x));

drop policy if exists "permdock_realtime_org_organization_quotes_insert" on "realtime"."messages";
create policy "permdock_realtime_org_organization_quotes_insert"
  on "realtime"."messages"
  as permissive
  for insert
  to authenticated
  with check (extension in ('broadcast', 'presence')
    and (select realtime.topic()) ~ '^org:[^:]+:quotes$'
    and split_part((select realtime.topic()), ':', 2) in (select x::text from "permdock".permitted_organization_ids_by_permission('quotes.update') x));

drop policy if exists "realtime_messages_insert_read_only_actors" on "realtime"."messages";
create policy "realtime_messages_insert_read_only_actors"
  on "realtime"."messages"
  as restrictive
  for insert
  to authenticated
  with check ((select "permdock".permdock_actor_may_write()));
