import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.git',
]);

export function listSourceFiles(
  cwd: string,
  srcPath: readonly string[],
): readonly string[] {
  const out = new Set<string>();
  for (const entry of srcPath) {
    if (entry.includes('*') || entry.includes('?')) {
      collectGlob(cwd, entry, out);
      continue;
    }
    collectRoot(resolve(cwd, entry), out, !entry.includes('node_modules'));
  }
  return [...out].toSorted();
}

function collectGlob(cwd: string, pattern: string, out: Set<string>): void {
  const prefix = pattern.split('*')[0] ?? '';
  const root = resolve(cwd, prefix);
  if (!existsSync(root)) {
    return;
  }
  collectRoot(root, out, false);
}

function collectRoot(
  root: string,
  out: Set<string>,
  skipNestedNodeModules: boolean,
): void {
  if (!existsSync(root)) {
    return;
  }
  const stats = statSync(root);
  if (stats.isFile()) {
    if (SOURCE_EXT.has(extname(root))) {
      out.add(root);
    }
    return;
  }
  walkDir(root, out, skipNestedNodeModules);
}

function walkDir(
  dir: string,
  out: Set<string>,
  skipNestedNodeModules: boolean,
): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.agents') {
      continue;
    }
    if (SKIP_DIRS.has(name) && skipNestedNodeModules) {
      continue;
    }
    if (name === 'node_modules' && skipNestedNodeModules) {
      continue;
    }
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walkDir(full, out, skipNestedNodeModules);
      continue;
    }
    if (SOURCE_EXT.has(extname(name)) && !name.endsWith('.generated.ts')) {
      out.add(full);
    }
  }
}

export function rel(cwd: string, abs: string): string {
  return relative(cwd, abs).split('\\').join('/');
}

export function defaultSrcPath(): readonly string[] {
  return ['./src'];
}
