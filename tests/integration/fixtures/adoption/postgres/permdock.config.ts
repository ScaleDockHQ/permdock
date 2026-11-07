import { defineConfig } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";

export default defineConfig({
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  plugins: [rls({ dialect: "neon" })],
});
