import { defineConfig } from "oxlint";

import {
  core,
  oneLibraryPerConcern,
  react,
  test,
} from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, react, test],
  rules: {
    ...oneLibraryPerConcern,
    // Collection checks pass `undefined` data before the demo's pinned clock (2 findings).
    "eslint/no-undefined": "off",
  },
  overrides: [
    {
      files: ["env.ts"],
      rules: {
        // The one module that reads `process.env`; everything else imports `env` (4 findings).
        "node/no-process-env": "off",
      },
    },
    {
      files: ["markdown.d.ts"],
      rules: {
        // A wildcard ambient module declaration only works in a script file (1 finding).
        "import/unambiguous": "off",
      },
    },
  ],
});
