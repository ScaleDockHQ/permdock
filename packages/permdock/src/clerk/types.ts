import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ClaimsMap } from "../core/claims-map.ts";
import type { CustomRoleSource } from "../core/interfaces.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Principal } from "../core/subject.ts";
import type { RemotePdpCache } from "../pdp/types.ts";

export type ClerkPrincipal = Principal & {
  readonly clerkPermissions?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly featureSources?: Readonly<Record<string, "o" | "u">>;
};

export type ClerkMembershipListItem = {
  readonly organization?: { readonly id?: string };
  readonly organizationId?: string;
  readonly role?: string;
  readonly publicUserData?: { readonly userId?: string } | null;
};

export type ClerkBackend = {
  readonly users?: {
    readonly getOrganizationMembershipList?: (args: {
      readonly userId: string;
      readonly limit?: number;
      readonly offset?: number;
    }) => Promise<
      | {
          readonly data?: readonly ClerkMembershipListItem[];
          readonly totalCount?: number;
        }
      | readonly ClerkMembershipListItem[]
    >;
  };
};

export type ClerkSubjectOptions = {
  readonly memberships?: "active" | "all";
  readonly backend?: ClerkBackend;
  readonly customRoles?: CustomRoleSource;
  readonly permissions?: Readonly<Record<string, Permission>>;
  readonly schema?: StandardSchemaV1;
  /** Where the session token carries platform roles (`claims.roles`): a path such as `publicMetadata.staff`, or a function. Organization roles come from the `o` claim. */
  readonly claims?: Pick<ClaimsMap, "roles">;
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

export type ClerkSubjectResolverOptions = ClerkSubjectOptions & {
  readonly cache?: RemotePdpCache;
};
