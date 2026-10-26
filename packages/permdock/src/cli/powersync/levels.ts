import type { Scope } from "../../core/scopes.ts";
import type { Policy } from "../../index.ts";
import type { RoleSource } from "../../supabase/roles.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsGrant } from "../sql/grants.ts";
import type { PermDockConfig } from "../types.ts";
import type { StreamDialect } from "./streams.ts";

import { scopeMembershipTable } from "../../conditions/compile.ts";
import { policyLevels } from "../../core/policy.ts";
import { SQL_IDENT } from "../../core/sql.ts";
import { keptKeys } from "../../supabase/keep.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { andConditions } from "../sql/conditions.ts";
import { assignableRoles } from "../sql/grants.ts";
import { CUSTOM_ROLES, customRolesOn } from "../sql/shared.ts";
import { CUSTOM_ROLE, bare, fromTable, quotedTable } from "./names.ts";
import {
  isFixed,
  ownRows,
  roleSources,
  scopeSourcesOf,
  streamOf,
} from "./sources.ts";

type LevelCtx = {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly scopes: readonly Scope[];
  readonly dialect: StreamDialect;
  readonly sources: readonly SqlMembershipSource[];
  readonly gaps: string[];
};

/**
 * One ceiling grant at one level, with who reaches it: a member holding a
 * custom role that allows the permission at that level.
 */
export type CustomRoleItem = {
  readonly label: string;
  readonly level: string | null;
  readonly item: RlsGrant;
  readonly access: readonly (readonly string[])[];
};

const ALIAS = "cr";

/**
 * The role key column of one role source, with the join to its roles table;
 * `undefined` for a mapped column, which holds declared roles only.
 */
function roleKeyOf(
  role: RoleSource,
  table: string,
  dialect: StreamDialect,
): { readonly join: string; readonly roleKey: string } | undefined {
  if (typeof role === "string") {
    return { join: "", roleKey: dialect.column(table, role) };
  }
  if ("map" in role) {
    return undefined;
  }
  const [pair] = Object.entries(role.on);
  if (pair === undefined) {
    return undefined;
  }
  const keys = bare(role.through, dialect);
  return {
    join: ` INNER JOIN ${fromTable(role.through, dialect)} ON ${dialect.column(keys, pair[1])} = ${dialect.column(table, pair[0])}`,
    roleKey: dialect.column(keys, role.column),
  };
}

/**
 * The `IN (SELECT …)` of each root-scope source: the row's `left` is a tenant
 * where the user holds a custom role with an allow row of `key` at `level`
 * (`null` for an allow with no level). A role column the source maps or fixes
 * holds declared roles only, so it never names a custom role.
 */
function customRoleIn(
  ctx: LevelCtx,
  root: string,
  left: string,
  key: string,
  level: string | null,
): readonly (readonly string[])[] {
  const { dialect } = ctx;
  const rls = ctx.config.rls;
  const table = quotedTable(
    `${rls?.schema ?? PERMDOCK_SCHEMA}.${CUSTOM_ROLES.permissions}`,
  );
  const cr = (column: string): string => dialect.column(ALIAS, column);
  const out: string[][] = [];
  for (const source of scopeSourcesOf(ctx.sources, root)) {
    const stream = streamOf(source);
    if (typeof stream === "string") {
      ctx.gaps.push(stream);
      continue;
    }
    if (isFixed(stream.roles)) {
      continue;
    }
    const own = ownRows(
      stream,
      dialect,
      root,
      keptKeys(rls?.suspension?.memberships).includes(key),
    );
    const id = dialect.column(own.table, stream.id);
    for (const role of roleSources(stream.roles)) {
      const keyed = roleKeyOf(role, own.table, dialect);
      if (keyed === undefined) {
        continue;
      }
      const { join, roleKey } = keyed;
      const filters = [
        ...own.where,
        `${cr("tenant_id")} = ${id}`,
        `${cr("scope")} = ${dialect.literal(root)}`,
        `${cr("permission")} = ${dialect.literal(key)}`,
        `${cr("effect")} = ${dialect.literal("allow")}`,
        level === null
          ? `${cr("level")} IS NULL`
          : `${cr("level")} = ${dialect.literal(level)}`,
      ];
      out.push([
        `${left} IN (SELECT ${id} FROM ${own.from}${join} INNER JOIN ${table} AS ${ALIAS} ON ${cr("role")} = ${roleKey} WHERE ${filters.join(" AND ")})`,
      ]);
    }
  }
  return out;
}

/**
 * What a custom role can reach on `resource` through `key`, in `database` mode
 * when the root scope reads membership sources: each allow of `key` by an
 * assignable role at the root scope (the ceiling), once for an allow with no
 * level and once per level the resource declares, narrowed by that level's
 * condition. `skipped` says why a root scope with custom roles reaching `key`
 * has no custom-role stream.
 */
export function customRoleItems(
  ctx: LevelCtx,
  grants: readonly RlsGrant[],
  resource: string,
  key: string,
  table: string,
): { readonly items: readonly CustomRoleItem[]; readonly skipped?: string } {
  const rls = ctx.config.rls;
  const root = ctx.scopes[0]?.name;
  const field = ctx.policy.scopes.find((scope) => scope.name === root)?.key;
  if (
    rls?.authorize !== "database" ||
    !customRolesOn(rls) ||
    root === undefined ||
    field === undefined ||
    !SQL_IDENT.test(field)
  ) {
    return { items: [] };
  }
  const assignable = new Set(assignableRoles(ctx.policy));
  const ceiling = grants.filter(
    (item) =>
      item.access.kind === "role" &&
      item.access.scope === root &&
      assignable.has(item.access.role) &&
      item.grant.effect === "allow" &&
      item.grant.permission.key === key,
  );
  if (ceiling.length === 0) {
    return { items: [] };
  }
  if (scopeMembershipTable(rls.memberships, ctx.scopes, root) !== undefined) {
    return {
      items: [],
      skipped: `the ${root} scope reads an rls.memberships table; custom-role streams read rls.membershipSources`,
    };
  }
  const left = ctx.dialect.column(table, field);
  const levels: readonly (readonly [string | null, RlsGrant["where"]])[] = [
    [null, undefined],
    ...policyLevels(ctx.policy, resource),
  ];
  const items = levels.flatMap(([level, condition]) => {
    const access = customRoleIn(ctx, root, left, key, level);
    const label = `${CUSTOM_ROLE}/${key}${level === null ? "" : `@${level}`}`;
    return access.length === 0
      ? []
      : ceiling.map((item) => {
          const where = andConditions(item.where, condition);
          return {
            label,
            level,
            access,
            item: where === undefined ? item : { ...item, where },
          };
        });
  });
  return { items };
}
