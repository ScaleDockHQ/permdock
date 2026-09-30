import type { SupabaseHookManifest } from '../supabase/manifest.ts';

/**
 * Claim sets in the shape the Supabase custom access token hook produces (the RBAC guide's
 * `user_role` claim, optionally mirrored into `app_metadata`, plus a `memberships` array for
 * multi-org apps). Plain data: no Supabase or better-supabase types.
 */
export type SupabaseClaimFixture = {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly expect: {
    readonly id: string | null;
    readonly roles: readonly string[];
    readonly memberships: readonly {
      readonly tenant: string;
      readonly roles: readonly string[];
    }[];
    readonly tenant?: string;
  };
};

const base = {
  sub: '6f1c2c1e-5d0a-4d9e-9a51-6b1f0e7c2a10',
  aud: 'authenticated',
  role: 'authenticated',
  iss: 'https://project.supabase.co/auth/v1',
  iat: 1_790_000_000,
  exp: 1_790_003_600,
  aal: 'aal1',
  session_id: 'b7a8f9c0-1111-4222-8333-944455556666',
  is_anonymous: false,
} as const;

const id: string = base.sub;

export type SupabaseClaimFixtureName =
  | 'topLevelRole'
  | 'appMetadataRole'
  | 'nullTopLevelFallsBack'
  | 'arrayRoles'
  | 'missingRole'
  | 'nullRole'
  | 'userMetadataIgnored'
  | 'multiOrg'
  | 'anon'
  | 'serviceRole';

export const supabaseClaimFixtures: Readonly<
  Record<SupabaseClaimFixtureName, SupabaseClaimFixture>
> = {
  topLevelRole: {
    claims: {
      ...base,
      user_role: 'admin',
      app_metadata: { provider: 'email' },
    },
    expect: { id, roles: ['admin'], memberships: [] },
  },
  appMetadataRole: {
    claims: {
      ...base,
      app_metadata: { provider: 'email', user_role: 'moderator' },
    },
    expect: { id, roles: ['moderator'], memberships: [] },
  },
  nullTopLevelFallsBack: {
    claims: {
      ...base,
      user_role: null,
      app_metadata: { user_role: 'moderator' },
    },
    expect: { id, roles: ['moderator'], memberships: [] },
  },
  arrayRoles: {
    claims: { ...base, user_role: ['admin', 'moderator'] },
    expect: { id, roles: ['admin', 'moderator'], memberships: [] },
  },
  missingRole: {
    claims: { ...base },
    expect: { id, roles: [], memberships: [] },
  },
  nullRole: {
    claims: { ...base, user_role: null, app_metadata: { user_role: null } },
    expect: { id, roles: [], memberships: [] },
  },
  userMetadataIgnored: {
    claims: {
      ...base,
      user_metadata: {
        user_role: 'admin',
        memberships: [{ tenant: 'acme', roles: ['owner'] }],
      },
    },
    expect: { id, roles: [], memberships: [] },
  },
  multiOrg: {
    claims: {
      ...base,
      tenant_id: 'acme',
      memberships: [
        { tenant: 'acme', roles: ['admin'] },
        { tenant: 'globex', roles: ['viewer'] },
      ],
    },
    expect: {
      id,
      roles: [],
      tenant: 'acme',
      memberships: [
        { tenant: 'acme', roles: ['admin'] },
        { tenant: 'globex', roles: ['viewer'] },
      ],
    },
  },
  anon: {
    claims: { ...base, role: 'anon', sub: '' },
    expect: { id: null, roles: [], memberships: [] },
  },
  serviceRole: {
    claims: { ...base, role: 'service_role', user_role: 'admin' },
    expect: { id: null, roles: [], memberships: [] },
  },
};

/**
 * Suggested ceiling for the `memberships` claim in bytes of JSON: about 15 UUID-keyed
 * single-role memberships. `permdock supabase hook generate` truncates at it by default.
 */
export { supabaseMembershipsBudget } from '../supabase/budget.ts';

/**
 * The `permdock supabase inspect --json` manifest for a policy with one
 * `tenant` scope, the default `supabase.hook` and a `features` claim from
 * `better_supabase.feature_claims`. A package that reads the manifest tests its
 * parser against this value.
 */
export const supabaseHookManifestFixture: SupabaseHookManifest = {
  version: 1,
  hook: {
    schema: 'public',
    function: 'custom_access_token_hook',
    out: 'supabase/permdock-hook.sql',
  },
  helpers: {
    schema: 'public',
    functions: ['permdock_has', 'permitted_tenant_ids'],
  },
  tenantClaim: 'tenant_id',
  budget: {
    bytes: 1024,
    measure: 'octet_length(memberships::text) + octet_length(attrs::text)',
  },
  claims: [
    { name: 'user_role', source: 'permdock', budget: false },
    { name: 'roles', source: 'permdock', budget: false },
    { name: 'memberships', source: 'permdock', budget: true },
    { name: 'memberships_truncated', source: 'permdock', budget: false },
    { name: 'tenant_id', source: 'permdock', budget: false },
    { name: 'authz_ver', source: 'permdock', budget: false },
    {
      name: 'features',
      source: 'better_supabase.feature_claims',
      budget: false,
    },
  ],
  authzVersion: true,
};
