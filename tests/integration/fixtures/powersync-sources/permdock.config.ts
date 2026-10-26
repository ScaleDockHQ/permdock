import { junctionMembershipSource } from "permdock/supabase";

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "guc",
    scopeTypes: { tenant: "text" },
    authorize: "database",
    customRoles: true,
    fixtures: "rls.fixtures.json",
    tables: { job: "jobs" },
    membershipSources: [
      junctionMembershipSource({
        table: "tenant_users",
        scope: "tenant",
        id: "tenant_id",
        roles: "tier_role",
      }),
      junctionMembershipSource({
        table: "user_roles",
        scope: "tenant",
        id: "tenant_id",
        roles: { through: "roles", on: { role_id: "id" }, column: "key" },
      }),
    ],
  },
  powersync: {
    out: "sync-config.yaml",
    manifest: "permdock-manifest.json",
    tables: {
      attachments: {
        follow: [
          { resource: "job", field: "parent_id", match: { kind: "job" } },
        ],
      },
    },
  },
};
