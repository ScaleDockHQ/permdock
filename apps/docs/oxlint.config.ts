import { defineConfig } from 'oxlint';

import {
  core,
  oneLibraryPerConcern,
  react,
  test,
} from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react, test],
  rules: {
    ...oneLibraryPerConcern,
    // Collection checks pass `undefined` data before the demo's pinned clock (2 findings).
    'eslint/no-undefined': 'off',
  },
});
