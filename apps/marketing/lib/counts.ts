import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapterTiles } from './adapters';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function countTestFiles(directory: string): number {
  let count = 0;
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next') {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      count += countTestFiles(path);
      continue;
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      count += 1;
    }
  }
  return count;
}

function standardCount(): number {
  const meta = JSON.parse(
    readFileSync(
      join(root, 'apps/docs/content/docs/standards/meta.json'),
      'utf8',
    ),
  ) as { pages?: unknown };
  if (!Array.isArray(meta.pages)) {
    return 0;
  }
  return meta.pages.filter(
    (page): page is string =>
      typeof page === 'string' && !page.startsWith('---') && page !== 'index',
  ).length;
}

export function siteCounts(): {
  readonly adapters: number;
  readonly standards: number;
  readonly tests: number;
} {
  return {
    adapters: adapterTiles.length,
    standards: standardCount(),
    tests: countTestFiles(join(root, 'packages')),
  };
}
