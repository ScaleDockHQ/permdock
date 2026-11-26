-- better-supabase module: entitlements
-- @bsb-block entitlements@1 managed
-- @bsb-hash sha256:0812447ddc44f742c5c06773fb64d0b82c0b2c583d1cee7af28661cf87a1735d
-- Active Stripe entitlements per tenant from the Stripe Sync Engine, feature_claims() for the access token hook, and has_entitlement() and tenant_ids_with_entitlement() for RLS.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

grant usage on schema better_supabase to supabase_auth_admin;

-- Lookup keys of the tenant's active entitlements, from the Stripe Sync
-- Engine's stripe.active_entitlements. Empty before the engine is installed.
create or replace function better_supabase.tenant_entitlements(tenant uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer_id text := better_supabase.tenant_stripe_customer(tenant);
begin
  if customer_id is null or to_regclass('stripe.active_entitlements') is null then
    return '{}';
  end if;
  return coalesce((
    select array_agg(distinct e.lookup_key order by e.lookup_key)
    from stripe.active_entitlements e
    where e.customer = customer_id
      and e.lookup_key is not null
  ), '{}');
end
$$;

revoke execute on function better_supabase.tenant_entitlements(uuid) from public, anon, authenticated;
grant execute on function better_supabase.tenant_entitlements(uuid) to service_role, supabase_auth_admin;

-- The value of a feature for the tenant: true when it has the key, null
-- otherwise. Numeric limits come from the plan catalog's value column.
create or replace function better_supabase.tenant_entitlement_value(tenant uuid, key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when key = any (better_supabase.tenant_entitlements(tenant)) then 'true'::jsonb end
$$;

revoke execute on function better_supabase.tenant_entitlement_value(uuid, text) from public, anon, authenticated;
grant execute on function better_supabase.tenant_entitlement_value(uuid, text) to service_role;

-- Memberships come from the authorization provider (PermDock), in its
-- organization scope: authorization.functions.memberIds and memberIdsFor.

-- using ((select better_supabase.has_entitlement(organization_id, 'exports')))
create or replace function better_supabase.has_entitlement(tenant uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id))
    and key = any (better_supabase.tenant_entitlements(tenant))
$$;

revoke execute on function better_supabase.has_entitlement(uuid, text) from public, anon;
grant execute on function better_supabase.has_entitlement(uuid, text) to authenticated, service_role;

-- The value of a feature for a member of the tenant: a number or text from
-- the plan catalog's value column, true for a feature without one, null
-- when the tenant lacks it or the caller is not a member.
create or replace function better_supabase.entitlement_value(tenant uuid, key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id)) then better_supabase.tenant_entitlement_value(tenant, key) end
$$;

revoke execute on function better_supabase.entitlement_value(uuid, text) from public, anon;
grant execute on function better_supabase.entitlement_value(uuid, text) to authenticated, service_role;

-- Every tenant of the caller with `key`, for one set check per query instead of
-- one call per row:
--   using (organization_id in (select better_supabase.tenant_ids_with_entitlement('exports')))
create or replace function better_supabase.tenant_ids_with_entitlement(key text)
returns setof uuid
language sql
rows 1
stable
security definer
set search_path = ''
as $$
  select t.id::uuid from permdock.member_organization_ids() as t(id)
  where key = any (better_supabase.tenant_entitlements(t.id::uuid))
$$;

revoke execute on function better_supabase.tenant_ids_with_entitlement(text) from public, anon;
grant execute on function better_supabase.tenant_ids_with_entitlement(text) to authenticated, service_role;

-- The `features` claim: { [organization id]: lookup keys }, read by
-- hasEntitlement(). Register it with the provider's access token hook, which
-- runs as supabase_auth_admin, so that role needs execute on what
-- memberIdsFor calls.
create or replace function better_supabase.feature_claims(user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(r.tenant, to_jsonb(r.keys)), '{}'::jsonb)
  from (
    select t.id::text as tenant, e.keys
    from permdock.member_organization_ids_for(feature_claims.user_id) as t(id)
    cross join lateral (select better_supabase.tenant_entitlements(t.id::uuid) as keys) e
    where cardinality(e.keys) > 0
    order by 1
  ) r
$$;

revoke execute on function better_supabase.feature_claims(uuid) from public, anon, authenticated;
grant execute on function better_supabase.feature_claims(uuid) to service_role, supabase_auth_admin;

-- config.entitlements: better_supabase.organizations.stripe_customer_id
create or replace function better_supabase.tenant_stripe_customer(tenant uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (select t."stripe_customer_id" from "better_supabase"."organizations" t where t."id" = tenant);
end
$$;

create or replace function better_supabase.stripe_customer_tenants(customer text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query select t."id" from "better_supabase"."organizations" t where t."stripe_customer_id" = customer;
end
$$;

-- Users whose features claim carries the customer's entitlements, for
-- invalidating their sessions after entitlements.active_entitlement_summary.updated.
create or replace function better_supabase.entitlement_members(customer text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m."user_id"::uuid
  from "public"."organization_memberships" m
  where m."organization_id"::text in (select t::text from better_supabase.stripe_customer_tenants(customer) t)
$$;

revoke execute on function better_supabase.tenant_stripe_customer(uuid) from public, anon, authenticated;
revoke execute on function better_supabase.stripe_customer_tenants(text) from public, anon, authenticated;
revoke execute on function better_supabase.entitlement_members(text) from public, anon, authenticated;
grant execute on function better_supabase.entitlement_members(text) to service_role;
