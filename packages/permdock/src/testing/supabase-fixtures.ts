import type { SupabaseHookManifest } from "../supabase/manifest.ts";

/**
 * Claim sets in the shape the Supabase custom access token hook produces (the RBAC guide's
 * `user_role` claim, optionally mirrored into `app_metadata`, plus a `memberships` array for
 * multi-org apps). `betterSupabase` is the canonical shape better-supabase 0.5 emits: scoped
 * memberships, `tenant_id` and per-tenant plans in `features`. `full` sets every field of the
 * claim contract plus a `hook.claims` extra claim; `portalContact`, `oauthClient` and
 * `actChain` cover a customer contact, a Supabase OAuth server token and an RFC 8693 chain.
 * `supportSession`, `supportSessionReadOnly` and `impersonation` are the `act.kind` tokens
 * better-supabase mints; `anonymousSignIn` is a `signInAnonymously()` token read with
 * `anonymousSignIns: 'deny'`. Every fixture passes `supabaseClaims()` and
 * `schemas/supabase-claims-v1.json`. Plain data: no Supabase or better-supabase types.
 */
export type SupabaseClaimFixture = {
  readonly claims: Readonly<Record<string, unknown>>;
  /** `subjectFromSupabase` options the case needs. */
  readonly options?: {
    readonly plans?: string;
    readonly anonymousSignIns?: "deny";
  };
  readonly expect: {
    readonly id: string | null;
    readonly roles: readonly string[];
    readonly memberships: readonly {
      readonly tenant?: string;
      readonly scope?: string;
      readonly id?: string;
      readonly within?: Readonly<Record<string, string>>;
      readonly on?: { readonly resource: string; readonly id: string };
      readonly roles: readonly string[];
      readonly via?: string;
      readonly expiresAt?: number;
      readonly grantedBy?: string;
      readonly reason?: string;
      readonly managedBy?: "idp";
      readonly entitlements?: readonly string[];
    }[];
    readonly tenant?: string;
    readonly plans?: readonly string[];
    /** `subject.actor`, absent when the token has neither `act` nor `client_id`. */
    readonly actor?:
      | { readonly id: string; readonly kind: "oauth-client" | "impersonation" }
      | {
          readonly id: string;
          readonly kind: "support";
          readonly sessionId: string;
          readonly readOnly: boolean;
        };
    /** `subject.delegation`: the `scope` claim and the `act` chain of an `oauth-client` actor. */
    readonly delegation?: {
      readonly scopes?: readonly string[];
      readonly chain?: Readonly<Record<string, unknown>>;
    };
  };
};

const base = {
  sub: "6f1c2c1e-5d0a-4d9e-9a51-6b1f0e7c2a10",
  aud: "authenticated",
  role: "authenticated",
  iss: "https://project.supabase.co/auth/v1",
  iat: 1_790_000_000,
  exp: 1_790_003_600,
  aal: "aal1",
  session_id: "b7a8f9c0-1111-4222-8333-944455556666",
  is_anonymous: false,
} as const;

const id: string = base.sub;
const org = "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6";
const project = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const customer = "c7d8e9f0-1a2b-4c3d-9e4f-5a6b7c8d9e0f";
const supportAdmin = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const supportSessionId = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const ownerMembership = {
  scope: "organization",
  id: org,
  roles: ["owner"],
  via: "direct",
  expiresAt: 1_900_000_000,
  grantedBy: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  reason: "founding member",
  managedBy: "idp",
  entitlements: ["seat:pro"],
} as const;
const projectMembership = {
  scope: "project",
  id: project,
  within: { organization: org },
  roles: ["editor"],
} as const;
const shareMembership = {
  on: { resource: "document", id: "doc-1" },
  roles: ["viewer"],
  via: "share",
} as const;
const contactMembership = {
  scope: "customer",
  id: customer,
  within: { organization: org },
  roles: ["contact"],
  via: "contact",
} as const;

export type SupabaseClaimFixtureName =
  | "topLevelRole"
  | "appMetadataRole"
  | "nullTopLevelFallsBack"
  | "arrayRoles"
  | "missingRole"
  | "nullRole"
  | "userMetadataIgnored"
  | "multiOrg"
  | "betterSupabase"
  | "full"
  | "portalContact"
  | "oauthClient"
  | "actChain"
  | "supportSession"
  | "supportSessionReadOnly"
  | "impersonation"
  | "anonymousSignIn"
  | "anon"
  | "serviceRole";

export const supabaseClaimFixtures: Readonly<
  Record<SupabaseClaimFixtureName, SupabaseClaimFixture>
> = {
  topLevelRole: {
    claims: {
      ...base,
      user_role: "admin",
      app_metadata: { provider: "email" },
    },
    expect: { id, roles: ["admin"], memberships: [] },
  },
  appMetadataRole: {
    claims: {
      ...base,
      app_metadata: { provider: "email", user_role: "moderator" },
    },
    expect: { id, roles: ["moderator"], memberships: [] },
  },
  nullTopLevelFallsBack: {
    claims: {
      ...base,
      user_role: null,
      app_metadata: { user_role: "moderator" },
    },
    expect: { id, roles: ["moderator"], memberships: [] },
  },
  arrayRoles: {
    claims: { ...base, user_role: ["admin", "moderator"] },
    expect: { id, roles: ["admin", "moderator"], memberships: [] },
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
        user_role: "admin",
        memberships: [{ tenant: "acme", roles: ["owner"] }],
      },
    },
    expect: { id, roles: [], memberships: [] },
  },
  multiOrg: {
    claims: {
      ...base,
      tenant_id: "acme",
      memberships: [
        { tenant: "acme", roles: ["admin"] },
        { tenant: "globex", roles: ["viewer"] },
      ],
    },
    expect: {
      id,
      roles: [],
      tenant: "acme",
      memberships: [
        { tenant: "acme", roles: ["admin"] },
        { tenant: "globex", roles: ["viewer"] },
      ],
    },
  },
  betterSupabase: {
    claims: {
      ...base,
      user_role: null,
      tenant_id: "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6",
      memberships: [
        {
          scope: "tenant",
          id: "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6",
          roles: ["admin"],
        },
        {
          scope: "tenant",
          id: "7e6d5c4b-3a29-4817-9605-f4e3d2c1b0a9",
          roles: ["viewer"],
        },
      ],
      features: {
        "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6": ["pro"],
        "7e6d5c4b-3a29-4817-9605-f4e3d2c1b0a9": ["free"],
      },
      authz_ver: 3,
    },
    options: { plans: "features" },
    expect: {
      id,
      roles: [],
      tenant: "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6",
      memberships: [
        {
          scope: "tenant",
          id: "0d8c5a2e-3f4b-4c6d-8e9f-a1b2c3d4e5f6",
          roles: ["admin"],
        },
        {
          scope: "tenant",
          id: "7e6d5c4b-3a29-4817-9605-f4e3d2c1b0a9",
          roles: ["viewer"],
        },
      ],
      plans: ["pro"],
    },
  },
  full: {
    claims: {
      ...base,
      user_role: ["admin"],
      roles: ["admin"],
      tenant_id: org,
      memberships: [
        {
          ...ownerMembership,
          grants: { analyst: ["post.read", "-post.delete"] },
        },
        projectMembership,
        shareMembership,
      ],
      memberships_truncated: true,
      attrs: { department: "finance", clearance: 2 },
      authz_ver: 7,
      datetime_preferences: {
        timezone: "Europe/Amsterdam",
        week_start: "monday",
        date_format: "dd-MM-yyyy",
        time_format: "24h",
      },
      app_metadata: { provider: "email", providers: ["email"] },
    },
    expect: {
      id,
      roles: ["admin"],
      tenant: org,
      memberships: [ownerMembership, projectMembership, shareMembership],
    },
  },
  portalContact: {
    claims: {
      ...base,
      user_role: null,
      tenant_id: org,
      memberships: [contactMembership],
    },
    expect: {
      id,
      roles: [],
      tenant: org,
      memberships: [contactMembership],
    },
  },
  oauthClient: {
    claims: {
      ...base,
      client_id: "5f0e4d3c-2b1a-4098-8776-655443322110",
      scope: "openid email posts:read",
      user_role: "member",
    },
    expect: {
      id,
      roles: ["member"],
      memberships: [],
      actor: {
        id: "5f0e4d3c-2b1a-4098-8776-655443322110",
        kind: "oauth-client",
      },
      delegation: { scopes: ["posts:read"] },
    },
  },
  actChain: {
    claims: {
      ...base,
      scope: "posts:read",
      act: { sub: "agent-runner", act: { sub: "mcp-client-42" } },
    },
    expect: {
      id,
      roles: [],
      memberships: [],
      actor: { id: "agent-runner", kind: "oauth-client" },
      delegation: {
        scopes: ["posts:read"],
        chain: { sub: "agent-runner", act: { sub: "mcp-client-42" } },
      },
    },
  },
  supportSession: {
    claims: {
      ...base,
      user_role: "member",
      act: {
        kind: "support",
        sub: supportAdmin,
        reason: "ticket 42",
        session_id: supportSessionId,
        read_only: false,
      },
    },
    expect: {
      id,
      roles: ["member"],
      memberships: [],
      actor: {
        id: supportAdmin,
        kind: "support",
        sessionId: supportSessionId,
        readOnly: false,
      },
    },
  },
  supportSessionReadOnly: {
    claims: {
      ...base,
      user_role: "member",
      act: {
        kind: "support",
        sub: supportAdmin,
        reason: "ticket 42",
        session_id: supportSessionId,
        read_only: true,
      },
    },
    expect: {
      id,
      roles: ["member"],
      memberships: [],
      actor: {
        id: supportAdmin,
        kind: "support",
        sessionId: supportSessionId,
        readOnly: true,
      },
    },
  },
  impersonation: {
    claims: {
      ...base,
      user_role: "member",
      act: { kind: "impersonation", sub: supportAdmin, reason: "ticket 42" },
    },
    expect: {
      id,
      roles: ["member"],
      memberships: [],
      actor: { id: supportAdmin, kind: "impersonation" },
    },
  },
  anonymousSignIn: {
    claims: { ...base, is_anonymous: true },
    options: { anonymousSignIns: "deny" },
    expect: { id: null, roles: [], memberships: [] },
  },
  anon: {
    claims: { ...base, role: "anon", sub: "" },
    expect: { id: null, roles: [], memberships: [] },
  },
  serviceRole: {
    claims: { ...base, role: "service_role", user_role: "admin" },
    expect: { id: null, roles: [], memberships: [] },
  },
};

/**
 * `supabaseClaimFixtures` as a `supabase/sdk` conformance vector file
 * (`schema/conformance.schema.json`): each case's `input` is a verified
 * `getClaims()` payload and the `subjectFromSupabase` options, `expected` the
 * subject fields it maps to. `JSON.stringify` it for a port in another language.
 */
export type SupabaseClaimVectors = {
  readonly feature: "auth.session.get_claims";
  readonly cases: readonly {
    readonly name: string;
    readonly input: {
      readonly claims: SupabaseClaimFixture["claims"];
      readonly options?: SupabaseClaimFixture["options"];
    };
    readonly expected: SupabaseClaimFixture["expect"];
  }[];
};

export const supabaseClaimVectors: SupabaseClaimVectors = {
  feature: "auth.session.get_claims",
  cases: Object.entries(supabaseClaimFixtures).map(([name, fixture]) => ({
    name,
    input: {
      claims: fixture.claims,
      ...(fixture.options === undefined ? {} : { options: fixture.options }),
    },
    expected: fixture.expect,
  })),
};

/**
 * Suggested ceiling for the `memberships` claim in bytes of JSON: about 15 UUID-keyed
 * single-role memberships. `permdock supabase hook generate` truncates at it by default.
 */
export { supabaseMembershipsBudget } from "../supabase/budget.ts";

/**
 * The `permdock supabase inspect --json` manifest for a policy with one
 * `tenant` scope, the default `supabase.hook` and a `features` claim from
 * `better_supabase.feature_claims`. A package that reads the manifest tests its
 * parser against this value.
 */
export const supabaseHookManifestFixture: SupabaseHookManifest = {
  $schema: "https://permdock.com/schemas/supabase-manifest-v1.json",
  version: 1,
  hook: {
    schema: "permdock",
    function: "custom_access_token_hook",
    out: "supabase/permdock-hook.sql",
  },
  helpers: {
    schema: "permdock",
    functions: [
      "permdock_has",
      "permitted_tenant_ids",
      "member_tenant_ids",
      "member_tenant_ids_for",
    ],
  },
  tenantClaim: "tenant_id",
  budget: {
    bytes: 1024,
    measure: "octet_length(memberships::text) + octet_length(attrs::text)",
  },
  claims: [
    { name: "user_role", source: "permdock", budget: false },
    { name: "roles", source: "permdock", budget: false },
    { name: "memberships", source: "permdock", budget: true },
    { name: "memberships_truncated", source: "permdock", budget: false },
    { name: "tenant_id", source: "permdock", budget: false },
    { name: "authz_ver", source: "permdock", budget: false },
    {
      name: "features",
      source: "better_supabase.feature_claims",
      budget: false,
    },
  ],
  authzVersion: true,
  authzVersionBump: {
    schema: "permdock",
    function: "permdock_bump_authz_version_for",
    args: "p_users uuid[]",
  },
  memberships: [
    {
      table: "public.memberships",
      user: { column: "user_id" },
      scope: { column: "scope" },
      id: { column: "scope_id" },
      role: { column: "role" },
      columns: ["user_id", "scope", "scope_id", "role"],
    },
  ],
  rls: {
    schema: "permdock",
    mode: "jwt",
    tenantClaim: "tenant_id",
    scopes: [{ name: "tenant", type: "uuid" }],
    helpers: [
      {
        name: "permdock_has",
        args: "p_grant text",
        returns: "boolean",
        execute: ["authenticated"],
      },
      {
        name: "permitted_tenant_ids",
        args: "p_grant text",
        returns: "setof uuid",
        execute: ["authenticated"],
      },
      {
        name: "member_tenant_ids",
        args: "",
        returns: "setof uuid",
        execute: ["authenticated"],
      },
      {
        name: "member_tenant_ids_for",
        args: "p_user uuid",
        returns: "setof uuid",
        execute: ["supabase_auth_admin"],
      },
      {
        name: "permdock_user_id",
        args: "",
        returns: "uuid",
        execute: ["authenticated"],
      },
    ],
    memberships: [
      {
        table: "public.memberships",
        user: { column: "user_id" },
        scope: { column: "scope" },
        id: { column: "scope_id" },
        role: { column: "role" },
        columns: ["user_id", "scope", "scope_id", "role"],
      },
    ],
    customRoles: false,
    roles: {
      table: "permdock.user_roles",
      user: { column: "user_id" },
      role: { column: "role" },
    },
  },
  decidingColumns: [
    "public.memberships.role",
    "public.memberships.scope",
    "public.memberships.scope_id",
    "public.memberships.user_id",
  ],
  markers: { hook: "v1", grants: "v1" },
  requires: {
    matrix: "capability-matrix-v1.12.0",
    capabilities: ["auth.session.get_claims"],
  },
};
