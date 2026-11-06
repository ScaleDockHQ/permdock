import { rls } from "permdock/cli/plugins/rls";
import { supabaseHook } from "permdock/cli/plugins/supabase-hook";

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: {
      organization: "text",
      region: "text",
      site: "text",
      workspace: "text",
      squad: "text",
      project: "text",
    },
    authorize: "database",
    memberships: {
      scopes: {
        organization: {
          table: "organization_members",
          user: "user_id",
          role: "role",
          columns: { organization: "organization_id" },
        },
        region: {
          table: "region_members",
          user: "user_id",
          role: "role",
          columns: { organization: "organization_id", region: "region_id" },
        },
        site: {
          table: "site_members",
          user: "user_id",
          role: "role",
          columns: {
            organization: "organization_id",
            region: "region_id",
            site: "site_id",
          },
        },
        workspace: {
          table: "workspace_members",
          user: "user_id",
          role: "role",
          columns: {
            organization: "organization_id",
            region: "region_id",
            site: "site_id",
            workspace: "workspace_id",
          },
        },
        squad: {
          table: "squad_members",
          user: "user_id",
          role: "role",
          columns: {
            organization: "organization_id",
            region: "region_id",
            site: "site_id",
            workspace: "workspace_id",
            squad: "squad_id",
          },
        },
        project: {
          table: "project_members",
          user: "user_id",
          role: "role",
          columns: {
            organization: "organization_id",
            region: "region_id",
            site: "site_id",
            workspace: "workspace_id",
            squad: "squad_id",
            project: "project_id",
          },
        },
      },
    },
    actions: { export: "none" },
    rowHelpers: [
      "res00",
      "res01",
      "res02",
      "res03",
      "res04",
      "res05",
      "res06",
      "res07",
      "res08",
      "res09",
    ],
  },
  supabase: { hook: { budget: 2000 } },
  plugins: [rls({ target: "sql", out: "out.sql" }), supabaseHook()],
};
