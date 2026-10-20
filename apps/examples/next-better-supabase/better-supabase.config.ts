import { defineConfig } from "better-supabase/config";
import { readFileSync } from "node:fs";
import { authorizationProvider } from "permdock/better-supabase";

/** Membership and PermDock tables stay off the Data API: only the token hook and the security definer helpers read them. */
const internal = [
  "memberships",
  "contacts",
  "customers",
  "organization_features",
  "user_roles",
  "role_permissions",
  "permdock_authz_version",
  "roles",
  "custom_role_permissions",
  "custom_role_includes",
] as const;

export default defineConfig({
  output: "src/lib/supabase/generated.ts",
  authorization: authorizationProvider({
    manifest: readFileSync(
      new URL("permdock.manifest.json", import.meta.url),
      "utf8",
    ),
    catalog: readFileSync(
      new URL("permissions.catalog.json", import.meta.url),
      "utf8",
    ),
  }),
  sql: { testsDir: "supabase/tests" },
  blocks: {
    access: {
      model: "provider",
      // Memberships are service-only tables here, so no client assigns a role.
      functions: { canAssign: "false" },
    },
    "updated-at": {},
    audit: {
      permissions: {
        view: "audit.view",
        viewAll: "audit.view",
        revert: "audit.revert",
      },
    },
    pgtap: {},
  },
  doctor: {
    // staff and quotes are read-only to clients: the API roles hold no write
    // privilege on them, so a missing insert, update or delete policy denies nothing extra.
    ignore: ["BS107"],
  },
  expose: {
    organizations: { anon: ["select"], authenticated: ["select"] },
    staff: ["select"],
    quotes: ["select"],
    datetime_preferences: ["select"],
    ...Object.fromEntries(internal.map((table) => [table, []])),
  },
});
