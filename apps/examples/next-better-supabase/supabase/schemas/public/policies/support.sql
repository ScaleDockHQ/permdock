-- Policy delegations stop at the server: in Postgres a support token is its user.
-- A support session writes only when better-supabase started it with read_only false.
drop policy if exists "quotes_support_read_only" on "public"."quotes";
create policy "quotes_support_read_only"
  on "public"."quotes"
  as restrictive
  for update
  to authenticated
  using (
    not coalesce(
      (select auth.jwt() -> 'act' ->> 'kind') = 'support'
        or (select auth.jwt() -> 'act') ? 'session_id',
      false
    )
    or (select auth.jwt() -> 'act' ->> 'read_only') = 'false'
  );
