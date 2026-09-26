import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { listSourceFiles, rel } from './files.ts';

const TMP = join(dirname(fileURLToPath(import.meta.url)), '../tmp');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: readonly string[]): string {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, 'files-'));
  temps.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'export {};\n');
  }
  return root;
}

function listed(root: string, srcPath: readonly string[]): readonly string[] {
  return listSourceFiles(root, srcPath).map((file) => rel(root, file));
}

describe('listSourceFiles', () => {
  it('matches a glob segment instead of walking everything under its prefix', () => {
    const root = tree([
      'packages/a/src/a.ts',
      'packages/a/test/a.test.ts',
      'packages/b/src/b.ts',
      'packages/b/README.ts',
    ]);
    expect(listed(root, ['packages/*/src'])).toEqual([
      'packages/a/src/a.ts',
      'packages/b/src/b.ts',
    ]);
  });

  it('skips node_modules and dist under a glob', () => {
    const root = tree([
      'apps/web/src/page.ts',
      'apps/web/node_modules/dep/src/index.ts',
      'apps/web/dist/page.js',
    ]);
    expect(listed(root, ['apps/**/*.ts', 'apps/**/*.js'])).toEqual([
      'apps/web/src/page.ts',
    ]);
  });

  it('follows a pattern that names node_modules, without nested dependencies', () => {
    const root = tree([
      'node_modules/@acme/ui/src/permissions.ts',
      'node_modules/@acme/ui/dist/index.js',
      'node_modules/@acme/ui/node_modules/dep/index.ts',
      'node_modules/other/index.ts',
    ]);
    expect(listed(root, ['./node_modules/@acme/*'])).toEqual([
      'node_modules/@acme/ui/dist/index.js',
      'node_modules/@acme/ui/src/permissions.ts',
    ]);
  });

  it('dedupes a file reached through a workspace symlink', () => {
    const root = tree(['packages/permissions/src/index.ts']);
    mkdirSync(join(root, 'linked'), { recursive: true });
    symlinkSync(
      join(root, 'packages/permissions'),
      join(root, 'linked/permissions'),
      'dir',
    );
    expect(listed(root, ['packages/*/src', 'linked/*/src'])).toEqual([
      'packages/permissions/src/index.ts',
    ]);
  });
});
