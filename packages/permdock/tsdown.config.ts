import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { defineConfig } from 'tsdown';

const SVELTE_SOURCE = 'src/svelte/Protected.svelte';

function sveltePlugin(): {
  readonly name: string;
  resolveId(
    source: string,
    importer: string | undefined,
  ): { readonly id: string; readonly external: true } | null;
  transform(
    code: string,
    id: string,
  ): { readonly code: string; readonly map: unknown } | undefined;
  generateBundle(this: {
    emitFile(file: {
      readonly type: 'asset';
      readonly fileName: string;
      readonly source: string;
    }): string;
  }): void;
} {
  return {
    name: 'svelte',
    // The `svelte` export condition ships the component as source, so the
    // app's compiler builds it for SSR or the client.
    resolveId(source, importer) {
      if (
        source === './Protected.svelte' &&
        importer?.endsWith('src/svelte/source.ts') === true
      ) {
        return { id: './Protected.svelte', external: true };
      }
      return null;
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'svelte/Protected.svelte',
        source: readFileSync(SVELTE_SOURCE, 'utf8').replace(
          "from './runtime.ts'",
          "from './runtime.js'",
        ),
      });
    },
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

function clientReferencePlugin(): {
  readonly name: string;
  resolveId(
    source: string,
    importer: string | undefined,
  ): { readonly id: string; readonly external: true } | null;
} {
  return {
    // The server entry imports the provider from the built
    // `react/provider-client.js` entry, so it stays a "use client" reference.
    name: 'react-provider-reference',
    resolveId(source, importer) {
      if (
        source === '../react/provider-client.js' &&
        importer?.endsWith('src/next/provider.tsx') === true
      ) {
        return { id: '../react/provider-client.js', external: true };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [sveltePlugin(), clientReferencePlugin()],
  entry: [
    'src/index.ts',
    'src/approvals/index.ts',
    'src/jwt/index.ts',
    'src/react/index.ts',
    'src/react/provider-client.ts',
    'src/react-native/index.ts',
    'src/next/index.ts',
    'src/next/plugin.ts',
    'src/next/client.tsx',
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
    'src/svelte/source.ts',
    'src/svelte/runtime.ts',
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
    'src/a2a/index.ts',
    'src/otel/index.ts',
    'src/scim/index.ts',
    'src/cloud/index.ts',
    'src/drizzle/index.ts',
    'src/prisma/index.ts',
    'src/kysely/index.ts',
    'src/supabase/index.ts',
    'src/supabase/middleware.ts',
    'src/ssf/index.ts',
    'src/better-auth/index.ts',
    'src/clerk/index.ts',
    'src/convex/index.ts',
    'src/pdp/index.ts',
    'src/cli/index.ts',
    'src/cli/bin.ts',
    'src/unplugin/index.ts',
    'src/testing/index.ts',
    'src/testing/saas/index.ts',
    'src/testing/saas/permissions.ts',
  ],
  platform: 'neutral',
  dts: true,
  clean: true,
  // Only the pure-JS CLI helpers may be inlined, into the lazily loaded
  // command chunks; `oxc-parser` is a dependency and the other CLI packages
  // are optional peers, so they stay external.
  deps: {
    onlyBundle: [
      'ajv',
      'fast-deep-equal',
      'fast-uri',
      'json-schema-traverse',
      'require-from-string',
      'yaml',
    ],
  },
  exports: false,
});
