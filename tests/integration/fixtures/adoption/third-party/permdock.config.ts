import { defineConfig } from "permdock/cli";

import { fixturePlugin } from "./plugin.ts";

export default defineConfig({
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  plugins: [fixturePlugin],
});
