import type { Condition } from "../../index.ts";
import type { PowerSyncMemberLevel } from "../types.ts";
import type { StreamCtx } from "./stream-types.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { policyLevels } from "../../core/policy.ts";
import { SQL_IDENT } from "../../core/sql.ts";
import { scopeField } from "../../core/tenancy.ts";
import { bare, fromTable } from "./names.ts";
import { ownRows, scopeSourcesOf, streamOf } from "./sources.ts";
import { conditionSql } from "./stream-condition.ts";

/** The levels a member's own value selects; every other value syncs nothing. */
const LEVELS = ["own", "team"] as const;

/** The value of a member with no level: the whole tenant. */
const WHOLE = "all";

function qualified(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

/** `table` and `public.table` name one table. */
function sameTable(left: string, right: string): boolean {
  return qualified(left) === qualified(right);
}

type Alternatives = readonly (readonly string[])[];

export type MemberLevelPlan =
  | {
      readonly alternatives: Alternatives;
      readonly warnings: readonly string[];
    }
  | { readonly omitted: string };

/**
 * The membership rows of the root scope that live in `spec.table`, as a
 * function from the filter on the level column to the `IN (SELECT …)` that
 * keeps the rows whose tenant column matches a membership of the signed-in
 * user. `undefined` when the table is none of the root scope's membership
 * tables.
 */
function membersIn(
  ctx: StreamCtx,
  spec: PowerSyncMemberLevel,
  left: string,
  root: string,
): ((filter: (table: string) => string) => readonly string[]) | undefined {
  const { dialect } = ctx;
  const table = scopeMembershipTable(
    ctx.config.rls?.memberships,
    ctx.scopes,
    root,
  );
  if (table !== undefined) {
    const id = scopeColumn(table, ctx.scopes, root);
    if (
      !sameTable(table.table, spec.table) ||
      id === undefined ||
      table.expiresAt !== undefined
    ) {
      return undefined;
    }
    const name = bare(table.table, dialect);
    return (filter) => [
      `${left} IN (SELECT ${dialect.column(name, id)} FROM ${fromTable(table.table, dialect)} WHERE ${[
        `${dialect.column(name, table.user)} = ${dialect.user}`,
        ...(table.disabledAt === undefined
          ? []
          : [`${dialect.column(name, table.disabledAt)} IS NULL`]),
        filter(name),
      ].join(" AND ")})`,
    ];
  }
  const streams = scopeSourcesOf(ctx.sources, root).flatMap((source) => {
    const stream = streamOf(source);
    return typeof stream === "string" || !sameTable(stream.table, spec.table)
      ? []
      : [stream];
  });
  if (streams.length === 0) {
    return undefined;
  }
  return (filter) =>
    streams.map((stream) => {
      const own = ownRows(stream, dialect, root);
      return `${left} IN (SELECT ${dialect.column(own.table, stream.id)} FROM ${own.from} WHERE ${[...own.where, filter(own.table)].join(" AND ")})`;
    });
}

/**
 * `powersync.memberLevel`: the clauses that narrow a resource's stream to the
 * level on the member's membership row. A member with no level, or `all`, syncs
 * what the grants reach in the tenant; `own` and `team` also need the condition
 * of the level of that name the resource declares; any other value syncs
 * nothing.
 */
export function memberLevelOf(
  ctx: StreamCtx,
  resource: string,
  key: string,
  table: string,
  spec: PowerSyncMemberLevel,
): MemberLevelPlan {
  if (!SQL_IDENT.test(spec.column)) {
    throw new TypeError(
      `PermDock CLI: powersync.memberLevel.${resource}.column must be a plain identifier`,
    );
  }
  const declared = policyLevels(ctx.policy, resource);
  const conditions = LEVELS.flatMap((name): [string, Condition][] => {
    const found = declared.find(([level]) => level === name);
    return found === undefined ? [] : [[name, found[1]]];
  });
  if (conditions.length === 0) {
    return {
      omitted: `memberLevel needs a level named own or team on ${resource}`,
    };
  }
  const root = ctx.scopes[0]?.name;
  const node = ctx.policy.resources.get(resource);
  const field =
    root === undefined ? undefined : scopeField(node, root, ctx.scopes);
  if (root === undefined || field === undefined || !SQL_IDENT.test(field)) {
    return {
      omitted: `memberLevel needs the tenant scope's key on ${resource}`,
    };
  }
  const members = membersIn(ctx, spec, ctx.dialect.column(table, field), root);
  if (members === undefined) {
    return {
      omitted: `memberLevel table ${spec.table} is not a membership table of the ${root} scope`,
    };
  }
  const level = (table_: string): string =>
    ctx.dialect.column(table_, spec.column);
  const alternatives: (readonly string[])[] = members(
    (name) =>
      `(${level(name)} IS NULL OR ${level(name)} = ${ctx.dialect.literal(WHOLE)})`,
  ).map((clause) => [clause]);
  const warnings: string[] = [
    `${resource}/${key} narrows by member level: a member whose ${spec.table}.${spec.column} is own or team syncs the rows of that level only`,
  ];
  for (const [name, condition] of conditions) {
    const where = conditionSql(condition, table, ctx, key);
    for (const reason of new Set(ctx.gaps.splice(0))) {
      warnings.push(
        `${resource}/${key} member level ${name} under-syncs: ${reason}`,
      );
    }
    if (where === undefined) {
      warnings.push(
        `${resource}/${key} member level ${name} does not sync: its condition has no Sync Streams form`,
      );
      continue;
    }
    for (const member of members(
      (tableName) => `${level(tableName)} = ${ctx.dialect.literal(name)}`,
    )) {
      for (const clauses of where) {
        alternatives.push([member, ...clauses]);
      }
    }
  }
  return { alternatives, warnings };
}
