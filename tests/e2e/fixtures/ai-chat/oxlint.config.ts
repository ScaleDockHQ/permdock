import { defineConfig } from 'oxlint';

import {
  core,
  fixture,
  ignorePatterns,
  node,
  test,
} from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, node, test, fixture],
  ignorePatterns: [...ignorePatterns, 'build/**', '**/routeTree.gen.ts'],
});
