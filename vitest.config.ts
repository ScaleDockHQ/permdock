import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration and runtime suites need Docker, Bun and Deno, and the bundle
    // suite needs a build; they run through their own scripts.
    projects: [
      "apps/docs",
      "apps/marketing",
      "packages/ox-config",
      "packages/permdock",
    ],
  },
});
