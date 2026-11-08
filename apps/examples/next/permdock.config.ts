import { defineConfig } from "permdock/cli";

export default defineConfig({
  policy: "./src/policy.ts",
  gen: { kinds: ["bundle"], out: "src/permdock" },
});
