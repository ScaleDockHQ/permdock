import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * The `permdock` package directory. The bundler may place this module in
 * `dist/cli/` or in a shared chunk at `dist/`, so walk up instead of
 * assuming a depth.
 */
export function packageRoot(): string {
  if (cached !== undefined) {
    return cached;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      // SAFETY: name is typed unknown and compared with a string literal before use.
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        readonly name?: unknown;
      };
      if (name === 'permdock') {
        cached = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('PermDock CLI: cannot find the permdock package root');
    }
    dir = parent;
  }
}
