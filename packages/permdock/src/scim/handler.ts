import type { DirectoryEvent, SinkEvent } from '../core/interfaces.ts';

import { compact } from '../core/compact.ts';
import { memorySink } from '../core/sink.ts';
import { authenticateScim, type ScimCredential } from './auth.ts';
import { resourceTypes, schemas, serviceProviderConfig } from './discovery.ts';
import { filterSupported, parseScimFilter } from './filter.ts';
import { normalizePatchOps, readPatchOperations } from './patch.ts';
import {
  ERROR_SCHEMA,
  GROUP_SCHEMA,
  LIST_SCHEMA,
  PATCH_SCHEMA,
  ROLES_EXTENSION,
  SCIM_CONTENT_TYPE,
  USER_SCHEMA,
  isDirectoryNotFoundError,
  isDirectoryUniquenessError,
  type DirectoryGroup,
  type DirectoryUser,
  type ScimHandlerOptions,
  type ScimPage,
} from './types.ts';

const RESOURCES = new Set([
  'Users',
  'Groups',
  'ServiceProviderConfig',
  'ResourceTypes',
  'Schemas',
]);

type ScimRoute =
  | { readonly kind: 'Users'; readonly id?: string }
  | { readonly kind: 'Groups'; readonly id?: string }
  | { readonly kind: 'ServiceProviderConfig' }
  | { readonly kind: 'ResourceTypes' }
  | { readonly kind: 'Schemas'; readonly id?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function tenantFromPath(request: Request): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  if (index <= 0) {
    return '';
  }
  const prev = parts[index - 1] ?? '';
  if (prev === 'v2' || prev === 'scim') {
    return '';
  }
  return prev;
}

function parseRoute(url: URL): ScimRoute | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  if (index === -1) {
    return undefined;
  }
  const kind = parts[index];
  const id = parts[index + 1];
  if (kind === undefined) {
    return undefined;
  }
  switch (kind) {
    case 'Users':
      return compact<ScimRoute>({ kind: 'Users', id });
    case 'Groups':
      return compact<ScimRoute>({ kind: 'Groups', id });
    case 'ServiceProviderConfig':
      return { kind: 'ServiceProviderConfig' };
    case 'ResourceTypes':
      return { kind: 'ResourceTypes' };
    case 'Schemas':
      return compact<ScimRoute>({ kind: 'Schemas', id });
    default:
      return undefined;
  }
}

function scimResponse(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': SCIM_CONTENT_TYPE, ...extra },
  });
}

function scimError(status: number, scimType: string, detail: string): Response {
  return scimResponse(status, {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    scimType,
    detail,
  });
}

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

function forbidden(): Response {
  return new Response(null, {
    status: 403,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

function audienceOf(request: Request, configured?: string): string {
  if (configured !== undefined) {
    return configured;
  }
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  const prefix = index === -1 ? parts : parts.slice(0, index);
  return `${url.origin}/${prefix.join('/')}`;
}

function locationOf(
  request: Request,
  kind: 'Users' | 'Groups',
  id: string,
): string {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  const prefix = index === -1 ? parts : parts.slice(0, index);
  return `${url.origin}/${[...prefix, kind, id].join('/')}`;
}

function pageFrom(url: URL): ScimPage {
  const startIndex = url.searchParams.get('startIndex');
  const count = url.searchParams.get('count');
  const cursor = url.searchParams.get('cursor');
  return compact<ScimPage>({
    startIndex:
      startIndex === null ? undefined : Math.trunc(Number(startIndex)),
    count: count === null ? undefined : Math.trunc(Number(count)),
    cursor: cursor ?? undefined,
  });
}

function listBody<T>(
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

function renderUser(
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

function renderGroup(
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

function readRoles(
  body: Record<string, unknown>,
): readonly string[] | undefined {
  const extension = body[ROLES_EXTENSION];
  if (!isRecord(extension) || !Array.isArray(extension.roles)) {
    return undefined;
  }
  return extension.roles.filter(
    (item): item is string => typeof item === 'string',
  );
}

function userFromBody(
  body: Record<string, unknown>,
  id: string,
): DirectoryUser | undefined {
  if (typeof body.userName !== 'string' || body.userName === '') {
    return undefined;
  }
  const emails = Array.isArray(body.emails)
    ? body.emails.flatMap((item) => {
        if (!isRecord(item) || typeof item.value !== 'string') {
          return [];
        }
        return [
          compact<{
            readonly value: string;
            readonly primary?: boolean;
            readonly type?: string;
          }>({
            value: item.value,
            primary:
              typeof item.primary === 'boolean' ? item.primary : undefined,
            type: typeof item.type === 'string' ? item.type : undefined,
          }),
        ];
      })
    : undefined;
  const active =
    typeof body.active === 'boolean'
      ? body.active
      : typeof body.active === 'string'
        ? body.active.toLowerCase() !== 'false'
        : true;
  return compact<DirectoryUser>({
    id,
    userName: body.userName,
    externalId:
      typeof body.externalId === 'string' ? body.externalId : undefined,
    active,
    emails,
    meta: { created: '', lastModified: '' },
  });
}

function groupFromBody(
  body: Record<string, unknown>,
  id: string,
  fallbackRoles: readonly string[] | undefined,
): DirectoryGroup | undefined {
  if (typeof body.displayName !== 'string' || body.displayName === '') {
    return undefined;
  }
  const members = Array.isArray(body.members)
    ? body.members.flatMap((item) => {
        if (!isRecord(item) || typeof item.value !== 'string') {
          return [];
        }
        return [{ value: item.value }];
      })
    : [];
  return compact<DirectoryGroup>({
    id,
    displayName: body.displayName,
    externalId:
      typeof body.externalId === 'string' ? body.externalId : undefined,
    members,
    roles: readRoles(body) ?? fallbackRoles,
    meta: { created: '', lastModified: '' },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

function schemasOk(body: Record<string, unknown>, required: string): boolean {
  const listed = body.schemas;
  if (!Array.isArray(listed)) {
    return false;
  }
  return listed.includes(required) || listed.includes(PATCH_SCHEMA);
}

function mapStoreError(error: unknown): Response {
  if (isDirectoryUniquenessError(error)) {
    return scimError(409, 'uniqueness', error.message);
  }
  if (isDirectoryNotFoundError(error)) {
    return scimError(404, 'invalidValue', 'resource not found');
  }
  return scimError(500, 'invalidValue', 'store failed');
}

function reportUnknownRoles(
  roles: readonly string[] | undefined,
  options: ScimHandlerOptions,
): void {
  if (roles === undefined || options.assignable === undefined) {
    return;
  }
  const allowed = new Set(options.assignable);
  for (const name of roles) {
    if (!allowed.has(name)) {
      options.onUnknownRole?.(name);
    }
  }
}

async function emitDirectory(
  options: ScimHandlerOptions,
  event: DirectoryEvent,
  userIds: readonly string[],
): Promise<void> {
  const sink = options.sink ?? memorySink();
  try {
    await sink.write([event] as readonly SinkEvent[]);
  } catch {
    // A throwing sink must never fail the IdP write.
  }
  try {
    await options.onChange?.({ tenant: event.tenant, userIds });
  } catch {
    // Snapshot invalidation is best-effort.
  }
}

function directoryEvent(input: {
  readonly operation: DirectoryEvent['operation'];
  readonly tenant: string;
  readonly type: 'User' | 'Group';
  readonly id: string;
  readonly credential: ScimCredential;
  readonly active?: boolean;
}): DirectoryEvent {
  return compact<DirectoryEvent>({
    type: 'directory',
    at: new Date().toISOString(),
    source: 'scim',
    operation: input.operation,
    tenant: input.tenant,
    resource: { type: input.type, id: input.id },
    credential: input.credential,
    active: input.active,
  });
}

export function scimHandler(
  options: ScimHandlerOptions,
): (request: Request) => Promise<Response> {
  if (options.token === undefined && options.verifier === undefined) {
    throw new Error('scimHandler requires token or verifier');
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = parseRoute(url);
    if (route === undefined) {
      return scimError(404, 'invalidValue', 'unknown route');
    }

    let tenant: string;
    try {
      tenant =
        typeof options.tenant === 'string'
          ? options.tenant
          : await options.tenant(request);
    } catch {
      return forbidden();
    }
    if (tenant === '') {
      return forbidden();
    }

    const auth = await authenticateScim(
      compact({
        request,
        tenant,
        audience: audienceOf(request, options.audience),
        token: options.token,
        verifier: options.verifier,
      }),
    );
    if (!auth.ok) {
      return auth.status === 403 ? forbidden() : unauthorized();
    }

    try {
      if (route.kind === 'ServiceProviderConfig') {
        return scimResponse(200, serviceProviderConfig());
      }
      if (route.kind === 'ResourceTypes') {
        return scimResponse(200, resourceTypes());
      }
      if (route.kind === 'Schemas') {
        const all = schemas();
        if (route.id !== undefined) {
          const schema = all.find((item) => item.id === route.id);
          if (schema === undefined) {
            return scimError(404, 'invalidValue', 'schema not found');
          }
          return scimResponse(200, schema);
        }
        return scimResponse(200, all);
      }

      if (request.method === 'GET' && route.id === undefined) {
        const rawFilter = url.searchParams.get('filter');
        const filter =
          rawFilter === null || rawFilter === ''
            ? undefined
            : parseScimFilter(rawFilter);
        if (rawFilter !== null && rawFilter !== '' && filter === undefined) {
          return scimError(400, 'invalidFilter', 'unsupported filter');
        }
        if (filter !== undefined && !filterSupported(filter)) {
          return scimError(400, 'invalidFilter', 'unsupported filter');
        }
        const page = pageFrom(url);
        if (route.kind === 'Users') {
          const result = await options.store.findUsers(tenant, filter, page);
          return scimResponse(
            200,
            listBody(result, (user) =>
              renderUser(user, locationOf(request, 'Users', user.id)),
            ),
          );
        }
        const result = await options.store.findGroups(tenant, filter, page);
        return scimResponse(
          200,
          listBody(result, (group) =>
            renderGroup(group, locationOf(request, 'Groups', group.id)),
          ),
        );
      }

      if (request.method === 'GET' && route.id !== undefined) {
        if (route.kind === 'Users') {
          const user = await options.store.getUser(tenant, route.id);
          if (user === null) {
            return scimError(404, 'invalidValue', 'resource not found');
          }
          return scimResponse(
            200,
            renderUser(user, locationOf(request, 'Users', user.id)),
          );
        }
        const group = await options.store.getGroup(tenant, route.id);
        if (group === null) {
          return scimError(404, 'invalidValue', 'resource not found');
        }
        return scimResponse(
          200,
          renderGroup(group, locationOf(request, 'Groups', group.id)),
        );
      }

      if (request.method === 'DELETE' && route.id !== undefined) {
        if (route.kind === 'Users') {
          const existing = await options.store.getUser(tenant, route.id);
          await options.store.deleteUser(tenant, route.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'delete',
              tenant,
              type: 'User',
              id: route.id,
              credential: auth.credential,
              active: false,
            }),
            existing === null ? [] : [existing.id],
          );
          return new Response(null, { status: 204 });
        }
        const existing = await options.store.getGroup(tenant, route.id);
        await options.store.deleteGroup(tenant, route.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'delete',
            tenant,
            type: 'Group',
            id: route.id,
            credential: auth.credential,
          }),
          existing?.members.map((member) => member.value) ?? [],
        );
        return new Response(null, { status: 204 });
      }

      const body = await readJson(request);
      if (!isRecord(body)) {
        return scimError(400, 'invalidSyntax', 'malformed body');
      }

      if (request.method === 'POST' && route.id === undefined) {
        if (route.kind === 'Users') {
          if (!schemasOk(body, USER_SCHEMA)) {
            return scimError(400, 'invalidSyntax', 'unsupported schema');
          }
          const parsed = userFromBody(body, '');
          if (parsed === undefined) {
            return scimError(400, 'invalidValue', 'userName is required');
          }
          const stored = await options.store.putUser(tenant, parsed);
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'create',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(201, renderUser(stored, location), {
            location,
          });
        }
        if (!schemasOk(body, GROUP_SCHEMA)) {
          return scimError(400, 'invalidSyntax', 'unsupported schema');
        }
        const parsed = groupFromBody(
          body,
          '',
          options.groupRoles?.[body.id as string],
        );
        if (parsed === undefined) {
          return scimError(400, 'invalidValue', 'displayName is required');
        }
        reportUnknownRoles(parsed.roles, options);
        const stored = await options.store.putGroup(tenant, parsed);
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'create',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
        );
        return scimResponse(201, renderGroup(stored, location), { location });
      }

      if (request.method === 'PUT' && route.id !== undefined) {
        if (route.kind === 'Users') {
          if (!schemasOk(body, USER_SCHEMA)) {
            return scimError(400, 'invalidSyntax', 'unsupported schema');
          }
          const existing = await options.store.getUser(tenant, route.id);
          if (existing === null) {
            return scimError(404, 'invalidValue', 'resource not found');
          }
          const parsed = userFromBody(body, route.id);
          if (parsed === undefined) {
            return scimError(400, 'invalidValue', 'userName is required');
          }
          const stored = await options.store.putUser(tenant, parsed);
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'replace',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(200, renderUser(stored, location), { location });
        }
        if (!schemasOk(body, GROUP_SCHEMA)) {
          return scimError(400, 'invalidSyntax', 'unsupported schema');
        }
        const existing = await options.store.getGroup(tenant, route.id);
        if (existing === null) {
          return scimError(404, 'invalidValue', 'resource not found');
        }
        const parsed = groupFromBody(
          body,
          route.id,
          options.groupRoles?.[route.id],
        );
        if (parsed === undefined) {
          return scimError(400, 'invalidValue', 'displayName is required');
        }
        reportUnknownRoles(parsed.roles, options);
        const stored = await options.store.putGroup(tenant, parsed);
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'replace',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
        );
        return scimResponse(200, renderGroup(stored, location), { location });
      }

      if (request.method === 'PATCH' && route.id !== undefined) {
        const operations = readPatchOperations(body);
        if (operations === undefined) {
          return scimError(400, 'invalidSyntax', 'Operations required');
        }
        const normalized = normalizePatchOps(operations);
        if (normalized === undefined) {
          return scimError(400, 'invalidSyntax', 'invalid patch');
        }
        if (route.kind === 'Users') {
          const stored = await options.store.patchUser(
            tenant,
            route.id,
            normalized,
          );
          const location = locationOf(request, 'Users', stored.id);
          await emitDirectory(
            options,
            directoryEvent({
              operation: 'patch',
              tenant,
              type: 'User',
              id: stored.id,
              credential: auth.credential,
              active: stored.active,
            }),
            [stored.id],
          );
          return scimResponse(200, renderUser(stored, location), { location });
        }
        const stored = await options.store.patchGroup(
          tenant,
          route.id,
          normalized,
        );
        const location = locationOf(request, 'Groups', stored.id);
        await emitDirectory(
          options,
          directoryEvent({
            operation: 'patch',
            tenant,
            type: 'Group',
            id: stored.id,
            credential: auth.credential,
          }),
          stored.members.map((member) => member.value),
        );
        return scimResponse(200, renderGroup(stored, location), { location });
      }

      return scimError(405, 'invalidValue', 'method not allowed');
    } catch (error) {
      if (error instanceof SyntaxError) {
        return scimError(400, 'invalidSyntax', 'malformed body');
      }
      return mapStoreError(error);
    }
  };
}
