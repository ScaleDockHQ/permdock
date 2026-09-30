import { defineConfig } from 'oxlint';

import { core, example, react } from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react, example],
  overrides: [
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        // Nest guards and controllers are classes by framework contract (3 findings).
        'eslint/class-methods-use-this': 'off',
        // Nest modules are empty decorated classes (1 finding).
        'typescript/no-extraneous-class': 'off',
        // A Nest module sits next to its controller and guard (1 finding).
        'eslint/max-classes-per-file': 'off',
        // Nest needs the side-effect `reflect-metadata` import (2 findings).
        'import/no-unassigned-import': 'off',
        // Nest controllers follow the framework's own style (3 findings).
        'typescript/explicit-member-accessibility': 'off',
      },
    },
  ],
});
