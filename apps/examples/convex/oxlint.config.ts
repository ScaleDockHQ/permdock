import { defineConfig } from 'oxlint';

import { core, example, react } from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react, example],
});
