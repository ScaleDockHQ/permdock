import { describe, expectTypeOf, it } from 'vitest';

import type {
  SupabaseGrantsMarker,
  SupabaseHookMarker,
} from '../../src/cli/index.ts';

import { parseGrantsMarker, parseHookMarker } from '../../src/cli/index.ts';

describe('permdock/cli marker types', () => {
  it('names what the marker readers return', () => {
    expectTypeOf(parseHookMarker).returns.toEqualTypeOf<
      SupabaseHookMarker | undefined
    >();
    expectTypeOf(parseGrantsMarker).returns.toEqualTypeOf<
      SupabaseGrantsMarker | undefined
    >();
  });
});
