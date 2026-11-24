import type {
  AuthorizationProvider,
  AuthorizationRoleSource,
} from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type {
  SupabaseManifest,
  SupabaseManifestMembership,
  SupabaseManifestRole,
} from "../supabase/manifest.ts";

import { qualifySqlTable, quoteSqlLiteral, sqlIdent } from "../core/sql.ts";
import { ASSIGN_ANY } from "./provider-functions.ts";

export function isRoleList(
  role: SupabaseManifestMembership["role"],
): role is readonly SupabaseManifestRole[] {
  return Array.isArray(role);
}

function scopeValue(source: SupabaseManifestMembership): string | undefined {
  if (!("value" in source.scope)) {
    return undefined;
  }
  return typeof source.scope.value === "string"
    ? source.scope.value
    : undefined;
}

function scopeRoleKeys(
  catalog: CatalogDocument | undefined,
  scope: string | undefined,
): readonly string[] {
  return (catalog?.roles ?? [])
    .filter((role) =>
      scope === undefined ? typeof role.on === "string" : role.on === scope,
    )
    .map((role) => role.key)
    .toSorted();
}

function roleWhere(
  column: string,
  keys: readonly string[],
  tenant: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (keys.length > 0) {
    const listed = keys.map((key) => quoteSqlLiteral(key)).join(", ");
    parts.push(`{row}.${sqlIdent(column)} in (${listed})`);
  }
  if (tenant !== undefined && tenant !== "") {
    parts.push(`{row}.${sqlIdent(tenant)} is not null`);
  }
  return parts.length === 0 ? undefined : parts.join(" or ");
}

/** `rls.customRoleScope` when `table` is the custom-role table it describes. */
function customRoleScopeOf(
  manifest: SupabaseManifest,
  table: string,
): NonNullable<SupabaseManifest["rls"]["customRoleScope"]> | undefined {
  const scope = manifest.rls.customRoleScope;
  return scope !== undefined &&
    qualifySqlTable(scope.table) === qualifySqlTable(table)
    ? scope
    : undefined;
}

/**
 * A membership's role column read through the roles table, as better-supabase's
 * `roleSources` entry. With the custom-role table's scope column in the
 * manifest, `where` keeps the roles at the membership's scope; without it, the
 * catalog's roles at that scope and every tenant custom role.
 */
export function roleSourceOf(
  manifest: SupabaseManifest,
  source: SupabaseManifestMembership,
  catalog: CatalogDocument | undefined,
): AuthorizationRoleSource | undefined {
  const role = source.role;
  if (
    isRoleList(role) ||
    !("column" in role) ||
    !("through" in role) ||
    role.through.on !== undefined
  ) {
    return undefined;
  }
  const tenant = manifest.rls.customRoleTenant;
  const scoped = customRoleScopeOf(manifest, role.through.table);
  const value = scopeValue(source);
  const where =
    scoped !== undefined && value !== undefined
      ? `{row}.${sqlIdent(scoped.column)} = ${quoteSqlLiteral(value)}`
      : roleWhere(role.through.column, scopeRoleKeys(catalog, value), tenant);
  return {
    table: source.table,
    role: {
      column: role.column,
      through: {
        table: role.through.table,
        id: role.through.id,
        column: role.through.column,
        ...(tenant === undefined || tenant === "" ? {} : { tenant }),
        ...(where === undefined ? {} : { where }),
      },
    },
  };
}

/**
 * `rls.roles` as better-supabase's `platformRoles`: the global-roles table with
 * its roles table, and the assignment helpers asked at the `global` scope.
 * `through.where` needs the custom-role table's scope column and its
 * `globalScope` value in the manifest.
 */
export function platformRolesOf(
  manifest: SupabaseManifest,
  schema: string,
  assignAny: boolean,
): AuthorizationProvider["platformRoles"] {
  const roles = manifest.rls.roles;

  if (
    roles === undefined ||
    isRoleList(roles.role) ||
    !("column" in roles.role)
  ) {
    return undefined;
  }

  const through = "through" in roles.role ? roles.role.through : undefined;
  const scoped =
    through === undefined
      ? undefined
      : customRoleScopeOf(manifest, through.table);
  const where =
    scoped?.global === undefined
      ? undefined
      : `{row}.${sqlIdent(scoped.column)} = ${quoteSqlLiteral(scoped.global)}`;
  const literal = quoteSqlLiteral("global");

  return {
    table: roles.table,
    user: roles.user.column,
    role: roles.role.column,
    ...(through === undefined || through.on !== undefined
      ? {}
      : {
          through: {
            table: through.table,
            id: through.id,
            column: through.column,
            ...(where === undefined ? {} : { where }),
          },
        }),
    ...(assignAny
      ? {
          canAssign: `${schema}.${ASSIGN_ANY.canAssign.helper}({role}, null::uuid, ${literal}, null::text)`,
          canAssignFor: `${schema}.${ASSIGN_ANY.canAssignFor.helper}({user}, {role}, null::uuid, ${literal}, null::text)`,
        }
      : {}),
  };
}
