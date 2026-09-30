import { defineConfig } from 'oxlint';

import { core, ignorePatterns, react } from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react],
  // shadcn/ui and ReUI code is vendored as published and updated through the shadcn CLI.
  ignorePatterns: [...ignorePatterns, 'src/components/**', 'src/reui/**'],
});
