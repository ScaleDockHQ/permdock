import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { findPackageRoot, packageRoot } from '../../src/cli/package-root.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

const PACKAGE = path.join(import.meta.dirname, '../..');

describe('packageRoot', () => {
  it('is the permdock package directory, and stays cached', () => {
    expect(packageRoot()).toBe(PACKAGE);
    expect(packageRoot()).toBe(PACKAGE);
  });

  it('walks past other manifests to the permdock one', () => {
    const cwd = project({
      'package.json': '{"name":"app"}',
      'nested/package.json': '{}',
      'nested/deep/file.ts': '',
    });
    expect(findPackageRoot(path.join(cwd, 'nested/deep'))).toBe(PACKAGE);
  });

  it('throws at the filesystem root', () => {
    expect(() => findPackageRoot(path.parse(PACKAGE).root)).toThrow(
      'PermDock CLI: cannot find the permdock package root',
    );
  });
});
