import type { MembershipStream } from "../../supabase/sources.ts";
import type { GlobalRoles, RlsMembershipTable, RoleThrough } from "../types.ts";
import type { StreamCtx, SubjectStream } from "./stream-types.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { keptKeys } from "../../supabase/keep.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { CUSTOM_ROLES, customRolesOn } from "../sql/shared.ts";
import { bare, fromTable } from "./names.ts";
import {
  ownRows,
  roleTableRows,
  scopeSourcesOf,
  streamOf,
  throughRows,
} from "./sources.ts";

type Ctx = StreamCtx;

/**
 * `permdock_<table>`; a table in the `permdock` schema, `permdock_<table>`
 * already, keeps one prefix.
 */
function subjectStreamName(table: string): string {
  return table.startsWith("permdock_") ? table : `permdock_${table}`;
}

type SubjectRows = { user: string | undefined; readonly queries: Set<string> };

function roleThroughs(
  role: RlsMembershipTable["role"] | GlobalRoles["role"],
): readonly RoleThrough[] {
  const list = Array.isArray(role) ? role : [role];
  return list.filter(
    (item): item is RoleThrough =>
      typeof item === "object" && item !== null && "through" in item,
  );
}

/**
 * The `SELECT`s of the root-scope ids the user is a member of: the root scope's
 * `rls.memberships` table, else each of its sources that can filter a stream.
 */
function userTenantIds(ctx: Ctx): readonly string[] {
  const { dialect } = ctx;
  const root = ctx.scopes[0]?.name;
  if (root === undefined) {
    return [];
  }
  const tenants = scopeMembershipTable(
    ctx.config.rls?.memberships,
    ctx.scopes,
    root,
  );
  if (tenants !== undefined) {
    const column = scopeColumn(tenants, ctx.scopes, root);
    const members = bare(tenants.table, dialect);
    const active =
      tenants.disabledAt !== undefined &&
      keptKeys(ctx.config.rls?.suspension?.memberships).length === 0
        ? ` AND ${dialect.column(members, tenants.disabledAt)} IS NULL`
        : "";
    return column === undefined
      ? []
      : [
          `SELECT ${dialect.column(members, column)} FROM ${fromTable(tenants.table, dialect)} WHERE ${dialect.column(members, tenants.user)} = ${dialect.user}${active}`,
        ];
  }
  return scopeSourcesOf(ctx.sources, root).flatMap((source) => {
    const stream = streamOf(source);
    if (typeof stream === "string") {
      return [];
    }
    const rows = ownRows(
      stream,
      dialect,
      root,
      keptKeys(ctx.config.rls?.suspension?.memberships).length > 0,
    );
    return [
      `SELECT ${dialect.column(rows.table, stream.id)} FROM ${rows.from} WHERE ${rows.where.join(" AND ")}`,
    ];
  });
}

/**
 * The stream forms of the sources of every scope `rls.memberships` maps no
 * table for.
 */
function unmappedStreams(ctx: Ctx): readonly MembershipStream[] {
  const out = new Set<MembershipStream>();
  for (const scope of ctx.scopes) {
    if (
      scopeMembershipTable(
        ctx.config.rls?.memberships,
        ctx.scopes,
        scope.name,
      ) !== undefined
    ) {
      continue;
    }
    for (const source of scopeSourcesOf(ctx.sources, scope.name)) {
      if (source.sql.stream !== undefined) {
        out.add(source.sql.stream);
      }
    }
  }
  return [...out];
}

/**
 * Streams of the rows a device builds the user's snapshot from: the user's own
 * membership and global-role rows, the roles tables they reference, and the
 * custom roles of the user's tenants. Each query starts from the user's own
 * rows.
 */
export function subjectStreams(ctx: Ctx): readonly SubjectStream[] {
  const rls = ctx.config.rls;
  const { dialect } = ctx;
  const tables = new Map<string, SubjectRows>();
  const add = (table: string, query: string, user?: string): void => {
    const entry = tables.get(table) ?? {
      user: undefined,
      queries: new Set<string>(),
    };
    if (entry.queries.size === 0) {
      entry.user = user;
    } else if (entry.user !== user) {
      entry.user = undefined;
    }
    entry.queries.add(query);
    tables.set(table, entry);
  };
  const own = (
    table: string,
    user: string,
    role: RlsMembershipTable["role"] | GlobalRoles["role"],
    disabledAt?: string,
  ): void => {
    const name = bare(table, dialect);
    const active =
      disabledAt !== undefined &&
      keptKeys(rls?.suspension?.memberships).length === 0
        ? ` AND ${dialect.column(name, disabledAt)} IS NULL`
        : "";
    const mine = `${dialect.column(name, user)} = ${dialect.user}${active}`;
    add(name, `SELECT * FROM ${fromTable(table, dialect)} WHERE ${mine}`, user);
    const rows = {
      table: name,
      from: fromTable(table, dialect),
      where: [mine],
    };
    for (const through of roleThroughs(role)) {
      if (Object.keys(through.on).length === 0) {
        continue;
      }
      const keys = throughRows(through, rows, dialect, user);
      add(keys.table, keys.query, keys.user);
    }
  };
  const memberships = rls?.memberships;
  for (const table of [
    ...Object.values(memberships?.scopes ?? {}),
    ...Object.values(memberships?.resource ?? {}),
  ]) {
    own(table.table, table.user, table.role, table.disabledAt);
  }
  for (const stream of unmappedStreams(ctx)) {
    const keep = keptKeys(rls?.suspension?.memberships).length > 0;
    const rows = ownRows(stream, dialect, undefined, keep);
    add(
      rows.table,
      typeof stream.user === "string"
        ? `SELECT * FROM ${rows.from} WHERE ${rows.where.join(" AND ")}`
        : `SELECT ${rows.table}.* FROM ${rows.from} WHERE ${rows.where.join(" AND ")}`,
      typeof stream.user === "string" ? stream.user : undefined,
    );
    if (typeof stream.user !== "string") {
      const users = bare(stream.user.through, dialect);
      add(
        users,
        `SELECT * FROM ${fromTable(stream.user.through, dialect)} WHERE ${dialect.column(users, stream.user.column)} = ${dialect.user}`,
        stream.user.column,
      );
    }
    for (const keys of roleTableRows(stream, dialect, keep)) {
      add(keys.table, keys.query, keys.user);
    }
  }
  const schema = rls?.schema ?? PERMDOCK_SCHEMA;
  const database = rls?.authorize === "database";
  const globalRoles =
    rls?.roles ?? (database ? { table: `${schema}.user_roles` } : undefined);
  if (globalRoles !== undefined) {
    own(
      globalRoles.table,
      globalRoles.user ?? "user_id",
      globalRoles.role ?? "role",
    );
  }
  if (database && customRolesOn(rls)) {
    const tenantIds = userTenantIds(ctx);
    for (const name of [CUSTOM_ROLES.permissions, CUSTOM_ROLES.includes]) {
      const qualified = `${schema}.${name}`;
      const table = bare(qualified, dialect);
      const from = fromTable(qualified, dialect);
      const tenant = dialect.column(table, "tenant_id");
      add(table, `SELECT * FROM ${from} WHERE ${tenant} IS NULL`);
      for (const ids of tenantIds) {
        add(table, `SELECT * FROM ${from} WHERE ${tenant} IN (${ids})`);
      }
    }
  }
  const out: SubjectStream[] = [];
  const names = new Set<string>();
  for (const [table, entry] of tables) {
    const short = subjectStreamName(table);
    // `public.user_roles` and `permdock.user_roles` share the short name.
    const name = names.has(short) ? `permdock_${table}` : short;
    names.add(name);
    const queries = [...entry.queries];
    out.push(
      entry.user === undefined
        ? { name, table, queries }
        : { name, table, user: entry.user, queries },
    );
  }
  return out;
}
