import { defineConfig } from "oxlint";

import {
  core,
  example,
  ignorePatterns,
  react,
} from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, react, example],
  ignorePatterns: [...ignorePatterns, ".tanstack/**", "src/routeTree.gen.ts"],
  rules: {
    // The TanStack Start root route renders the document `<head>` (1 finding).
    "nextjs/no-head-element": "off",
  },
});
