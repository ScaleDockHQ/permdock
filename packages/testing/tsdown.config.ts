import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    saas: 'src/saas/index.ts',
    'saas-permissions': 'src/saas/permissions.ts',
  },
  platform: 'neutral',
  dts: true,
  clean: true,
  deps: { neverBundle: ['permdock', 'vitest'] },
  exports: false,
});
