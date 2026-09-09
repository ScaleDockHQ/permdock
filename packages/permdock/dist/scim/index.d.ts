import { P as TokenVerifier, T as MembershipSource, y as DecisionSink } from "../policy-CrXDbTAD.js";
//#region src/scim/types.d.ts
export declare const SCIM_CONTENT_TYPE = "application/scim+json";
export declare const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export declare const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export declare const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export declare const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export declare const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export declare const ROLES_EXTENSION = "urn:permdock:scim:schemas:extension:roles:1.0";
type DirectoryMeta = {
  readonly created: string;
  readonly lastModified: string;
  readonly location?: string;
  readonly resourceType?: "User" | "Group";
};
type DirectoryEmail = {
  readonly value: string;
  readonly primary?: boolean;
  readonly type?: string;
};
type DirectoryUser = {
  readonly id: string;
  readonly externalId?: string;
  readonly userName: string;
  readonly active: boolean;
  readonly emails?: readonly DirectoryEmail[];
  readonly meta: DirectoryMeta;
};
type DirectoryGroupMember = {
  readonly value: string;
};
type DirectoryGroup = {
  readonly id: string;
  readonly externalId?: string;
  readonly displayName: string;
  readonly members: readonly DirectoryGroupMember[];
  readonly roles?: readonly string[];
  readonly meta: DirectoryMeta;
};
type ScimCompareOp = "eq" | "ne" | "co" | "sw";
type ScimFilter = {
  readonly op: ScimCompareOp;
  readonly attribute: string;
  readonly value: string | boolean;
} | {
  readonly op: "pr";
  readonly attribute: string;
} | {
  readonly op: "and" | "or";
  readonly filters: readonly ScimFilter[];
};
type ScimPage = {
  readonly startIndex?: number;
  readonly count?: number;
  readonly cursor?: string;
};
type ScimPageResult<T> = {
  readonly Resources: readonly T[];
  readonly totalResults: number;
  readonly startIndex?: number;
  readonly itemsPerPage?: number;
  readonly nextCursor?: string;
};
type ScimPatchOp = {
  readonly op: "add" | "replace" | "remove";
  readonly path?: string;
  readonly value?: unknown;
};
type DirectoryStore = {
  getUser(tenant: string, id: string): Promise<DirectoryUser | null>;
  findUsers(tenant: string, filter: ScimFilter | undefined, page: ScimPage): Promise<ScimPageResult<DirectoryUser>>;
  putUser(tenant: string, user: DirectoryUser): Promise<DirectoryUser>;
  patchUser(tenant: string, id: string, ops: readonly ScimPatchOp[]): Promise<DirectoryUser>;
  deleteUser(tenant: string, id: string): Promise<void>;
  getGroup(tenant: string, id: string): Promise<DirectoryGroup | null>;
  findGroups(tenant: string, filter: ScimFilter | undefined, page: ScimPage): Promise<ScimPageResult<DirectoryGroup>>;
  putGroup(tenant: string, group: DirectoryGroup): Promise<DirectoryGroup>;
  patchGroup(tenant: string, id: string, ops: readonly ScimPatchOp[]): Promise<DirectoryGroup>;
  deleteGroup(tenant: string, id: string): Promise<void>;
  groupsFor(tenant: string, userId: string): Promise<readonly DirectoryGroup[]>;
};
type ScimTokenOptions = {
  readonly hash: "sha256";
  readonly lookup: (tenant: string) => string | undefined | Promise<string | undefined>;
};
type DirectoryChange = {
  readonly tenant: string;
  readonly userIds: readonly string[];
};
type ScimHandlerOptions = {
  readonly store: DirectoryStore;
  readonly tenant: string | ((request: Request) => string | Promise<string>);
  readonly token?: ScimTokenOptions;
  readonly verifier?: TokenVerifier;
  readonly audience?: string;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly assignable?: readonly string[];
  readonly sink?: DecisionSink;
  readonly onChange?: (change: DirectoryChange) => void | Promise<void>;
  readonly onUnknownRole?: (name: string) => void;
};
type DirectoryMembershipMatch = "externalId" | "userName" | "either";
type DirectoryMembershipSourceOptions = {
  readonly match?: DirectoryMembershipMatch;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly assignable?: readonly string[];
  readonly onUnknownRole?: (name: string) => void;
};
export declare class DirectoryUniquenessError extends Error {
  override readonly name = "DirectoryUniquenessError";
  readonly code: "uniqueness";
  constructor(message?: string);
}
export declare class DirectoryNotFoundError extends Error {
  override readonly name = "DirectoryNotFoundError";
  readonly code: "not-found";
  constructor(message?: string);
}
//#endregion
//#region src/scim/auth.d.ts
type ScimCredential = {
  readonly kind: "token";
} | {
  readonly kind: "jwt";
  readonly iss?: string;
};
type ScimAuthResult = {
  readonly ok: true;
  readonly credential: ScimCredential;
} | {
  readonly ok: false;
  readonly status: 401 | 403;
};
export declare function authenticateScim(input: {
  readonly request: Request;
  readonly tenant: string;
  readonly audience: string;
  readonly token?: ScimTokenOptions;
  readonly verifier?: TokenVerifier;
}): Promise<ScimAuthResult>;
export declare function sha256Hex(value: string): string;
//#endregion
//#region src/scim/discovery.d.ts
export declare function serviceProviderConfig(): Record<string, unknown>;
export declare function resourceTypes(): readonly Record<string, unknown>[];
export declare function schemas(): readonly Record<string, unknown>[];
//#endregion
//#region src/scim/filter.d.ts
export declare function parseScimFilter(input: string): ScimFilter | undefined;
export declare function matchFilter(target: DirectoryUser | DirectoryGroup | Record<string, unknown>, filter: ScimFilter | undefined): boolean;
export declare function filterSupported(filter: ScimFilter): boolean;
//#endregion
//#region src/scim/handler.d.ts
export declare function tenantFromPath(request: Request): string;
export declare function scimHandler(options: ScimHandlerOptions): (request: Request) => Promise<Response>;
//#endregion
//#region src/scim/patch.d.ts
export declare function normalizePatchOps(ops: readonly unknown[]): readonly ScimPatchOp[] | undefined;
//#endregion
//#region src/scim/source.d.ts
export declare function directoryMembershipSource(store: DirectoryStore, options?: DirectoryMembershipSourceOptions): MembershipSource;
//#endregion
//#region src/scim/store.d.ts
export declare function memoryDirectoryStore(): DirectoryStore;
//#endregion
export type { DirectoryChange, DirectoryGroup, DirectoryMembershipSourceOptions, DirectoryStore, DirectoryUser, ScimFilter, ScimHandlerOptions, ScimPage, ScimPageResult, ScimPatchOp, ScimTokenOptions };