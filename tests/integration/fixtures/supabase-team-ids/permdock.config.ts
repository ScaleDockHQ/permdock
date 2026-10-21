import { junctionMembershipSource } from "permdock/supabase";

const memberships = [
  junctionMembershipSource({
    table: "organization_members",
    scope: "organization",
    id: "organization_id",
    roles: "role",
  }),
  junctionMembershipSource({
    table: "team_members",
    scope: "team",
    id: "team_id",
    within: { organization: "organization_id" },
    roles: ["teammate"],
  }),
];

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { tenant: "text" },
    authorize: "jwt",
  },
  supabase: { hook: { roles: false, memberships } },
};
