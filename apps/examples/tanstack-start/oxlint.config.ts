import { defineConfig } from "oxlint";

// @boundaries-ignore the shared lint config lives at the repository root
import {
  core,
  example,
  ignorePatterns,
  react,
} from "../../../oxlint.config.ts";

export default defineConfig({
  extends: [core, react, example],
  ignorePatterns: [...ignorePatterns, ".tanstack/**", "src/routeTree.gen.ts"],
  rules: {
    // The TanStack Start root route renders the document `<head>` (1 finding).
    "nextjs/no-head-element": "off",
  },
});
