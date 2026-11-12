create or replace function "permdock".grant_keys(p_permission text, p_scope text, p_effect text default 'allow')
returns setof text
language plpgsql
stable
set search_path = ''
as $$
begin
  return query
  select g.grant_key
  from pg_catalog.jsonb_array_elements_text(coalesce(
    '{"customer":{"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]}},"organization":{"audit.read":{"allow":["audit.read"],"deny":[]},"audit.revert":{"allow":["audit.revert"],"deny":[]},"quotes.list":{"allow":["quotes.list"],"deny":[]},"quotes.read":{"allow":["quotes.read"],"deny":[]},"quotes.update":{"allow":["quotes.update"],"deny":[]},"roles.manage":{"allow":["roles.manage"],"deny":[]},"staff.list":{"allow":["staff.list"],"deny":[]},"staff.read":{"allow":["staff.read"],"deny":[]}}}'::jsonb -> p_scope -> p_permission -> p_effect,
    '[]'::jsonb
  )) g(grant_key);
end;
$$;
revoke execute on function "permdock".grant_keys(text, text, text) from public, anon;
grant execute on function "permdock".grant_keys(text, text, text) to authenticated;

create or replace function "permdock".permitted_quotes_match(p_row "public"."quotes", p_permission text)
returns boolean
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
begin
  return (
  with permdock_candidates as (select (p_row).*)
  select exists (select 1 from permdock_candidates where case p_permission
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list'))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else false
  end)
  );
end;
$$;
revoke execute on function "permdock".permitted_quotes_match("public"."quotes", text) from public, anon;
grant execute on function "permdock".permitted_quotes_match("public"."quotes", text) to authenticated;
