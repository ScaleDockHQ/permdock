import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { measureConsumers } from './consumers.ts';

const baselinePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'consumers.json',
);

describe('consumer bundles', () => {
  it('match the recorded min+gzip baseline', async () => {
    // SAFETY: the consumer baseline is written by write-baseline.ts in this shape
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<
      string,
      number
    >;
    expect(await measureConsumers()).toEqual(baseline);
  });

  it('keep opt-in executors out of apps that do not use them', async () => {
    const sizes = await measureConsumers();
    expect(sizes['hono createPermDock + withOtel']).toBeGreaterThan(
      (sizes['hono createPermDock'] ?? 0) + 1000,
    );
    expect(sizes['server createPermDock + verifyWebBotAuth']).toBeGreaterThan(
      (sizes['server createPermDock'] ?? 0) + 1000,
    );
  });
});
