import type { RlsSqlContext } from "../sql/context.ts";

import { rootScope } from "../../core/scopes.ts";
import { scopeTypeOf } from "../sql/columns.ts";
import { permittedIdsHelper } from "../sql/names.ts";
import { qualified } from "../sql/quote.ts";
import { subjectClaimSql } from "../sql/subject.ts";
import { memoizes } from "./helper-bodies.ts";

/**
 * `permitted_<scope>_id_array(p_grant)`: the ids of a scope a grant key
 * reaches, as one array.
 */
function idArrayHelper(scope: string): string {
  return permittedIdsHelper(scope).replace(/_ids$/u, "_id_array");
}

/**
 * `permdock_<root scope>_has(p_grant, p_tenant)`, named after the root scope
 * (`permdock_tenant_has` for a scope called `tenant`).
 */
function scopeHasHelper(scope: string): string {
  return permittedIdsHelper(scope)
    .replace(/^permitted_/u, "permdock_")
    .replace(/_ids$/u, "_has");
}

/**
 * `permdock_<root>_has_active(p_grant)`: the same test as
 * `permdock_<root>_has`, with the tenant read from the token. The answer
 * depends only on the caller's grants of that key in the active tenant.
 */
function scopeHasActiveHelper(scope: string): string {
  return `${scopeHasHelper(scope)}_active`;
}

/**
 * The active tenant, or null when the claim is absent. An empty string is not
 * cast: `''::uuid` throws, and no tenant must answer false.
 */
export function activeTenantSql(ctx: RlsSqlContext, type: string): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')::${type}`;
}

/**
 * `permitted_<scope>_id_array(p_grant)` for one scope: a policy writes
 * `<column> = any(<array>)`, which an index on the column serves. The root
 * scope also gets `permdock_<scope>_has(p_grant, p_tenant)`, one membership
 * test for one tenant that reads the same array.
 */
export function setHelpersSql(
  ctx: RlsSqlContext,
  scope: string,
  anonExecute: boolean,
): string {
  const type = scopeTypeOf(ctx, scope);
  // A memoising ids helper writes a setting, which a parallel worker cannot.
  const parallel = memoizes(ctx) ? "" : "\nparallel safe";
  const array = qualified(ctx, idArrayHelper(scope));
  const grants = (fn: string, args: string): string =>
    anonExecute
      ? `revoke execute on function ${fn}(${args}) from public;\ngrant execute on function ${fn}(${args}) to anon, authenticated;`
      : `revoke execute on function ${fn}(${args}) from public, anon;\ngrant execute on function ${fn}(${args}) to authenticated;`;
  const chunks = [
    `-- ${scope} ids a grant key reaches, as one array, for \`<column> = any(...)\`
create or replace function ${array}(p_grant text)
returns ${type}[]
language sql
stable
security definer
cost 1000${parallel}
set search_path = ''
as $$
  select coalesce(array_agg(i), '{}'::${type}[]) from ${qualified(ctx, permittedIdsHelper(scope))}(p_grant) i
$$;
${grants(array, "text")}`,
  ];
  if (rootScope(ctx.scopes) === scope) {
    const fn = qualified(ctx, scopeHasHelper(scope));
    chunks.push(`-- whether a grant key reaches one ${scope}
create or replace function ${fn}(p_grant text, p_tenant ${type})
returns boolean
language sql
stable
security definer
cost 1000${parallel}
set search_path = ''
as $$
  select p_tenant = any(${array}(p_grant))
$$;
${grants(fn, `text, ${type}`)}`);
    const active = qualified(ctx, scopeHasActiveHelper(scope));
    chunks.push(`-- the same test for the tenant the token names; a shared function calls it with a literal key
create or replace function ${active}(p_grant text)
returns boolean
language sql
stable
security invoker
cost 1000${parallel}
set search_path = ''
as $$
  select ${fn}(p_grant, ${activeTenantSql(ctx, type)})
$$;
${grants(active, "text")}`);
  }
  return chunks.join("\n");
}
