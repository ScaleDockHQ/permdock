import { defineConfig } from "oxlint";

import { core, ignorePatterns, node, test } from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, node, test],
  ignorePatterns: [...ignorePatterns, "src/support/prisma/**"],
  overrides: [
    {
      files: ["src/http/nest.test.ts"],
      rules: {
        // Nest guards and controllers are classes by framework contract (9 findings).
        "eslint/class-methods-use-this": "off",
        // Nest modules are empty decorated classes (2 findings).
        "typescript/no-extraneous-class": "off",
        // A Nest module sits next to its controller and guard (1 finding).
        "eslint/max-classes-per-file": "off",
        // Nest needs the side-effect `reflect-metadata` import (1 finding).
        "import/no-unassigned-import": "off",
        // Nest controllers follow the framework's own style (9 findings).
        "typescript/explicit-member-accessibility": "off",
      },
    },
  ],
});
