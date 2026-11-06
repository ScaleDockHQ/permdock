import type { Policy, ResourceNode } from "../../index.ts";
import type { CompiledBranch } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { RowArm } from "./row-memo.ts";

import { flattenGrantee } from "../../core/grantee.ts";
import { listPermissions } from "../../core/permission-registry.ts";
import { policyLevels } from "../../core/policy.ts";
import { resolveScope, rootScope } from "../../core/scopes.ts";
import { configError } from "../core/errors.ts";
import { branchClauses } from "../sql/clauses.ts";
import { idTypeOf } from "../sql/columns.ts";
import { tableFor } from "../sql/compile.ts";
import { graphSqlName } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { memoizes } from "./helper-bodies.ts";
import { permittedByPermissionHelper } from "./permission-keys.ts";
import { orSql } from "./policies.ts";
import { memoRowSql, memoRowTriggersSql } from "./row-memo.ts";

/**
 * `permitted_<resource>_rows(p_permission)`: the resource's row ids the subject
 * may act on with one permission.
 */
export function rowsHelper(resource: string): string {
  const name = graphSqlName(resource);
  const helper = `permitted_${name ?? resource}_rows`;
  if (
    name === undefined ||
    new TextEncoder().encode(`${helper}_for`).length > 63
  ) {
    throw configError(
      `PermDock CLI: rls.rowHelpers cannot name a helper for resource '${resource}'; use a SQL name of at most 45 bytes`,
    );
  }
  return helper;
}

/**
 * A `<permission>@<level>` key a custom role may hold, with the row helper that
 * applies its condition.
 */
export type LevelKey = {
  readonly key: string;
  readonly permission: string;
  /** `false` for a level without a row condition, such as `all: {}`. */
  readonly conditioned: boolean;
  /** `permitted_<resource>_row`, unqualified. */
  readonly rowHelper: string;
};

/**
 * Every declared `<permission>@<level>` of an instance permission on a resource
 * with levels.
 */
export function levelKeys(policy: Policy): readonly LevelKey[] {
  const out: LevelKey[] = [];
  for (const leaf of listPermissions(policy.vocabulary.permissions)) {
    if (leaf.kind !== "instance") {
      continue;
    }
    for (const [level, condition] of policyLevels(policy, leaf.resource)) {
      out.push({
        key: `${leaf.key}@${level}`,
        permission: leaf.key,
        conditioned: !(
          condition.op === "and" && condition.conditions.length === 0
        ),
        rowHelper: `permitted_${graphSqlName(leaf.resource) ?? leaf.resource}_row`,
      });
    }
  }
  return out;
}

/**
 * The branches a row check of a permission reads: its allows and denies,
 * inserts included, for signed-in callers.
 */
function rowBranchesOf(
  branches: readonly CompiledBranch[],
  resource: string,
): ReadonlyMap<string, readonly CompiledBranch[]> {
  const out = new Map<string, CompiledBranch[]>();
  for (const branch of branches) {
    if (
      branch.resource !== resource ||
      branch.coverage === true ||
      !branch.roles.includes("authenticated")
    ) {
      continue;
    }
    out.set(branch.permissionKey, [
      ...(out.get(branch.permissionKey) ?? []),
      branch,
    ]);
  }
  return out;
}

/**
 * What a branch asks of a row: the `with check` of an insert, which sees the
 * new row, the `using` of every other command.
 */
function clauseOf(branch: CompiledBranch): string {
  const clauses = branchClauses(branch);
  return (
    (branch.command === "insert" ? clauses.check : clauses.using) ?? "true"
  );
}

function usingOf(branches: readonly CompiledBranch[]): string | undefined {
  const parts = branches.map(clauseOf);
  return parts.length === 0 ? undefined : orSql(parts);
}

function permissionCase(
  key: string,
  branches: readonly CompiledBranch[],
  tenantFirst: string | undefined,
): string | undefined {
  const allow = usingOf(branches.filter((branch) => branch.effect === "allow"));
  if (allow === undefined) {
    return undefined;
  }
  const deny = usingOf(branches.filter((branch) => branch.effect === "deny"));
  const granted = `coalesce((${allow}), false)`;
  const first = tenantFirst === undefined ? "" : `${tenantFirst} and `;
  return `    when ${quoteLiteral(key)} then ${first}${deny === undefined ? granted : `${granted} and (${deny}) is not true`}`;
}

function forUserSql(
  ctx: RlsSqlContext,
  fn: string,
  helper: string,
  ids: boolean,
  idType: string,
): string {
  const user = ctx.dialect === "supabase" ? "uuid" : "text";
  const signature = `${user}, text, ${ids ? `${idType}[], ` : ""}jsonb`;
  const call = `${helper}(p_permission${ids ? ", p_ids" : ""})`;
  const head = `create or replace function ${fn}(p_user ${user}, p_permission text, ${ids ? `p_ids ${idType}[], ` : ""}p_claims jsonb default '{}')
returns setof ${idType}
language plpgsql
volatile
security definer
set search_path = ''
as $$`;
  const tail = `revoke execute on function ${fn}(${signature}) from public, anon, authenticated;`;
  if (ctx.dialect === "supabase") {
    return `${head}
declare
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    (coalesce(p_claims, '{}'::jsonb) || pg_catalog.jsonb_build_object('sub', p_user::text, 'role', 'authenticated'))::text,
    true
  );
  return query select r.id from ${call} r(id);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end
$$;
${tail}`;
  }
  const prefix = ctx.gucPrefix;
  return `${head}
declare
  v_saved jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
begin
  for v_key, v_value in
    select 'user_id', p_user
    union all
    select c.key, c.value from pg_catalog.jsonb_each_text(coalesce(p_claims, '{}'::jsonb)) c where c.key <> 'user_id'
  loop
    v_saved := v_saved || pg_catalog.jsonb_build_object(v_key, coalesce(pg_catalog.current_setting(${quoteLiteral(`${prefix}.`)} || v_key, true), ''));
    perform pg_catalog.set_config(${quoteLiteral(`${prefix}.`)} || v_key, v_value, true);
  end loop;
  return query select r.id from ${call} r(id);
  for v_key, v_value in select s.key, s.value from pg_catalog.jsonb_each_text(v_saved) s loop
    perform pg_catalog.set_config(${quoteLiteral(`${prefix}.`)} || v_key, v_value, true);
  end loop;
end
$$;
${tail}`;
}

export function inheritTargets(policy: Policy): readonly string[] {
  const out = new Set<string>();
  for (const grant of policy.grants) {
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind === "inherit") {
        out.add(item.resource);
      }
    }
  }
  return [...out].toSorted();
}

/**
 * `cost 1000`, so the planner runs a helper after the cheap filters, and
 * `parallel safe` unless the scope helpers it calls keep a `set_config` memo,
 * which a parallel worker cannot write.
 */
function plannerOf(ctx: RlsSqlContext): string {
  return `cost 1000${memoizes(ctx) ? "" : "\nparallel safe"}`;
}

export const CANDIDATES = "permdock_candidates";

function rowSql(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
  table: string,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const fn = qualified(ctx, rowsHelper(node.name).replace(/_rows$/u, "_row"));
  const body =
    memoRowSql(
      ctx,
      policy,
      fn,
      `p_row ${table}`,
      graphSqlName(node.name) ?? node.name,
      armsOf(branches),
      `${CANDIDATES} as (select (p_row).*)`,
    ) ??
    `create or replace function ${fn}(p_row ${table}, p_permission text)
returns boolean
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  with ${CANDIDATES} as (select (p_row).*)
  select exists (select 1 from ${CANDIDATES} where ${whereOf(branches)})
$$;`;
  return `${body}
revoke execute on function ${fn}(${table}, text) from public, anon;
grant execute on function ${fn}(${table}, text) to authenticated;`;
}

function armsOf(
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
): readonly RowArm[] {
  return [...branches.keys()].toSorted().flatMap((key) => {
    const sql = permissionCase(key, branches.get(key) ?? [], undefined);
    return sql === undefined ? [] : [{ key, sql }];
  });
}

/**
 * `permitted_<resource>_row(p_id <type>, p_permission)`: the per-id form, which
 * reads the one row by its key so a caller holding an id never builds a row.
 */
function rowByIdSql(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
  table: string,
  idType: string,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const fn = qualified(ctx, rowsHelper(node.name).replace(/_rows$/u, "_row"));
  const id = quoteIdent(node.id);
  const source = `${CANDIDATES} as materialized (select * from ${table} where ${id} = p_id)`;
  const body =
    memoRowSql(
      ctx,
      policy,
      fn,
      `p_id ${idType}`,
      graphSqlName(node.name) ?? node.name,
      armsOf(branches),
      source,
    ) ??
    `create or replace function ${fn}(p_id ${idType}, p_permission text)
returns boolean
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  with ${source}
  select exists (select 1 from ${CANDIDATES} where ${whereOf(branches)})
$$;`;
  return `${body}
revoke execute on function ${fn}(${idType}, text) from public, anon;
grant execute on function ${fn}(${idType}, text) to authenticated;`;
}

function whereOf(
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
  tenantFirst?: (key: string) => string | undefined,
): string {
  const cases = [...branches.keys()].toSorted().flatMap((key) => {
    const sql = permissionCase(
      key,
      branches.get(key) ?? [],
      tenantFirst?.(key),
    );
    return sql === undefined ? [] : [sql];
  });
  return cases.length === 0
    ? "false"
    : `case p_permission\n${cases.join("\n")}\n    else false\n  end`;
}

function candidatesSql(
  fn: string,
  table: string,
  id: string,
  idType: string,
  where: string,
): string {
  const assign = (indent: string): string =>
    `${indent}v_row.${id} := v_id;\n${indent}v_rows := pg_catalog.array_append(v_rows, v_row);`;
  return `create or replace function ${fn}(p_permission text, p_ids ${idType}[])
returns setof ${idType}
language plpgsql
stable
security definer
cost 1000
set search_path = ''
as $$
declare
  v_row ${table};
  v_rows ${table}[] := '{}';
  v_id ${idType};
begin
  begin
    foreach v_id in array coalesce(p_ids, '{}') loop
${assign("      ")}
    end loop;
  exception when data_exception then
    v_rows := '{}';
    foreach v_id in array p_ids loop
      begin
${assign("        ")}
      exception when data_exception then
        null;
      end;
    end loop;
  end;
  return query
  with ${CANDIDATES} as materialized (
    select * from ${table} where ${id} = any (array(select (r).${id} from pg_catalog.unnest(v_rows) r))
  )
  select ${id}::${idType} from ${CANDIDATES}
  where ${where};
end
$$;
revoke execute on function ${fn}(text, ${idType}[]) from public, anon;
grant execute on function ${fn}(text, ${idType}[]) to authenticated;`;
}

/**
 * For a key whose every allow is a role held at the root scope, the check that
 * the row's tenant column is among the tenants where the caller holds the key.
 * It sits first in the key's branch and its subquery does not depend on the
 * row, so Postgres runs it once and the index on the column applies.
 * `undefined` when the resource has no tenant column (a relation `memberOf` the
 * root scope) or an allow reaches the key through a global role, a sub-scope or
 * instance role, a relation, a link or an `anyone` grantee.
 */
function tenantFirstOf(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
): ((key: string) => string | undefined) | undefined {
  const root = rootScope(ctx.scopes);
  if (
    root === undefined ||
    ctx.customRoles !== undefined ||
    [...policyLevels(policy, node.name)].length > 0
  ) {
    return undefined;
  }
  const column = Object.values(node.relations).find(
    (relation) =>
      "field" in relation &&
      relation.memberOf !== undefined &&
      resolveScope(ctx.scopes, relation.memberOf) === root,
  );
  if (column === undefined || !("field" in column)) {
    return undefined;
  }
  const check = `${quoteIdent(column.field)} in (select ${qualified(ctx, permittedByPermissionHelper(root))}(p_permission, true))`;
  return (key) => {
    const allows = policy.grants.filter(
      (grant) => grant.effect === "allow" && grant.permission.key === key,
    );
    const bound =
      allows.length > 0 &&
      allows.every(
        (grant) =>
          flattenGrantee(grant.to).length > 0 &&
          flattenGrantee(grant.to).every(
            (item) =>
              item.kind === "role" &&
              typeof item.scope === "string" &&
              resolveScope(ctx.scopes, item.scope) === root,
          ),
      );
    return bound ? check : undefined;
  };
}

function resourceSql(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
  narrowed: ReadonlyMap<string, readonly CompiledBranch[]>,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const name = rowsHelper(node.name);
  const fn = qualified(ctx, name);
  const table = quoteQualified(tableFor(node.name, tables));
  const idType = idTypeOf(ctx, node.name);
  const where = whereOf(branches, tenantFirstOf(ctx, policy, node));
  const near = whereOf(narrowed);
  const rows = `-- ${node.name}: ids of the rows the caller may act on with p_permission, as the table's policies decide it
create or replace function ${fn}(p_permission text)
returns setof ${idType}
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select ${quoteIdent(node.id)}::${idType} from ${table}
  where ${where}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;
${candidatesSql(fn, table, quoteIdent(node.id), idType, near)}
${rowSql(ctx, policy, node, table, narrowed)}
${rowByIdSql(ctx, policy, node, table, idType, narrowed)}`;
  if (ctx.dialect === "neon") {
    return rows;
  }
  return `${rows}
-- the same rows for a user the caller names, with claims it supplies; no client role may execute it
${forUserSql(ctx, qualified(ctx, `${name}_for`), fn, false, idType)}
${forUserSql(ctx, qualified(ctx, `${name}_for`), fn, true, idType)}`;
}

/**
 * `permitted_<resource>_rows(p_permission)` for each resource `select` names
 * (or every resource a grant reaches with `true`): the ids of its rows the
 * caller may read, update or delete with that permission, from the same
 * compiled allows and denies the table policies use, so closure walks, link
 * hops, the restricted stop, `includes`, groups and `requires` all apply. A
 * `security definer` helper, so hand-written policies and functions call it
 * without restating the graph. Outside the `neon` dialect a
 * `permitted_<resource>_rows_for(p_user, p_permission, p_claims)` form runs it
 * as the named user, with the claims the caller supplies, for trusted SQL.
 */
export function rowHelpersSql(
  ctx: RlsSqlContext,
  policy: Policy,
  branches: readonly CompiledBranch[],
  select: true | readonly string[],
  tables: Readonly<Record<string, string>> | undefined,
  warnings: string[],
  narrowed: readonly CompiledBranch[] = branches,
): string {
  const names =
    select === true
      ? [
          ...new Set(
            branches.flatMap((branch) =>
              branch.resource === undefined ? [] : [branch.resource],
            ),
          ),
        ].toSorted()
      : [...new Set(select)];
  const called = inheritTargets(policy);
  for (const name of called) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  const ordered = [
    ...called.filter((name) => names.includes(name)),
    ...names.filter((name) => !called.includes(name)),
  ];
  const chunks: string[] = [];
  for (const name of ordered) {
    const node = policy.resources.get(name);
    if (node === undefined) {
      throw configError(
        `PermDock CLI: rls.rowHelpers names '${name}', which the policy does not declare`,
      );
    }
    chunks.push(
      resourceSql(
        ctx,
        policy,
        node,
        rowBranchesOf(branches, name),
        rowBranchesOf(narrowed, name),
        tables,
      ),
    );
  }
  const triggers =
    names.length === 0 ? "" : memoRowTriggersSql(ctx, policy, tables);
  if (triggers !== "") {
    chunks.push(
      `-- a relation write changes what the row helpers' memo holds inside the statement\n${triggers}`,
    );
  }
  if (chunks.length > 0 && ctx.dialect === "neon") {
    warnings.push(
      "rls.rowHelpers: the neon dialect reads the subject from auth.session(), which SQL cannot set, so no permitted_<resource>_rows_for is written",
    );
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}
