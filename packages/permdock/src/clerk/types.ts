import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { RoleSource } from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Principal } from '../core/subject.ts';

export type ClerkPrincipal = Principal & {
  readonly clerkPermissions?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly featureSources?: Readonly<Record<string, 'o' | 'u'>>;
};

export type ClerkMembershipListItem = {
  readonly organization?: { readonly id?: string };
  readonly organizationId?: string;
  readonly role?: string;
};

export type ClerkBackend = {
  readonly users?: {
    readonly getOrganizationMembershipList?: (args: {
      readonly userId: string;
    }) => Promise<
      | { readonly data?: readonly ClerkMembershipListItem[] }
      | readonly ClerkMembershipListItem[]
    >;
  };
};

export type ClerkGlobalRoles =
  | string
  | ((claims: Readonly<Record<string, unknown>>) => readonly string[]);

export type ClerkSubjectOptions = {
  readonly memberships?: 'active' | 'all';
  readonly backend?: ClerkBackend;
  readonly customRoles?: RoleSource;
  readonly permissions?: Readonly<Record<string, Permission>>;
  readonly schema?: StandardSchemaV1;
  readonly globalRoles?: ClerkGlobalRoles;
  readonly features?: Readonly<Record<string, string>>;
  readonly declared?: readonly string[];
};

export type ClerkAuthObject = {
  readonly userId?: string | null;
  readonly orgId?: string | null;
  readonly orgRole?: string | null;
  readonly orgPermissions?: readonly string[] | null;
  readonly sessionId?: string | null;
  readonly sessionClaims?: Readonly<Record<string, unknown>> | null;
  readonly has?: (...args: never[]) => unknown;
};
