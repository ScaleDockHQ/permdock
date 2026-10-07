import type { ResourceNode } from "../core/permissions.ts";
import type { ShimGrants } from "./rls-shims.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { partitionsOf, scopeField } from "../core/tenancy.ts";
import { HELPERS, qualified } from "./rls-helpers.ts";
import {
  permittedForHelper,
  permittedIdsHelper,
  quoteIdent,
  quoteLiteral,
  scopeTypeOf,
} from "./rls-sql.ts";

/** The helpers that take a permission key instead of a grant key. Names are part of the SQL contract. */
const PERMISSION_HELPERS = {
  grantKeys: "grant_keys",
  has: "permdock_has_permission",
  hasFor: "permdock_has_permission_for",
} as const;

/** `permitted_<scope>_permission_keys(p_id)`: every permission key the subject holds on one instance. */
function permissionKeysHelper(scope: string): string {
  permittedIdsHelper(scope);
  return `permitted_${scope}_permission_keys`;
}

/** `permitted_<scope>_ids_by_permission(p_permission)`. */
export function permittedByPermissionHelper(scope: string): string {
  return `${permittedIdsHelper(scope)}_by_permission`;
}

/**
 * A grant's `requires` as SQL: the subject holds `key` globally, or on the
 * row's instance of a scope that partitions it, through the helpers by
 * permission key, as `requirementCondition` does in process.
 */
export function requiresSql(
  ctx: RlsSqlContext,
  key: string,
  resource: ResourceNode | undefined,
): string {
  const literal = quoteLiteral(key);
  const parts = [
    `(select ${qualified(ctx, PERMISSION_HELPERS.has)}(${literal}))`,
    ...(resource === undefined ? [] : partitionsOf(resource, ctx.scopes)).map(
      (scope) => {
        const field = scopeField(resource, scope, ctx.scopes) ?? scope;
        return `${quoteIdent(field)} in (select ${qualified(ctx, checkName(permittedByPermissionHelper(scope)))}(${literal}))`;
      },
    ),
  ];
  return `(${parts.join(" or ")})`;
}

/** Postgres truncates an identifier past 63 bytes, which would merge two helpers. */
function checkName(name: string): string {
  if (new TextEncoder().encode(name).length > 63) {
    throw new Error(
      `PermDock CLI: the helper name ${name} is longer than 63 bytes; use a shorter scope name`,
    );
  }
  return name;
}

function grantsFunction(
  ctx: RlsSqlContext,
  grants: ShimGrants,
  renamed: Readonly<Record<string, string>>,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, PERMISSION_HELPERS.grantKeys);
  const map = Object.fromEntries(
    [...grants].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const current =
    Object.keys(renamed).length === 0
      ? "p_permission"
      : `coalesce(${quoteLiteral(JSON.stringify(renamed))}::jsonb ->> p_permission, p_permission)`;
  return `-- the grant keys a permission key reaches on one scope: its unconditional allows, with p_effect 'deny' every deny, and with 'conditioned-allow' or 'conditioned-deny' the allows or denies that carry a row condition
create or replace function ${fn}(p_permission text, p_scope text, p_effect text default 'allow')
returns setof text
language sql
stable
set search_path = ''
as $$
  select g.grant_key
  from pg_catalog.jsonb_array_elements_text(coalesce(
    ${quoteLiteral(JSON.stringify(map))}::jsonb -> p_scope -> ${current} -> p_effect,
    '[]'::jsonb
  )) g(grant_key)
$$;
${grantsSql(fn, "text, text, text", anonExecute)}`;
}

function grantsSql(fn: string, args: string, anonExecute: boolean): string {
  return anonExecute
    ? `revoke execute on function ${fn}(${args}) from public;
grant execute on function ${fn}(${args}) to anon, authenticated;`
    : `revoke execute on function ${fn}(${args}) from public, anon;
grant execute on function ${fn}(${args}) to authenticated;`;
}

function definer(
  fn: string,
  params: string,
  returns: string,
  sql: string,
): string {
  return `create or replace function ${fn}(${params})
returns ${returns}
language sql
stable
security definer
set search_path = ''
as $$
${sql}
$$;`;
}

/**
 * The permission-key forms of the helpers: `grant_keys`, which maps a
 * permission key to the grant keys of its unconditional allows on a scope
 * (or every deny key, or the conditioned allow or deny keys),
 * `permdock_has_permission(p_permission)` and one
 * `permitted_<scope>_ids_by_permission(p_permission)` per scope, plus their
 * `_for(p_user, ...)` forms in `database` mode. They answer with the
 * unconditional allows minus any deny, so a permission whose allows all carry
 * a row condition answers nothing. The
 * `permitted_<scope>_ids_by_permission(p_permission, p_conditioned)` overload
 * with `true` also lists the instances a conditioned allow reaches and
 * subtracts only unconditional denies, leaving the row condition to the
 * caller, as `permittedIds(..., { conditioned: true })` does in process.
 */
export function permissionHelpersSql(
  ctx: RlsSqlContext,
  grants: ShimGrants,
  renamed: Readonly<Record<string, string>>,
  anonExecute: boolean,
): string {
  const keys = qualified(ctx, PERMISSION_HELPERS.grantKeys);
  const allowKeys = (scope: string): string =>
    `${keys}(p_permission, ${quoteLiteral(scope)}) g(grant_key)`;
  const denyKeys = (scope: string): string =>
    `${keys}(p_permission, ${quoteLiteral(scope)}, 'deny') g(grant_key)`;
  const has = (helper: string, user: string): string =>
    `  select exists (select 1 from ${allowKeys("global")} where ${helper}(${user}g.grant_key))
    and not exists (select 1 from ${denyKeys("global")} where ${helper}(${user}g.grant_key))`;
  const ids = (helper: string, scope: string, user: string): string =>
    `  select a.id
  from ${allowKeys(scope)}
  cross join lateral ${helper}(${user}g.grant_key) a(id)
  except
  select d.id
  from ${denyKeys(scope)}
  cross join lateral ${helper}(${user}g.grant_key) d(id)`;
  const conditionedIds = (
    helper: string,
    scope: string,
    user: string,
  ): string =>
    `  select a.id
  from (
    select g.grant_key from ${allowKeys(scope)}
    union all
    select g.grant_key from ${keys}(p_permission, ${quoteLiteral(scope)}, 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral ${helper}(${user}g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from ${denyKeys(scope)}
    except
    select g.grant_key from ${keys}(p_permission, ${quoteLiteral(scope)}, 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral ${helper}(${user}g.grant_key) d(id)`;
  const heldKeys = (scope: string): string => {
    const held = [
      ...new Set([
        ...Object.keys(grants.get("global") ?? {}),
        ...Object.keys(grants.get(scope) ?? {}),
      ]),
    ].toSorted();
    return held.length === 0
      ? "array[]::text[]"
      : `array[${held.map(quoteLiteral).join(", ")}]::text[]`;
  };
  const keysOn = (
    scope: string,
    hasHelper: string,
    idsHelper: string,
    user: string,
  ): string =>
    `  select k.key
  from pg_catalog.unnest(${heldKeys(scope)}) k(key)
  where ${hasHelper}(${user}k.key)
    or p_id in (select ${idsHelper}(${user}k.key))`;
  const chunks = [
    grantsFunction(ctx, grants, renamed, anonExecute),
    `-- the helpers by permission key: unconditional allows minus any deny
${definer(
  qualified(ctx, PERMISSION_HELPERS.has),
  "p_permission text",
  "boolean",
  has(qualified(ctx, HELPERS.has), ""),
)}
${grantsSql(qualified(ctx, PERMISSION_HELPERS.has), "text", anonExecute)}`,
  ];
  for (const scope of ctx.scopes) {
    const fn = qualified(
      ctx,
      checkName(permittedByPermissionHelper(scope.name)),
    );
    chunks.push(`${definer(
      fn,
      "p_permission text",
      `setof ${scopeTypeOf(ctx, scope.name)}`,
      ids(qualified(ctx, permittedIdsHelper(scope.name)), scope.name, ""),
    )}
${grantsSql(fn, "text", anonExecute)}`);
    const keysFn = qualified(ctx, checkName(permissionKeysHelper(scope.name)));
    chunks.push(`-- the permission keys the caller holds on one ${scope.name}: what permdock_has_permission or permitted_${scope.name}_ids_by_permission answers for each key, in one call
${definer(
  keysFn,
  `p_id ${scopeTypeOf(ctx, scope.name)}`,
  "setof text",
  keysOn(scope.name, qualified(ctx, PERMISSION_HELPERS.has), fn, ""),
)}
${grantsSql(keysFn, scopeTypeOf(ctx, scope.name), anonExecute)}`);
    chunks.push(`-- with p_conditioned true, also the instances a conditioned allow reaches, minus only unconditional denies: the caller applies the row condition
${definer(
  fn,
  "p_permission text, p_conditioned boolean",
  `setof ${scopeTypeOf(ctx, scope.name)}`,
  conditionedIds(
    qualified(ctx, permittedIdsHelper(scope.name)),
    scope.name,
    "",
  ),
)}
${grantsSql(fn, "text, boolean", anonExecute)}`);
  }
  if (ctx.authorize !== "database") {
    return `${chunks.join("\n\n")}\n`;
  }
  const user = ctx.dialect === "supabase" ? "uuid" : "text";
  const revoke = (fn: string): string =>
    `revoke execute on function ${fn}(${user}, text) from public, anon, authenticated;`;
  const hasFor = qualified(ctx, PERMISSION_HELPERS.hasFor);
  chunks.push(`-- the same for a user the caller names; no client role may execute them
${definer(
  hasFor,
  `p_user ${user}, p_permission text`,
  "boolean",
  has(qualified(ctx, HELPERS.hasFor), "p_user, "),
)}
${revoke(hasFor)}`);
  for (const scope of ctx.scopes) {
    const fn = qualified(
      ctx,
      checkName(`${permittedByPermissionHelper(scope.name)}_for`),
    );
    chunks.push(`${definer(
      fn,
      `p_user ${user}, p_permission text`,
      `setof ${scopeTypeOf(ctx, scope.name)}`,
      ids(
        qualified(ctx, permittedForHelper(scope.name)),
        scope.name,
        "p_user, ",
      ),
    )}
${revoke(fn)}`);
    chunks.push(`${definer(
      fn,
      `p_user ${user}, p_permission text, p_conditioned boolean`,
      `setof ${scopeTypeOf(ctx, scope.name)}`,
      conditionedIds(
        qualified(ctx, permittedForHelper(scope.name)),
        scope.name,
        "p_user, ",
      ),
    )}
revoke execute on function ${fn}(${user}, text, boolean) from public, anon, authenticated;`);
    const keysFor = qualified(
      ctx,
      checkName(`${permissionKeysHelper(scope.name)}_for`),
    );
    chunks.push(`${definer(
      keysFor,
      `p_user ${user}, p_id ${scopeTypeOf(ctx, scope.name)}`,
      "setof text",
      keysOn(scope.name, hasFor, fn, "p_user, "),
    )}
revoke execute on function ${keysFor}(${user}, ${scopeTypeOf(ctx, scope.name)}) from public, anon, authenticated;`);
  }
  return `${chunks.join("\n\n")}\n`;
}
