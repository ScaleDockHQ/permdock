import type { DecisionSink, TokenVerifier } from "../core/interfaces.ts";
import type { RevocationFeed } from "../core/revocations.ts";

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const ROLES_EXTENSION = "urn:permdock:scim:schemas:extension:roles:1.0";

export type DirectoryMeta = {
  readonly created: string;
  readonly lastModified: string;
  readonly location?: string;
  readonly resourceType?: "User" | "Group";
};

export type DirectoryEmail = {
  readonly value: string;
  readonly primary?: boolean;
  readonly type?: string;
};

export type DirectoryUser = {
  readonly id: string;
  readonly externalId?: string;
  readonly userName: string;
  readonly active: boolean;
  readonly emails?: readonly DirectoryEmail[];
  readonly meta: DirectoryMeta;
};

export type DirectoryGroupMember = {
  readonly value: string;
};

export type DirectoryGroup = {
  readonly id: string;
  readonly externalId?: string;
  readonly displayName: string;
  readonly members: readonly DirectoryGroupMember[];
  readonly roles?: readonly string[];
  readonly meta: DirectoryMeta;
};

export type ScimCompareOp = "eq" | "ne" | "co" | "sw";

export type ScimFilter =
  | {
      readonly op: ScimCompareOp;
      readonly attribute: string;
      readonly value: string | boolean;
    }
  | { readonly op: "pr"; readonly attribute: string }
  | { readonly op: "and" | "or"; readonly filters: readonly ScimFilter[] };

export type ScimPage = {
  readonly startIndex?: number;
  readonly count?: number;
  readonly cursor?: string;
};

export type ScimPageResult<T> = {
  readonly Resources: readonly T[];
  readonly totalResults: number;
  readonly startIndex?: number;
  readonly itemsPerPage?: number;
  readonly nextCursor?: string;
};

export type ScimPatchOp = {
  readonly op: "add" | "replace" | "remove";
  readonly path?: string;
  readonly value?: unknown;
};

export type DirectoryStore = {
  getUser(tenant: string, id: string): Promise<DirectoryUser | null>;
  findUsers(
    tenant: string,
    filter: ScimFilter | undefined,
    page: ScimPage,
  ): Promise<ScimPageResult<DirectoryUser>>;
  putUser(tenant: string, user: DirectoryUser): Promise<DirectoryUser>;
  patchUser(
    tenant: string,
    id: string,
    ops: readonly ScimPatchOp[],
  ): Promise<DirectoryUser>;
  deleteUser(tenant: string, id: string): Promise<void>;
  getGroup(tenant: string, id: string): Promise<DirectoryGroup | null>;
  findGroups(
    tenant: string,
    filter: ScimFilter | undefined,
    page: ScimPage,
  ): Promise<ScimPageResult<DirectoryGroup>>;
  putGroup(tenant: string, group: DirectoryGroup): Promise<DirectoryGroup>;
  patchGroup(
    tenant: string,
    id: string,
    ops: readonly ScimPatchOp[],
  ): Promise<DirectoryGroup>;
  deleteGroup(tenant: string, id: string): Promise<void>;
  groupsFor(tenant: string, userId: string): Promise<readonly DirectoryGroup[]>;
};

export type ScimTokenOptions = {
  readonly hash: "sha256";
  readonly lookup: (
    tenant: string,
  ) => string | undefined | Promise<string | undefined>;
};

export type DirectoryChange = {
  readonly tenant: string;
  readonly userIds: readonly string[];
  /** `session-revoked` when a user was deactivated or deleted; `changed` otherwise. */
  readonly kind: "session-revoked" | "changed";
};

export type ScimHandlerOptions = {
  readonly store: DirectoryStore;
  readonly tenant: string | ((request: Request) => string | Promise<string>);
  readonly token?: ScimTokenOptions;
  readonly verifier?: TokenVerifier;
  readonly audience?: string;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly assignable?: readonly string[];
  readonly sink?: DecisionSink;
  readonly onChange?: (change: DirectoryChange) => void | Promise<void>;
  /**
   * Publishes for each affected user's id, `externalId` and `userName`:
   * `session-revoked` when a user is deactivated (`active: false`) or
   * deleted, so open connections end; `changed` otherwise, so they revalidate.
   */
  readonly revocations?: RevocationFeed;
  readonly onUnknownRole?: (name: string) => void;
};

export type DirectoryMembershipMatch = "externalId" | "userName" | "either";

export type DirectoryMembershipSourceOptions = {
  readonly match?: DirectoryMembershipMatch;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly assignable?: readonly string[];
  readonly onUnknownRole?: (name: string) => void;
};

export class DirectoryUniquenessError extends Error {
  public override readonly name = "DirectoryUniquenessError";
  public readonly code = "uniqueness" as const;

  public constructor(message = "uniqueness") {
    super(message);
  }
}

export class DirectoryNotFoundError extends Error {
  public override readonly name = "DirectoryNotFoundError";
  public readonly code = "not-found" as const;

  public constructor(message = "not found") {
    super(message);
  }
}

export function isDirectoryUniquenessError(
  error: unknown,
): error is DirectoryUniquenessError {
  return error instanceof DirectoryUniquenessError;
}

export function isDirectoryNotFoundError(
  error: unknown,
): error is DirectoryNotFoundError {
  return error instanceof DirectoryNotFoundError;
}
