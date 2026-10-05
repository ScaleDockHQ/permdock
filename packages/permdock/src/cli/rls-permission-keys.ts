import type { ShimGrants } from "./rls-shims.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { HELPERS, qualified } from "./rls-helpers.ts";
import {
  permittedForHelper,
  permittedIdsHelper,
  quoteLiteral,
  scopeTypeOf,
} from "./rls-sql.ts";

/** The helpers that take a permission key instead of a grant key. Names are part of the SQL contract. */
const PERMISSION_HELPERS = {
  grantKeys: "grant_keys",
  has: "permdock_has_permission",
  hasFor: "permdock_has_permission_for",
} as const;

/** `permitted_<scope>_ids_by_permission(p_permission)`. */
function permittedByPermissionHelper(scope: string): string {
  return `${permittedIdsHelper(scope)}_by_permission`;
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
  return `-- the grant keys a permission key reaches on one scope: its unconditional allows, or with p_effect 'deny' every deny
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
 * (or every deny key), `permdock_has_permission(p_permission)` and one
 * `permitted_<scope>_ids_by_permission(p_permission)` per scope, plus their
 * `_for(p_user, ...)` forms in `database` mode. They answer with the
 * unconditional allows minus any deny, so a permission whose allows all carry
 * a row condition answers nothing: SQL that applies the condition itself
 * still names the condition group's grant key.
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
  }
  return `${chunks.join("\n\n")}\n`;
}
