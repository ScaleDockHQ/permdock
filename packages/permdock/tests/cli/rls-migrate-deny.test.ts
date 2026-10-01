import { describe, expect, it } from 'vitest';

import type { GenerateOutcome } from '../../src/cli/rls-generate.ts';

import { migrateTarget } from '../../src/cli/rls-migrate.ts';

describe('migrateTarget', () => {
  it('counts only allow seeds as granted keys', () => {
    // SAFETY: migrateTarget reads only seeds, schema, text and keys; the rest of the outcome is unused here.
    const generated = {
      text: '',
      seeds: [
        {
          role: 'member',
          permission: 'quote.read',
          grantKey: 'quote.read',
          scope: 'organization',
          effect: 'allow',
        },
        {
          role: 'member',
          permission: 'quote.delete',
          grantKey: 'quote.delete',
          scope: 'organization',
          effect: 'deny',
        },
      ],
    } as unknown as GenerateOutcome;
    const target = migrateTarget(generated);
    expect([...(target.granted.get('organization') ?? [])]).toEqual([
      'quote.read',
    ]);
  });
});
