import type { AppData } from "../core/app-data.ts";

import { canonicalJson } from "../core/canonical-json.ts";
import { compact, isRecord } from "../core/compact.ts";
import { sha256Digest } from "../core/sha256.ts";
import {
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  APP_DATA_EXTENSION,
  ROLES_EXTENSION,
  SCIM_CONTENT_TYPE,
  USER_SCHEMA,
  isDirectoryNotFoundError,
  isDirectoryUniquenessError,
  type DirectoryGroup,
  type DirectoryUser,
} from "./types.ts";

export function scimResponse(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, ...extra },
  });
}

/**
 * RFC 7644 section 3.12: `scimType` is defined for `400` and `409` only, so
 * other statuses omit it.
 */
export function scimError(
  status: number,
  scimType: string,
  detail: string,
  extra?: Record<string, string>,
): Response {
  return scimResponse(
    status,
    compact({
      schemas: [ERROR_SCHEMA],
      status: String(status),
      scimType: status === 400 || status === 409 ? scimType : undefined,
      detail,
    }),
    extra,
  );
}

export function unauthorized(): Response {
  return scimError(401, "", "authentication required", {
    "www-authenticate": "Bearer",
  });
}

export function forbidden(): Response {
  return scimError(403, "", "the credential may not provision this tenant", {
    "www-authenticate": 'Bearer error="insufficient_scope"',
  });
}

/**
 * RFC 7644 section 3.14 `meta.version`: a weak entity tag over the resource as
 * rendered, `meta.location` excluded so every URL agrees.
 */
function withVersion(
  resource: Record<string, unknown>,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const { location: _location, ...stable } = meta;
  const version = `W/"${sha256Digest(canonicalJson({ ...resource, meta: stable }))}"`;
  return { ...resource, meta: { ...meta, version } };
}

/** The `meta.version` a rendered resource carries, for `ETag`. */
export function versionOf(rendered: Record<string, unknown>): string {
  const meta = rendered["meta"];
  return isRecord(meta) && typeof meta["version"] === "string"
    ? meta["version"]
    : "";
}

function entityTags(field: string): readonly string[] {
  return field
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//u, ""))
    .filter((tag) => tag !== "");
}

/**
 * RFC 9110 section 13.1.1 `If-Match` against a weak `meta.version`: `true` when
 * the request may proceed.
 */
export function ifMatchHolds(request: Request, version: string): boolean {
  const field = request.headers.get("if-match");
  if (field === null) {
    return true;
  }
  const tags = entityTags(field);
  return tags.includes("*") || tags.includes(version.replace(/^W\//u, ""));
}

/**
 * RFC 9110 section 13.1.2 `If-None-Match`: `true` when the client holds
 * `version`.
 */
export function ifNoneMatchHolds(request: Request, version: string): boolean {
  const field = request.headers.get("if-none-match");
  if (field === null) {
    return false;
  }
  const tags = entityTags(field);
  return tags.includes("*") || tags.includes(version.replace(/^W\//u, ""));
}

export function preconditionFailed(): Response {
  return scimError(412, "", "the resource changed since meta.version");
}

export function mapStoreError(error: unknown): Response {
  if (isDirectoryUniquenessError(error)) {
    return scimError(409, "uniqueness", error.message);
  }
  if (isDirectoryNotFoundError(error)) {
    return scimError(404, "invalidValue", "resource not found");
  }
  return scimError(500, "invalidValue", "store failed");
}

export function listBody<T>(
  result: {
    readonly Resources: readonly T[];
    readonly totalResults: number;
    readonly startIndex?: number;
    readonly itemsPerPage?: number;
    readonly nextCursor?: string;
  },
  render: (item: T) => Record<string, unknown>,
): Record<string, unknown> {
  return compact({
    schemas: [LIST_SCHEMA],
    totalResults: result.totalResults,
    startIndex: result.startIndex,
    itemsPerPage: result.itemsPerPage,
    nextCursor: result.nextCursor,
    Resources: result.Resources.map(render),
  });
}

/** The `AppData` extension for `x`, and the schema URN it adds. */
function appData(x: AppData | undefined): {
  readonly schemas: readonly string[];
  readonly body: Record<string, unknown>;
} {
  return x === undefined
    ? { schemas: [], body: {} }
    : { schemas: [APP_DATA_EXTENSION], body: { [APP_DATA_EXTENSION]: { x } } };
}

export function renderUser(
  user: DirectoryUser,
  location: string,
): Record<string, unknown> {
  const data = appData(user.x);
  return withVersion(
    compact({
      schemas: [USER_SCHEMA, ...data.schemas],
      id: user.id,
      externalId: user.externalId,
      userName: user.userName,
      active: user.active,
      emails: user.emails,
      ...data.body,
    }),
    {
      resourceType: "User",
      created: user.meta.created,
      lastModified: user.meta.lastModified,
      location,
    },
  );
}

export function renderGroup(
  group: DirectoryGroup,
  location: string,
): Record<string, unknown> {
  const extension =
    group.roles === undefined
      ? undefined
      : { [ROLES_EXTENSION]: { roles: group.roles } };
  const data = appData(group.x);
  return withVersion(
    compact({
      schemas: [
        GROUP_SCHEMA,
        ...(group.roles === undefined ? [] : [ROLES_EXTENSION]),
        ...data.schemas,
      ],
      id: group.id,
      externalId: group.externalId,
      displayName: group.displayName,
      members: group.members,
      ...extension,
      ...data.body,
    }),
    {
      resourceType: "Group",
      created: group.meta.created,
      lastModified: group.meta.lastModified,
      location,
    },
  );
}
