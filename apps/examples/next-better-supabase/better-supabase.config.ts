import { defineConfig } from "better-supabase/config";
import { readFileSync } from "node:fs";
import { authorizationProvider } from "permdock/better-supabase";

/**
 * Contact, role and PermDock tables stay off the Data API: only the token hook
 * and the security definer helpers read them.
 */
const internal = [
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
  gen: { output: "src/lib/supabase/generated.ts" },
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
    }),
  },
  database: {
    sql: { testsDir: "supabase/tests" },
    expose: {
      organizations: { anon: ["select"], authenticated: ["select"] },
      staff: ["select"],
      quotes: ["select"],
      organization_memberships: ["select"],
      datetime_preferences: ["select"],
      ...Object.fromEntries(internal.map((table) => [table, []])),
    },
  },
  blocks: {
    permissions: {
      model: "provider",
      // Memberships are service-only tables here, so no client assigns a role.
      functions: { canAssign: "false" },
    },
    "updated-at": {},
    audit: {
      permissions: {
        view: "audit.read",
        viewAll: "audit.read",
        revert: "audit.revert",
      },
    },
    pgtap: {},
    // The block runs over the app's table, which PermDock reads with blockMembershipSource.
    memberships: {
      tables: { memberships: "public.organization_memberships" },
      columns: { memberships: { updatedAt: null, lastUsedAt: null } },
    },
    // Guest links to a quote: whoever may update quotes creates them.
    "share-links": {
      permissions: { create: "quotes.update", read: "quotes.read" },
    },
  },
  tooling: {
    doctor: {
      // staff and quotes are read-only to clients: the API roles hold no write
      // privilege on them, so a missing insert, update or delete policy denies nothing extra.
      ignore: ["BS107"],
    },
  },
});
