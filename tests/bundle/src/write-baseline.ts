import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRIES, exportNames, gzipGraph, walk } from './graph.ts';

export function measureSizes(): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const [entry, file] of Object.entries(ENTRIES)) {
    measured[entry] = gzipGraph(walk(file));
  }
  return measured;
}

export function measureExports(): Record<string, readonly string[]> {
  const measured: Record<string, readonly string[]> = {};
  for (const [entry, file] of Object.entries(ENTRIES)) {
    measured[entry] = exportNames(file);
  }
  return measured;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    join(dir, 'baseline.json'),
    `${JSON.stringify(measureSizes(), null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'exports.json'),
    `${JSON.stringify(measureExports(), null, 2)}\n`,
  );
}
