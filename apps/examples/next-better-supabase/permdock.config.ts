import { sources } from "./src/sources.ts";

export default {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  collect: { srcPath: ["./src"] },
  rls: {
    dialect: "supabase",
    authorize: "database",
    tenantType: "uuid",
    tables: ["staff", "quotes"],
    readOnlyActors: true,
  },
  supabase: {
    hook: {
      memberships: sources(),
      claims: {
        datetime_preferences: "public.datetime_preference_claims",
        features: "public.feature_claims",
      },
    },
  },
};
