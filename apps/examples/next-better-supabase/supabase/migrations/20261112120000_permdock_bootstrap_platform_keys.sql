create or replace function "permdock".permdock_bootstrap_permissions(p_tenant text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with pdk_k(key, n) as (
    select k.key, (k.n - 1)::integer
    from unnest(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[]) with ordinality as k(key, n)
  ),
  pdk_t(id) as (
    select t.id from "permdock".member_organization_ids() as t(id)
    where p_tenant is null or t.id::text = p_tenant
  ),
  pdk_p(n) as (
    select k.n from "permdock".permitted_organization_permission_keys(null::uuid) h(key) join pdk_k k on k.key = h.key
    where k.key = any(array[]::text[])
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'apiVersion', 1,
    'form', 'compact',
    'keys', to_jsonb(array['audit.read', 'audit.revert', 'quotes.list', 'quotes.read', 'quotes.update', 'roles.manage', 'staff.list', 'staff.read']::text[]),
    'tenants', coalesce((
      select jsonb_object_agg(t.id::text, (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 0) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select k.n from "permdock".permitted_organization_permission_keys(t.id) h(key) join pdk_k k on k.key = h.key) x(n) group by 1
      ) b on b.i = g.i))
      from pdk_t t
    ), '{}'::jsonb),
    'platform', case when exists (select 1 from pdk_p) then (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 0) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select p.n from pdk_p p) x(n) group by 1
      ) b on b.i = g.i) end
  ))
$$;
revoke execute on function "permdock".permdock_bootstrap_permissions(text) from public, anon, authenticated;
grant execute on function "permdock".permdock_bootstrap_permissions(text) to authenticated;
