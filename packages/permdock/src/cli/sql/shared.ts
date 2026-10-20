import type { RlsConfig } from "../types.ts";
import type { RlsSqlContext } from "./context.ts";

import { subjectIdSql } from "./subject.ts";

/** `rls.customRoles` turns custom roles on as `true` or as an object. */
export function customRolesOn(rls: RlsConfig | undefined): boolean {
  const custom = rls?.customRoles;
  return custom === true || (typeof custom === "object" && custom !== null);
}

/**
 * The per-statement helpers every generated policy calls: `permdock_has` for
 * global roles and one `permitted_<scope>_ids` per scope
 * (`permittedIdsHelper`). Names are part of the SQL contract.
 */
export const HELPERS = {
  has: "permdock_has",
  hasFor: "permdock_has_for",
} as const;

/** Objects `--custom-roles` adds next to the helpers. Names are part of the SQL contract. */
export const CUSTOM_ROLES = {
  permissions: "custom_role_permissions",
  includes: "custom_role_includes",
  ceiling: "permdock_ceiling",
  keys: "permdock_custom_keys",
  beyond: "permdock_custom_role_beyond",
  guard: "permdock_custom_role_guard",
  beyondFor: "permdock_custom_role_beyond_for",
  guardFor: "permdock_custom_role_guard_for",
  shape: "permdock_custom_role_shape",
  entries: "permdock_custom_role_entries",
  replace: "permdock_replace_custom_role_grants",
  rename: "permdock_rename_custom_role_grants",
  remove: "permdock_delete_custom_role_grants",
  trustedReplace: "permdock_trusted_replace_custom_role_grants",
  trustedRename: "permdock_trusted_rename_custom_role_grants",
  trustedRemove: "permdock_trusted_delete_custom_role_grants",
  cascade: "permdock_cascade_custom_role",
  nameGuard: "permdock_custom_role_name_guard",
  sync: "permdock_sync_custom_role",
  shared: "permdock_is_shared_role",
} as const;

/** The function `rls.roles` adds. The name is part of the SQL contract. */
export const GLOBAL_ROLES = {
  replace: "permdock_replace_global_roles",
} as const;

/** `user` is the SQL for the user id: the dialect's (the default) or the `p_user` parameter of a `_for` helper. */
export function signedIn(
  ctx: RlsSqlContext,
  user: string = subjectIdSql(ctx),
): string {
  return `coalesce(${user}::text, '') <> ''`;
}

export function rootName(ctx: RlsSqlContext): string {
  return ctx.scopes[0]?.name ?? "tenant";
}

/** The stored allow as `permissions` hands it to `permdock_custom_keys`: `key`, or `key@level` with levels. */
export function allowEntry(ctx: RlsSqlContext): string {
  return ctx.customRoles?.levels === true
    ? "permission || coalesce('@' || c.level, '')"
    : "permission";
}
