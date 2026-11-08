import { defineConfig } from "permdock/cli";

export default defineConfig({
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  gen: { kinds: ["bundle"], out: "src/permdock" },
});
