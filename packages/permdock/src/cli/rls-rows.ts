import type { Policy, ResourceNode } from "../index.ts";
import type { CompiledBranch } from "./rls-compile.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { flattenGrantee } from "../core/grantee.ts";
import { tableFor } from "./rls-compile.ts";
import { branchClauses } from "./rls-compile.ts";
import { orSql } from "./rls-policies.ts";
import { qualified } from "./rls-shared.ts";
import {
  graphSqlName,
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "./rls-sql.ts";

/** `permitted_<resource>_rows(p_permission)`: the resource's row ids the subject may act on with one permission. */
export function rowsHelper(resource: string): string {
  const name = graphSqlName(resource);
  const helper = `permitted_${name ?? resource}_rows`;
  if (
    name === undefined ||
    new TextEncoder().encode(`${helper}_for`).length > 63
  ) {
    throw new Error(
      `PermDock CLI: rls.rowHelpers cannot name a helper for resource '${resource}'; use a SQL name of at most 45 bytes`,
    );
  }
  return helper;
}

/** The branches a row check of a permission reads: its allows and denies on rows that exist, for signed-in callers. */
function rowBranchesOf(
  branches: readonly CompiledBranch[],
  resource: string,
): ReadonlyMap<string, readonly CompiledBranch[]> {
  const out = new Map<string, CompiledBranch[]>();
  for (const branch of branches) {
    if (
      branch.resource !== resource ||
      branch.command === "insert" ||
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

function usingOf(branches: readonly CompiledBranch[]): string | undefined {
  const parts = branches.map((branch) => branchClauses(branch).using ?? "true");
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

function forUserSql(ctx: RlsSqlContext, fn: string, helper: string): string {
  const user = ctx.dialect === "supabase" ? "uuid" : "text";
  const signature = `${user}, text, jsonb`;
  const head = `create or replace function ${fn}(p_user ${user}, p_permission text, p_claims jsonb default '{}')
returns setof text
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
  return query select r.id from ${helper}(p_permission) r(id);
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
  return query select r.id from ${helper}(p_permission) r(id);
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

function stubSql(ctx: RlsSqlContext, resource: string): string {
  const fn = qualified(ctx, rowsHelper(resource));
  return `create or replace function ${fn}(p_permission text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select null::text where false
$$;`;
}

function rowSql(
  ctx: RlsSqlContext,
  rows: string,
  table: string,
  where: string,
): string {
  const fn = qualified(ctx, rows.replace(/_rows$/u, "_row"));
  return `create or replace function ${fn}(p_row ${table}, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from (select (p_row).*) r where ${where})
$$;
revoke execute on function ${fn}(${table}, text) from public, anon;
grant execute on function ${fn}(${table}, text) to authenticated;`;
}

function resourceSql(
  ctx: RlsSqlContext,
  node: ResourceNode,
  branches: ReadonlyMap<string, readonly CompiledBranch[]>,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const name = rowsHelper(node.name);
  const fn = qualified(ctx, name);
  const table = quoteTable(qualifiedTable(tableFor(node.name, tables)));
  const cases = [...branches.keys()].toSorted().flatMap((key) => {
    const sql = permissionCase(key, branches.get(key) ?? []);
    return sql === undefined ? [] : [sql];
  });
  const where =
    cases.length === 0
      ? "false"
      : `case p_permission\n${cases.join("\n")}\n    else false\n  end`;
  const rows = `-- ${node.name}: ids of the rows the caller may act on with p_permission, as the table's policies decide it
create or replace function ${fn}(p_permission text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select ${quoteIdent(node.id)}::text from ${table}
  where ${where}
$$;
revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;
${rowSql(ctx, name, table, where)}`;
  if (ctx.dialect === "neon") {
    return rows;
  }
  return `${rows}
-- the same rows for a user the caller names, with claims it supplies; no client role may execute it
${forUserSql(ctx, qualified(ctx, `${name}_for`), fn)}`;
}

/**
 * `permitted_<resource>_rows(p_permission)` for each resource `select`
 * names (or every resource a grant reaches with `true`): the ids of its rows
 * the caller may read, update or delete with that permission, from the same
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
  const chunks: string[] = called.map((name) => stubSql(ctx, name));
  for (const name of names) {
    const node = policy.resources.get(name);
    if (node === undefined) {
      throw new Error(
        `PermDock CLI: rls.rowHelpers names '${name}', which the policy does not declare`,
      );
    }
    chunks.push(resourceSql(ctx, node, rowBranchesOf(branches, name), tables));
  }
  if (chunks.length > 0 && ctx.dialect === "neon") {
    warnings.push(
      "rls.rowHelpers: the neon dialect reads the subject from auth.session(), which SQL cannot set, so no permitted_<resource>_rows_for is written",
    );
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}
