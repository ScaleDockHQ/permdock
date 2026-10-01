import { describe, expectTypeOf, it } from 'vitest';

import type { RlsMigrateHelper } from '../../src/cli/types.ts';

import { defineConfig } from '../../src/cli/index.ts';

describe('rls config', () => {
  it('accepts helpersOnly and the migrate helper forms', () => {
    const config = defineConfig({
      policy: './policy.ts',
      rls: {
        helpersOnly: true,
        migrate: {
          helpers: {
            org_ids_with_permission: { form: 'ids', scope: 'organization' },
            authorize_scope: { form: 'scoped' },
            is_system_user_with: { form: 'global' },
          },
          prefixes: { 'organization.': '' },
          globalScopes: ['system'],
        },
      },
    });
    expectTypeOf(config.rls?.helpersOnly).toExtend<boolean | undefined>();
  });

  it('needs a scope on the scope-bound forms', () => {
    expectTypeOf({ form: 'row' } as const).not.toExtend<RlsMigrateHelper>();
    expectTypeOf({
      form: 'membership',
      scope: 'organization',
    } as const).toExtend<RlsMigrateHelper>();
  });
});
