-- Each user receives their own authz:<uid> topic, and no user may join the server topic.
-- This policy sits outside the scoped declarative sync: pg-delta's shadow database has no realtime.messages.
-- Apply this file with an unscoped sync only where the Realtime service has created the table.
create policy permdock_authz_version_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'authz:' || (select auth.uid())::text
  );
