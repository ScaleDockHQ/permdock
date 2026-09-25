import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Principal } from '../core/subject.ts';

export type SupabasePrincipal = Principal & {
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly email?: string;
  readonly phone?: string;
  readonly is_anonymous?: boolean;
};

export type SupabaseInclude = 'email' | 'phone' | 'is_anonymous';

export type SupabaseMembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};

export type AuthorizeSqlOptions = {
  /** Postgres schema of `authorize`, `user_roles`, `role_permissions` and `app_permission`. Default `public`. */
  readonly schema?: string;
  /** `database` (default) reads the tables on every call; `jwt` reads the hook-injected claims. */
  readonly authorize?: 'database' | 'jwt';
  /** Membership table for tenant requests in `database` mode; without one they deny. */
  readonly tenant?: boolean | SupabaseMembershipTable;
};

export type SupabaseRlsOptions = {
  readonly roleClaim?: string;
  readonly tenantClaim?: string;
  readonly memberships?:
    | SupabaseMembershipTable
    | {
        readonly tenant?: SupabaseMembershipTable;
        readonly team?: SupabaseMembershipTable;
        readonly resource?: Readonly<Record<string, SupabaseMembershipTable>>;
      };
};

export type SupabaseRlsConfig = {
  readonly dialect: 'supabase';
  readonly roleClaim: string;
  readonly tenantClaim: string;
  readonly memberships?: {
    readonly tenant?: SupabaseMembershipTable;
    readonly team?: SupabaseMembershipTable;
    readonly resource?: Readonly<Record<string, SupabaseMembershipTable>>;
  };
};

/**
 * The structural shape `subjectFromSupabaseSession` reads: a discriminant and the verified JWT claims.
 * Matches better-supabase's `AuthSession` and similar session objects without importing them.
 */
export type SupabaseSessionLike = {
  readonly kind: string;
  readonly claims?: unknown;
};

export type SupabaseSubjectOptions = {
  readonly roles?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly schema?: StandardSchemaV1;
  readonly include?: readonly SupabaseInclude[];
  readonly declared?: readonly string[];
};
