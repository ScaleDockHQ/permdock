import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'neutral',
  dts: true,
  clean: true,
  deps: { neverBundle: ['permdock', 'vitest'] },
  exports: false,
});
