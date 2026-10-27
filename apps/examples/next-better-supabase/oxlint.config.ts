import { defineConfig } from "oxlint";
import playwright from "ultracite/oxlint/playwright";

// @boundaries-ignore the shared lint config lives at the repository root
import {
  core,
  example,
  ignorePatterns,
  react,
} from "../../../oxlint.config.ts";

export default defineConfig({
  extends: [core, react, playwright, example],
  ignorePatterns: [
    ...ignorePatterns,
    "src/lib/supabase/{generated.*,blocks.generated.ts,database.types.ts}",
  ],
});
