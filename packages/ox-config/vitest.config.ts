import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Oxlint's RuleTester reads `describe` / `it` from globals at import time.
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
