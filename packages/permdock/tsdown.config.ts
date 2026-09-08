import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/approvals/index.ts', 'src/jwt/index.ts'],
  platform: 'neutral',
  dts: true,
  clean: true,
  exports: false,
});
