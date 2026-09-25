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
 * Suggested ceiling for the `memberships` claim in bytes of JSON. Supabase sessions travel in
 * chunked cookies, and every claim is re-sent on each request: about 15 UUID-keyed single-role
 * memberships fit. Above it, use database mode (`authorize()` reads the table; pass
 * `memberships` to `snapshotFor`).
 */
export const supabaseMembershipsBudget = 1024;
