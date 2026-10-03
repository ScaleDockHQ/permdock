import { defineConfig } from "oxlint";

import {
  core,
  ignorePatterns,
  library,
  test,
} from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, library],
  ignorePatterns: [...ignorePatterns, "src/anti-slop/**"],
  overrides: [
    {
      files: [
        "tests/**/*.{ts,tsx}",
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.test-d.ts",
        "**/fixtures/**/*.ts",
      ],
      plugins: test.plugins ?? [],
      rules: test.rules ?? {},
    },
  ],
});
