import type { SupabaseHookConfig } from "../types-supabase.ts";

import { configError } from "../core/errors.ts";

/**
 * `supabase.hook.activeTenant`: `"request"` when the app resolves the active
 * tenant per request, which the manifest carries for better-supabase's
 * `activeOrganizationFrom: "resolver"`.
 */
export function hookActiveTenant(
  hook: SupabaseHookConfig,
): "request" | undefined {
  const value: unknown = hook.activeTenant;
  if (value === undefined || value === "request") {
    return value;
  }
  throw configError(
    `PermDock CLI: supabase.hook.activeTenant is ${JSON.stringify(value)}; the only value is "request"`,
  );
}
