import { defineConfig } from "oxlint";

import { core, library, node } from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, library, node],
});
