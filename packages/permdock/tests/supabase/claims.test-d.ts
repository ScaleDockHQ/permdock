import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  type SupabaseClaims,
  type SupabaseMembershipClaim,
  supabaseClaims,
} from '../../src/supabase/index.ts';

describe('supabaseClaims() output types', () => {
  it('is SupabaseClaims for the default tenant claim', () => {
    const schema = supabaseClaims();
    expectTypeOf<
      StandardSchemaV1.InferOutput<typeof schema>
    >().toEqualTypeOf<SupabaseClaims>();
    expectTypeOf<
      StandardSchemaV1.InferOutput<typeof schema>['tenant_id']
    >().toEqualTypeOf<string | undefined>();
    expectTypeOf<
      NonNullable<SupabaseClaims['memberships']>[number]
    >().toEqualTypeOf<SupabaseMembershipClaim>();
  });

  it('follows a configured tenant claim', () => {
    const schema = supabaseClaims({ tenantClaim: 'org_id' });
    expectTypeOf<StandardSchemaV1.InferOutput<typeof schema>>().toEqualTypeOf<
      SupabaseClaims<'org_id'>
    >();
    expectTypeOf<SupabaseClaims<'org_id'>['org_id']>().toEqualTypeOf<
      string | undefined
    >();
  });

  it('merges a Zod and a valibot extension', () => {
    const schema = supabaseClaims()
      .extend(
        z.object({ datetime_preferences: z.object({ timezone: z.string() }) }),
      )
      .extend(v.object({ locale: v.string() }));
    type Out = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Out['datetime_preferences']>().toEqualTypeOf<{
      timezone: string;
    }>();
    expectTypeOf<Out['locale']>().toEqualTypeOf<string>();
    expectTypeOf<Out['memberships']>().toEqualTypeOf<
      SupabaseClaims['memberships']
    >();
  });
});
