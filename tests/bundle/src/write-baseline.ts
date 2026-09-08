import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRIES, gzipGraph, walk } from './graph.ts';

const measured: Record<string, number> = {};
for (const [entry, file] of Object.entries(ENTRIES)) {
  measured[entry] = gzipGraph(walk(file));
}

writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'baseline.json'),
  `${JSON.stringify(measured, null, 2)}\n`,
);
