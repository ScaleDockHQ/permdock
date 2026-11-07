import type { Policy } from "../../index.ts";
import type { CompiledPolicy, SqlCommand } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsTable, RlsTableOwner } from "../types.ts";

import { isFieldRelation } from "../../core/resource-relations.ts";
import { rootScope } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { configError } from "../core/errors.ts";
import { idTypeOf } from "../sql/columns.ts";
import { graphSqlName, memberIdsHelper } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { tableNameOf } from "../sql/tables.ts";

function isOwner(entry: RlsTable): entry is RlsTableOwner {
  return typeof entry === "object" && !("tableOf" in entry);
}

function bare(table: string): string {
  return table.slice(table.lastIndexOf(".") + 1);
}

function policyName(table: string, command: SqlCommand): string {
  const slug = bare(table)
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "");
  const full = `permdock_follow_${slug}_${command}`;
  if (new TextEncoder().encode(full).length > 63) {
    throw configError(
      `PermDock CLI: the follows policy name ${full} is longer than Postgres's 63 bytes; shorten '${table}'`,
    );
  }
  return full;
}

/**
 * Child policies for `rls.tables.<resource>.follows`. Select calls
 * `can_<resource>(parent, '<resource>.read')`. Insert, update and delete call
 * it with `<resource>.update`. The child resource gets no permission of its
 * own.
 */
export function followPolicies(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
): readonly CompiledPolicy[] {
  const out: CompiledPolicy[] = [];
  for (const [resource, entry] of Object.entries(tables ?? {})) {
    if (!isOwner(entry) || entry.follows === undefined) {
      continue;
    }
    const node = policy.resources.get(resource);
    if (node === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.follows names a resource the policy does not declare`,
      );
    }
    const sql = graphSqlName(resource);
    if (sql === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource} is not a SQL name, so follows cannot call can_${resource}`,
      );
    }
    const parent = quoteQualified(tableNameOf(entry, resource, tables));
    const id = quoteIdent(node.id);
    const can = qualified(ctx, `can_${sql}`);
    for (const [child, fk] of Object.entries(entry.follows)) {
      const childName = quoteIdent(bare(child));
      const column = quoteIdent(fk);
      const exists = (action: "read" | "update"): string =>
        `exists (select 1 from ${parent} p where p.${id} = ${childName}.${column} and ${can}(p, ${quoteLiteral(`${resource}.${action}`)}::text))`;
      const commands: readonly [
        SqlCommand,
        "read" | "update",
        "using" | "check" | "both",
      ][] = [
        ["select", "read", "using"],
        ["insert", "update", "check"],
        ["update", "update", "both"],
        ["delete", "update", "using"],
      ];
      for (const [command, action, place] of commands) {
        const expression = exists(action);
        out.push({
          name: policyName(child, command),
          table: child,
          command,
          effect: "allow",
          roles: ["authenticated"],
          ...(place === "check" ? {} : { using: expression }),
          ...(place === "using" ? {} : { check: expression }),
        });
      }
    }
  }
  return out;
}

/** The relation-walk maximum: a chain stops this many steps below its start. */
const WALK_DEPTH = 32;

/**
 * `walk: "recursive"`: one set of the rows below the caller on a self-parented
 * resource. The walk starts at the caller's own row, the one whose
 * `tables.<resource>.user` column (the id column by default) is the caller, and
 * stays in that row's tenant. A path guard and a depth cap of 32 end a cycle or
 * a self-parented row. The caller's row is not in the result. With approval
 * delegations, each delegator whose cover is active adds their row and every
 * row below it.
 */
export function walkChainSql(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
  covers: boolean,
): string {
  const root = rootScope(ctx.scopes);
  const chunks: string[] = [];
  for (const [resource, entry] of Object.entries(tables ?? {})) {
    if (!isOwner(entry) || entry.walk !== "recursive") {
      continue;
    }
    const node = policy.resources.get(resource);
    const parent = node?.parent;
    if (
      node === undefined ||
      parent === undefined ||
      parent.resource !== resource
    ) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.walk needs a self-parented resource`,
      );
    }
    const sql = graphSqlName(resource);
    if (sql === undefined) {
      throw configError(
        `PermDock CLI: rls.tables.${resource}.walk is not a SQL name`,
      );
    }
    const type = idTypeOf(ctx, resource);
    const table = quoteQualified(tableNameOf(entry, resource, tables));
    const id = quoteIdent(node.id);
    const up = quoteIdent(parent.field);
    const user = quoteIdent(entry.user ?? node.id);
    const tenantColumn =
      root === undefined ? undefined : tenantField(policy, resource, root);
    const tenant =
      tenantColumn === undefined ? undefined : quoteIdent(tenantColumn);
    const fn = qualified(ctx, `permdock_${sql}_chain`);
    const me = `(select ${qualified(ctx, "permdock_user_id")}())`;
    const startTenant = tenant === undefined ? "null" : `t.${tenant}`;
    const stepTenant =
      tenant === undefined ? "" : `\n      and c.${tenant} = w.tenant`;
    const cover = covers
      ? `
    union all
    select t.${id}, ${startTenant}, 0, array[t.${id}], true
    from ${table} t
    join ${qualified(ctx, "approval_delegations")} d on t.${user} = d.delegator
    where d.delegate = ${me}
      and d."from" <= now()
      and d."until" > now()`
      : "";
    chunks.push(`-- ${resource}: rows below the caller's row, one recursive set
create or replace function ${fn}()
returns setof ${type}
language sql
stable
security definer
set search_path = ''
as $$
  with recursive walk(id, tenant, depth, path, cover) as (
    select t.${id}, ${startTenant}, 0, array[t.${id}], false
    from ${table} t
    where t.${user} = ${me}${cover}
    union all
    select c.${id}, w.tenant, w.depth + 1, w.path || c.${id}, false
    from ${table} c
    join walk w on c.${up} = w.id
    where not c.${id} = any (w.path)
      and w.depth < ${String(WALK_DEPTH)}${stepTenant}
  )
  select id from walk where depth >= 1 or cover
$$;
revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`);
  }
  return chunks.join("\n\n");
}

function sameTable(left: string, right: string): boolean {
  return qualifySqlTable(left) === qualifySqlTable(right);
}

function folderOf(
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
  table: string,
): string | undefined {
  let byName: string | undefined;
  for (const resource of policy.resources.keys()) {
    const named = tableNameOf(tables?.[resource], resource, tables);
    if (sameTable(named, table)) {
      return resource;
    }
    if (resource === bare(table)) {
      byName = resource;
    }
  }
  return byName;
}

function tenantField(
  policy: Policy,
  resource: string,
  root: string,
): string | undefined {
  const node = policy.resources.get(resource);
  if (node === undefined) {
    return undefined;
  }
  for (const relation of Object.values(node.relations)) {
    if (isFieldRelation(relation) && relation.memberOf === root) {
      return relation.field;
    }
  }
  return undefined;
}

/**
 * One helper per `rls.treeValues` table: the folder rows in the caller's
 * tenants, walked on that table alone.
 */
export function treeHelperSql(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, RlsTable>> | undefined,
  treeValues: Readonly<Record<string, unknown>> | undefined,
): string {
  const root = rootScope(ctx.scopes);
  const chunks: string[] = [];
  for (const table of Object.keys(treeValues ?? {}).toSorted()) {
    const resource = folderOf(policy, tables, table);
    const node =
      resource === undefined ? undefined : policy.resources.get(resource);
    const parent = node?.parent;
    const tenant =
      root === undefined || resource === undefined
        ? undefined
        : tenantField(policy, resource, root);
    if (
      resource === undefined ||
      node === undefined ||
      parent === undefined ||
      parent.resource !== resource ||
      tenant === undefined ||
      root === undefined
    ) {
      throw configError(
        `PermDock CLI: rls.treeValues.${table} must be a self-parented folder in the caller's root scope`,
      );
    }
    const sql = graphSqlName(resource);
    if (sql === undefined) {
      throw configError(
        `PermDock CLI: rls.treeValues.${table} is not a SQL name`,
      );
    }
    const type = idTypeOf(ctx, resource);
    const fn = qualified(ctx, `permdock_tree_${sql}`);
    const id = quoteIdent(node.id);
    const up = quoteIdent(parent.field);
    const org = quoteIdent(tenant);
    const from = quoteQualified(
      tableNameOf(tables?.[resource], resource, tables),
    );
    const members = qualified(ctx, memberIdsHelper(root));
    chunks.push(`-- ${resource}: folder rows in the caller's tenants
create or replace function ${fn}()
returns setof ${type}
language sql
stable
security definer
set search_path = ''
as $$
  with recursive tree(id) as (
    select t.${id}
    from ${from} t
    where t.${org} in (select ${members}())
    union
    select c.${id}
    from ${from} c
    join tree w on c.${up} = w.id
    where c.${org} in (select ${members}())
  )
  select id from tree
$$;
revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;`);
  }
  return chunks.join("\n\n");
}
