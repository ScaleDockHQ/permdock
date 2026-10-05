import { build } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * What an app ships for a typical import: each fixture is bundled the way a
 * consumer's bundler would (tree-shaken, minified, framework and peer
 * packages external), then gzipped.
 */
export const OPENAPI_CONTRACT = `export { permissionsExtension, securityFor } from 'permdock/openapi';`;

const CONSUMERS = {
  "core definePolicy + createPermDock": `import { createPermDock, definePermissions, definePolicy } from 'permdock'; export { createPermDock, definePermissions, definePolicy };`,
  "react PermDockProvider + usePermission": `export { PermDockProvider, usePermission } from 'permdock/react';`,
  "react-native PermDockProvider + usePermission": `export { PermDockProvider, usePermission } from 'permdock/react-native';`,
  "react-native PermDockProvider + localSnapshot": `export { PermDockProvider, localSnapshot, usePermission } from 'permdock/react-native';`,
  "next createPermDock": `export { createPermDock } from 'permdock/next';`,
  "server createPermDock": `export { createPermDock } from 'permdock/server';`,
  "server createPermDock + verifyWebBotAuth": `export { createPermDock, verifyWebBotAuth } from 'permdock/server';`,
  "hono createPermDock": `export { createPermDock } from 'permdock/hono';`,
  "hono createPermDock + withOtel": `export { createPermDock } from 'permdock/hono'; export { withOtel } from 'permdock/otel';`,
  "express createPermDock": `export { createPermDock } from 'permdock/express';`,
  "fastify createPermDock": `export { createPermDock } from 'permdock/fastify';`,
  "jwt subjectFromJwt": `export { subjectFromJwt } from 'permdock/jwt';`,
  "mcp createPermDock": `export { createPermDock } from 'permdock/mcp';`,
  "ai-sdk createPermDock": `export { createPermDock } from 'permdock/ai-sdk';`,
  "supabase/middleware createPermDock": `export { createPermDock } from 'permdock/supabase/middleware';`,
  "openapi securityFor + permissionsExtension": OPENAPI_CONTRACT,
} as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The minified, tree-shaken output files a consumer's bundler emits for `source`. */
export async function bundled(source: string): Promise<readonly Uint8Array[]> {
  const result = await build({
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
          pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path === "permdock" || args.path.startsWith("permdock/")
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  return result.outputFiles.map((file) => file.contents);
}

async function bundledGzip(source: string): Promise<number> {
  const files = await bundled(source);
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
