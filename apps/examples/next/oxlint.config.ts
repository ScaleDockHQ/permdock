import { defineConfig } from "oxlint";

import {
  core,
  example,
  ignorePatterns,
  react,
} from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, react, example],
  // shadcn/ui code is vendored as published and updated through the shadcn CLI.
  ignorePatterns: [...ignorePatterns, "src/components/ui/**"],
});
