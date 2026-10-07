import { supabaseRls } from "permdock/supabase";

export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "./policy.ts",
  rls: supabaseRls({
    tenantType: "text",
    memberships: {
      table: "organization_members",
      tenant: "organization_id",
      user: "user_id",
      role: "role",
    },
  }),
};
