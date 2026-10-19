import type { GraphSql } from "../../conditions/graph-sql.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type {
  RlsDialect,
  RlsMembershipTable,
  RlsMemberships,
} from "../types.ts";
import type { RlsSqlContext } from "./context.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { type Scope, rootScope, scopeChain } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { type RoleColumn, roleColumn } from "../../supabase/roles.ts";
import { configError } from "../core/errors.ts";
import { CLI, quoteIdent, quoteLiteral } from "./quote.ts";
import { subjectIdSql } from "./subject.ts";

/** The closure table graph grants read. Part of the SQL contract. */
export const CLOSURE = {
  table: "permdock_closure",
} as const;

/**
 * The snake_case SQL name of a resource or link (`chatThread` becomes
 * `chat_thread`), or `undefined` when it is not made of ASCII letters,
 * digits and underscores starting with a letter.
 */
export function graphSqlName(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) {
    return undefined;
  }
  return name
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
}

function sqlNameOf(name: string, label: string): string {
  const sql = graphSqlName(name);
  if (sql === undefined) {
    throw configError(
      `PermDock CLI: ${label} is not a SQL name (letters, digits and underscores, starting with a letter), so rls generate cannot name its helper`,
    );
  }
  return sql;
}

/** The helper returning the ids of `resource` the subject holds a relation on: `permitted_<snake_case resource>_ids`. */
export function graphHelper(resource: string): string {
  return permittedIdsHelper(sqlNameOf(resource, `resource '${resource}'`));
}

export function inheritedRowsHelper(resource: string): string {
  return `permitted_${sqlNameOf(resource, `resource '${resource}'`)}_rows`;
}

/** The helper returning the ids of `resource` whose `link` points into the ids it is given. */
export function linkHelper(resource: string, link: string): string {
  return `permdock_link_${sqlNameOf(resource, `resource '${resource}'`)}_${sqlNameOf(link, `link '${link}' on ${resource}`)}`;
}

export function restrictedHelper(resource: string): string {
  return `permdock_restricted_${sqlNameOf(resource, `resource '${resource}'`)}`;
}

/** Graph SQL parts as RLS text: values inline as literals, the subject from the dialect's claim. */
export function graphSqlText(parts: GraphSql, ctx: RlsSqlContext): string {
  return parts
    .map((part) => {
      if ("text" in part) {
        return part.text;
      }
      if ("column" in part) {
        return quoteIdent(part.column);
      }
      if ("subject" in part) {
        return subjectIdSql(ctx);
      }
      return typeof part.value === "string"
        ? quoteLiteral(part.value)
        : String(part.value);
    })
    .join("");
}

/**
 * The role column of an `rls.memberships` table aliased `alias`; a `through`
 * column joins its roles table as `<alias>k`, after a newline and `indent`
 * (inline without one).
 */
export function memberRoleOf(
  table: RlsMembershipTable,
  alias = "m",
  indent?: string,
): RoleColumn {
  return roleColumn(table.role, qualifySqlTable(table.table), alias, {
    label: `rls.memberships ${table.table} role`,
    prefix: CLI,
    ...(indent === undefined ? {} : { indent }),
  });
}

/** The schema-qualified name of a table under `search_path = ''`. */
/** The helper returning the ids of scope `name` a grant key reaches. */
export function permittedIdsHelper(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    throw configError(`PermDock CLI: unsafe scope name '${name}'`);
  }
  return `permitted_${name}_ids`;
}

/** `permitted_<scope>_ids_for(p_user, p_grant)`: the same ids for a user the caller names. */
export function permittedForHelper(name: string): string {
  return `${permittedIdsHelper(name)}_for`;
}

/** The helper returning the ids of scope `name` the subject holds any live membership of. */
export function memberIdsHelper(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    throw configError(`PermDock CLI: unsafe scope name '${name}'`);
  }
  return `member_${name}_ids`;
}

/** `member_<scope>_ids_for(p_user uuid)`: the same rows for a user the caller names; the token hook's helper. */
export function memberForHelper(name: string): string {
  return `${memberIdsHelper(name)}_for`;
}

/**
 * Whether `member_<scope>_ids_for` is generated for `name`: Supabase only
 * (its one caller is `supabase_auth_admin`), and only where `memberships` maps
 * a table for the scope or a membership source can hold it.
 */
export function hasMemberFor(
  input: {
    readonly dialect: RlsDialect;
    readonly scopes: readonly Scope[];
    readonly memberships?: RlsMemberships;
    readonly memberSources?: readonly SqlMembershipSource[];
  },
  name: string,
): boolean {
  if (input.dialect !== "supabase") {
    return false;
  }
  return (
    memberForTable(input, name) !== undefined ||
    memberForSources(input, name).length > 0
  );
}

/**
 * Whether `permitted_<scope>_users` can list the members of one instance of
 * `name`: a mapped membership table, or sources that all read a table.
 */
export function hasPermittedUsers(
  input: {
    readonly scopes: readonly Scope[];
    readonly memberships?: RlsMemberships;
    readonly memberSources?: readonly SqlMembershipSource[];
  },
  name: string,
): boolean {
  if (memberForTable(input, name) !== undefined) {
    return true;
  }
  const sources = memberForSources(input, name);
  return (
    sources.length > 0 &&
    sources.every((source) => source.sql.holders !== undefined)
  );
}

/** The table `member_<scope>_ids_for` reads for scope `name`, when `memberships` maps one with its id column. */
export function memberForTable(
  input: {
    readonly scopes: readonly Scope[];
    readonly memberships?: RlsMemberships;
  },
  name: string,
): RlsMembershipTable | undefined {
  const table = scopeMembershipTable(input.memberships, input.scopes, name);
  return table !== undefined &&
    scopeColumn(table, input.scopes, name) !== undefined
    ? table
    : undefined;
}

/** The sources `member_<scope>_ids_for` reads: none when a table is mapped, as in `database` mode. */
export function memberForSources(
  input: {
    readonly scopes: readonly Scope[];
    readonly memberships?: RlsMemberships;
    readonly memberSources?: readonly SqlMembershipSource[];
  },
  name: string,
): readonly SqlMembershipSource[] {
  if (memberForTable(input, name) !== undefined) {
    return [];
  }
  return (input.memberSources ?? []).filter(
    (source) => source.sql.scope === undefined || source.sql.scope === name,
  );
}

/**
 * The membership sources that can hold scope `name` when `memberships` maps
 * no table for it: every `tableMembershipSource` source and the `junctionMembershipSource` sources of
 * that scope. Empty outside `database` mode.
 */
export function scopeSources(
  ctx: RlsSqlContext,
  name: string,
): readonly SqlMembershipSource[] {
  if (ctx.authorize !== "database" || scopeTable(ctx, name) !== undefined) {
    return [];
  }
  return (ctx.sources ?? []).filter(
    (source) => source.sql.scope === undefined || source.sql.scope === name,
  );
}

/** The membership table mapped for scope `name`, with the column of its id and of the first scope's id. */
export function scopeTable(
  ctx: RlsSqlContext,
  name: string,
):
  | {
      readonly table: RlsMembershipTable;
      readonly column: string;
      readonly tenantColumn?: string;
    }
  | undefined {
  const table = scopeMembershipTable(ctx.memberships, ctx.scopes, name);
  if (table === undefined) {
    return undefined;
  }
  const column = scopeColumn(table, ctx.scopes, name);
  if (column === undefined) {
    return undefined;
  }
  const root = rootScope(ctx.scopes);
  const tenantColumn =
    root !== undefined && scopeChain(ctx.scopes, name).includes(root)
      ? scopeColumn(table, ctx.scopes, root)
      : undefined;
  return tenantColumn === undefined
    ? { table, column }
    : { table, column, tenantColumn };
}
