import {
  existsSync,
  globSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.git',
]);

const PACKAGE_SKIP_DIRS = new Set(['node_modules', '.git']);

export function listSourceFiles(
  cwd: string,
  srcPath: readonly string[],
): readonly string[] {
  const out = new Set<string>();
  for (const entry of srcPath) {
    if (/[*?[{]/u.test(entry)) {
      collectGlob(cwd, entry, out);
      continue;
    }
    collectRoot(resolve(cwd, entry), out, skipDirsFor(entry));
  }
  const byRealPath = new Map<string, string>();
  for (const file of [...out].toSorted()) {
    const real = realPath(file);
    if (!byRealPath.has(real)) {
      byRealPath.set(real, file);
    }
  }
  return [...byRealPath.values()].toSorted();
}

function segments(path: string): readonly string[] {
  return path.split(/[\\/]/u).filter((part) => part !== '' && part !== '.');
}

/** Installed packages often ship only `dist`; their own dependencies are never walked. */
function skipDirsFor(path: string): ReadonlySet<string> {
  return segments(path).includes('node_modules')
    ? PACKAGE_SKIP_DIRS
    : SKIP_DIRS;
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function collectGlob(cwd: string, pattern: string, out: Set<string>): void {
  const literal = segments(pattern);
  const matches = globSync(pattern, {
    cwd,
    exclude: (path: string) => {
      const parts = segments(path);
      const name = basename(path);
      return SKIP_DIRS.has(name) && literal[parts.length - 1] !== name;
    },
  });
  for (const match of matches) {
    collectRoot(resolve(cwd, match), out, skipDirsFor(match));
  }
}

function collectRoot(
  root: string,
  out: Set<string>,
  skip: ReadonlySet<string>,
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
  walkDir(root, out, skip);
}

function walkDir(
  dir: string,
  out: Set<string>,
  skip: ReadonlySet<string>,
): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.agents') {
      continue;
    }
    if (skip.has(name)) {
      continue;
    }
    const full = join(dir, name);
    const stats = statSync(full, { throwIfNoEntry: false });
    if (stats === undefined) {
      continue;
    }
    if (stats.isDirectory()) {
      walkDir(full, out, skip);
      continue;
    }
    if (SOURCE_EXT.has(extname(name)) && !name.endsWith('.generated.ts')) {
      out.add(full);
    }
  }
}

/**
 * The `.sql` files under each entry: a glob, a file, or a directory searched
 * recursively. `order: 'entry'` keeps each entry's matches together in entry
 * order (how `supabase db diff` reads `schema_paths`); the default sorts all paths.
 */
export function sqlFiles(
  cwd: string,
  entries: readonly string[],
  options: { readonly order?: 'path' | 'entry' } = {},
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of entries) {
    const abs = resolve(cwd, entry);
    const isGlob = /[*?[{]/u.test(entry);
    if (!isGlob && statSync(abs, { throwIfNoEntry: false })?.isFile()) {
      if (!seen.has(abs)) {
        seen.add(abs);
        ordered.push(abs);
      }
      continue;
    }
    const pattern = isGlob ? entry : `${entry}/**/*.sql`;
    for (const match of globSync(pattern, { cwd }).toSorted()) {
      const path = resolve(cwd, match);
      if (path.endsWith('.sql') && !seen.has(path)) {
        seen.add(path);
        ordered.push(path);
      }
    }
  }
  return options.order === 'entry' ? ordered : ordered.toSorted();
}

export function rel(cwd: string, abs: string): string {
  return relative(cwd, abs).split('\\').join('/');
}

export function defaultSrcPath(): readonly string[] {
  return ['./src'];
}
