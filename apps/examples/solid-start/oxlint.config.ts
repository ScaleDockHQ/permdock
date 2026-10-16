import { defineConfig } from "oxlint";

import {
  core,
  example,
  ignorePatterns,
  react,
} from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, react, example],
  ignorePatterns: [...ignorePatterns, ".solid/**", ".vinxi/**"],
  rules: {
    // `src/entry-server.tsx` renders the document `<head>` (1 finding).
    "nextjs/no-head-element": "off",
  },
});
