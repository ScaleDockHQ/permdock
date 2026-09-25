import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { measureExports } from './write-baseline.ts';

const exportsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'exports.json',
);

describe('public exports', () => {
  it('matches the recorded exports snapshot', () => {
    const recorded = JSON.parse(readFileSync(exportsPath, 'utf8')) as Record<
      string,
      readonly string[]
    >;
    expect(measureExports()).toEqual(recorded);
  });
});
