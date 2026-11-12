import type { RlsSqlContext } from "../sql/context.ts";
import type { ShimGrants } from "./shims.ts";

import { scopeTypeOf } from "../sql/columns.ts";
import { BOOTSTRAP_PERMISSIONS, memberIdsHelper } from "../sql/names.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { rootName } from "../sql/shared.ts";
import { checkName, permissionKeysHelper } from "./permission-keys.ts";

function textArray(values: readonly string[]): string {
  return values.length === 0
    ? "array[]::text[]"
    : `array[${values.map(quoteLiteral).join(", ")}]::text[]`;
}

/**
 * The bitset of the key indexes `indexes` selects (column `n`, 0-based) over
 * `bytes` bytes, as better-supabase's `compactBootstrapPermissions` writes it:
 * bit `n % 8` of byte `n / 8`, least significant first, in base64url without
 * padding. Postgres `encode(…, 'base64')` breaks lines every 76 characters, so
 * the newlines go with the padding.
 */
function bitsetSql(indexes: string, bytes: number): string {
  return `(select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, ${String(bytes - 1)}) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (${indexes}) x(n) group by 1
      ) b on b.i = g.i)`;
}

/**
 * `permdock_bootstrap_permissions(p_tenant text default null) returns jsonb`:
 * the caller's permissions as better-supabase's compact
 * `BootstrapPermissionsWire` (`apiVersion: 1`, `form: 'compact'`). `keys` is
 * every permission key of the policy, sorted; each root-scope instance the
 * caller is a member of (only `p_tenant` when it is given) gets one bitset of
 * the keys `permitted_<root>_permission_keys` answers there, and `platform` the
 * keys `permdock_has_permission` grants. A tenant the caller is no member of,
 * an unknown or a malformed one answers no tenants. `security invoker`: every
 * helper it calls answers for the caller only. Execute belongs to
 * `authenticated`.
 */
export function bootstrapPermissionsSql(
  ctx: RlsSqlContext,
  keys: readonly string[],
  grants: ShimGrants,
): string {
  const fn = qualified(ctx, BOOTSTRAP_PERMISSIONS);
  const root = rootName(ctx);
  const bytes = Math.ceil(keys.length / 8);
  const platform = Object.entries(grants.get("global") ?? {})
    .filter(([key, effects]) => effects.allow.length > 0 && keys.includes(key))
    .map(([key]) => key)
    .toSorted();
  const memberIds = qualified(ctx, memberIdsHelper(root));
  const held = qualified(ctx, checkName(permissionKeysHelper(root)));
  return `-- the caller's permissions in better-supabase's compact BootstrapPermissionsWire: the policy's keys once, a bitset per ${root} the caller is a member of (p_tenant alone when given) and one for platform
create or replace function ${fn}(p_tenant text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with pdk_k(key, n) as (
    select k.key, (k.n - 1)::integer
    from unnest(${textArray(keys)}) with ordinality as k(key, n)
  ),
  pdk_t(id) as (
    select t.id from ${memberIds}() as t(id)
    where p_tenant is null or t.id::text = p_tenant
  ),
  pdk_p(n) as (
    select k.n from ${held}(null::${scopeTypeOf(ctx, root)}) h(key) join pdk_k k on k.key = h.key
    where k.key = any(${textArray(platform)})
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'apiVersion', 1,
    'form', 'compact',
    'keys', to_jsonb(${textArray(keys)}),
    'tenants', coalesce((
      select jsonb_object_agg(t.id::text, ${bitsetSql(
        `select k.n from ${held}(t.id) h(key) join pdk_k k on k.key = h.key`,
        bytes,
      )})
      from pdk_t t
    ), '{}'::jsonb),
    'platform', case when exists (select 1 from pdk_p) then ${bitsetSql("select p.n from pdk_p p", bytes)} end
  ))
$$;
revoke execute on function ${fn}(text) from public, anon, authenticated;
grant execute on function ${fn}(text) to authenticated;
`;
}
