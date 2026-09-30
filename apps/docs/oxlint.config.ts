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
  },
});
