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
    scopeTypes: { tenant: "uuid" },
    tables: { staff: "staff", quotes: "quotes" },
    readOnlyActors: true,
    // Out-of-office covers: a delegate approves for the delegator inside a window.
    approvals: { delegations: true },
    // The guest quote page reads through an exchanged share-link capability.
    capabilities: true,
    // The app keeps each custom role's entries in `public.role_permissions`; a trigger copies them.
    customRoles: {
      from: {
        sync: "trigger",
        permissions: {
          table: "role_permissions",
          role: { through: "roles", on: { role_id: "id" }, column: "key" },
          permission: "permission",
        },
      },
    },
    trustedReaders: ["service_role"],
    customRoleWrites: {
      requires: ["roles.manage"],
      roles: {
        table: "roles",
        key: "key",
        tenant: "organization_id",
        skip: "is_system",
        primaryKey: "id",
      },
      audit: {
        function: "better_supabase.audit_event_trusted",
        args: { source: "permdock" },
      },
    },
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
