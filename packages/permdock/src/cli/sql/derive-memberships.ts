import { isDeepStrictEqual } from "node:util";

import type {
  SupabaseManifestMembership,
  SupabaseManifestRole,
} from "../../supabase/manifest.ts";
import type { RoleMap, RoleThrough } from "../../supabase/types.ts";
import type {
  PermDockConfig,
  RlsMembershipTable,
  RlsMemberships,
} from "../types.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { membershipSourcesOf } from "./sources.ts";

type MappedRole = string | RoleMap | RoleThrough;

function roleOne(role: SupabaseManifestRole): MappedRole | undefined {
  if (!("column" in role)) {
    return undefined;
  }
  if ("through" in role) {
    return role.through.on === undefined
      ? {
          through: role.through.table,
          on: { [role.column]: role.through.id },
          column: role.through.column,
        }
      : undefined;
  }
  if ("map" in role) {
    return { column: role.column, map: role.map };
  }
  return role.column;
}

function roleOf(
  role: SupabaseManifestMembership["role"],
): RlsMembershipTable["role"] | undefined {
  if (!Array.isArray(role)) {
    // SAFETY: Array.isArray narrows the readonly array branch out; what is left is one manifest role.
    return roleOne(role as SupabaseManifestRole);
  }
  const roles = role.map((item: SupabaseManifestRole) => roleOne(item));
  return roles.every((item) => item !== undefined)
    ? roles.filter((item) => item !== undefined)
    : undefined;
}

/**
 * The `rls.memberships` table one junction source describes, or `undefined`
 * when the table form cannot say the same: a user read through another table, a
 * scope column, fixed roles, a kind column or a guarded roles table.
 */
function tableOf(
  manifest: SupabaseManifestMembership,
  guarded: boolean,
): { readonly scope: string; readonly table: RlsMembershipTable } | undefined {
  if (
    guarded ||
    "through" in manifest.user ||
    !("value" in manifest.scope) ||
    typeof manifest.scope.value !== "string" ||
    (manifest.within !== undefined && !("columns" in manifest.within)) ||
    (manifest.via !== undefined &&
      (!("value" in manifest.via) || typeof manifest.via.value !== "string"))
  ) {
    return undefined;
  }
  const role = roleOf(manifest.role);
  if (role === undefined) {
    return undefined;
  }
  const scope = manifest.scope.value;
  const within =
    manifest.within !== undefined && "columns" in manifest.within
      ? manifest.within.columns
      : {};
  const via =
    manifest.via !== undefined &&
    "value" in manifest.via &&
    typeof manifest.via.value === "string"
      ? { value: manifest.via.value }
      : undefined;
  return {
    scope,
    table: {
      table: manifest.table,
      user: manifest.user.column,
      role,
      columns: { [scope]: manifest.id.column, ...within },
      ...(manifest.expiresAt === undefined
        ? {}
        : { expiresAt: manifest.expiresAt.column }),
      ...(manifest.disabledAt === undefined
        ? {}
        : { disabledAt: manifest.disabledAt.column }),
      ...(via === undefined ? {} : { via }),
    },
  };
}

/**
 * The `rls.memberships` tables the membership sources describe, one per scope,
 * or `undefined` unless every source maps to its own scope in the table form:
 * the generator reads the sources themselves otherwise, and a partial
 * derivation would drop the rest.
 */
export function membershipsFromSources(
  config: PermDockConfig,
): RlsMemberships | undefined {
  const scopes: Record<string, RlsMembershipTable> = {};
  for (const source of membershipSourcesOf(config)) {
    const found = tableOf(
      source.sql.manifest,
      source.sql.stream?.guard !== undefined,
    );
    if (found === undefined || Object.hasOwn(scopes, found.scope)) {
      return undefined;
    }
    scopes[found.scope] = found.table;
  }
  return Object.keys(scopes).length === 0 ? undefined : { scopes };
}

function normalisedRole(role: MappedRole): MappedRole {
  return typeof role === "object" && "through" in role
    ? { ...role, through: qualifySqlTable(role.through) }
    : role;
}

function normalisedTable(table: RlsMembershipTable): unknown {
  const role = table.role;
  return {
    ...table,
    table: qualifySqlTable(table.table),
    role: Array.isArray(role)
      ? role.map((item: MappedRole) => normalisedRole(item))
      : normalisedRole(
          // SAFETY: Array.isArray narrows the list branch out; what is left is one role.
          role as MappedRole,
        ),
    columns: table.columns ?? {},
  };
}

/** A scope whose written `rls.memberships` table differs from its source. */
export type MembershipDisagreement = {
  readonly scope: string;
  readonly written: RlsMembershipTable;
  readonly derived: RlsMembershipTable | undefined;
};

/**
 * The scopes `rls.memberships` maps differently from the membership sources. A
 * scope the sources leave out, or describe in a form the table cannot, is a
 * disagreement only when a source names that scope.
 */
export function membershipDisagreements(
  config: PermDockConfig,
): readonly MembershipDisagreement[] {
  const written = config.rls?.memberships?.scopes;
  if (written === undefined) {
    return [];
  }
  const sourced = new Set(
    membershipSourcesOf(config).flatMap((source) => {
      const scope = source.sql.manifest.scope;
      return "value" in scope && typeof scope.value === "string"
        ? [scope.value]
        : [];
    }),
  );
  const derived = membershipsFromSources(config)?.scopes ?? {};
  return Object.entries(written).flatMap(([scope, table]) => {
    if (!sourced.has(scope)) {
      return [];
    }
    const from = derived[scope];
    return from !== undefined &&
      isDeepStrictEqual(normalisedTable(table), normalisedTable(from))
      ? []
      : [{ scope, written: table, derived: from }];
  });
}

/**
 * `config` with `rls.memberships` and `rls.suspension` filled from the
 * membership sources and `supabase.hook.suspension` when `rls` is set and
 * leaves them out, so each fact is declared once.
 */
export function withSourcedRls(config: PermDockConfig): PermDockConfig {
  const rls = config.rls;
  if (rls === undefined) {
    return config;
  }
  const memberships =
    rls.memberships === undefined ? membershipsFromSources(config) : undefined;
  const suspension =
    rls.suspension === undefined
      ? config.supabase?.hook?.suspension
      : undefined;
  if (memberships === undefined && suspension === undefined) {
    return config;
  }
  return {
    ...config,
    rls: {
      ...rls,
      ...(memberships === undefined ? {} : { memberships }),
      ...(suspension === undefined ? {} : { suspension }),
    },
  };
}

/**
 * The `rls.memberships.scopes` entries and the `rls.suspension` block that say
 * what the membership sources and `supabase.hook.suspension` already say, as
 * config paths.
 */
export function restatedFacts(
  config: PermDockConfig,
): readonly (readonly string[])[] {
  const paths: (readonly string[])[] = [];
  const written = config.rls?.memberships?.scopes ?? {};
  const derived = membershipsFromSources(config)?.scopes ?? {};
  for (const [scope, table] of Object.entries(written)) {
    const from = derived[scope];
    if (
      from !== undefined &&
      isDeepStrictEqual(normalisedTable(table), normalisedTable(from))
    ) {
      paths.push(["rls", "memberships", "scopes", scope]);
    }
  }
  const suspension = config.rls?.suspension;
  const hook = config.supabase?.hook?.suspension;
  if (
    suspension !== undefined &&
    hook !== undefined &&
    isDeepStrictEqual(suspension, hook)
  ) {
    paths.push(["rls", "suspension"]);
  }
  return paths;
}
