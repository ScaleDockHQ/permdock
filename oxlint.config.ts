import { defineConfig } from 'oxlint';

import { core, ignorePatterns, node } from '@permdock/ox-config/oxlint';

// Root tooling only: every workspace lints itself through its own
// oxlint.config.ts and the `lint` turbo task.
export default defineConfig({
  options: { typeAware: true },
  extends: [core, node],
  ignorePatterns: [...ignorePatterns, '.agents/**', '.cursor/**', '.claude/**'],
});
