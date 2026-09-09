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

export type SupabaseSubjectOptions = {
  readonly roles?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly schema?: StandardSchemaV1;
  readonly include?: readonly SupabaseInclude[];
  readonly declared?: readonly string[];
};
