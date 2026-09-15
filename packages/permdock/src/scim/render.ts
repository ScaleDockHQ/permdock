import { compact } from '../core/compact.ts';
import {
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  ROLES_EXTENSION,
  SCIM_CONTENT_TYPE,
  USER_SCHEMA,
  isDirectoryNotFoundError,
  isDirectoryUniquenessError,
  type DirectoryGroup,
  type DirectoryUser,
} from './types.ts';

export function scimResponse(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': SCIM_CONTENT_TYPE, ...extra },
  });
}

export function scimError(
  status: number,
  scimType: string,
  detail: string,
): Response {
  return scimResponse(status, {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    scimType,
    detail,
  });
}

export function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

export function forbidden(): Response {
  return new Response(null, {
    status: 403,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

export function mapStoreError(error: unknown): Response {
  if (isDirectoryUniquenessError(error)) {
    return scimError(409, 'uniqueness', error.message);
  }
  if (isDirectoryNotFoundError(error)) {
    return scimError(404, 'invalidValue', 'resource not found');
  }
  return scimError(500, 'invalidValue', 'store failed');
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

export function renderUser(
  user: DirectoryUser,
  location: string,
): Record<string, unknown> {
  return compact({
    schemas: [USER_SCHEMA],
    id: user.id,
    externalId: user.externalId,
    userName: user.userName,
    active: user.active,
    emails: user.emails,
    meta: {
      resourceType: 'User',
      created: user.meta.created,
      lastModified: user.meta.lastModified,
      location,
    },
  });
}

export function renderGroup(
  group: DirectoryGroup,
  location: string,
): Record<string, unknown> {
  const extension =
    group.roles === undefined
      ? undefined
      : { [ROLES_EXTENSION]: { roles: group.roles } };
  return compact({
    schemas:
      group.roles === undefined
        ? [GROUP_SCHEMA]
        : [GROUP_SCHEMA, ROLES_EXTENSION],
    id: group.id,
    externalId: group.externalId,
    displayName: group.displayName,
    members: group.members,
    ...extension,
    meta: {
      resourceType: 'Group',
      created: group.meta.created,
      lastModified: group.meta.lastModified,
      location,
    },
  });
}
