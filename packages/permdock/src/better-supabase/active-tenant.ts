import type {
  SupabaseHookManifest,
  SupabaseManifestActiveFrom,
} from "../supabase/manifest.ts";

import { qualifySqlTable } from "../core/sql.ts";

/**
 * better-supabase's `blocks.permissions.activeTenant`: where its
 * `switch_organization` writes the active tenant and `current_tenant_id()`
 * reads it.
 */
export type BetterSupabaseActiveTenant =
  | "claim"
  | "resolver"
  | { readonly profileColumn: string; readonly key?: string };

const REQUEST =
  ', or set supabase.hook.activeTenant: "request" when the request resolves the tenant.';

function describe(from: SupabaseManifestActiveFrom): string {
  return "appMetadata" in from
    ? `app_metadata.${from.appMetadata}`
    : `${from.table}.${from.column} (joined on ${from.id})`;
}

/**
 * Why PermDock's token hook and better-supabase disagree on the active tenant,
 * or `undefined` when they agree. `"resolver"` takes the tenant from the
 * request, so any hook source agrees with it.
 */
export function activeTenantMismatch(
  from: SupabaseManifestActiveFrom,
  tenantClaim: string,
  activeTenant: BetterSupabaseActiveTenant,
): string | undefined {
  if (activeTenant === "resolver") {
    return undefined;
  }
  if (activeTenant === "claim") {
    if ("appMetadata" in from && from.appMetadata === tenantClaim) {
      return undefined;
    }
    return `blocks.permissions.activeTenant is "claim", so better-supabase's switch_organization writes app_metadata.${tenantClaim}, but PermDock's token hook reads the active tenant from ${describe(from)}. Set supabase.hook.activeFrom: "app_metadata.${tenantClaim}" and run permdock supabase hook generate${REQUEST}`;
  }
  const dot = activeTenant.profileColumn.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  const table = qualifySqlTable(activeTenant.profileColumn.slice(0, dot));
  const column = activeTenant.profileColumn.slice(dot + 1);
  const id = activeTenant.key ?? "id";
  if (
    "table" in from &&
    qualifySqlTable(from.table) === table &&
    from.column === column &&
    from.id === id
  ) {
    return undefined;
  }
  return `blocks.permissions.activeTenant writes the active tenant to ${table}.${column} (joined on ${id}), but PermDock's token hook reads it from ${describe(from)}. Set supabase.hook.activeFrom: { table: "${table}", column: "${column}", id: "${id}" } and run permdock supabase hook generate${REQUEST}`;
}

/**
 * Where the token hook reads the active tenant, as better-supabase names it in
 * `tokenHook.activeOrganizationFrom`: `"resolver"` with
 * `supabase.hook.activeTenant: "request"`, else the hook's `activeFrom`.
 * `undefined` when the manifest has no `activeFrom` or the hook reads an
 * `app_metadata` key other than the tenant claim, which has no better-supabase
 * name.
 */
export function activeOrganizationFrom(
  hook: SupabaseHookManifest["hook"],
  tenantClaim: string,
): BetterSupabaseActiveTenant | undefined {
  if (hook.activeTenant === "request") {
    return "resolver";
  }
  const from = hook.activeFrom;
  if (from === undefined) {
    return undefined;
  }
  if ("appMetadata" in from) {
    return from.appMetadata === tenantClaim ? "claim" : undefined;
  }
  return {
    profileColumn: `${qualifySqlTable(from.table)}.${from.column}`,
    ...(from.id === "id" ? {} : { key: from.id }),
  };
}
