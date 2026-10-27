import { defineConfig } from "oxlint";

// @boundaries-ignore the shared lint config lives at the repository root
import {
  core,
  oneLibraryPerConcern,
  react,
  test,
} from "../../oxlint.config.ts";

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
