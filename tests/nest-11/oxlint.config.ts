import { defineConfig } from "oxlint";

import { core, node, test } from "@permdock/ox-config/oxlint";

export default defineConfig({
  extends: [core, node, test],
});
