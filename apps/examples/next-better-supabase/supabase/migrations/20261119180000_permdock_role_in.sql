create or replace function "permdock".permdock_role_in(p_role text, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_role = any(array['contact', 'guest', 'member', 'owner']::text[])
    or exists (select 1 from "public"."roles" r where r."key"::text = p_role and (r."organization_id" = p_tenant or r."organization_id" is null))
$$;
revoke execute on function "permdock".permdock_role_in(text, uuid) from public, anon, authenticated;
