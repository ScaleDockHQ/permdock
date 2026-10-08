import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Principal } from "../core/subject.ts";

export type BetterAuthPrincipal = Principal & {
  readonly email?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

export type BetterAuthStatements = Readonly<Record<string, readonly string[]>>;

export type BetterAuthAccessRole = {
  readonly statements?: BetterAuthStatements;
  readonly permissions?: BetterAuthStatements;
};

export type BetterAuthAccessControl = {
  readonly ac?: unknown;
  readonly roles: Readonly<Record<string, BetterAuthAccessRole>>;
};

export type BetterAuthAssignableRole = {
  readonly name: string;
  readonly statements: BetterAuthStatements;
};

export type BetterAuthLike = {
  readonly api?: {
    readonly listOrganizations?: (args?: {
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listMembers?: (args?: {
      readonly query?: {
        readonly organizationId?: string;
        readonly filterField?: string;
        readonly filterOperator?: "eq";
        readonly filterValue?: string;
      };
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly getActiveMember?: (args?: {
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listUserTeams?: (args?: {
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listOrganizationRoles?: (args?: {
      readonly query?: { readonly organizationId?: string };
      readonly headers?: unknown;
    }) => Promise<unknown>;
  };
};

export type BetterAuthSubjectOptions = {
  readonly memberships?: "all" | "active";
  /**
   * Parses the user's additional fields into `principal.claims`. Without it no
   * field reaches claims, because a user may edit their own additional fields.
   */
  readonly schema?: StandardSchemaV1;
  readonly headers?: unknown;
  readonly declared?: readonly string[];
};

export type BetterAuthRoleSourceOptions = {
  readonly assignable?: readonly BetterAuthAssignableRole[];
  readonly headers?: unknown;
};

export type BetterAuthUnmatchedStatement = {
  readonly role: string;
  readonly resource: string;
  readonly action: string;
};

export type BetterAuthRoleChangeEvent = {
  readonly userId?: string;
  readonly organizationId?: string;
  readonly role?: string;
  readonly previousRole?: string;
  readonly teamId?: string;
  readonly by?: { readonly id: string; readonly kind: string };
};
