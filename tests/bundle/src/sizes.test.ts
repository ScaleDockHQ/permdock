import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { measureSizes } from './write-baseline.ts';

const baselinePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'baseline.json',
);

describe('per-entry gzip', () => {
  it('matches the recorded baseline', () => {
    // SAFETY: the size baseline is written by this suite in this shape
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<
      string,
      number
    >;
    expect(measureSizes()).toEqual(baseline);
  });
});
