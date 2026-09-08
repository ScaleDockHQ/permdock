import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/approvals/index.ts',
    'src/jwt/index.ts',
    'src/react/index.ts',
    'src/next/index.ts',
    'src/server/index.ts',
    'src/hono/index.ts',
    'src/ai-sdk/index.ts',
    'src/claude-agent/index.ts',
    'src/eve/index.ts',
  ],
  platform: 'neutral',
  dts: true,
  clean: true,
  exports: false,
});
