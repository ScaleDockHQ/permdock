import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DIST,
  ENTRIES,
  RUNTIME_ENTRIES,
  TOOLING_PACKAGES,
  packageImports,
  walk,
} from './graph.ts';

describe('invariant 12: runtime entries depend on @standard-schema/spec only', () => {
  it('never loads a CLI or test-runner package from a runtime entry', () => {
    const leaked: string[] = [];
    for (const entry of RUNTIME_ENTRIES) {
      for (const name of packageImports(walk(ENTRIES[entry]))) {
        // SAFETY: widens the literal tuple so includes() accepts any package name
        if ((TOOLING_PACKAGES as readonly string[]).includes(name)) {
          leaked.push(`${entry}: ${name}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('keeps the core entry free of every package but optional peers', () => {
    expect(packageImports(walk(ENTRIES['.']))).toEqual([]);
  });

  it('declares only @standard-schema/spec and the CLI parser as dependencies', () => {
    // SAFETY: dist/../package.json is the built package's own manifest
    const manifest = JSON.parse(
      readFileSync(join(DIST, '..', 'package.json'), 'utf8'),
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(Object.keys(manifest.dependencies).toSorted()).toEqual([
      '@standard-schema/spec',
      'oxc-parser',
    ]);
  });
});
