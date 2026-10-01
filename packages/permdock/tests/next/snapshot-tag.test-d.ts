import { describe, expectTypeOf, it } from 'vitest';

import { snapshotTag } from '../../src/next/index.ts';

describe('snapshotTag', () => {
  it('takes a subject id, null or nothing and returns a string', () => {
    expectTypeOf(snapshotTag)
      .parameter(0)
      .toEqualTypeOf<string | null | undefined>();
    expectTypeOf(snapshotTag).returns.toEqualTypeOf<string>();
    expectTypeOf(snapshotTag).parameter(0).not.toExtend<number>();
  });
});
