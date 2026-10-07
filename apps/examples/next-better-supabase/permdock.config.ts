import { permissions } from "./src/permissions.ts";
import { sources } from "./src/sources.ts";

const { quotes } = permissions;

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
    // supabase.channel(`org:${organizationId}:quotes`, { config: { private: true } })
    realtime: {
      topics: {
        "org:{organization}:quotes": {
          read: quotes.read,
          write: quotes.update,
        },
      },
    },
    // objects named `<organization id>/<quote id>.pdf`
    storage: {
      buckets: {
        "quote-files": {
          scope: "organization",
          read: quotes.read,
          write: quotes.update,
          delete: quotes.update,
        },
      },
    },
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
