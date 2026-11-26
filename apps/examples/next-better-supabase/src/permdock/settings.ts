import "server-only";
import type { SettingsSource } from "permdock";

import { postgres } from "../lib/supabase/server.ts";

function seconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Tightens API keys from `organization_settings.credentialMaxTtl`. No row means
 * no extra rule. `createPermDock` does not take a settings source.
 */
export const tenantSettings: SettingsSource = {
  name: "better-supabase-settings",
  async settingsFor(tenant) {
    const rows = await postgres.admin.queryRaw(
      `select value from better_supabase.organization_settings
       where tenant_id = $1 and key = 'credentialMaxTtl'`,
      [tenant],
    );
    const maxTtl = seconds(rows[0]?.["value"]);
    return maxTtl === undefined ? undefined : { credentials: { maxTtl } };
  },
};
