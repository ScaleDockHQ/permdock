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
} as const;

export type Entry = keyof typeof ENTRIES;

export const WINTERTC_ENTRIES = ['.', './server', './react'] as const;
export const CLIENT_ENTRIES = [
  './react',
  './react-native',
  './vue',
  './svelte',
  './solid',
  './webmcp',
] as const;

const RELATIVE_IMPORT =
  /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]|import\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/gu;

const NODE_SPECIFIER =
  /(?:from|import)\s*['"](node:[^'"]+|fs|path|crypto|buffer|child_process|worker_threads|async_hooks|os|net|tls|http|https|module|vm|inspector|v8|perf_hooks|querystring|assert|constants|domain|repl|readline|tty|dgram|dns|cluster|string_decoder|diagnostics_channel)['"]/u;

const NODE_GLOBAL =
  /\b(?:process\.|AsyncLocalStorage|createRequire|__dirname|__filename)\b/u;

export function walk(entryFile: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [join(DIST, entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, 'utf8');
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

export function serverOnlyFiles(files: readonly string[]): readonly string[] {
  return files.filter((file) =>
    /[/\\](?:jwt|next|hono|express|fastify|elysia|nest|node|trpc|orpc|server|approvals|mcp|authzen|openapi|a2a|terminal|otel|scim)[/\\]/u.test(
      file,
    ),
  );
}
