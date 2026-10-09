import type { GraphSql } from "../conditions/graph-sql.ts";
import type { Scope } from "../core/scopes.ts";
import type { ResourceNode } from "../index.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type {
  GlobalRoles,
  RlsActions,
  RlsActiveRow,
  RlsAssignmentTable,
  RlsCustomRoleTable,
  RlsDialect,
  RlsMemberships,
  RlsMembershipTable,
  RlsSuspendedScope,
  RlsSuspension,
} from "./types.ts";

import { scopeColumn, scopeMembershipTable } from "../conditions/compile.ts";
import { byCodePoint } from "../core/compare.ts";
import { isForbiddenKey } from "../core/paths.ts";
import { resolveScope, rootScope, scopeChain } from "../core/scopes.ts";
import {
  quoteSqlIdent,
  quoteSqlLiteral,
  quoteSqlTable,
  SQL_IDENT,
} from "../core/sql.ts";
import { keptKeys } from "../supabase/keep.ts";
import { type RoleColumn, roleColumn } from "../supabase/roles.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";

const CLI = "PermDock CLI";

export const CLAIM: RegExp = SQL_IDENT;

export type RlsSqlContext = {
  readonly dialect: RlsDialect;
  /** `rls.anonymousSignIns`: `'deny'` keeps an `is_anonymous` token out of every branch but `anyone()`'s. */
  readonly anonymousSignIns?: "deny";
  /** The policy's scopes in order (the implicit `tenant` / `team` pair when it declares none). */
  readonly scopes: readonly Scope[];
  readonly memberships?: RlsMemberships;
  /**
   * `database` mode: the `fromTable` / `fromJunction` sources the helpers read
   * for a scope `memberships` maps no table for (the same SQL the hook runs).
   */
  readonly sources?: readonly SqlMembershipSource[];
  /**
   * `rls.membershipSources ?? supabase.hook.memberships` in either mode: what
   * `member_<scope>_ids_for(p_user)` reads for a scope `memberships` maps no table for.
   */
  readonly memberSources?: readonly SqlMembershipSource[];
  readonly tenantClaim: string;
  /**
   * SQL for the subject's user id in place of the dialect's (`auth.uid()`):
   * `p_user` inside a `_for` helper, which answers for a user the caller names.
   */
  readonly subjectId?: string;
  /**
   * `'all'` (`rls.tenants`): the helpers and `memberOf` checks admit every
   * tenant the subject holds a membership in, ignoring the tenant claim.
   * Unset, they narrow to the tenant claim when the token carries one.
   */
  readonly tenants?: "all";
  readonly grantSet?: true;
  readonly gucPrefix: string;
  /** `rls.actions`: verb to SQL command overrides. */
  readonly actions?: RlsActions;
  readonly inlineFunctions?: boolean;
  /** Schema of `role_permissions` and the RLS helpers (`permdock_has`, `permitted_<scope>_ids`). Default `permdock`, a schema the Data API does not expose. */
  readonly schema?: string;
  /** Where the helpers read roles and memberships: tables (`database`) or claims (`jwt`, the default). */
  readonly authorize?: "database" | "jwt";
  /** Claim holding the global role (string or array). Default `user_role`. */
  readonly roleClaim?: string;
  /** Postgres type of the tenant column; the tenant claim is cast to it. Default `uuid`. */
  readonly tenantType?: string;
  /** Postgres type of the team column. Defaults to `tenantType`. */
  readonly teamType?: string;
  /** Postgres type of each scope's id column; overrides `tenantType` / `teamType`. */
  readonly scopeTypes?: Readonly<Record<string, string>>;
  /**
   * Set when custom roles compile: the helpers also resolve tenant-defined
   * roles, bounded by the ceiling of `assignable` declared roles.
   */
  readonly customRoles?: {
    readonly declared: readonly string[];
    readonly assignable: readonly string[];
    /** Former key to current key; a stored custom-role entry under a former key resolves like the current one. */
    readonly renamed?: Readonly<Record<string, string>>;
    /** Every declared permission key: a saved entry naming another key is `unknown-permission`. */
    readonly permissions?: readonly string[];
    /** Keys of permissions with `meta.manageRoles`: holding one lifts the hand-out check, as in-process. */
    readonly manage?: readonly string[];
    /** Keys of which the caller must hold one before any custom-role write (`rls.customRoleWrites.requires`). */
    readonly requires?: readonly string[];
    /** The application's roles table whose renames, moves and deletes cascade to the custom-role tables (`rls.customRoleWrites.roles`). */
    readonly table?: RlsCustomRoleTable;
    /**
     * Set when a resource declares levels: stored allows may carry a level
     * (`custom_role_permissions.level`, `key@level` in claims), and the
     * assignable roles' grants get one `<grant key>@<level>` key per level.
     */
    readonly levels?: true;
  };
  /** Set when link capabilities compile: resource-scoped grants also get `anon` branches. */
  readonly capabilities?: true;
  readonly apiKeys?: ApiKeysPlan;
  /** Role ownership rules (`for`, `assigns`, `min`, `max`, `transferOnly`), when any role declares one. */
  readonly ownership?: RlsOwnership;
  /** Scopes whose holder-count and transfer-only triggers `rls.ownershipTriggers` leaves out; `'all'` for every scope. */
  readonly skipOwnershipTriggers?: "all" | readonly string[];
  /** `rls.assignments`: assignment triggers on the membership tables, the global-roles table and these extra tables. */
  readonly assignments?: {
    readonly tables: readonly RlsAssignmentTable[];
    readonly ownRole?: "refuse" | Readonly<Record<string, "refuse">>;
  };
  /**
   * Postgres types of the current table's columns, read from the resource
   * schema (`columnTypesOf`). A claim compared with a typed column is cast to
   * that type; a column without an entry compares as text.
   */
  readonly columnTypes?: Readonly<Record<string, string>>;
  /** Array columns of the table, each with its item type: `contains` on one compiles to `v = any(col)`. */
  readonly arrayColumns?: Readonly<Record<string, string>>;
  /** Active-row tables; scope keys are declared names (`checkSuspension` resolves aliases). */
  readonly suspension?: RlsSuspension;
  /** The permission key of the grant being compiled, for the suspension `keep` of its inline checks. */
  readonly permission?: string;
  /** `rls.roles`: the app's global-roles table, in place of the generated `user_roles`. */
  readonly roles?: GlobalRoles;
  /** Set when field views compile: grant keys also split by field set. */
  readonly fields?: "views";
  /** Graph grants: the closure depth kept for each walked resource. */
  readonly graph?: {
    readonly closures: Readonly<Record<string, number>>;
    /** The policy's resources, for link hops. */
    readonly resources?: ReadonlyMap<string, ResourceNode>;
    /** The table of each resource, as `rls.tables` maps it. */
    readonly tables?: Readonly<Record<string, string>>;
  };
};

export type ApiKeysPlan = {
  readonly claim: string;
  readonly scopes: string;
  readonly tenant: string;
  readonly roles: string;
  readonly serviceRoles: readonly string[];
  readonly renamed?: Readonly<Record<string, string>>;
};

/** The policy's role ownership rules as the SQL generator needs them. */
export type RlsOwnership = {
  /** Role name to the membership kinds (`via`) that may hold it. */
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  /**
   * Who assigns what: the assigner's scope (or `global`) is the target role's
   * scope or an ancestor of it. `at` is the target role's own scope, or
   * `global` for a global role, which only a global assigner may assign.
   */
  readonly assigns: readonly {
    readonly assigner: string;
    readonly scope: string;
    readonly role: string;
    readonly at: string;
  }[];
  /** Roles whose holder count per scope instance is constrained. */
  readonly counted: readonly {
    readonly role: string;
    readonly scope: string;
    readonly min: number;
    readonly max?: number;
    readonly transferOnly: boolean;
  }[];
};

function checkActiveRow(label: string, row: RlsActiveRow): void {
  quoteTable(row.table);
  quoteIdent(row.id);
  if (row.disabledAt !== undefined) {
    quoteIdent(row.disabledAt);
  }
  if (row.status !== undefined) {
    quoteIdent(row.status);
    if (row.active === undefined || row.active.length === 0) {
      throw new Error(
        `PermDock CLI: ${label}.status needs the active values in ${label}.active`,
      );
    }
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw new Error(
      `PermDock CLI: ${label} needs disabledAt or status to tell an active row`,
    );
  }
}

/** Validates `rls.suspension` and keys its scopes by declared name. */
export function checkSuspension(
  suspension: RlsSuspension | undefined,
  scopes: readonly Scope[],
): RlsSuspension | undefined {
  if (suspension === undefined) {
    return undefined;
  }
  if (suspension.users !== undefined) {
    checkActiveRow("rls.suspension.users", suspension.users);
  }
  const byName: Record<string, RlsSuspendedScope> = {};
  for (const [key, row] of Object.entries(suspension.scopes ?? {})) {
    const name = resolveScope(scopes, key);
    if (name === undefined) {
      throw new Error(
        `PermDock CLI: rls.suspension.scopes.${key} names a scope the policy does not declare`,
      );
    }
    checkActiveRow(`rls.suspension.scopes.${key}`, row);
    if (row.keep !== undefined && !Array.isArray(row.keep)) {
      throw new Error(
        `PermDock CLI: rls.suspension.scopes.${key}.keep is a list of permissions or permission keys`,
      );
    }
    const keep = keptKeys(row);
    const { keep: _given, ...active } = row;
    byName[name] = keep.length === 0 ? active : { ...active, keep };
  }
  const memberships = suspension.memberships;
  if (memberships?.keep !== undefined && !Array.isArray(memberships.keep)) {
    throw new Error(
      "PermDock CLI: rls.suspension.memberships.keep is a list of permissions or permission keys",
    );
  }
  const keep = keptKeys(memberships);
  return {
    ...(suspension.users === undefined ? {} : { users: suspension.users }),
    ...(Object.keys(byName).length === 0 ? {} : { scopes: byName }),
    ...(keep.length === 0 ? {} : { memberships: { keep } }),
  };
}

export function disabledKeep(ctx: RlsSqlContext): readonly string[] {
  return keptKeys(ctx.suspension?.memberships);
}

export function activeMembershipSql(
  ctx: RlsSqlContext,
  disabledAt: string | undefined,
  permission: CheckedPermission | undefined = ctx.permission === undefined
    ? undefined
    : { key: ctx.permission },
): string[] {
  if (disabledAt === undefined) {
    return [];
  }
  const keep = disabledKeep(ctx);
  if (
    permission !== undefined &&
    "key" in permission &&
    keep.includes(permission.key)
  ) {
    return [];
  }
  return permission !== undefined && "sql" in permission && keep.length > 0
    ? [
        `(${disabledAt} is null or ${permission.sql} = any(array[${keep.map(quoteLiteral).join(", ")}]::text[]))`,
      ]
    : [`${disabledAt} is null`];
}

export function keptRowSql(
  keep: string,
  permission: CheckedPermission | undefined,
): string {
  const kind = `coalesce(jsonb_typeof(${keep}), 'null')`;
  if (permission === undefined) {
    return `${kind} = 'null'`;
  }
  const value =
    "key" in permission ? quoteLiteral(permission.key) : permission.sql;
  return `case ${kind} when 'null' then true when 'array' then ${keep} @> jsonb_build_array(${value}) else false end`;
}

/**
 * `exists` over an active row whose id column equals `id`: a missing row is
 * suspended, so the check fails closed.
 */
export function activeRowSql(row: RlsActiveRow, id: string): string {
  const table = quoteTable(
    row.table.includes(".") ? row.table : `public.${row.table}`,
  );
  const parts = [`s.${quoteIdent(row.id)} = ${id}`];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${quoteIdent(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = (row.active ?? []).map(quoteLiteral).join(", ");
    parts.push(
      `s.${quoteIdent(row.status)}::text = any(array[${values}]::text[])`,
    );
  }
  return `exists (select 1 from ${table} s where ${parts.join(" and ")})`;
}

/** The active-user check for `user`; empty without `rls.suspension.users`. */
export function activeUserSql(
  ctx: RlsSqlContext,
  user: string = subjectIdSql(ctx),
): string[] {
  const row = ctx.suspension?.users;
  return row === undefined ? [] : [activeRowSql(row, user)];
}

/**
 * The permission an active-instance check is for: a key known when the SQL
 * is generated, or the SQL of one read at run time. Without one, a
 * suspended instance keeps nothing.
 */
export type CheckedPermission =
  | { readonly key: string }
  | { readonly sql: string };

/** The permission of a grant key held in `grant`: `key#group` and `key@level` name `key`. */
export function grantPermissionSql(grant: string): CheckedPermission {
  return { sql: `split_part(split_part(${grant}, '#', 1), '@', 1)` };
}

/**
 * The active-instance check for every suspendable scope on `scope`'s chain:
 * its own and each ancestor's. `idOf` gives the SQL for the id the membership
 * holds for a scope on that chain. A scope's `keep` lets `permission` through
 * a suspended instance: a kept key known now drops its check, and one read
 * at run time is compared with the kept keys.
 */
export function activeInstancesSql(
  ctx: RlsSqlContext,
  scope: string,
  idOf: (name: string) => string | undefined,
  permission: CheckedPermission | undefined = ctx.permission === undefined
    ? undefined
    : { key: ctx.permission },
): string[] {
  const parts: string[] = [];
  for (const name of scopeChain(ctx.scopes, scope)) {
    const row = ctx.suspension?.scopes?.[name];
    if (row === undefined) {
      continue;
    }
    const id = idOf(name);
    if (id === undefined) {
      throw new Error(
        `PermDock CLI: rls.suspension.scopes.${name} needs the ${name} id on ${scope} memberships: add columns.${name} to the ${scope} memberships table`,
      );
    }
    const keep = keptKeys(row);
    if (
      permission !== undefined &&
      "key" in permission &&
      keep.includes(permission.key)
    ) {
      continue;
    }
    const active = activeRowSql(row, `(${id})::${scopeTypeOf(ctx, name)}`);
    parts.push(
      permission !== undefined && "sql" in permission && keep.length > 0
        ? `(${active} or ${permission.sql} = any(array[${keep.map(quoteLiteral).join(", ")}]::text[]))`
        : active,
    );
  }
  return parts;
}

const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/u;

export function sqlType(name: string): string {
  if (!SQL_TYPE.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL type '${name}'`);
  }
  return name;
}

export function tenantTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.tenantType ?? "uuid");
}

function teamTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.teamType ?? ctx.tenantType ?? "uuid");
}

/** Postgres type of scope `name`'s id: `scopeTypes`, then the tenant / team type by position. */
export function scopeTypeOf(ctx: RlsSqlContext, name: string): string {
  const declared = ctx.scopeTypes?.[name];
  if (declared !== undefined) {
    return sqlType(declared);
  }
  return name === ctx.scopes[1]?.name ? teamTypeOf(ctx) : tenantTypeOf(ctx);
}

/**
 * The membership kind of a row: SQL for a column (or a claim entry), or the
 * value every row of the table has, `null` when the table has no kind.
 */
export type MemberVia = string | { readonly value: string | null };

function viaAllowed(value: string | null, allowed: readonly string[]): boolean {
  return allowed.includes(value ?? "");
}

/**
 * A role with `for` counts only on a membership of one of those kinds:
 * `case role when 'admin' then via = any(...) ... else true end`. A missing
 * kind (`viaExpr` null) holds none of them. A constant kind folds into the
 * roles it excludes, or no filter. `undefined` when nothing is filtered.
 */
export function kindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
  viaExpr: MemberVia,
): string | undefined {
  const kinds = Object.entries(ctx.ownership?.kinds ?? {}).toSorted(
    ([a], [b]) => byCodePoint(a, b),
  );
  if (kinds.length === 0) {
    return undefined;
  }
  if (typeof viaExpr !== "string") {
    const excluded = kinds
      .filter(([, allowed]) => !viaAllowed(viaExpr.value, allowed))
      .map(([role]) => role);
    return excluded.length === 0
      ? undefined
      : `not (${roleExpr} = any(array[${excluded.map(quoteLiteral).join(", ")}]::text[]))`;
  }
  const arms = kinds.map(
    ([role, allowed]) =>
      `when ${quoteLiteral(role)} then coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(", ")}]::text[])`,
  );
  return `case ${roleExpr} ${arms.join(" ")} else true end`;
}

/** The kind check for one known role; `undefined` when it has no `for` or a constant kind it allows. */
export function roleKindSql(
  ctx: RlsSqlContext,
  role: string,
  viaExpr: MemberVia,
): string | undefined {
  const allowed = ctx.ownership?.kinds[role];
  if (allowed === undefined) {
    return undefined;
  }
  if (typeof viaExpr !== "string") {
    return viaAllowed(viaExpr.value, allowed) ? undefined : "false";
  }
  return `coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(", ")}]::text[])`;
}

/** Roles with `for` held globally (no membership, so no kind) grant nothing. */
export function globalKindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
): string | undefined {
  const roles = Object.keys(ctx.ownership?.kinds ?? {}).toSorted();
  return roles.length === 0
    ? undefined
    : `not (${roleExpr} = any(array[${roles.map(quoteLiteral).join(", ")}]::text[]))`;
}

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
    throw new Error(
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
  return roleColumn(table.role, qualifiedTable(table.table), alias, {
    label: `rls.memberships ${table.table} role`,
    prefix: CLI,
    ...(indent === undefined ? {} : { indent }),
  });
}

/** The schema-qualified name of a table under `search_path = ''`. */
export function qualifiedTable(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

/** The helper returning the ids of scope `name` a grant key reaches. */
export function permittedIdsHelper(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    throw new Error(`PermDock CLI: unsafe scope name '${name}'`);
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
    throw new Error(`PermDock CLI: unsafe scope name '${name}'`);
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
 * no table for it: every `fromTable` source and the `fromJunction` sources of
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

export function keyTenantSql(
  ctx: RlsSqlContext,
  tenant: string | undefined,
): string | undefined {
  const keys = ctx.apiKeys;
  if (keys === undefined) {
    return undefined;
  }
  const named = `nullif(${subjectClaimJsonSql(ctx, keys.claim)} ->> ${quoteLiteral(keys.tenant)}, '')`;
  return tenant === undefined
    ? `${named} is null`
    : `(${named} is null or (${tenant})::text = ${named})`;
}

/** The active-tenant claim cast to the tenant column's type, so the comparison uses the column's index. */
export function tenantClaimSql(ctx: RlsSqlContext): string {
  return `${subjectClaimSql(ctx, ctx.tenantClaim)}::${tenantTypeOf(ctx)}`;
}

export function quoteIdent(name: string): string {
  return quoteSqlIdent(name, CLI);
}

export function quoteTable(name: string): string {
  return quoteSqlTable(name, CLI);
}

/** The membership kind of a row `m` of `table`: its column as text, or its constant (`null` without one). */
export function memberVia(table: RlsMembershipTable): MemberVia {
  const via = table.via;
  if (via === undefined) {
    return { value: null };
  }
  return typeof via === "string"
    ? `m.${quoteIdent(via)}::text`
    : { value: via.value };
}

export function quoteLiteral(value: string): string {
  return quoteSqlLiteral(value);
}

export const USER_ID_HELPER = "permdock_user_id";

export function userIdHelperSql(ctx: Pick<RlsSqlContext, "schema">): string {
  return `${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${USER_ID_HELPER}`;
}

export const SESSION_LIVE_HELPER = "permdock_session_live";

/** `{ subject: { session: { live: true } } }` in a policy; only Supabase has `auth.sessions`. */
export function liveSessionSql(ctx: RlsSqlContext): string {
  if (ctx.dialect !== "supabase") {
    throw new Error(
      `PermDock CLI: { subject: { session: { live: true } } } reads auth.sessions, which only the supabase dialect has (got ${ctx.dialect})`,
    );
  }
  return `(select ${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${SESSION_LIVE_HELPER}())`;
}

/**
 * `permdock_session_live()`: the token's `session_id` names a session of its
 * user that is still in `auth.sessions`, so a signed-out or revoked session
 * stops passing before the token's `exp`. A token without one, such as a
 * service key's, is never live.
 */
export function sessionLiveHelperSql(ctx: RlsSqlContext): string {
  const name = `${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${SESSION_LIVE_HELPER}`;
  return `create or replace function ${name}()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  begin
    v_session := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_session is null then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions s
    where s.id = v_session
      and s.user_id::text = ${subjectIdSql(ctx)}::text
      and (s.not_after is null or s.not_after > now())
  );
end;
$$;
revoke execute on function ${name}() from public, anon;
grant execute on function ${name}() to authenticated;
`;
}

export function subjectIdSql(ctx: RlsSqlContext): string {
  if (ctx.subjectId !== undefined) {
    return ctx.subjectId;
  }
  switch (ctx.dialect) {
    case "supabase":
      return `(select ${userIdHelperSql(ctx)}())`;
    case "neon":
      return "(select auth.user_id())";
    case "guc":
      return `(select current_setting(${quoteLiteral(`${ctx.gucPrefix}.user_id`)}, true))`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function subjectClaimSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw new Error(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case "supabase":
      return `((select auth.jwt()) ->> ${quoteLiteral(claim)})`;
    case "neon":
      return `((select auth.session()) ->> ${quoteLiteral(claim)})`;
    case "guc":
      return `(select current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true))`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/** A claim as `jsonb`; the `guc` dialect stores JSON text in `<prefix>.<claim>`. */
export function subjectClaimJsonSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw new Error(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case "supabase":
      return `((select auth.jwt()) -> ${quoteLiteral(claim)})`;
    case "neon":
      return `((select auth.session()) -> ${quoteLiteral(claim)})`;
    case "guc":
      return `nullif((select current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true)), '')::jsonb`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The Postgres type a JSON Schema property compares as; `undefined` for text or an unknown shape. */
function columnTypeOf(property: unknown): string | undefined {
  if (!isRecord(property)) {
    return undefined;
  }
  // SAFETY: find(Array.isArray) returns an array or undefined; its items stay unknown.
  const variants = [property["anyOf"], property["oneOf"]].find(
    Array.isArray,
  ) as readonly unknown[] | undefined;
  if (variants !== undefined) {
    const present = variants.filter(
      (item) => !(isRecord(item) && item["type"] === "null"),
    );
    return present.length === 1 ? columnTypeOf(present[0]) : undefined;
  }
  const types = (
    Array.isArray(property["type"]) ? property["type"] : [property["type"]]
  ).filter((item) => item !== "null");
  if (types.length !== 1) {
    return undefined;
  }
  switch (types[0]) {
    case "integer":
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "string":
      switch (property["format"]) {
        case "date-time":
          return "timestamptz";
        case "date":
          return "date";
        case "uuid":
          return "uuid";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * Column types from a resource's JSON Schema (`~standard.jsonSchema`): numbers
 * compare as `numeric`, booleans as `boolean`, and `date-time`, `date` and
 * `uuid` strings as `timestamptz`, `date` and `uuid`. Other columns are left
 * out and compare as text.
 */
export function columnTypesOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const types: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    const type = isForbiddenKey(name) ? undefined : columnTypeOf(property);
    if (type !== undefined) {
      types[name] = type;
    }
  }
  return types;
}

/**
 * Array columns from a resource's JSON Schema, each with the type its items
 * compare as (`text` when `columnTypesOf` would leave the item out).
 */
export function arrayColumnsOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const arrays: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (isForbiddenKey(name) || !isRecord(property)) {
      continue;
    }
    const types = (
      Array.isArray(property["type"]) ? property["type"] : [property["type"]]
    ).filter((item) => item !== "null");
    if (types.length === 1 && types[0] === "array") {
      arrays[name] = columnTypeOf(property["items"]) ?? "text";
    }
  }
  return arrays;
}

export function parseMembershipsFlag(
  raw: string | undefined,
): RlsMemberships | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const colon = raw.indexOf(":");
  const table = colon === -1 ? raw : raw.slice(0, colon);
  const cols = (colon === -1 ? "" : raw.slice(colon + 1))
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const tenant: RlsMembershipTable = {
    table,
    tenant: cols[0] ?? "tenant_id",
    user: cols[1] ?? "user_id",
    role: cols[2] ?? "role",
    ...(cols[3] === undefined ? {} : { expiresAt: cols[3] }),
  };
  return { tenant };
}
