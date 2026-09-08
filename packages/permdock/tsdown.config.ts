import { compile } from 'svelte/compiler';
import { defineConfig } from 'tsdown';

function sveltePlugin(): {
  readonly name: string;
  transform(
    code: string,
    id: string,
  ): { readonly code: string; readonly map: unknown } | undefined;
} {
  return {
    name: 'svelte',
    transform(code, id) {
      if (!id.endsWith('.svelte')) {
        return undefined;
      }
      const result = compile(code, {
        filename: id,
        css: 'injected',
      });
      return { code: result.js.code, map: result.js.map };
    },
  };
}

export default defineConfig({
  plugins: [sveltePlugin()],
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
    'src/elysia/index.ts',
    'src/nest/index.ts',
    'src/node/index.ts',
    'src/trpc/index.ts',
    'src/orpc/index.ts',
    'src/vue/index.ts',
    'src/svelte/index.ts',
    'src/solid/index.ts',
    'src/ai-sdk/index.ts',
    'src/claude-agent/index.ts',
    'src/eve/index.ts',
    'src/openai/index.ts',
    'src/mcp/index.ts',
    'src/authzen/index.ts',
    'src/openapi/index.ts',
    'src/terminal/index.ts',
    'src/webmcp/index.ts',
  ],
  platform: 'neutral',
  dts: true,
  clean: true,
  exports: false,
});
