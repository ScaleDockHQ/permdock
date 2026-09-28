import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseChangelog, type ChangelogRelease } from './changelog';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const files: readonly { readonly file: string; readonly name: string }[] = [
  { file: 'packages/permdock/CHANGELOG.md', name: 'permdock' },
  { file: 'packages/cli/CHANGELOG.md', name: '@permdock/cli' },
  { file: 'packages/testing/CHANGELOG.md', name: '@permdock/testing' },
];

export function loadChangelogs(): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  for (const entry of files) {
    const path = join(root, entry.file);
    if (!existsSync(path)) {
      continue;
    }
    const markdown = readFileSync(path, 'utf8');
    releases.push(...parseChangelog(markdown, entry.name));
  }
  return releases;
}

export function loadRecentShips(count: number): ChangelogRelease[] {
  const permdock = loadChangelogs().filter(
    (release) => release.packageName === 'permdock',
  );
  return permdock.slice(0, count);
}
