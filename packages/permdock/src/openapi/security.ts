import type { Permission } from "../core/permissions.ts";
import type { OpenApiSecurityRequirement } from "./types.ts";

export type SecurityForOptions = {
  /** The security scheme name; defaults to `oauth2`, the name the adapters' `openapi.securitySchemes()` declares. */
  readonly scheme?: string;
  /** Any one of the permissions suffices: one requirement per scope instead of one with every scope. */
  readonly anyOf?: boolean;
};

export type SecurityFor = {
  readonly security: readonly OpenApiSecurityRequirement[];
  readonly "x-permdock-permissions": readonly string[];
};

function isList(
  permission: Permission | readonly Permission[],
): permission is readonly Permission[] {
  return Array.isArray(permission);
}

function listOf(
  permission: Permission | readonly Permission[],
): readonly Permission[] {
  return isList(permission) ? permission : [permission];
}

/** The `x-permdock-permissions` value: the permission keys an operation enforces. */
export function permissionsExtension(
  permissions: Permission | readonly Permission[],
): readonly string[] {
  return Object.freeze(listOf(permissions).map((leaf) => leaf.key));
}

/**
 * An operation's `security` and `x-permdock-permissions`, from permission
 * references alone. Needs no policy, so a contract package can import it.
 * Unlike `permdock openapi emit`, it never drops `security` for a public
 * permission: that needs the policy.
 */
export function securityFor(
  permission: Permission | readonly Permission[],
  options: SecurityForOptions = {},
): SecurityFor {
  const leaves = listOf(permission);
  const scheme = options.scheme ?? "oauth2";
  const security: readonly OpenApiSecurityRequirement[] =
    // An empty `security` list marks an operation public, so no permissions still requires the scheme.
    options.anyOf === true && leaves.length > 0
      ? leaves.map((leaf) => ({ [scheme]: [leaf.scope] }))
      : [{ [scheme]: leaves.map((leaf) => leaf.scope) }];
  return Object.freeze({
    security,
    "x-permdock-permissions": permissionsExtension(leaves),
  });
}
