import { d as Subject, u as Principal } from "../subject-BcgWbogX.js";
import { b as PermissionTree, c as Role } from "../policy-Ypk6zTSJ.js";
import { c as RoleSource } from "../interfaces-BPpihPRB.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/better-auth/types.d.ts
type BetterAuthPrincipal = Principal & {
  readonly email?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};
type BetterAuthStatements = Readonly<Record<string, readonly string[]>>;
type BetterAuthAccessRole = {
  readonly statements?: BetterAuthStatements;
  readonly permissions?: BetterAuthStatements;
};
type BetterAuthAccessControl = {
  readonly ac?: unknown;
  readonly roles: Readonly<Record<string, BetterAuthAccessRole>>;
};
type BetterAuthAssignableRole = {
  readonly name: string;
  readonly statements: BetterAuthStatements;
};
type BetterAuthLike = {
  readonly api?: {
    readonly listOrganizations?: (args?: {
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listMembers?: (args?: {
      readonly query?: {
        readonly organizationId?: string;
      };
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listTeams?: (args?: {
      readonly query?: {
        readonly organizationId?: string;
      };
      readonly headers?: unknown;
    }) => Promise<unknown>;
    readonly listOrganizationRoles?: (args?: {
      readonly query?: {
        readonly organizationId?: string;
      };
      readonly headers?: unknown;
    }) => Promise<unknown>;
  };
};
type BetterAuthSubjectOptions = {
  readonly memberships?: "all" | "active";
  readonly schema?: StandardSchemaV1;
  readonly headers?: unknown;
  readonly declared?: readonly string[];
};
type BetterAuthRoleSourceOptions = {
  readonly assignable?: readonly BetterAuthAssignableRole[];
  readonly headers?: unknown;
};
type BetterAuthUnmatchedStatement = {
  readonly role: string;
  readonly resource: string;
  readonly action: string;
};
type BetterAuthRoleChangeEvent = {
  readonly userId?: string;
  readonly organizationId?: string;
};
//#endregion
//#region src/better-auth/roles.d.ts
type SeededRoles = Role[] & {
  readonly unmatched: readonly BetterAuthUnmatchedStatement[];
};
export declare function rolesFromAccessControl(access: BetterAuthAccessControl, permissions: PermissionTree, options?: {
  readonly on?: "tenant" | "global";
}): SeededRoles;
export declare function betterAuthRoleSource(auth: BetterAuthLike, options?: BetterAuthRoleSourceOptions): RoleSource;
export declare function onRoleChange(refresh: (event: BetterAuthRoleChangeEvent) => void | Promise<void>): (event: BetterAuthRoleChangeEvent) => Promise<void>;
//#endregion
//#region src/better-auth/subject.d.ts
export declare function subjectFromBetterAuth(auth: BetterAuthLike, session: unknown, options?: BetterAuthSubjectOptions): Promise<Subject<BetterAuthPrincipal>>;
//#endregion
export type { BetterAuthAccessControl, BetterAuthAccessRole, BetterAuthAssignableRole, BetterAuthLike, BetterAuthPrincipal, BetterAuthRoleChangeEvent, BetterAuthRoleSourceOptions, BetterAuthStatements, BetterAuthSubjectOptions, BetterAuthUnmatchedStatement, SeededRoles };