import { d as Subject, u as Principal } from "../subject-BcgWbogX.js";
import { K as Permission, w as RoleSource } from "../policy-DdqgAkJT.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/clerk/types.d.ts
type ClerkPrincipal = Principal & {
  readonly clerkPermissions?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly featureSources?: Readonly<Record<string, "o" | "u">>;
};
type ClerkMembershipListItem = {
  readonly organization?: {
    readonly id?: string;
  };
  readonly organizationId?: string;
  readonly role?: string;
};
type ClerkBackend = {
  readonly users?: {
    readonly getOrganizationMembershipList?: (args: {
      readonly userId: string;
    }) => Promise<{
      readonly data?: readonly ClerkMembershipListItem[];
    } | readonly ClerkMembershipListItem[]>;
  };
};
type ClerkGlobalRoles = string | ((claims: Readonly<Record<string, unknown>>) => readonly string[]);
type ClerkSubjectOptions = {
  readonly memberships?: "active" | "all";
  readonly backend?: ClerkBackend;
  readonly customRoles?: RoleSource;
  readonly permissions?: Readonly<Record<string, Permission>>;
  readonly schema?: StandardSchemaV1;
  readonly globalRoles?: ClerkGlobalRoles;
  readonly features?: Readonly<Record<string, string>>;
  readonly declared?: readonly string[];
};
type ClerkAuthObject = {
  readonly userId?: string | null;
  readonly orgId?: string | null;
  readonly orgRole?: string | null;
  readonly orgPermissions?: readonly string[] | null;
  readonly sessionId?: string | null;
  readonly sessionClaims?: Readonly<Record<string, unknown>> | null;
  readonly has?: (...args: never[]) => unknown;
};
//#endregion
//#region src/clerk/subject.d.ts
export declare function subjectFromClerk(authObject: unknown, options?: ClerkSubjectOptions): Promise<Subject<ClerkPrincipal>>;
//#endregion
export type { ClerkAuthObject, ClerkBackend, ClerkGlobalRoles, ClerkMembershipListItem, ClerkPrincipal, ClerkSubjectOptions };