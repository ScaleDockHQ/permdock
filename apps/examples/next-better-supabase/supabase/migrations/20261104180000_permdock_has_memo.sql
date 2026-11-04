SET local check_function_bodies = off;

create or replace function "permdock".permdock_has(p_grant text)
returns boolean
language plpgsql
volatile
security definer
cost 1000
set search_path = ''
as $$
declare
  v_user text := (select "permdock".permdock_user_id())::text;
  v_key text := 'permdock.m.' || 'global' || '.k' || (hashtext(p_grant) & 1023)::text;
  v_disc text := md5(concat_ws('|',
      v_user,
      p_grant,
      coalesce((select auth.jwt()) ->> 'authz_ver', ''),
      coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
      statement_timestamp()::text,
      md5(coalesce((select auth.jwt())::text, ''))
    ));
  v_memo text := nullif(current_setting(v_key, true), '');
  v_has boolean;
begin
  if v_memo is not null and (v_memo::jsonb ->> 'k') = v_disc then
    return (v_memo::jsonb ->> 'v')::boolean;
  end if;
  v_has := (
  select exists (
    select 1
    from "permdock".user_roles ur
    join "permdock".role_permissions rp on rp.role = ur.role::text
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
      and rp.scope = 'global'
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['contact', 'guest', 'member', 'owner']::text[]))
      and p_grant in (select "permdock".permdock_custom_keys(
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'allow'),
      array(select c.permission from "permdock".custom_role_permissions c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text and c.effect = 'deny'),
      array(select c.include_role from "permdock".custom_role_includes c where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text),
      'global'
    ))
  )
  );
  perform set_config(v_key, jsonb_build_object('k', v_disc, 'v', v_has)::text, true);
  return v_has;
end;
$$;
