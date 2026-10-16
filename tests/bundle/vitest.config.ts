import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Compiles the `.svelte` source `permdock/svelte` publishes under the
  // `svelte` export condition, the way an app's bundler does.
  plugins: [svelte()],
  test: {
    include: ["src/**/*.test.ts"],
    // Every test walks or spawns over the whole dist; in CI they share the runner with lint and typecheck.
    testTimeout: 30_000,
  },
});
