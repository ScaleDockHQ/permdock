import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: { name: "integration", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "rls-bench", include: ["bench/**/*.test.ts"] },
      },
    ],
  },
});
