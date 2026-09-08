import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/approvals/index.ts',
    'src/jwt/index.ts',
    'src/react/index.ts',
    'src/react-native/index.ts',
    'src/next/index.ts',
    'src/next/plugin.ts',
    'src/server/index.ts',
    'src/hono/index.ts',
    'src/express/index.ts',
    'src/fastify/index.ts',
    'src/ai-sdk/index.ts',
    'src/claude-agent/index.ts',
    'src/eve/index.ts',
    'src/openai/index.ts',
    'src/mcp/index.ts',
    'src/authzen/index.ts',
    'src/openapi/index.ts',
  ],
  platform: 'neutral',
  dts: true,
  clean: true,
  exports: false,
});
