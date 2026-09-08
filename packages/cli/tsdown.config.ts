import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/plugin.ts', 'src/unplugin.ts'],
  platform: 'neutral',
  dts: true,
  clean: true,
  deps: { neverBundle: ['permdock', 'oxc-parser', 'unplugin'] },
  exports: false,
});
