import type { Metafile } from "esbuild";

import { build } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * What an app ships for a typical import: each fixture is bundled the way a
 * consumer's bundler would (tree-shaken, minified, framework and peer packages
 * external), then gzipped.
 */
const CONSUMERS = {
  "core definePolicy + getPermDockSync": `import { getPermDockSync, definePermissions, definePolicy } from 'permdock'; export { getPermDockSync, definePermissions, definePolicy };`,
  "react PermDockProvider + usePermission": `export { PermDockProvider, usePermission } from 'permdock/react';`,
  "react-native PermDockProvider + usePermission": `export { PermDockProvider, usePermission } from 'permdock/react-native';`,
  "react-native PermDockProvider + localSnapshot": `export { PermDockProvider, localSnapshot, usePermission } from 'permdock/react-native';`,
  "next createPermDock": `export { createPermDock } from 'permdock/next';`,
  "server createPermDock": `export { createPermDock } from 'permdock/server';`,
  "server createPermDock + webBotAuthVerifier": `export { createPermDock, webBotAuthVerifier } from 'permdock/server';`,
  "hono createPermDock": `export { createPermDock } from 'permdock/hono';`,
  "hono createPermDock + withOtel": `export { createPermDock } from 'permdock/hono'; export { withOtel } from 'permdock/otel';`,
  "express createPermDock": `export { createPermDock } from 'permdock/express';`,
  "fastify createPermDock": `export { createPermDock } from 'permdock/fastify';`,
  "jwt subjectFromJwt": `export { subjectFromJwt } from 'permdock/jwt';`,
  "mcp createPermDock": `export { createPermDock } from 'permdock/mcp';`,
  "ai-sdk createPermDock": `export { createPermDock } from 'permdock/ai-sdk';`,
  "supabase/middleware createPermDock": `export { createPermDock } from 'permdock/supabase/middleware';`,
  "saas client react": `export { PermDockProvider, Protected, usePermission } from 'permdock/react';`,
  "saas server better-supabase + next": `export { authorizer, blockMembershipSource, subjectFromBetterSupabase, subjectFromShareLink } from 'permdock/better-supabase'; export { authzVersion, exchangeCapability, junctionMembershipSource, supabaseClaims, supabasePostgresQuery } from 'permdock/supabase'; export { createPermDock, snapshotTag } from 'permdock/next'; export { actor, allow, claimsFirst, defineOperations, definePermissions, definePolicy, defineRoles, emptySnapshot, getPermDockSync, memoryVersionCache, resource, role } from 'permdock';`,
  "openapi securityFor + permissionsExtension + problemDetails": `export { permissionsExtension, problemDetails, securityFor } from 'permdock/openapi';`,
} as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The minified, tree-shaken output files a consumer's bundler emits for
 * `source`, with the esbuild metafile.
 */
export async function bundleWithMeta(
  source: string,
): Promise<{
  readonly files: readonly Uint8Array[];
  readonly metafile: Metafile;
}> {
  const result = await build({
    metafile: true,
    stdin: { contents: source, resolveDir: HERE, loader: "js" },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    logLevel: "silent",
    plugins: [
      {
        name: "externals",
        setup(pluginBuild): void {
          // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild runs the filter as a Go regexp, which has no u flag
          pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path === "permdock" || args.path.startsWith("permdock/")
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  return {
    files: result.outputFiles.map((file) => file.contents),
    metafile: result.metafile,
  };
}

export function consumerSource(name: string): string | undefined {
  return Object.entries(CONSUMERS).find(([key]) => key === name)?.[1];
}

async function bundledGzip(source: string): Promise<number> {
  const { files } = await bundleWithMeta(source);
  return files.reduce(
    (total, contents) => total + gzipSync(contents, { level: 9 }).length,
    0,
  );
}

export async function measureConsumers(): Promise<Record<string, number>> {
  const measured: Record<string, number> = {};
  for (const [name, source] of Object.entries(CONSUMERS)) {
    measured[name] = await bundledGzip(source);
  }
  return measured;
}
