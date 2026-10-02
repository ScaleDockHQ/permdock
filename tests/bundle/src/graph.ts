import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const DIST = join(
  fileURLToPath(new URL('../../../packages/permdock/dist/', import.meta.url)),
);

export const ENTRIES = {
  '.': 'index.js',
  './approvals': 'approvals/index.js',
  './jwt': 'jwt/index.js',
  './react': 'react/index.js',
  './react-native': 'react-native/index.js',
  './next': 'next/index.js',
  './server': 'server/index.js',
  './hono': 'hono/index.js',
  './express': 'express/index.js',
  './fastify': 'fastify/index.js',
  './elysia': 'elysia/index.js',
  './nest': 'nest/index.js',
  './node': 'node/index.js',
  './trpc': 'trpc/index.js',
  './orpc': 'orpc/index.js',
  './vue': 'vue/index.js',
  './svelte': 'svelte/index.js',
  './solid': 'solid/index.js',
  './ai-sdk': 'ai-sdk/index.js',
  './claude-agent': 'claude-agent/index.js',
  './eve': 'eve/index.js',
  './openai': 'openai/index.js',
  './mcp': 'mcp/index.js',
  './authzen': 'authzen/index.js',
  './openapi': 'openapi/index.js',
  './terminal': 'terminal/index.js',
  './webmcp': 'webmcp/index.js',
  './a2a': 'a2a/index.js',
  './otel': 'otel/index.js',
  './scim': 'scim/index.js',
  './cloud': 'cloud/index.js',
  './drizzle': 'drizzle/index.js',
  './prisma': 'prisma/index.js',
  './kysely': 'kysely/index.js',
  './supabase': 'supabase/index.js',
  './supabase/middleware': 'supabase/middleware.js',
  './ssf': 'ssf/index.js',
  './better-auth': 'better-auth/index.js',
  './clerk': 'clerk/index.js',
  './convex': 'convex/index.js',
  './pdp': 'pdp/index.js',
  './catalog': 'catalog/index.js',
  './testing': 'testing/index.js',
  './testing/saas': 'testing/saas/index.js',
  './testing/saas/permissions': 'testing/saas/permissions.js',
  './cli': 'cli/index.js',
  './unplugin': 'unplugin/index.js',
  './next/plugin': 'next/plugin.js',
  './next/client': 'next/client.js',
} as const;

export type Entry = keyof typeof ENTRIES;

/** Entries that are Node-only by design: a terminal CLI helper and the build tooling. */
const NODE_ONLY_ENTRIES = [
  './terminal',
  './cli',
  './unplugin',
  './next/plugin',
] as const;

/** Build- and test-time entries; every other entry is a runtime entry. */
const TOOLING_ENTRIES = [
  './cli',
  './unplugin',
  './next/plugin',
  './testing',
  './testing/saas',
  './testing/saas/permissions',
] as const;

export const RUNTIME_ENTRIES =
  // SAFETY: Object.keys(ENTRIES) lists exactly the Entry keys; the tuple is widened for includes()
  (Object.keys(ENTRIES) as Entry[]).filter(
    (entry) => !(TOOLING_ENTRIES as readonly string[]).includes(entry),
  );

/** Packages only the CLI and the test runners may load. */
export const TOOLING_PACKAGES = [
  '@clack/prompts',
  'citty',
  'diff',
  'jiti',
  'oxc-parser',
  'package-manager-detector',
  'smol-toml',
  'pgsql-parser',
  'pg',
  'unplugin',
  'ajv',
  'yaml',
  'vitest',
] as const;

const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/u;

/** A chunk's source without comment lines: bundled JSDoc names `import('./types')`. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

const BARE_IMPORT =
  /(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*['"]([^./'"][^'"]*)['"]|import\s*\(\s*['"]([^./'"][^'"]*)['"]\s*\)/gmu;

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : (parts[0] ?? specifier);
}

/** Packages a graph imports, by name; `node:` built-ins excluded. */
export function packageImports(files: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of codeOf(file).matchAll(BARE_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined && !specifier.startsWith('node:')) {
        found.add(packageName(specifier));
      }
    }
  }
  return [...found].toSorted();
}

export const WINTERTC_ENTRIES =
  // SAFETY: Object.keys(ENTRIES) lists exactly the Entry keys; the tuple is widened for includes()
  (Object.keys(ENTRIES) as Entry[]).filter(
    (entry) => !(NODE_ONLY_ENTRIES as readonly string[]).includes(entry),
  );
export const CLIENT_ENTRIES = [
  './react',
  './react-native',
  './vue',
  './svelte',
  './solid',
  './webmcp',
  './next/client',
] as const;

const RELATIVE_IMPORT =
  /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]|import\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/gu;

const NODE_SPECIFIER =
  /(?:from|import)\s*['"](node:[^'"]+|fs|path|crypto|buffer|child_process|worker_threads|async_hooks|os|net|tls|http|https|module|vm|inspector|v8|perf_hooks|querystring|assert|constants|domain|repl|readline|tty|dgram|dns|cluster|string_decoder|diagnostics_channel)['"]/u;

// Bare globals only: `loader.createRequire` on a feature-detected
// `process?.getBuiltinModule?.()` result is optional, not a hard dependency.
const NODE_GLOBAL =
  /(?<![.\w])(?:process\.|AsyncLocalStorage|createRequire|__dirname|__filename)\b/u;

export function walk(entryFile: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [join(DIST, entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = codeOf(file);
    const dir = dirname(file);
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const spec = match[1] ?? match[2];
      if (spec === undefined) {
        continue;
      }
      queue.push(join(dir, spec));
    }
  }
  return [...seen];
}

export function gzipGraph(files: readonly string[]): number {
  let total = 0;
  for (const file of files) {
    total += gzipSync(readFileSync(file)).length;
  }
  return total;
}

export function wintertcViolations(
  files: readonly string[],
): readonly string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (NODE_SPECIFIER.test(source)) {
      found.push(`${file}: node specifier`);
    }
    if (NODE_GLOBAL.test(source)) {
      found.push(`${file}: node global`);
    }
  }
  return found;
}

const USE_CLIENT = /^\s*['"]use client['"]/u;
const REACT_NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]react['"]/gu;
const CLIENT_ONLY_REACT = new Set([
  'createContext',
  'use',
  'useCallback',
  'useContext',
  'useEffect',
  'useLayoutEffect',
  'useMemo',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
]);

export function isClientBoundary(file: string): boolean {
  return USE_CLIENT.test(readFileSync(file, 'utf8'));
}

/**
 * Files reachable from a server entry, without crossing a "use client" module,
 * that import a client-only React API. Under the `react-server` condition those
 * exports do not exist, so the entry crashes when a Server Component imports it.
 */
export function clientApiLeaks(entryFile: string): readonly string[] {
  const leaks: string[] = [];
  const seen = new Set<string>();
  const queue = [join(DIST, entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = codeOf(file);
    if (USE_CLIENT.test(source)) {
      continue;
    }
    for (const match of source.matchAll(REACT_NAMED_IMPORT)) {
      const names = (match[1] ?? '')
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/u)[0] ?? '')
        .filter((name) => CLIENT_ONLY_REACT.has(name));
      if (names.length > 0) {
        leaks.push(`${file}: ${names.join(', ')}`);
      }
    }
    const dir = dirname(file);
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const spec = match[1] ?? match[2];
      if (spec !== undefined) {
        queue.push(join(dir, spec));
      }
    }
  }
  return leaks;
}

const EXPORT_LIST = /export\s*\{([^}]*)\}/gu;

/** Runtime export names of a built entry, from its `export { … }` statements. */
export function exportNames(entryFile: string): readonly string[] {
  const source = readFileSync(join(DIST, entryFile), 'utf8');
  const names: string[] = [];
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);
      if (name !== undefined && name !== '') {
        names.push(name);
      }
    }
  }
  return names.toSorted();
}

/** Chunks that carry policy definition or server evaluation code. */
export function policyChunks(files: readonly string[]): readonly string[] {
  return files.filter((file) =>
    /[/\\](?:policy|evaluate|instance)-[^/\\]+\.js$/u.test(file),
  );
}

export function serverOnlyFiles(files: readonly string[]): readonly string[] {
  // The client half of a server adapter lives in the adapter's folder.
  const clientHalves = new Set(
    [ENTRIES['./next/client']].map((file) => join(DIST, file)),
  );
  return files.filter(
    (file) =>
      !clientHalves.has(file) &&
      /[/\\](?:jwt|next|hono|express|fastify|elysia|nest|node|trpc|orpc|server|approvals|mcp|authzen|openapi|a2a|terminal|otel|scim|cloud|drizzle|prisma|kysely|supabase|ssf|better-auth|clerk|convex|pdp)[/\\]/u.test(
        file,
      ),
  );
}
