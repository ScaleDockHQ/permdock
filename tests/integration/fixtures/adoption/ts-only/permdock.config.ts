import { defineConfig } from "permdock/cli";

export default defineConfig({
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  plugins: [],
});
