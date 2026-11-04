import type { Metafile, Plugin } from "esbuild";

import { build } from "esbuild";
import { basename, dirname, join } from "node:path";
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
  "react/lazy PermDockProvider + usePermission": `export { PermDockProvider, usePermission } from 'permdock/react/lazy';`,
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
  "saas client react/lazy": `export { PermDockProvider, Protected, usePermission } from 'permdock/react/lazy';`,
  "saas server better-supabase + next": `export { authorizer, blockMembershipSource, subjectFromBetterSupabase, subjectFromShareLink } from 'permdock/better-supabase'; export { authzVersion, exchangeCapability, junctionMembershipSource, supabaseClaims, supabasePostgresQuery } from 'permdock/supabase'; export { createPermDock, snapshotTag } from 'permdock/next'; export { actor, allow, claimsFirst, defineOperations, definePermissions, definePolicy, defineRoles, emptySnapshot, getPermDockSync, memoryVersionCache, resource, role } from 'permdock';`,
  "openapi securityFor + permissionsExtension + problemDetails": `export { permissionsExtension, problemDetails, securityFor } from 'permdock/openapi';`,
} as const;

const HERE = dirname(fileURLToPath(import.meta.url));

function externalPermDock(): Plugin {
  return {
    name: "externals",
    setup(pluginBuild): void {
      // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild runs the filter as a Go regexp, which has no u flag
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
        args.path === "permdock" || args.path.startsWith("permdock/")
          ? undefined
          : { path: args.path, external: true },
      );
    },
  };
}

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
    plugins: [externalPermDock()],
  });
  return {
    files: result.outputFiles.map((file) => file.contents),
    metafile: result.metafile,
  };
}

/**
 * Fixtures whose bundle holds a lazily loaded chunk; their initial download is
 * measured too.
 */
const SPLIT = [
  "react/lazy PermDockProvider + usePermission",
  "saas client react/lazy",
] as const;

/**
 * The gzip bytes a page downloads before it runs: the entry chunk and every
 * chunk it imports statically. A chunk behind `import()` loads on demand.
 */
async function initialGzip(source: string): Promise<number> {
  const result = await build({
    metafile: true,
    stdin: { contents: source, resolveDir: HERE, loader: "js" },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    splitting: true,
    outdir: join(HERE, "split-out"),
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    logLevel: "silent",
    plugins: [externalPermDock()],
  });
  const byName = new Map(
    result.outputFiles.map((file) => [basename(file.path), file.contents]),
  );
  const outputs = Object.entries(result.metafile.outputs);
  const entry = outputs.find(([, output]) => output.entryPoint !== undefined);
  if (entry === undefined) {
    throw new Error("PermDock bundle: the fixture produced no entry chunk");
  }
  const seen = new Set<string>();
  const pending = [entry[0]];
  let total = 0;
  while (pending.length > 0) {
    const key = pending.pop();
    const output = key === undefined ? undefined : result.metafile.outputs[key];
    if (key === undefined || output === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const contents = byName.get(basename(key));
    total +=
      contents === undefined ? 0 : gzipSync(contents, { level: 9 }).length;
    for (const item of output.imports) {
      if (item.kind === "import-statement" && item.external !== true) {
        pending.push(item.path);
      }
    }
  }
  return total;
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
    // SAFETY: widening the literal tuple to string for a membership test.
    if ((SPLIT as readonly string[]).includes(name)) {
      measured[`${name} (initial)`] = await initialGzip(source);
    }
  }
  return measured;
}
