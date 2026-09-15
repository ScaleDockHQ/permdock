import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { latestReleases, parseChangelog } from './changelog';

const sample = `# permdock

## 0.1.0

### Minor Changes

- 258e0aa: Add permdock/a2a Agent Cards.
- Thread Policy generics through core.

### Patch Changes

- 8f79c80: Document the docs-site decide explorer.

## 0.0.1

### Patch Changes

- abcdef0: Initial placeholder.
`;

describe('parseChangelog', () => {
  test('groups versions, kinds and hashed bullets', () => {
    const releases = parseChangelog(sample, 'permdock');
    expect(releases).toHaveLength(3);
    expect(releases[0]).toMatchObject({
      packageName: 'permdock',
      version: '0.1.0',
      kind: 'Minor',
    });
    expect(releases[0]?.changes[0]).toEqual({
      hash: '258e0aa',
      text: 'Add permdock/a2a Agent Cards.',
    });
    expect(releases[0]?.changes[1]).toEqual({
      text: 'Thread Policy generics through core.',
    });
    expect(releases[1]?.kind).toBe('Patch');
    expect(releases[2]?.version).toBe('0.0.1');
  });

  test('parses the real permdock changelog', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const markdown = readFileSync(
      join(root, 'packages/permdock/CHANGELOG.md'),
      'utf8',
    );
    const releases = parseChangelog(markdown, 'permdock');
    expect(releases.length).toBeGreaterThan(0);
    expect(releases[0]?.version).toBe('0.1.0');
    expect(latestReleases(releases, 3).length).toBeGreaterThan(0);
  });
});
