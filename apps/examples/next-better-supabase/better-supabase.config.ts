import { defineConfig } from "better-supabase/config";

/** Membership and PermDock tables stay off the Data API: only the token hook and the security definer helpers read them. */
const internal = [
  "memberships",
  "contacts",
  "customers",
  "organization_features",
  "user_roles",
  "role_permissions",
  "permdock_authz_version",
] as const;

export default defineConfig({
  output: "src/lib/supabase/generated.ts",
  sql: {
    dir: "supabase/schemas/better_supabase",
    testsDir: "supabase/tests",
    kit: ["updated-at", "audit", "pgtap"],
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
