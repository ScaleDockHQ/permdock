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
  gen: { file: "src/lib/supabase/generated.ts" },
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
  blocks: [
    {
      block: "permissions",
      model: "provider",
      activeTenant: "claim",
      // Memberships are service-only tables here, so no client assigns a role.
      functions: { canAssign: "false" },
    },
    "updated-at",
    "audit",
    "pgtap",
    // The block runs over the app's table, which PermDock reads with blockMembershipSource.
    {
      block: "memberships",
      tables: { memberships: "public.organization_memberships" },
    },
    // Guest links to a quote: whoever may update quotes creates them.
    {
      block: "share-links",
      permissions: { create: "quotes.update", read: "quotes.read" },
    },
  ],
  tooling: {
    doctor: {
      // staff and quotes are read-only to clients: the API roles hold no write
      // privilege on them, so a missing insert, update or delete policy denies nothing extra.
      // BS243: the generated permdock.* helpers embed the compiled policy as a literal.
      // BS601: `@chat-adapter/catalog` 4.42 and `@workflow/world` 5.0 are transitive and
      // inside the release-age window of the ranges 0.53 asks for.
      // BS721, BS722, BS723: pg-topo 1.0.0-alpha.8 reads `"public"."roles"."id"%type` as a type
      // and takes overloads for one function: permitted_quotes_rows(text, uuid) and (text, uuid[])
      // for a duplicate, and permdock_is_approver's overloads, which call each other, for a cycle.
      ignore: ["BS107", "BS243", "BS601", "BS721", "BS722", "BS723"],
    },
  },
});
