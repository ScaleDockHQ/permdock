import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseSnapshot } from './snapshot.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/snapshot.json', import.meta.url),
    'utf8',
  ),
) as unknown;

describe('parseSnapshot', () => {
  it('freezes a copy and leaves the caller’s object untouched', () => {
    const input = JSON.parse(JSON.stringify(fixture)) as Record<
      string,
      unknown
    >;
    const parsed = parseSnapshot(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.grants)).toBe(false);
  });

  it('accepts the snapshot fixture and rejects unknown majors and unsafe keys', () => {
    expect(parseSnapshot(fixture).v).toBe(1);
    expect(parseSnapshot(JSON.stringify(fixture)).v).toBe(1);
    expect(() => parseSnapshot({ v: 9 })).toThrow(
      /unsupported snapshot version/,
    );
    expect(() => parseSnapshot({ v: 1, constructor: {} })).toThrow(
      /unsafe snapshot key/,
    );
  });
});
