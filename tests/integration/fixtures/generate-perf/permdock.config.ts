import { rls } from "permdock/cli/plugins/rls";

export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: { dialect: "supabase" },
  plugins: [rls({ target: "sql", out: "out.sql" })],
};
