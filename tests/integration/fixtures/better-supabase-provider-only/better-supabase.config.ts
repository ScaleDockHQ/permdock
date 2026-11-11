import { defineConfig } from "better-supabase/config";
import { readFileSync } from "node:fs";
import { authorizationProvider } from "permdock/better-supabase";

import { permissions } from "./permissions.ts";

/** Only the token hook and the security definer helpers read these. */
const internal = [
  "organizations",
  "profiles",
  "memberships",
  "platform_roles",
  "reporting_lines",
] as const;

/**
 * Every authorization slot comes from the provider: memberships, suspension,
 * platform roles, the subject readers, the role personas and the approval sets
 * are all read from `permdock.manifest.json`.
 */
export default defineConfig({
  auth: {
    authorization: authorizationProvider({
      manifest: readFileSync(
        new URL("permdock.manifest.json", import.meta.url),
        "utf8",
      ),
      catalog: readFileSync(
        new URL("permissions.catalog.json", import.meta.url),
        "utf8",
      ),
      permissions,
      personas: "roles",
    }),
  },
  database: {
    sql: { testsDir: "supabase/tests" },
    expose: {
      projects: ["select", "update", "delete"],
      ...Object.fromEntries(internal.map((table) => [table, []])),
    },
  },
  blocks: {
    permissions: { model: "provider", activeTenant: "claim" },
    pgtap: {},
  },
  tooling: {
    doctor: {
      // BS303: the fixture has no app code, so it keeps no generated client.
      // BS377: the test builds the database from the schema files, so no schema migration exists.
      // BS601 and BS700 report the workspace install and the host, not the project.
      ignore: ["BS303", "BS377", "BS601", "BS700"],
    },
  },
});
