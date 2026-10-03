import { defineConfig } from "oxlint";

import { core, ignorePatterns, node, test } from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, node, test],
  ignorePatterns: [...ignorePatterns, "ts-*/**"],
});
