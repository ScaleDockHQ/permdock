import type { AuthorizationTokenHook } from "better-supabase/contract";

import type { SupabaseHookManifest } from "../supabase/manifest.ts";
import type { BetterSupabaseActiveTenant } from "./active-tenant.ts";

import { activeOrganizationFrom } from "./active-tenant.ts";

const TEAM_IDS_TRUNCATED = "team_ids_truncated";

/**
 * better-supabase's `tokenHook` from the manifest's hook and claims: the claims
 * PermDock owns and the ones it fills from other functions, the truncation
 * markers, the byte budget, the marker lines and the command that writes the
 * hook's grants.
 */
export function tokenHookOf(
  manifest: SupabaseHookManifest,
  activeTenant: BetterSupabaseActiveTenant | undefined,
): AuthorizationTokenHook {
  const owned = manifest.claims.filter((claim) => claim.source === "permdock");
  const registered = manifest.claims.filter(
    (claim) => claim.source !== "permdock",
  );
  const budgeted = manifest.claims.filter((claim) => claim.budget);
  const truncated = owned.some(
    (claim) => claim.name === "memberships_truncated",
  )
    ? "memberships_truncated"
    : undefined;
  const teamsTruncated = owned.some(
    (claim) => claim.name === TEAM_IDS_TRUNCATED,
  );
  const activeFrom =
    activeTenant === "resolver" || manifest.hook.activeFrom === undefined
      ? undefined
      : activeOrganizationFrom(manifest.hook.activeFrom, manifest.tenantClaim);
  return {
    function: `${manifest.hook.schema}.${manifest.hook.function}`,
    tenantClaim: manifest.tenantClaim,
    ...(activeFrom === undefined ? {} : { activeOrganizationFrom: activeFrom }),
    ownedClaims: owned.map((claim) => claim.name),
    // better-supabase takes one marker per hook: its `permissions` readers and
    // doctor's budget check read the same claim, so a memberships cut sends
    // permissionsOf to the database.
    ...(truncated === undefined ? {} : { truncatedClaim: truncated }),
    ...(teamsTruncated ? { teamIdsTruncatedClaim: TEAM_IDS_TRUNCATED } : {}),
    ...(registered.length > 0
      ? {
          registeredClaims: registered.map((claim) => ({
            name: claim.name,
            function: claim.source,
          })),
        }
      : {}),
    budget: {
      claims: budgeted.map((claim) => claim.name),
      bytes: manifest.budget.bytes,
      ...(truncated === undefined ? {} : { truncatedClaim: truncated }),
    },
    markers: {
      hook: `-- permdock:hook ${manifest.markers.hook}`,
      grants: `-- permdock:grants ${manifest.markers.grants}`,
    },
    grantsCommand: grantsCommandOf(manifest.hook.schemas ?? "pg-delta"),
  };
}

/** The command better-supabase doctor prints when the hook lacks its grants. */
function grantsCommandOf(
  schemas: NonNullable<SupabaseHookManifest["hook"]["schemas"]>,
): string {
  switch (schemas) {
    case "pg-delta":
      return "permdock supabase hook generate && supabase db schema declarative sync -f permdock_hook";
    case "migra":
      return "permdock supabase hook generate --grants-out supabase/migrations/<timestamp>_permdock_hook_grants.sql";
    case "migrations":
      return "permdock supabase hook generate --out supabase/migrations/<timestamp>_permdock_hook.sql";
    default: {
      const exhaustive: never = schemas;
      return exhaustive;
    }
  }
}
