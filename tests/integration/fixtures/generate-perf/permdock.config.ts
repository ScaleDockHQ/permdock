import { rls } from "permdock/cli/plugins/rls";

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    actions: { archive: "none", assign: "none", export: "none" },
  },
  plugins: [rls({ target: "sql", out: "out.sql" })],
};
