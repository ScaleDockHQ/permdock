import type { Policy, ResourceNode } from "../../index.ts";
import type { CompiledBranch } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { flattenGrantee } from "../../core/grantee.ts";
import { listPermissions } from "../../core/permission-registry.ts";
import { policyLevels } from "../../core/policy.ts";
import { resolveScope, rootScope } from "../../core/scopes.ts";
import { configError } from "../core/errors.ts";
import { branchClauses } from "../sql/clauses.ts";
import { idTypeOf, scopeTypeOf } from "../sql/columns.ts";
import { tableFor } from "../sql/compile.ts";
import { graphSqlName } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";
import { memoHitList, memoizes } from "./helper-bodies.ts";
import { permittedByPermissionHelper } from "./permission-keys.ts";
import { orSql } from "./policies.ts";
import { memoRowTriggersSql } from "./row-memo.ts";

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
  /** `can_<resource>`, unqualified. */
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
        rowHelper: `can_${graphSqlName(leaf.resource) ?? leaf.resource}`,
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
): string | undefined {
  const allow = usingOf(branches.filter((branch) => branch.effect === "allow"));
  if (allow === undefined) {
    return undefined;
  }
  const deny = usingOf(branches.filter((branch) => branch.effect === "deny"));
  const granted = `coalesce((${allow}), false)`;
  return `    when ${quoteLiteral(key)} then ${deny === undefined ? granted : `${granted} and (${deny}) is not true`}`;
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

const ROW = "permdock_row";

function matchHelper(resource: string): string {
  return rowsHelper(resource).replace(/_rows$/u, "_match");
}

function canHelper(resource: string): string {
  return rowsHelper(resource)
    .replace(/^permitted_/u, "can_")
    .replace(/_rows$/u, "");
}

function matchSql(
  ctx: RlsSqlContext,
  node: ResourceNode,
  table: string,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const fn = qualified(ctx, matchHelper(node.name));
  const seenTouch = new Set<string>();
  const touches = (ctx.memoTouches ?? [])
    .filter((touch) => {
      if (seenTouch.has(touch.call)) {
        return false;
      }
      seenTouch.add(touch.call);
      return true;
    })
    .map(
      (touch) =>
        `(select count(*) from (${memoHitList(touch.scope, touch.keySql, touch.call, `${subjectIdSql(ctx)}::text`, ctx.memo)}) s) >= 0`,
    )
    .join(" and ");
  const guard = touches === "" ? "" : `${touches} and `;
  return `create or replace function ${fn}(p_row ${table}, p_permission text)
returns boolean
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  with ${CANDIDATES} as (select (p_row).*)
  select exists (select 1 from ${CANDIDATES} where ${guard}${whereOf(branches)})
$$;
revoke execute on function ${fn}(${table}, text) from public, anon;
grant execute on function ${fn}(${table}, text) to authenticated;`;
}

function rowSql(ctx: RlsSqlContext, node: ResourceNode, table: string): string {
  const fn = qualified(ctx, canHelper(node.name));
  const match = qualified(ctx, matchHelper(node.name));
  return `create or replace function ${fn}(p_row ${table}, p_permission text)
returns boolean
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select ${match}(p_row, p_permission)
$$;
revoke execute on function ${fn}(${table}, text) from public, anon;
grant execute on function ${fn}(${table}, text) to authenticated;`;
}

/**
 * `can_<resource>(p_id <type>, p_permission)`: the per-id form, which reads the
 * one row by its key so a caller holding an id never builds a row.
 */
function rowByIdSql(
  ctx: RlsSqlContext,
  node: ResourceNode,
  table: string,
  idType: string,
): string {
  const fn = qualified(ctx, canHelper(node.name));
  const match = qualified(ctx, matchHelper(node.name));
  const id = quoteIdent(node.id);
  return `create or replace function ${fn}(p_id ${idType}, p_permission text)
returns boolean
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select exists (
    select 1 from ${table} as ${ROW}
    where ${ROW}.${id} = p_id
      and ${match}(${ROW}, p_permission)
  )
$$;
revoke execute on function ${fn}(${idType}, text) from public, anon;
grant execute on function ${fn}(${idType}, text) to authenticated;`;
}

function whereOf(
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const cases = [...branches.keys()].toSorted().flatMap((key) => {
    const sql = permissionCase(key, branches.get(key) ?? []);
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
  match: string,
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
  v_rows ${table}[] := '{}'::${table}[];
  v_id ${idType};
begin
  begin
    foreach v_id in array coalesce(p_ids, '{}'::${idType}[]) loop
${assign("      ")}
    end loop;
  exception when data_exception then
    v_rows := '{}'::${table}[];
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
  where ${match}(${CANDIDATES}, p_permission);
end
$$;
revoke execute on function ${fn}(text, ${idType}[]) from public, anon;
grant execute on function ${fn}(text, ${idType}[]) to authenticated;`;
}

/**
 * The column of a resource that holds its root-scope id, from a `memberOf`
 * relation.
 */
export function tenantColumnOf(
  ctx: RlsSqlContext,
  node: ResourceNode,
): string | undefined {
  const root = rootScope(ctx.scopes);
  if (root === undefined) {
    return undefined;
  }
  const column = Object.values(node.relations).find(
    (relation) =>
      "field" in relation &&
      relation.memberOf !== undefined &&
      resolveScope(ctx.scopes, relation.memberOf) === root,
  );
  return column !== undefined && "field" in column ? column.field : undefined;
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
  const field = tenantColumnOf(ctx, node);
  if (root === undefined || field === undefined) {
    return undefined;
  }
  const check = `${quoteIdent(field)} = any(array(select ${qualified(ctx, permittedByPermissionHelper(root))}(p_permission, true)))`;
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

/**
 * A `(select <schema>.<function>(<literal>?))`: one uncorrelated call, which
 * Postgres runs once per statement as an InitPlan or a hashed subplan.
 */
const ONE_CALL =
  /\(select (?:"[^"]+"|[a-z_]+)\.(?:"[^"]+"|[a-z_]+)\((?:'[^']*')?\)\)/gu;

/**
 * Whether a clause reads nothing but the row and uncorrelated one-call
 * subselects, so the id-set query can carry it: behind
 * `permitted_<resource>_match` each of those calls runs once per row, because a
 * `security definer` function is not inlined.
 */
function readsOnlyTheRow(clause: string): boolean {
  return !/\b(?:select|from|exists)\b/iu.test(clause.replaceAll(ONE_CALL, "x"));
}

function inlineArm(
  key: string,
  narrowed: ReadonlyMap<string, readonly CompiledBranch[]>,
): string | undefined {
  const list = narrowed.get(key) ?? [];
  const arm = permissionCase(key, list);
  return arm !== undefined &&
    list.every((branch) => readsOnlyTheRow(clauseOf(branch)))
    ? arm
    : undefined;
}

/**
 * The `where` of `permitted_<resource>_rows(p_permission)`: an arm that reads
 * only the row inline, a tenant lead before the match for a key a root-scope
 * role holds, and the match for the rest.
 */
function rowsWhereSql(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
  narrowed: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const match = `${qualified(ctx, matchHelper(node.name))}(${ROW}, p_permission)`;
  const first = tenantFirstOf(ctx, policy, node);
  const arms = [...new Set([...branches.keys(), ...narrowed.keys()])]
    .toSorted()
    .flatMap((key) => {
      const inline = inlineArm(key, narrowed);
      if (inline !== undefined) {
        return [inline];
      }
      const lead = first?.(key);
      return lead === undefined
        ? []
        : [`    when ${quoteLiteral(key)} then ${lead} and ${match}`];
    });
  return arms.length === 0
    ? match
    : `case p_permission\n${arms.join("\n")}\n    else ${match}\n  end`;
}

/**
 * `permitted_<resource>_ids_in(p_permission, p_ids)`: the given ids the caller
 * may act on, the id-list form of the set.
 */
function idsInSql(
  ctx: RlsSqlContext,
  node: ResourceNode,
  rows: string,
  idType: string,
): string {
  const fn = qualified(ctx, idsInHelper(node.name));
  return `create or replace function ${fn}(p_permission text, p_ids ${idType}[])
returns setof ${idType}
language sql
stable
security definer
cost 1000
set search_path = ''
as $$
  select i from ${rows}(p_permission, p_ids) i
$$;
revoke execute on function ${fn}(text, ${idType}[]) from public, anon;
grant execute on function ${fn}(text, ${idType}[]) to authenticated;
`;
}

/** `permitted_<resource>_ids_in`. */
export function idsInHelper(resource: string): string {
  return rowsHelper(resource).replace(/_rows$/u, "_ids_in");
}

/** `permitted_<resource>_count`. */
export function countHelper(resource: string): string {
  return rowsHelper(resource).replace(/_rows$/u, "_count");
}

/**
 * `permitted_<resource>_rows(p_permission, p_tenant)`, which reads one tenant's
 * rows through the tenant column's index, and `permitted_<resource>_count`,
 * which counts them up to a cap. Empty for a resource with no tenant column.
 */
function tenantRowsSql(
  ctx: RlsSqlContext,
  policy: Policy,
  node: ResourceNode,
  rows: string,
  table: string,
  idType: string,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
  narrowed: ReadonlyMap<string, readonly CompiledBranch[]>,
): string {
  const column = tenantColumnOf(ctx, node);
  const root = rootScope(ctx.scopes);
  if (column === undefined || root === undefined) {
    return "";
  }
  const tenantType = scopeTypeOf(ctx, root);
  const count = qualified(ctx, countHelper(node.name));
  return `-- ${node.name}: the same set within one ${root}, by the index on ${column}
create or replace function ${rows}(p_permission text, p_tenant ${tenantType})
returns setof ${idType}
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select ${quoteIdent(node.id)}::${idType} from ${table} as ${ROW}
  where ${ROW}.${quoteIdent(column)} = p_tenant
    and ${rowsWhereSql(ctx, policy, node, branches, narrowed)}
$$;
revoke execute on function ${rows}(text, ${tenantType}) from public, anon;
grant execute on function ${rows}(text, ${tenantType}) to authenticated;
-- ${node.name}: how many of them the caller may act on, counted up to p_cap
create or replace function ${count}(p_permission text, p_tenant ${tenantType}, p_cap integer)
returns integer
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select count(*)::integer from (select 1 from ${rows}(p_permission, p_tenant) limit greatest(p_cap, 0)) s
$$;
revoke execute on function ${count}(text, ${tenantType}, integer) from public, anon;
grant execute on function ${count}(text, ${tenantType}, integer) to authenticated;
`;
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
  const match = qualified(ctx, matchHelper(node.name));
  const rows = `-- ${node.name}: one predicate, called by the set, the id list and both row forms
${matchSql(ctx, node, table, narrowed)}
-- ${node.name}: ids of the rows the caller may act on with p_permission, as the table's policies decide it
create or replace function ${fn}(p_permission text)
returns setof ${idType}
language sql
stable
security definer
${plannerOf(ctx)}
set search_path = ''
as $$
  select ${quoteIdent(node.id)}::${idType} from ${table} as ${ROW}
  where ${rowsWhereSql(ctx, policy, node, branches, narrowed)}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;
${candidatesSql(fn, table, quoteIdent(node.id), idType, match)}
${idsInSql(ctx, node, fn, idType)}
${tenantRowsSql(ctx, policy, node, fn, table, idType, branches, narrowed)}${rowSql(ctx, node, table)}
${rowByIdSql(ctx, node, table, idType)}`;
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
