import { defineConfig } from "oxlint";

// @boundaries-ignore the shared lint config lives at the repository root
import { core, ignorePatterns, node, test } from "../../oxlint.config.ts";

export default defineConfig({
  extends: [core, node, test],
  ignorePatterns: [...ignorePatterns, "ts-*/**"],
});
