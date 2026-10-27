import { defineConfig } from "oxlint";

// @boundaries-ignore the shared lint config lives at the repository root
import { core, library, node } from "../../oxlint.config.ts";

export default defineConfig({ extends: [core, library, node] });
