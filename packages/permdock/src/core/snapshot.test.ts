import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseSnapshot } from './snapshot.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/snapshot-v2.json', import.meta.url),
    'utf8',
  ),
) as unknown;

describe('parseSnapshot', () => {
  it('accepts snapshot v2 fixtures and rejects unknown majors and unsafe keys', () => {
    expect(parseSnapshot(fixture).v).toBe(2);
    expect(parseSnapshot(JSON.stringify(fixture)).v).toBe(2);
    expect(() => parseSnapshot({ v: 9 })).toThrow(
      /unsupported snapshot version/,
    );
    expect(() => parseSnapshot({ v: 2, constructor: {} })).toThrow(
      /unsafe snapshot key/,
    );
  });
});
