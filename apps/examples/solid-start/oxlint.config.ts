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
  ignorePatterns: [...ignorePatterns, ".solid/**", ".vinxi/**"],
  rules: {
    // `src/entry-server.tsx` renders the document `<head>` (1 finding).
    "nextjs/no-head-element": "off",
  },
});
