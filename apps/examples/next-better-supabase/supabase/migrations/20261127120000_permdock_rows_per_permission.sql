create or replace function "permdock".permitted_quotes_rows(p_permission text)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
begin
  if p_permission = 'quotes.create' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.create'))));
  elsif p_permission = 'quotes.delete' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.delete')))) and ("status" = 'draft'));
  elsif p_permission = 'quotes.list' then
    return query
    with permdock_hoisted as materialized (
    select
    coalesce((((select auth.jwt()) -> 'api_key')) is null or (((select auth.jwt()) -> 'api_key')) = 'null'::jsonb, false) as key_unlimited
  )
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row, permdock_hoisted
      where (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list')))) or ((permdock_hoisted.key_unlimited or (select "permdock".permdock_api_key_allows('quotes.list'))) and ("customer_id" = any(array(select "permdock".member_customer_ids())))));
  elsif p_permission = 'quotes.read' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read')))));
  elsif p_permission = 'quotes.send' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.send')))) and ("status" = 'draft'));
  elsif p_permission = 'quotes.update' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update'))));
  else
    return query select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where "permdock".permitted_quotes_match(permdock_row, p_permission);
  end if;
end;
$$;
create or replace function "permdock".permitted_quotes_rows(p_permission text, p_tenant uuid)
returns setof uuid
language plpgsql
stable
security definer
cost 1000
parallel safe
set search_path = ''
as $$
begin
  if p_permission = 'quotes.create' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.create'))));
  elsif p_permission = 'quotes.delete' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.delete')))) and ("status" = 'draft'));
  elsif p_permission = 'quotes.list' then
    return query
    with permdock_hoisted as materialized (
    select
    coalesce((((select auth.jwt()) -> 'api_key')) is null or (((select auth.jwt()) -> 'api_key')) = 'null'::jsonb, false) as key_unlimited
  )
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row, permdock_hoisted
      where permdock_row."organization_id" = p_tenant and (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list')))) or ((permdock_hoisted.key_unlimited or (select "permdock".permdock_api_key_allows('quotes.list'))) and ("customer_id" = any(array(select "permdock".member_customer_ids())))));
  elsif p_permission = 'quotes.read' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read')))));
  elsif p_permission = 'quotes.send' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and (("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.send')))) and ("status" = 'draft'));
  elsif p_permission = 'quotes.update' then
    return query
    select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and ("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update'))));
  else
    return query select permdock_row."id"::uuid from "public"."quotes" as permdock_row
      where permdock_row."organization_id" = p_tenant and "permdock".permitted_quotes_match(permdock_row, p_permission);
  end if;
end;
$$;
