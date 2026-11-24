import type {
  AuthorizationProvider,
  AuthorizationRequirement,
} from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type { SupabaseManifest } from "../supabase/manifest.ts";

import { sqlIdent } from "../core/sql.ts";
import { hasTokenHook } from "../supabase/manifest.ts";

/**
 * better-supabase's `versions` from the hook's `authz_version_for(p_user
 * uuid)`, which the hook writes beside `permdock_authz_version` when
 * `supabase.hook.version` is on. It answers `null` for an unknown or suspended
 * user.
 */
export function versionsOf(
  manifest: SupabaseManifest,
):
  | {
      readonly versions: NonNullable<AuthorizationProvider["versions"]>;
      readonly requires: AuthorizationRequirement;
    }
  | undefined {
  if (!hasTokenHook(manifest) || !manifest.authzVersion) return undefined;
  const fn = `${sqlIdent(manifest.hook.schema)}.authz_version_for`;
  return {
    versions: { function: fn },
    requires: { function: fn, args: "uuid", role: "postgres" },
  };
}

/**
 * `'none'` when no catalog key holds a `*`: PermDock grants name exact keys, so
 * a stray wildcard row in better-supabase's tables grants nothing.
 */
export function wildcardsOf(
  catalog: CatalogDocument | undefined,
): AuthorizationProvider["wildcards"] {
  if (catalog === undefined) return undefined;
  return catalog.permissions.some((permission) => permission.key.includes("*"))
    ? undefined
    : "none";
}
