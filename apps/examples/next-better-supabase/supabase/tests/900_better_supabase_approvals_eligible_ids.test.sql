-- better-supabase module: approvals
-- @bsb-block-test approvals
-- @bsb-hash sha256:9526edacafbbcc4fad24f037e202d59fb10ae797f5b746d1c8e9d983316690b2
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $$
declare
  u record;
  bad bigint := 0;
begin
  for u in select a.id from auth.users a order by a.id limit 25 loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', u.id, 'role', 'authenticated')::text, true);
    if (
      select coalesce(array_agg(r."id" order by r."id"), '{}') from "better_supabase"."approval_requests" r
      where r."status" = 'pending' and "better_supabase"."approval_eligible"(r."id")
    ) is distinct from (
      select coalesce(array_agg(x order by x), '{}') from "better_supabase"."approval_eligible_ids"() x
    ) then
      bad := bad + 1;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('better_supabase.parity', bad::text, true);
end;
$$;

select extensions.is(
  current_setting('better_supabase.parity')::bigint,
  0::bigint,
  'approval_eligible_ids returns the pending requests approval_eligible accepts, for every user'
);

select * from extensions.finish();
rollback;
