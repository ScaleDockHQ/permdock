import { defineConfig } from "oxlint";

// @boundaries-ignore the shared lint config lives at the repository root
import { core, ignorePatterns, react } from "../../oxlint.config.ts";

export default defineConfig({
  extends: [core, react],
  // shadcn/ui and ReUI code is vendored as published and updated through the shadcn CLI.
  ignorePatterns: [...ignorePatterns, "src/components/**", "src/reui/**"],
});
